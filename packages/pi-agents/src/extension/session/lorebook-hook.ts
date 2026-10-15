/**
 * 子会话世界书注入通道(docs/10 §5.1/§5.3)。
 *
 * 以 inline extension(extensionFactories)挂进子会话:
 *   - `context_with_system` 事件(每次 LLM 请求前触发,已核实 agent-loop.streamAssistantResponse
 *     → transformContext → runner.emitContext):depth 条目插消息 + system 条目改写
 *     首个 system 消息的文本(system prompt 每请求重算,§5.1);
 *   - persistent depth 条目(§5.3):首次生效时经 sessionManager.appendCustomMessageEntry
 *     写入子会话记录(convertToLlm 转 user 消息);之后按 entry id 判重不再注入;
 *     同一子会话生命周期内有效(in-memory,进程退出即失)。
 *
 * 组装逻辑在 lorebook.ts(resolveLorebook/composeSystemPrompt/planDepthInsertions)。
 */

import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { LorebookContext, LorebookMessageLike } from '../types.js';
import { composeSystemPrompt, entryId, planDepthInsertions, resolveLorebook, type LorebookSource } from './lorebook.js';

/**
 * pnpm 双实例(顶层链 vs .pnpm 嵌套链)导致 pi-agent-core 类型名义不兼容;
 * hook 内部消息操作全是结构化子集(role/content/timestamp),统一走此别名。
 */
type HookMessage = AgentMessage;
const asHookMessages = (ms: readonly HookMessage[]): HookMessage[] => ms as HookMessage[];

/** 持久化 custom 消息的 customType(pi 转user 进上下文;判重/识别键) */
export const LOREBOOK_ENTRY_TYPE = 'pi-agents-lorebook';

/** hook 依赖(由 run-node 组装;测试可替换) */
export interface LorebookHookDeps {
    /** 三级来源(每次注入重新解析;工作区级按 ctx.agent 筛选由 index 层做) */
    sourcesOf: (ctx: LorebookContext) => LorebookSource[];
    /** 系统提示词基座列表(Agent systemPrompt 投影) */
    baseSystemPrompt: string[];
    /** 组装 LorebookContext 的宿主信息(调用时展开) */
    makeContext: (messages: readonly AgentMessage[], requestIndex: number) => LorebookContext;
    /** 告警 */
    warn?: (msg: string) => void;
}

/**
 * 创建注入扩展。返回 (factory, 状态查询)。
 * 状态仅供测试/诊断(requestIndex/已持久化 id 集)。
 */
export function createLorebookHook(
    deps: LorebookHookDeps,
    sessionManager: { appendCustomMessageEntry: (t: string, content: string, display: boolean) => string },
): { factory: ExtensionFactory; stats: () => { requestIndex: number; persisted: string[] } } {
    let requestIndex = 0;
    let persisted: string[] | null = null;

    const factory: ExtensionFactory = (pi) => {
        pi.on('context_with_system', async (event) => {
            requestIndex++;
            const messages = asHookMessages(event.messages as readonly HookMessage[]);

            const lbCtx = deps.makeContext(messages, requestIndex);
            const resolution = await resolveLorebook(deps.sourcesOf(lbCtx), lbCtx);
            for (const name of resolution.skipped) {
                deps.warn?.(`世界书 "${name}" 本轮评估抛错,已跳过(不影响运行)`);
            }

            let out = messages;

            /* ---- system 条目:改写首个 system 消息文本(§5.1,每请求重算) ---- */
            if (resolution.system.length > 0) {
                const sysIdx = out.findIndex((m) => m.role === 'system');
                const sys = out[sysIdx];
                if (sys) {
                    const prevText = systemTextOf(sys);
                    const nextText = composeSystemPrompt(deps.baseSystemPrompt, resolution.system);
                    if (nextText !== prevText) {
                        out = [...out];
                        out[sysIdx] = { ...sys, content: nextText } as AgentMessage;
                    }
                }
            }

            /* ---- depth 条目:非持久化动态插入;持久化首见写入(§5.3) ---- */
            const dynamic: typeof resolution.depth = [];
            for (const r of resolution.depth) {
                const isPersistent = persistentOf(deps.sourcesOf(lbCtx), r.id);
                if (!isPersistent) {
                    dynamic.push(r);
                    continue;
                }
                persisted ??= [];
                if (!persisted.includes(r.id)) {
                    // 首次生效 → 写入记录(convertToLlm 转 user);不插入本轮列表(写入即生效)
                    sessionManager.appendCustomMessageEntry(LOREBOOK_ENTRY_TYPE, r.entry.content, false);
                    persisted.push(r.id);
                }
            }
            if (dynamic.length > 0) {
                out = insertMessages(out, planDepthInsertions(dynamic, out.length));
            }

            return { messages: out };
        });
    };

    return { factory, stats: () => ({ requestIndex, persisted: persisted ?? [] }) };
}

/** system 消息当前文本(string 或 text 块首块) */
function systemTextOf(m: AgentMessage): string {
    const content = (m as { content: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const first = content.find((b) => (b as { type?: string }).type === 'text');
        const text = (first as { text?: string } | undefined)?.text;
        return text ?? '';
    }
    return '';
}

/** 插入 depth 消息(role → 文本消息) */
function insertMessages(
    messages: readonly AgentMessage[],
    plan: Array<{ index: number; message: { role: 'user' | 'assistant'; content: string; order: number } }>,
): AgentMessage[] {
    // 先深后浅插入;同 index 按 order 降序插(splice 后插在前 → 最终 order 升序,§5.3)
    const sorted = [...plan].sort((a, b) => b.index - a.index || b.message.order - a.message.order);
    const out = [...messages];
    for (const inj of sorted) {
        const at = Math.max(0, Math.min(inj.index, out.length));
        out.splice(at, 0, {
            role: inj.message.role,
            content: [{ type: 'text', text: inj.message.content }],
            timestamp: Date.now(),
        } as AgentMessage);
    }
    return out;
}

/** 查 entry id 对应来源的 persistent 声明(仅 depth 条目;§5.3) */
function persistentOf(sources: LorebookSource[], id: string): boolean {
    for (const source of sources) {
        if (!source.spec?.persistent) continue;
        // 粗判:该来源声明了 persistent 即可(条目级判重已由 id 保证不重复注入);
        // 来源级声明是文档语义(persistent 是 LorebookSpec 字段)。
        void id;
        return true;
    }
    return false;
}

/** 作者侧 messages 投影(LorebookContext.messages = LorebookMessageLike[]) */
export function toLorebookMessages(messages: readonly AgentMessage[]): LorebookMessageLike[] {
    return messages.map((m) => ({
        role: m.role,
        content: (m as { content: unknown }).content,
    }));
}

/** entryId 再导出(测试/诊断) */
export { entryId };
