/**
 * 工作流唤醒运行时(docs/40 §4 唤醒语义 + §4.2 引擎接线)。
 *
 * 职责:
 *   - 唤醒输入提取:宿主请求末条 user 消息 → 文本(图片块占位,§4.1)
 *   - 组装真实 NodeExecutor 并驱动 runFlow(M2 引擎)
 */

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { runFlow, FlowError } from '../engine/runner.js';
import type { RunFlowResult } from '../engine/runner.js';
import type {
    FlowDefinition,
    HostContentBlock,
    HostMessageLike,
    HostRole,
    HostSessionView,
    ImageContent,
    WakeContext,
} from '../types.js';
import { collectWakeImages, type ImageLimits } from '../shared/images.js';
import type { AgentFrame } from '../../shared/protocol.js';
import { AskPostedError, AbortedError } from './run-node.js';
import type { SessionPool } from './pool.js';
import { createNodeExecutor, type RunNodeEnv } from './run-node.js';
import { createFileHelpers } from '../files.js';

/* ------------------------------------------------------------------ */
/*  §4.1 唤醒输入提取                                                   */
/* ------------------------------------------------------------------ */

/** 消息 content → 纯文本(图片块计数)。custom 消息等无 content 形态按空处理。 */
function contentText(content: unknown): { text: string; images: number } {
    if (typeof content === 'string') return { text: content, images: 0 };
    if (!Array.isArray(content)) return { text: '', images: 0 };
    let text = '';
    let images = 0;
    for (const block of content) {
        const b = block as { type?: string; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text;
        else if (b.type === 'image') images++;
    }
    return { text, images };
}

export interface ExtractWakeInputResult {
    /** 文本(图片位置 "[图片 xN]" 占位;真实图片在 images 通道) */
    text: string | null;
    /** 收集到的图片块(按上限过滤;40 §4.1) */
    images: ImageContent[];
    /** 因超 maxImageBytes 丢弃的张数(thinking 行提示用) */
    droppedBytes: number;
    /** 因超 maxWakeImages 丢弃的张数 */
    droppedCount: number;
}

/**
 * 从宿主请求消息(已去 system)提取本次唤醒输入:最后一条 user 消息(§4.1/D12)。
 * 文本中图片位置保留 "[图片 xN]" 占位;ImageContent 块收集为 wake.images
 * (collectWakeImages 按上限过滤,docs/20 §9.2)。
 * 找不到 user 消息或文本为空 → text: null(调用方 error 流;图片通道不单独成立)。
 */
export function extractWakeInput(messages: readonly AgentMessage[], limits: ImageLimits): ExtractWakeInputResult {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'user') {
            const { text, images } = contentText((m as { content: unknown }).content);
            const suffix = images > 0 ? `\n[图片 x${images}]` : '';
            const full = (text + suffix).trim();
            const collected = collectWakeImages((m as { content: unknown }).content, limits);
            return { text: full.length > 0 ? full : null, ...collected };
        }
    }
    return { text: null, images: [], droppedBytes: 0, droppedCount: 0 };
}

/* ------------------------------------------------------------------ */
/*  唤醒驱动                                                            */
/* ------------------------------------------------------------------ */

export interface WakeArgs {
    flow: FlowDefinition;
    /** 宿主本次请求消息(含 system;内部过滤) */
    hostMessages: readonly AgentMessage[];
    wakeIndex: number;
    hostSessionId: string;
    /** 上一次唤醒的工作流输出(WakeContext.lastOutput) */
    lastOutput?: string;
    /** 真实执行环境 */
    env: RunNodeEnv;
    /** 中断信号(宿主 Esc → 引擎/子会话级联) */
    signal?: AbortSignal;
    /** 引擎 maxHops(配置) */
    maxHops?: number;
    /** 中断收尾(docs/40 §8):被中断唤醒涉及的 inherit 节点键,调用方弃池重建 */
    onAbortCleanup?: (nodeKeys: string[]) => void;
    /** M7:成功唤醒结束时持久化用量 entry(pi.appendEntry;index 构造,§6) */
    usageFlush?: () => void;
    /** M8:图片上限(config.images;缺省用 shared/images 默认组) */
    imageLimits?: ImageLimits;
    /** M8:图片事件 thinking 行(onThinking 缺省时仅忽略) */
    onThinking?: (line: string) => void;
    /** M9:插件事件发射(40 §13;缺省 = 不发射;index 由 piEventEmitter 构造) */
    onAgentEvent?: (frame: AgentFrame) => void;
}

export type WakeOutcome =
    | { ok: true; result: RunFlowResult; wake: WakeContext }
    | { ok: false; aborted: true; error: AbortedError }
    | { ok: false; aborted: false; error: FlowError };

/** 驱动一次唤醒(docs/40 §4.3)。错误按 docs/60 §7:用户代码错误原样透传 FlowError。 */
export async function wakeFlow(args: WakeArgs): Promise<WakeOutcome> {
    const limits: ImageLimits = args.imageLimits ?? {
        maxWakeImages: 4,
        maxImageBytes: 2 * 1024 * 1024,
        maxNodeImages: 8,
    };
    const extracted = extractWakeInput(args.hostMessages, limits);
    const wakeInput = extracted.text;
    if (wakeInput === null) {
        return { ok: false, aborted: false, error: new FlowError('唤醒输入为空(未找到宿主 user 消息)') };
    }
    // 图片收集提示(40 §5.5:丢弃/收集汇总一次;onThinking 缺省时静默)
    const onThinking = args.onThinking ?? args.env.onThinking;
    if (extracted.images.length > 0 || extracted.droppedBytes > 0 || extracted.droppedCount > 0) {
        const parts: string[] = [`收到 ${extracted.images.length} 张图片`];
        if (extracted.droppedCount > 0) parts.push(`${extracted.droppedCount} 张超出唤醒上限丢弃`);
        if (extracted.droppedBytes > 0) parts.push(`${extracted.droppedBytes} 张超出单图上限丢弃`);
        onThinking?.(`[pi-agents] ${parts.join(', ')}`);
    }

    const wake: WakeContext = {
        input: wakeInput,
        images: extracted.images,
        hostSessionId: args.hostSessionId,
        wakeIndex: args.wakeIndex,
        ...(args.lastOutput !== undefined ? { lastOutput: args.lastOutput } : {}),
    };

    const { execute } = createNodeExecutor({
        ...args.env,
        signal: args.signal,
    });

    // §8 中断收尾:本唤醒涉及的 inherit 节点(从 trail 之外无法精确恢复中断点,
    // 保守计已进入过的节点 + 入口;收集在 execute 外包一层)
    const visitedAgentNodes = new Set<string>();
    const wrappedExecute: typeof execute = async (agentName, input, spec, ctx) => {
        visitedAgentNodes.add(spec.label ?? agentName);
        return execute(agentName, input, spec, ctx);
    };

    try {
        const result = await runFlow(args.flow, wake, {
            executeAgentNode: wrappedExecute,
            maxHops: args.maxHops,
            warn: args.env.warn,
            onThinking: args.env.onThinking,
            // M8:函数节点 files 助手(cwd 动态取 env.cwd)与图片开关(docs/20 §9.5/9.7);
            // config.images 可能缺省(测试假 env)→ 兜底默认组
            fileHelpers: createFileHelpers(args.env.cwd, args.env.config?.images ?? limits),
            imageLimits: args.imageLimits ?? args.env.config?.images ?? limits,
            embedFinalImages: args.env.config?.images?.embedFinalImages ?? 'markdown',
            // M9:node/edge 帧由 runner 发(onAgentEvent 缺省 = 不发射)
            emit: args.onAgentEvent ?? args.env.onAgentEvent,
            // 函数节点 ctx.host:宿主会话只读视图(docs/20 §2.2)
            hostView: projectHostView(args.hostMessages, wake, args.lastOutput),
        });
        return { ok: true, result, wake };
    } catch (error) {
        if (error instanceof AbortedError) {
            // 中断污染清理:本次唤醒涉及的 inherit 节点全部弃池(§8);
            // 至少包括入口节点(中断可能落在首节点 prompt 之前/中)。
            const keys = [...visitedAgentNodes];
            if (!keys.includes(args.flow.entry) && args.flow.nodes[args.flow.entry]?.agent) {
                keys.push(args.flow.entry);
            }
            try {
                await args.onAbortCleanup?.(keys);
            } catch {
                /* 清理失败不影响中断语义 */
            }
            return { ok: false, aborted: true, error };
        }
        if (error instanceof AskPostedError) {
            // ask 挂起(ask_user 已转发宿主,回答以 followUp 唤醒):按正常落定形态收尾。
            // text = 提问节点已产出文本(常为空);stream 层在 ask 边界段已完成 toolUse
            // 收口,宿主执行 pi-web ask_user 后本轮终止,不再消费此 outcome。
            return {
                ok: true,
                result: {
                    text: error.partialText,
                    terminal: error.nodeKey,
                    trail: [{ node: error.nodeKey, visit: error.visit, text: error.partialText }],
                },
                wake,
            };
        }
        if (error instanceof FlowError) return { ok: false, aborted: false, error };
        // 用户代码错误(route/pass/run 抛错已被引擎包成 FlowError;这里是非引擎路径)
        return {
            ok: false,
            aborted: false,
            error: new FlowError(error instanceof Error ? error.message : String(error)),
        };
    }
}

/** 会话池类型再导出(runtime 消费方) */
export type { SessionPool };

/**
 * 宿主消息 → HostSessionView 投影(docs/20 §2.2 ctx.host)。
 * 与 lorebook 的 toLorebookMessages 同构:仅保留 role/content(作者侧强类型);
 * system 消息由调用方(index buildWakeArgs)过滤后再传入,这里不做二次过滤。
 * content 非字符串且非块数组(宿主 custom 消息等异常形态)→ 归一为单 text 块
 * (JSON 序列化,保证投影类型守恒、不丢内容)。
 */
export function projectHostView(
    messages: readonly AgentMessage[],
    wake: Pick<WakeContext, 'hostSessionId' | 'wakeIndex' | 'input'>,
    lastOutput?: string,
): HostSessionView {
    const projected: HostMessageLike[] = messages.map((m) => {
        const raw = m as { role: string; content: unknown };
        const role: HostRole =
            raw.role === 'user' || raw.role === 'assistant' || raw.role === 'toolResult' ? raw.role : 'assistant'; // 防御:投影外角色(custom 等)按 assistant 语义呈现
        return { role, content: normalizeHostContent(raw.content) };
    });
    return {
        sessionId: wake.hostSessionId,
        wakeIndex: wake.wakeIndex,
        lastInput: wake.input,
        ...(lastOutput !== undefined ? { lastOutput } : {}),
        messages: projected,
    };
}

/** content 归一化:字符串原样;已知形状块数组过滤;未知形态 → 单 text 块(序列化) */
function normalizeHostContent(content: unknown): string | HostContentBlock[] {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const blocks: HostContentBlock[] = [];
        for (const b of content) {
            const block = b as {
                type?: string;
                text?: unknown;
                thinking?: unknown;
                data?: unknown;
                mimeType?: unknown;
                id?: unknown;
                name?: unknown;
                arguments?: unknown;
            };
            if (block?.type === 'text' && typeof block.text === 'string') {
                blocks.push({ type: 'text', text: block.text });
            } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
                blocks.push({ type: 'thinking', thinking: block.thinking });
            } else if (
                block?.type === 'image' &&
                typeof block.data === 'string' &&
                typeof block.mimeType === 'string'
            ) {
                blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType });
            } else if (block?.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
                blocks.push({
                    type: 'toolCall',
                    id: block.id,
                    name: block.name,
                    arguments: (typeof block.arguments === 'object' && block.arguments !== null
                        ? block.arguments
                        : {}) as Record<string, unknown>,
                });
            }
            // 其他/畸形块 → 丢弃(投影类型守恒优先;内容仍可在原始消息里由宿主自身消费)
        }
        return blocks;
    }
    // 字符串/数组之外的形态(宿主 custom 等):单 text 块兜底,不丢信息
    if (content === undefined || content === null) return [];
    try {
        return [{ type: 'text', text: JSON.stringify(content) }];
    } catch {
        return [{ type: 'text', text: String(content) }];
    }
}
