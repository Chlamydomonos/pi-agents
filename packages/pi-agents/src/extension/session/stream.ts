/**
 * 虚拟模型端点(docs/30 §2 streamSimple 契约 + §6 分段续跑,M10)。
 *
 * 宿主(pi)agent loop:streamFn 返回的消息含 toolCall → 宿主执行工具 → 把 toolResult
 * 追加进 transcript → 再次调用 streamFn(续跑)。本模块把工作流执行映射为
 * 「多轮虚拟 assistant 消息」:
 *
 *   首调(尾部无占位 toolResult) → 启动 BufferedRun:异步跑 wakeFlow,NodeEvent 流经
 *                                FlowSegmenter 切段;含 toolCall 的段 →
 *                                done(stopReason:'toolUse') → 宿主执行占位工具 → 续跑;
 *   续跑(尾部 toolResult.toolCallId 命中注册表)→ 从缓冲队列继续推段;
 *   工作流落定                   → 末段以 outcome.text 收尾,done(stopReason:'stop')。
 *
 * 续跑注册键 = 占位 toolCall 的 id(全局唯一,agents-<rand>-<n>);
 * 宿主把它原样写进 toolResult.toolCallId,链路无歧义。进程重启丢注册表 →
 * 续跑找不到键 → 明确报错(用户重新发起)。
 *
 * 宿主约定:每次调用产一条 assistant 消息:start 最先;done/error 恰一;
 * thinking/text/toolcall 的 _start/_delta/_end 配对;usage 恒 0(D15)。
 * 每条消息块序 = 实际发生序(思考→工具→思考→…),宿主渲染天然有序。
 */

import type {
    AssistantMessage,
    AssistantMessageEventStream,
    Model,
    Api,
    TranscriptContext,
    SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as compatStreamSimple } from '@earendil-works/pi-ai/compat';
import type { FlowDefinition } from '../types.js';
import type { WakeArgs, WakeOutcome } from './runtime.js';
import { wakeFlow } from './runtime.js';
import { wakeStartFrame, wakeEndFrame } from '../emit.js';
import type { AgentFrame } from '../../shared/protocol.js';
import { getSystemMessageText } from '@earendil-works/pi-ai';
import type { NodeEvent } from './stream-events.js';
import type { PlaceholderToolCall } from './stream-events.js';
import { FlowSegmenter, type FlowSegment, type SegmentEvent } from './segmenter.js';

/** 宿主(pi-web)会话标题生成请求的识别特征(sessionNameGenerator 的 systemPrompt) */
const TITLE_PROMPT_MARKER = 'Generate a concise title for a coding-agent chat session';

/** 虚拟模型 usage/cost 恒 0(docs/30 §5,D15) */
const ZERO_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type ContentBlock = AssistantMessage['content'][number];

/** streamSimple 依赖(由 index.ts 接线注入) */
export interface StreamDeps {
    /** model.id → 工作流定义(注册时的有效 flows) */
    flowByName: ReadonlyMap<string, FlowDefinition>;
    /** 全局配置 streamPrefixes(docs/30 §3.2;缺省 true) */
    streamPrefixes: () => boolean;
    /** WakeArgs 组装所需:env/signal 之外的字段 */
    buildWakeArgs: (model: Model<Api>, context: TranscriptContext) => Omit<WakeArgs, 'flow' | 'signal'>;
    /** 引擎中断信号(宿主 Esc → options.signal) */
    signalOf: (options: SimpleStreamOptions | undefined) => AbortSignal | undefined;
    /**
     * 宿主标题生成请求改道:titleModel(provider/id)→ 已解析 Model;
     * 返回 undefined(未配置/解析失败)→ 标题请求照旧走工作流。
     */
    resolveTitleModel?: () => Model<Api> | undefined;
    /** 唤醒成功回调(index 写回 lastOutput → WakeContext.lastOutput;M6 记账也挂这里) */
    onWakeOk?: (modelId: string, hostSessionId: string, text: string) => void;
    /** 终止性错误出口(console) */
    logError?: (msg: string) => void;
}

/** 空起始 AssistantMessage(docs/30 §2.3) */
function emptyMessage(model: Model<Api>): AssistantMessage {
    return {
        role: 'assistant',
        content: [],
        api: 'pi-agents-virtual' as Api,
        provider: 'pi-workflows',
        model: model.id,
        usage: { ...ZERO_USAGE },
        stopReason: 'pending',
        timestamp: Date.now(),
    };
}

/** 错误消息(docs/30 §2.6) */
function errorMessage(model: Model<Api>, text: string, timestamp: number): AssistantMessage {
    return {
        role: 'assistant',
        content: [],
        api: 'pi-agents-virtual' as Api,
        provider: 'pi-workflows',
        model: model.id,
        usage: { ...ZERO_USAGE },
        stopReason: 'error',
        errorMessage: text,
        timestamp,
    };
}

/** 占位 toolCall id(全局唯一:随机段 + 单调序号;重启不撞) */
const RUN_ID = Math.random().toString(36).slice(2, 8);
let toolCallSeq = 0;
function nextToolCallId(): string {
    return `agents-${RUN_ID}-${toolCallSeq++}`;
}

/** 尾部 toolResult 的 toolCallId(续跑识别;无 → undefined) */
function tailToolCallId(context: TranscriptContext): string | undefined {
    for (let i = context.messages.length - 1; i >= 0; i--) {
        const m = context.messages[i] as { role?: string; toolCallId?: string } | undefined;
        if (!m) continue;
        if (m.role === 'toolResult') return m.toolCallId;
        if (m.role === 'assistant' || m.role === 'user') return undefined;
    }
    return undefined;
}

/* ------------------------------------------------------------------ */
/*  PendingRun(M10 §6.2):跨续跑的工作流执行缓冲                        */
/* ------------------------------------------------------------------ */

interface PendingRun {
    model: Model<Api>;
    startedAt: number;
    settled: boolean;
    finalText?: string;
    error?: { aborted: boolean; message: string };
    usageFlush?: () => void;
    hostSessionId: string;
    wakeIndex: number;
    onAgentEvent?: (frame: AgentFrame) => void;
    onWakeOk?: (modelId: string, hostSessionId: string, text: string) => void;
    signal?: AbortSignal;
    wakeArgs: Omit<WakeArgs, 'flow' | 'signal'>;
    segmenter: FlowSegmenter;
    /** 已产出但尚未推送的段边界事件(feed 返回值缓冲) */
    buffer: SegmentEvent[];
    /** 本 run 已注册续跑键的全部占位 toolCall id(收口后精确清理) */
    registeredIds: string[];
    /** 工作流落定后的终点节点名(纠偏比对用;ok 时有值) */
    terminal?: string;
}

/** toolCallId → PendingRun(续跑注册表);wake-end/error 清理 */
const pendingRuns = new Map<string, PendingRun>();

/** 测试钩子:清空注册表 */
export function resetPendingRunsForTest(): void {
    pendingRuns.clear();
}

export function createStreamSimple(deps: StreamDeps) {
    /**
     * streamSimple(model, context, options) → AssistantMessageEventStream
     * 同步返回流;异步任务立刻启动(docs/30 §2.1)。
     */
    return function streamVirtualWorkflow(
        model: Model<Api>,
        context: TranscriptContext,
        options?: SimpleStreamOptions,
    ): AssistantMessageEventStream {
        const stream = createAssistantMessageEventStream();

        // 宿主标题生成请求改道(pi-web sessionNameGenerator):配置了 titleModel 时
        // 不唤醒工作流,直接用该真实模型完成标题生成(否则每个新会话都会空跑一遍完整图)
        if (
            deps.resolveTitleModel !== undefined &&
            context.messages.some(
                (m) => m.role === 'system' && (getSystemMessageText(m) ?? '').includes(TITLE_PROMPT_MARKER),
            )
        ) {
            const titleModel = deps.resolveTitleModel();
            if (titleModel) return compatStreamSimple(titleModel, context, options);
        }

        const signal = deps.signalOf(options);
        const base = emptyMessage(model);
        const flow = deps.flowByName.get(model.id);
        const startedAt = Date.now();

        // 注册表只在装载/重载时重建,model.id 必命中;防御性错误流
        if (!flow) {
            stream.push({ type: 'start', partial: base });
            stream.push({
                type: 'error',
                reason: 'error',
                error: errorMessage(model, `工作流 "${model.id}" 未注册(可能已失效,请 /reload)`, base.timestamp),
            });
            stream.end();
            return stream;
        }

        /* ---------- 续跑:占位 toolCallId 找回 PendingRun ---------- */
        const tailId = tailToolCallId(context);
        if (tailId !== undefined) {
            const run = pendingRuns.get(tailId);
            if (!run) {
                stream.push({ type: 'start', partial: base });
                stream.push({
                    type: 'error',
                    reason: 'error',
                    error: errorMessage(
                        model,
                        '工作流续跑上下文缺失(服务重启/会话已被回收),请重新发起请求',
                        base.timestamp,
                    ),
                });
                stream.end();
                return stream;
            }
            // 续跑也是一条独立 assistant 消息:start 最先(docs/30 §2.1)
            stream.push({ type: 'start', partial: base });
            streamPushBatch(stream, model, base, run, signal, false);
            return stream;
        }
        /* ---------- 首调:启动 BufferedRun ---------- */
        let wakeArgs: Omit<WakeArgs, 'flow' | 'signal'>;
        try {
            wakeArgs = deps.buildWakeArgs(model, context);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            stream.push({ type: 'start', partial: base });
            stream.push({
                type: 'error',
                reason: 'error',
                error: errorMessage(model, msg, base.timestamp),
            });
            stream.end();
            return stream;
        }

        const run: PendingRun = {
            model,
            startedAt,
            settled: false,
            usageFlush: wakeArgs.usageFlush,
            hostSessionId: wakeArgs.hostSessionId ?? '',
            wakeIndex: wakeArgs.wakeIndex,
            onAgentEvent: wakeArgs.env.onAgentEvent,
            onWakeOk: deps.onWakeOk,
            signal,
            wakeArgs,
            segmenter: new FlowSegmenter(nextToolCallId),
            buffer: [],
            registeredIds: [],
        };

        const segmenter = run.segmenter;
        const prefixes = deps.streamPrefixes();
        const mapNodeEvent = (ev: NodeEvent): void => {
            if (run.settled) return;
            // feed 返回本次喂入产生的段事件;边界段(endsWithToolCall)注册续跑键
            const out = segmenter.feed(ev, { prefixes });
            for (const e of out) {
                if (e.type === 'segment-end' && e.segment.endsWithToolCall) {
                    const call = e.segment.blocks.find((b) => b.type === 'toolCall');
                    if (call && call.type === 'toolCall') {
                        pendingRuns.set(call.id, run);
                        run.registeredIds.push(call.id);
                    }
                }
                run.buffer.push(e);
            }
        };

        const onThinkingLine = (line: string): void => {
            if (!run.settled) segmenter.pushStatusLine(line);
        };

        void (async () => {
            stream.push({ type: 'start', partial: { ...base } });
            let outcome: WakeOutcome;
            try {
                const agentEmit = run.wakeArgs.env.onAgentEvent;
                agentEmit?.(wakeStartFrame(run.hostSessionId, run.wakeIndex, model.id, lastUserText(context.messages)));
                outcome = await wakeFlow({
                    ...wakeArgs,
                    flow,
                    signal,
                    env: { ...wakeArgs.env, onThinking: onThinkingLine, onNodeEvent: mapNodeEvent },
                });
                if (outcome.ok) {
                    agentEmit?.(wakeEndFrame(run.wakeIndex, 'completed', outcome.result.text));
                } else {
                    agentEmit?.(
                        wakeEndFrame(run.wakeIndex, outcome.aborted ? 'aborted' : 'failed', outcome.error.message),
                    );
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                run.wakeArgs.env.onAgentEvent?.(wakeEndFrame(run.wakeIndex, 'failed', msg));
                deps.logError?.(`[pi-agents] 工作流 "${flow.name}" 未捕获异常: ${msg}`);
                outcome = { ok: false, aborted: signal?.aborted ?? false, error: new Error(msg) };
            }

            // 落定:闭合尾部未收口段(末 text 段);finish 产出进 buffer 供收尾推送
            const trailing = segmenter.finish();
            if (trailing) {
                run.buffer.push({ type: 'segment-end', segment: trailing });
            }

            // 先落数据再置 settled(推段循环观察到 settled 时数据已就绪)
            if (outcome.ok) {
                run.finalText = outcome.result.text;
                run.terminal = outcome.result.terminal;
            } else {
                run.error = { aborted: outcome.aborted, message: outcome.error.message };
            }
            run.settled = true;
            if (outcome.ok) {
                try {
                    run.usageFlush?.();
                } catch (e) {
                    deps.logError?.(`[pi-agents] 用量 entry 写入失败: ${e instanceof Error ? e.message : String(e)}`);
                }
                run.onWakeOk?.(model.id, run.hostSessionId, outcome.result.text);
            }
            // 精确清理本 run 的续跑键(工作流已落定,不再接受续跑)
            for (const id of run.registeredIds) pendingRuns.delete(id);
        })();

        streamPushBatch(stream, model, base, run, signal, true);
        return stream;
    };
}

/* ------------------------------------------------------------------ */
/*  段批量推送(M10 §6.3)                                              */
/* ------------------------------------------------------------------ */

/**
 * 段批量推送:循环取 buffer,遇 toolUse 边界或落定收口。
 * first=true 时等第一个边界;续跑(false)从缓冲直接继续。
 */
function streamPushBatch(
    stream: ReturnType<typeof createAssistantMessageEventStream>,
    model: Model<Api>,
    base: AssistantMessage,
    run: PendingRun,
    signal: AbortSignal | undefined,
    _first: boolean,
): void {
    void (async () => {
        const pushed: FlowSegment[] = [];
        // 实时流状态:已产出块(供 partial 投影)+ 当前打开块
        const live: ContentBlock[] = [];
        let openType: 'thinking' | 'text' | null = null;
        let boundary: FlowSegment | null = null;
        const partial = () => ({ ...base, content: [...live] }) as AssistantMessage;
        const closeOpen = () => {
            if (!openType) return;
            const idx = live.length - 1;
            const block = live[idx]!;
            stream.push(
                openType === 'thinking'
                    ? {
                          type: 'thinking_end',
                          contentIndex: idx,
                          content: (block as { thinking: string }).thinking,
                          partial: partial(),
                      }
                    : {
                          type: 'text_end',
                          contentIndex: idx,
                          content: (block as { text: string }).text,
                          partial: partial(),
                      },
            );
            openType = null;
        };
        while (boundary === null) {
            // 消费分段器事件:delta 实时转发;segment-end 收口(_end + 占位工具块)
            for (const ev of run.buffer.splice(0)) {
                if (ev.type === 'thinking-delta') {
                    if (openType !== 'thinking') {
                        closeOpen();
                        live.push({ type: 'thinking', thinking: '' });
                        stream.push({ type: 'thinking_start', contentIndex: live.length - 1, partial: partial() });
                        openType = 'thinking';
                    }
                    (live[live.length - 1] as { thinking: string }).thinking += ev.delta;
                    stream.push({
                        type: 'thinking_delta',
                        contentIndex: live.length - 1,
                        delta: ev.delta,
                        partial: partial(),
                    });
                } else if (ev.type === 'text-delta') {
                    if (openType !== 'text') {
                        closeOpen();
                        live.push({ type: 'text', text: '' });
                        stream.push({ type: 'text_start', contentIndex: live.length - 1, partial: partial() });
                        openType = 'text';
                    }
                    (live[live.length - 1] as { text: string }).text += ev.delta;
                    stream.push({
                        type: 'text_delta',
                        contentIndex: live.length - 1,
                        delta: ev.delta,
                        partial: partial(),
                    });
                } else if (ev.type === 'segment-end') {
                    closeOpen();
                    pushed.push(ev.segment);
                    for (const block of ev.segment.blocks) {
                        if (block.type !== 'toolCall') continue;
                        live.push(block as ContentBlock);
                        const idx = live.length - 1;
                        stream.push({ type: 'toolcall_start', contentIndex: idx, partial: partial() });
                        stream.push({
                            type: 'toolcall_delta',
                            contentIndex: idx,
                            delta: JSON.stringify(block.arguments),
                            partial: partial(),
                        });
                        stream.push({
                            type: 'toolcall_end',
                            contentIndex: idx,
                            toolCall: block as never,
                            partial: partial(),
                        });
                    }
                    if (ev.segment.endsWithToolCall) {
                        boundary = ev.segment;
                        break;
                    }
                }
            }
            if (boundary) break;
            if (run.settled) break;
            if (signal?.aborted) break;
            await sleep(20);
        }
        closeOpen();
        if (signal?.aborted && !boundary) {
            stream.push({ type: 'error', reason: 'aborted', error: errorMessage(model, '已中断', base.timestamp) });
            stream.end();
            return;
        }
        if (!boundary && run.settled && run.error) {
            stream.push({
                type: 'error',
                reason: run.error.aborted ? 'aborted' : 'error',
                error: errorMessage(model, run.error.message, base.timestamp),
            });
            stream.end();
            return;
        }

        if (boundary) {
            // 边界消息 content = 本批已推段(边界段已在 pushed 末尾;工具调用前的思考/文本都要在 transcript);
            // §3.1 纠偏:边界后必有续跑 → 本批 text 块非最终回答,全部降为 thinking
            const msg = messageFor(base, pushed.map(downgradeSegmentTexts), Date.now(), Date.now() - run.startedAt);
            stream.push({ type: 'done', reason: 'toolUse', message: msg });
            stream.end(msg);
            return; // PendingRun 保留(注册键未清),等续跑
        }

        // 落定收尾:content = 本批全部段内容(去 toolCall)+ 终点 text;
        // §3.1 纠偏:非终点节点的 text 降为 thinking(与边界批同规则,但终点节点保留)
        const finalText = run.finalText ?? '';
        const finalMsg: AssistantMessage = {
            ...base,
            content: buildFinalContent(pushed, finalText, run.terminal),
            stopReason: 'stop',
            timestamp: Date.now(),
            durationMs: Date.now() - run.startedAt,
        };
        stream.push({ type: 'done', reason: 'stop', message: finalMsg });
        stream.end(finalMsg);
    })();
}

/** 消息组装(toolUse 边界):content = 本批全部段块 */
function messageFor(
    base: AssistantMessage,
    segs: FlowSegment[],
    timestamp: number,
    durationMs: number,
): AssistantMessage {
    return {
        ...base,
        content: segs.flatMap((s) => s.blocks) as ContentBlock[],
        stopReason: 'toolUse',
        timestamp,
        durationMs,
    };
}

/**
 * §3.1 收口纠偏:工具边界批的 text 块降级为 thinking。
 * 流式期间按 text 推(观感优先),收口消息里转 thinking——边界后必有续跑,
 * 这些文本不可能是最终回答。与旧 M4 纠偏同源,但仅作用于消息组装层,不重发事件。
 */
function downgradeSegmentTexts(seg: FlowSegment): FlowSegment {
    if (!seg.blocks.some((b) => b.type === 'text')) return seg;
    return {
        ...seg,
        blocks: seg.blocks.map((b) => (b.type === 'text' ? { type: 'thinking' as const, thinking: b.text } : b)),
    };
}

/** 最终 content:本批全部段(去 toolCall);非终点 text 降 thinking;无 text 块时补终点文本 */
function buildFinalContent(segs: FlowSegment[], finalText: string, terminal: string | undefined): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const seg of segs) {
        for (const b of seg.blocks) {
            if (b.type === 'toolCall') continue; // 占位调用最终消息不携带(宿主已执行)
            if (b.type === 'text' && terminal !== undefined && !seg.textNodeKeys.has(terminal)) {
                // §3.1 纠偏:本段 text 来自非终点节点 → thinking
                out.push({ type: 'thinking', thinking: b.text });
                continue;
            }
            out.push(b as ContentBlock);
        }
    }
    // 终点段已流式输出时内容即 outcome.text(同一来源);仅无任何 text 块(fn 工作流/
    // 快速完成/终点 outputVisible=false 全程 thinking)时补一条,保证回答非空。
    // 后者正是「不可见终点直到结束才一次性产生最终文本」的实现点。
    if (!out.some((b) => b.type === 'text')) out.push({ type: 'text', text: finalText });
    return out;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** 末条 user 消息文本(wake-start inputPreview 用;取 text 块拼接) */
function lastUserText(messages: readonly unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown } | undefined;
        if (m?.role !== 'user') continue;
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
            return c
                .map((b) =>
                    typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text'
                        ? String((b as { text?: string }).text ?? '')
                        : '',
                )
                .filter(Boolean)
                .join('\n');
        }
        return '';
    }
    return '';
}

/** WakeOutcome 类型再导出(index 接线用) */
export type { WakeArgs, WakeOutcome };
export type { PlaceholderToolCall };
