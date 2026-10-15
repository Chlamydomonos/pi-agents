/**
 * M3 session 层单元测试:会话池 / 唤醒输入提取 / streamSimple 事件序列。
 * 真实子会话(createAgentSession)不进单测——由 smoke/手工验收覆盖;
 * 这里注入假 create 与假引擎路径。
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEvent } from '@earendil-works/pi-ai';
import { SessionPool } from '../src/extension/session/pool.js';
import { extractWakeInput, projectHostView } from '../src/extension/session/runtime.js';
import type { WakeArgs, WakeOutcome } from '../src/extension/session/runtime.js';
import { createStreamSimple } from '../src/extension/session/stream.js';
import { resetPendingRunsForTest } from '../src/extension/session/stream.js';
import type { StreamDeps } from '../src/extension/session/stream.js';
import type { FlowDefinition, WakeContext } from '../src/extension/types.js';
import { AbortedError } from '../src/extension/session/run-node.js';
import type { NodeEvent } from '../src/extension/session/stream-events.js';

// M4 映射测试用:runtime 模块级 mock,wakeFlow 由 wakeFlowMock 变量接管(未设时走真实行为报错)
let wakeFlowMock: ((args: WakeArgs) => Promise<WakeOutcome>) | null = null;
vi.mock('../src/extension/session/runtime.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/extension/session/runtime.js')>();
    return {
        ...actual,
        wakeFlow: (args: WakeArgs) => {
            if (!wakeFlowMock) throw new Error('wakeFlowMock 未设置');
            return wakeFlowMock(args);
        },
    };
});

/* ------------------------------------------------------------------ */
/*  会话池(docs/40 §3)                                                 */
/* ------------------------------------------------------------------ */

function fakeSession() {
    let aborted = 0;
    let disposed = 0;
    return {
        session: {
            abort: async () => {
                aborted++;
            },
            dispose: () => {
                disposed++;
            },
        } as never,
        state: {
            get aborted() {
                return aborted;
            },
            get disposed() {
                return disposed;
            },
        },
    };
}

describe('SessionPool', () => {
    it('acquire:identity 相同 → 复用;不同 → 弃旧建新', async () => {
        const pool = new SessionPool();
        const a = fakeSession();
        const b = fakeSession();
        const created: unknown[] = [];
        const create = async (s: { session: { abort: () => Promise<void>; dispose: () => void } }) => {
            created.push(s.session);
            return { session: s.session as never, sessionManager: {} as never };
        };

        const n1 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'main',
            hostSessionId: 'h1',
            identity: 'agent:fresh@h1:1',
            wakeIndex: 1,
            create: () => create(a),
        });
        const n2 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'main',
            hostSessionId: 'h1',
            identity: 'agent:fresh@h1:1',
            wakeIndex: 1,
            create: () => create(b),
        });
        expect(n1).toBe(n2);
        expect(created).toHaveLength(1);

        // 跨唤醒(fresh identity 变化)→ 弃旧建新
        const n3 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'main',
            hostSessionId: 'h1',
            identity: 'agent:fresh@h1:2',
            wakeIndex: 2,
            create: () => create(b),
        });
        expect(n3).not.toBe(n1);
        expect(created).toHaveLength(2);
        expect(a.state.aborted).toBe(1);
        expect(a.state.disposed).toBe(1);
    });

    it('不同节点/不同宿主互不干扰(键空间)', async () => {
        const pool = new SessionPool();
        const create = async () => ({ session: {} as never, sessionManager: {} as never });
        const n1 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'a',
            hostSessionId: 'h1',
            identity: 'i',
            wakeIndex: 1,
            create,
        });
        const n2 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'b',
            hostSessionId: 'h1',
            identity: 'i',
            wakeIndex: 1,
            create,
        });
        const n3 = await pool.acquire({
            flowName: 'f',
            nodeKey: 'a',
            hostSessionId: 'h2',
            identity: 'i',
            wakeIndex: 1,
            create,
        });
        expect(n1 === n2 || n1 === n3 || n2 === n3).toBe(false);
    });

    it('evict/disposeAll:幂等、防泄漏', async () => {
        const pool = new SessionPool();
        const s = fakeSession();
        await pool.acquire({
            flowName: 'f',
            nodeKey: 'main',
            hostSessionId: 'h1',
            identity: 'agent:inherit',
            wakeIndex: 1,
            create: async () => ({ session: s.session, sessionManager: {} as never }),
        });
        // 命中(identity 相同)→ 复用不重建
        await pool.acquire({
            flowName: 'f',
            nodeKey: 'main',
            hostSessionId: 'h1',
            identity: 'agent:inherit',
            wakeIndex: 2,
            create: async () => {
                throw new Error('不应重建');
            },
        });

        await pool.evict('f', 'main', 'h1');
        expect(s.state.aborted).toBe(1);
        await pool.disposeAll();
        expect(s.state.aborted).toBe(1); // evict 已删,disposeAll 幂等
    });
});

/* ------------------------------------------------------------------ */
/*  唤醒输入提取(§4.1)                                             */
/* ------------------------------------------------------------------ */

function userMsg(text: string, images = 0): AgentMessage {
    const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: 'text', text }];
    for (let i = 0; i < images; i++) content.push({ type: 'image', data: 'aGk=', mimeType: 'image/png' });
    return { role: 'user', content, timestamp: 0 } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
    return {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        timestamp: 0,
    } as unknown as AgentMessage;
}

describe('extractWakeInput', () => {
    const LIMITS = { maxWakeImages: 4, maxImageBytes: 2 * 1024 * 1024, maxNodeImages: 8 };

    it('末条 user 消息;图片占位并进 images 通道;忽略 assistant/system', () => {
        const msgs: AgentMessage[] = [
            { role: 'system', content: 'sys' } as unknown as AgentMessage,
            userMsg('早先前的问题'),
            assistantMsg('早先的回答'),
            userMsg('本次输入', 2),
        ];
        const r = extractWakeInput(msgs, LIMITS);
        expect(r.text).toBe('本次输入\n[图片 x2]');
        expect(r.images).toHaveLength(2);
        expect(r.droppedCount).toBe(0);
        expect(r.droppedBytes).toBe(0);
    });

    it('超 maxWakeImages 丢尾图;文本仍带全部张数占位', () => {
        const msgs: AgentMessage[] = [userMsg('看图', 6)];
        const r = extractWakeInput(msgs, LIMITS);
        expect(r.images).toHaveLength(4);
        expect(r.droppedCount).toBe(2);
        expect(r.text).toBe('看图\n[图片 x6]');
    });

    it('无 user → text null、images 空;纯空文本(无图)→ null', () => {
        expect(extractWakeInput([assistantMsg('只有回答')], LIMITS).text).toBeNull();
        expect(extractWakeInput([userMsg('   ')], LIMITS).text).toBeNull();
        // 纯图片无文字:文本为 "[图片 xN]" 占位,非 null(§4.1)
        const r = extractWakeInput([userMsg('', 1)], LIMITS);
        expect(r.text).toBe('[图片 x1]');
        expect(r.images).toHaveLength(1);
    });
});

/*  streamSimple 事件序列(docs/30 §2)                                   */
/* ------------------------------------------------------------------ */

function flow(name: string): FlowDefinition {
    return {
        name,
        title: name,
        description: 't',
        nodes: { main: { agent: 'a' } },
        entry: 'main',
        edges: {},
    };
}

function deps(overrides: Partial<StreamDeps> & { outcome?: 'ok' | 'aborted' | 'error' | 'throw' }): StreamDeps {
    const wake: WakeContext = { input: 'in', images: [], hostSessionId: 'h', wakeIndex: 1 };
    void overrides;
    return {
        flowByName: new Map([['notes', flow('notes')]]),
        streamPrefixes: () => true,
        buildWakeArgs: () => ({
            hostMessages: [userMsg('in')],
            wakeIndex: 1,
            hostSessionId: 'h',
            env: {} as never,
        }),
        signalOf: () => undefined,
    };
}

/** 注入 NodeEvent 序列的映射测试:mock runtime.wakeFlow,脚本内直呼 stream 的 onNodeEvent */
async function runMappedStream(
    script: (emit: (ev: NodeEvent) => void) => void,
    finalText: string,
    opts: { prefixes?: boolean; terminal?: string } = {},
): Promise<AssistantMessageEvent[]> {
    wakeFlowMock = async (args) => {
        const emit = (ev: NodeEvent) => args.env.onNodeEvent?.(ev);
        script(emit);
        return {
            ok: true,
            result: { text: finalText, terminal: opts.terminal ?? 'main', trail: [] },
            wake: { input: 'in', images: [], hostSessionId: args.hostSessionId, wakeIndex: args.wakeIndex },
        };
    };
    try {
        const d = deps({});
        d.streamPrefixes = () => opts.prefixes ?? true;
        const stream = createStreamSimple(d)({ id: 'notes' } as never, { messages: [userMsg('in')] } as never);
        return await collect(stream);
    } finally {
        wakeFlowMock = null;
    }
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
    const events: AssistantMessageEvent[] = [];
    for await (const e of stream) events.push(e);
    return events;
}

/** 事件序列守卫: start 首位;done/error 恰一个且在末位 */
function assertEventShape(events: AssistantMessageEvent[]): { type: string }[] {
    expect(events[0]?.type).toBe('start');
    const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe(terminal[0]!.type);
    // 每个 text/thinking delta 都有对应 _end(docs/30 §2 简化校验)
    for (const kind of ['text', 'thinking'] as const) {
        expect(events.filter((e) => e.type === `${kind}_delta`).length > 0).toBe(
            events.some((e) => e.type === `${kind}_end`),
        );
    }
    return events.map((e) => ({ type: e.type }));
}

describe('projectHostView(函数节点 ctx.host,docs/20 §2.2)', () => {
    it('投影 role/content;不透传其余字段', () => {
        const msgs: AgentMessage[] = [userMsg('u1'), assistantMsg('a1'), userMsg('u2', 2)];
        const view = projectHostView(msgs, { hostSessionId: 'h1', wakeIndex: 2, input: 'u2' }, '上一轮输出');
        expect(view.sessionId).toBe('h1');
        expect(view.wakeIndex).toBe(2);
        expect(view.lastInput).toBe('u2');
        expect(view.lastOutput).toBe('上一轮输出');
        expect(view.messages).toHaveLength(3);
        // userMsg 辅助产块数组 content:content 原样透传(pi-ai 块形态)
        expect(view.messages[0]).toMatchObject({
            role: 'user',
            content: [{ type: 'text', text: 'u1' }],
        });
        // 投影仅保留 role/content(作者侧不透明);timestamp 等宿主内部字段不透传
        expect(Object.keys(view.messages[0] as object).sort()).toEqual(['content', 'role']);
        // user 消息带图片块时 content 为块数组,原样透传
        expect(Array.isArray(view.messages[2]?.content)).toBe(true);
    });

    it('无 lastOutput → 字段缺省;空历史 → messages []', () => {
        const view = projectHostView([], { hostSessionId: 'h', wakeIndex: 1, input: 'x' });
        expect('lastOutput' in view).toBe(false);
        expect(view.messages).toEqual([]);
    });
});

describe('streamSimple', () => {
    it('未知工作流 → 同步错误流', async () => {
        const d = deps({ outcome: 'error' });
        const stream = createStreamSimple(d)({ id: 'nope' } as never, { messages: [] } as never);
        const events = await collect(stream);
        const types = assertEventShape(events);
        expect(types).toEqual([{ type: 'start' }, { type: 'error' }]);
        const err = events.find((e) => e.type === 'error') as { reason: string };
        expect(err.reason).toBe('error');
    });

    it('wakeFlow 未捕获异常(宿主约定)→ error 流不抛出', async () => {
        const d = deps({ outcome: 'throw' });
        (d as { buildWakeArgs: unknown }).buildWakeArgs = () => {
            throw new Error('boom');
        };
        const stream = createStreamSimple(d)({ id: 'notes' } as never, { messages: [] } as never);
        const events = await collect(stream);
        const types = assertEventShape(events);
        expect(types[types.length - 1]).toEqual({ type: 'error' });
    });

    it('M10 §6 事件映射:段内前缀+thinking;占位 toolcall 边界切分出 toolUse done', async () => {
        const events = await runMappedStream((emit) => {
            // Agent 节点「main #1」:thinking → 占位工具(段边界)
            emit({ kind: 'node-start', nodeKey: 'main', label: 'main', visit: 1, isAgent: true });
            emit({ kind: 'thinking-delta', sourceKey: 'main#1', sourceLabel: 'main', delta: '思考中' });
            emit({
                kind: 'tool-call',
                sourceKey: 'main#1',
                sourceLabel: 'main',
                toolCall: { agent: 'main', tool: 'read', arguments: { path: 'a.txt' }, truncated: false },
            });
        }, '答案');
        const types = assertEventShape(events);

        // done = toolUse(段以占位 toolCall 收尾;宿主将执行并续跑)
        const done = events.find((e) => e.type === 'done') as {
            reason: string;
            message: { content: Array<{ type: string }> };
        };
        expect(done.reason).toBe('toolUse');

        // 前缀插一次(§3.2),在 thinking 开头(块整体推送:前缀+内容同一 delta)
        const allThinking = events
            .filter((e) => e.type === 'thinking_delta')
            .map((e) => (e as { delta: string }).delta)
            .join('');
        expect(allThinking.startsWith('【main #1】\n')).toBe(true);
        expect(allThinking).toContain('思考中');

        // 占位 toolcall 三连,arguments = {agent, tool, arguments}(§4.2)
        const tcStart = events.filter((e) => e.type === 'toolcall_start');
        expect(tcStart).toHaveLength(1);
        const tcEnd = events.find((e) => e.type === 'toolcall_end') as {
            toolCall: { name: string; arguments: unknown };
        };
        expect(tcEnd.toolCall.name).toBe('agents_tool');
        expect(tcEnd.toolCall.arguments).toEqual({
            agent: 'main',
            tool: 'read',
            arguments: { path: 'a.txt' },
        });

        // 边界消息 content = [thinking, toolCall](text 无 → 终点 text 只在最终消息)
        expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'toolCall']);
    });

    it('M10 §6:中间节点 text 保留;终点段流式文本即回答', async () => {
        const events = await runMappedStream(
            (emit) => {
                // 节点 main 输出「中间产物」(无工具)→ 新节点 final 流式输出终点文本
                emit({ kind: 'node-start', nodeKey: 'main', label: 'main', visit: 1, isAgent: true });
                emit({
                    kind: 'text-delta',
                    sourceKey: 'main#1',
                    sourceLabel: 'main',
                    delta: '中间产物',
                    isTerminal: true,
                    nodeKey: 'main',
                });
                emit({ kind: 'node-start', nodeKey: 'final', label: 'final', visit: 1, isAgent: true });
                emit({
                    kind: 'text-delta',
                    sourceKey: 'final#1',
                    sourceLabel: 'final',
                    delta: '最终答案',
                    isTerminal: true,
                    nodeKey: 'final',
                });
            },
            '最终答案',
            { terminal: 'final' },
        );
        assertEventShape(events);

        // §3.1 纠偏语义:中间节点 text 降为 thinking;终点 text 保留(唯一)
        const done = events.find((e) => e.type === 'done') as {
            message: { content: Array<{ type: string; text?: string; thinking?: string }> };
        };
        const textBlocks = done.message.content.filter((b) => b.type === 'text');
        expect(textBlocks).toHaveLength(1);
        expect(textBlocks[0]?.text).toBe('最终答案');
        const thinkingTexts = done.message.content
            .filter((b) => b.type === 'thinking')
            .map((b) => (b as { thinking?: string }).thinking ?? '');
        expect(thinkingTexts.join('')).toContain('中间产物');

        // 前缀行进段 thinking
        const allThinking = events
            .filter((e) => e.type === 'thinking_delta')
            .map((e) => (e as { delta: string }).delta)
            .join('');
        expect(allThinking).toContain('【main #1】');
        expect(allThinking).toContain('【final #1】');
    });

    it('M4 §3.2:streamPrefixes 关闭 → 无前缀', async () => {
        const events = await runMappedStream(
            (emit) => {
                emit({ kind: 'node-start', nodeKey: 'main', label: 'main', visit: 1, isAgent: true });
                emit({ kind: 'thinking-delta', sourceKey: 'main#1', sourceLabel: 'main', delta: '思' });
            },
            '答',
            { prefixes: false },
        );
        assertEventShape(events);
        const all = events.map((e) => JSON.stringify(e)).join('');
        expect(all).not.toContain('【main #1】');
    });

    it('M10 §6:多节点各自成段,段间以 node-start 切分', async () => {
        const events = await runMappedStream(
            (emit) => {
                emit({ kind: 'node-start', nodeKey: 'a', label: 'a', visit: 1, isAgent: true });
                emit({
                    kind: 'text-delta',
                    sourceKey: 'a#1',
                    sourceLabel: 'a',
                    delta: 'A输出',
                    isTerminal: true,
                    nodeKey: 'a',
                });
                emit({ kind: 'node-start', nodeKey: 'b', label: 'b', visit: 1, isAgent: true });
                emit({
                    kind: 'text-delta',
                    sourceKey: 'b#1',
                    sourceLabel: 'b',
                    delta: 'B输出',
                    isTerminal: true,
                    nodeKey: 'b',
                });
            },
            'B输出',
            { terminal: 'b' },
        );
        assertEventShape(events);

        // done content:§3.1 纠偏 — 非终点(a)降 thinking,终点(b)保留为唯一 text
        const done = events.find((e) => e.type === 'done') as {
            message: { content: Array<{ type: string; text?: string; thinking?: string }> };
        };
        const texts = done.message.content.filter((b) => b.type === 'text').map((b) => b.text);
        expect(texts).not.toContain('A输出');
        expect(texts[texts.length - 1]).toBe('B输出');
        const thinkingAll = done.message.content
            .filter((b) => b.type === 'thinking')
            .map((b) => (b as { thinking?: string }).thinking ?? '')
            .join('');
        expect(thinkingAll).toContain('A输出');

        // 两节点前缀行齐备
        const allThinking = events
            .filter((e) => e.type === 'thinking_delta')
            .map((e) => (e as { delta: string }).delta)
            .join('');
        expect(allThinking).toContain('【a #1】');
        expect(allThinking).toContain('【b #1】');
    });

    it('M10 §6:续跑——toolResult.toolCallId 找回 PendingRun,继续推后续段', async () => {
        resetPendingRunsForTest();
        let resume: (() => void) | undefined;
        const resumed = new Promise<void>((r) => {
            resume = r;
        });
        wakeFlowMock = async (args) => {
            const emit = (ev: NodeEvent) => args.env.onNodeEvent?.(ev);
            // 第一批:前缀+thinking → tool-call(边界)
            emit({ kind: 'node-start', nodeKey: 'c', label: '实现', visit: 1, isAgent: true });
            emit({ kind: 'thinking-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '先想' });
            emit({
                kind: 'tool-call',
                sourceKey: 'c#1',
                sourceLabel: '实现',
                toolCall: { agent: '实现', tool: 'write', arguments: { path: 'a.txt' }, truncated: false },
            });
            // 等宿主续跑再继续(边界暂停点)
            await resumed;
            emit({ kind: 'tool-result', sourceKey: 'c#1', sourceLabel: '实现', line: '✓ write a.txt' });
            emit({ kind: 'text-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '完成', isTerminal: true });
            return {
                ok: true,
                result: { text: '完成', terminal: 'c', trail: [] },
                wake: { input: 'in', images: [], hostSessionId: args.hostSessionId, wakeIndex: args.wakeIndex },
            };
        };
        try {
            const d = deps({});
            // 第一轮:边界消息(toolUse)
            const s1 = createStreamSimple(d)({ id: 'notes' } as never, { messages: [userMsg('in')] } as never);
            const ev1 = await collect(s1);
            const done1 = ev1.find((e) => e.type === 'done') as {
                reason: string;
                message: { content: Array<{ type: string }> };
            };
            expect(done1.reason).toBe('toolUse');
            const tc = done1.message.content.find((b) => b.type === 'toolCall') as unknown as { id: string };
            expect(tc.id).toMatch(/^agents-/);

            // 宿主侧续跑:占位 toolResult 追加进 transcript;放行工作流继续
            const contStream = createStreamSimple(d)(
                { id: 'notes' } as never,
                {
                    messages: [
                        userMsg('in'),
                        {
                            role: 'assistant',
                            content: [{ type: 'toolCall', id: tc.id, name: 'agents_tool', arguments: {} }],
                            stopReason: 'toolUse',
                        },
                        {
                            role: 'toolResult',
                            toolCallId: tc.id,
                            toolName: 'agents_tool',
                            content: [{ type: 'text', text: '占位' }],
                        },
                    ],
                } as never,
            );
            resume?.(); // 工作流继续:发 tool-result/text-delta → 落定
            const ev2 = await collect(contStream);
            const done2 = ev2.find((e) => e.type === 'done') as {
                reason: string;
                message: { content: Array<{ type: string; text?: string }> };
            };
            expect(done2.reason).toBe('stop');
            const allThinking2 = ev2
                .filter((e) => e.type === 'thinking_delta')
                .map((e) => (e as { delta: string }).delta)
                .join('');
            expect(allThinking2).toContain('✓ write a.txt');
            expect(done2.message.content.filter((b) => b.type === 'text').map((b) => b.text)).toContain('完成');
        } finally {
            wakeFlowMock = null;
            resume?.();
        }
    });

    it('M10 §6 + §3.1:边界批 text 收口降 thinking(先流式 text,收口消息纠偏)', async () => {
        resetPendingRunsForTest();
        let resume: (() => void) | undefined;
        const resumed = new Promise<void>((r) => {
            resume = r;
        });
        wakeFlowMock = async (args) => {
            const emit = (ev: NodeEvent) => args.env.onNodeEvent?.(ev);
            emit({ kind: 'node-start', nodeKey: 'a', label: 'a', visit: 1, isAgent: true });
            emit({
                kind: 'text-delta',
                sourceKey: 'a#1',
                sourceLabel: 'a',
                delta: '中间话',
                isTerminal: true,
                nodeKey: 'a',
            });
            emit({
                kind: 'tool-call',
                sourceKey: 'a#1',
                sourceLabel: 'a',
                toolCall: { agent: 'a', tool: 'bash', arguments: {}, truncated: false },
            });
            await resumed;
            emit({
                kind: 'text-delta',
                sourceKey: 'a#1',
                sourceLabel: 'a',
                delta: '终点话',
                isTerminal: true,
                nodeKey: 'a',
            });
            return {
                ok: true,
                result: { text: '终点话', terminal: 'a', trail: [] },
                wake: { input: 'in', images: [], hostSessionId: args.hostSessionId, wakeIndex: args.wakeIndex },
            };
        };
        try {
            const d = deps({});
            const s1 = createStreamSimple(d)({ id: 'notes' } as never, { messages: [userMsg('in')] } as never);
            const ev1 = await collect(s1);
            // 流式期间:'中间话' 按 text_delta 推(观感优先)
            expect(
                ev1
                    .filter((e) => e.type === 'text_delta')
                    .map((e) => (e as { delta: string }).delta)
                    .join(''),
            ).toContain('中间话');
            const done1 = ev1.find((e) => e.type === 'done') as {
                reason: string;
                message: { content: Array<{ type: string; text?: string; thinking?: string }> };
            };
            expect(done1.reason).toBe('toolUse');
            // 收口纠偏:'中间话' 在 toolUse 消息里已是 thinking
            const texts1 = done1.message.content.filter((b) => b.type === 'text').map((b) => b.text);
            expect(texts1).not.toContain('中间话');
            const think1 = done1.message.content
                .filter((b) => b.type === 'thinking')
                .map((b) => (b as { thinking?: string }).thinking ?? '')
                .join('');
            expect(think1).toContain('中间话');
            const tc = done1.message.content.find((b) => b.type === 'toolCall') as unknown as { id: string };

            // 续跑:终点文本保留 text
            const contStream = createStreamSimple(d)(
                { id: 'notes' } as never,
                {
                    messages: [
                        userMsg('in'),
                        {
                            role: 'assistant',
                            content: [{ type: 'toolCall', id: tc.id, name: 'agents_tool', arguments: {} }],
                            stopReason: 'toolUse',
                        },
                        {
                            role: 'toolResult',
                            toolCallId: tc.id,
                            toolName: 'agents_tool',
                            content: [{ type: 'text', text: '占位' }],
                        },
                    ],
                } as never,
            );
            resume?.();
            const ev2 = await collect(contStream);
            const done2 = ev2.find((e) => e.type === 'done') as {
                reason: string;
                message: { content: Array<{ type: string; text?: string }> };
            };
            expect(done2.reason).toBe('stop');
            expect(done2.message.content.filter((b) => b.type === 'text').map((b) => b.text)).toContain('终点话');
        } finally {
            wakeFlowMock = null;
            resume?.();
        }
    });

    it('M10 §6 + §3.1:终点 outputVisible=false — 全程 thinking,落定一次性出最终文本', async () => {
        const events = await runMappedStream(
            (emit) => {
                emit({ kind: 'node-start', nodeKey: 't', label: 't', visit: 1, isAgent: true });
                emit({
                    kind: 'text-delta',
                    sourceKey: 't#1',
                    sourceLabel: 't',
                    delta: '秘密结果',
                    isTerminal: true,
                    outputVisible: false,
                });
            },
            '秘密结果',
            { terminal: 't' },
        );
        assertEventShape(events);
        // 流式期间:'秘密结果' 不以 text_delta 出现(不可见 → thinking 通道)
        const streamedText = events
            .filter((e) => e.type === 'text_delta')
            .map((e) => (e as { delta: string }).delta)
            .join('');
        expect(streamedText).not.toContain('秘密结果');
        const done = events.find((e) => e.type === 'done') as {
            message: { content: Array<{ type: string; text?: string; thinking?: string }> };
        };
        // 落定收口:一次性补最终文本;thinking 里保留原文本
        const texts = done.message.content.filter((b) => b.type === 'text').map((b) => b.text);
        expect(texts).toEqual(['秘密结果']);
        const think = done.message.content
            .filter((b) => b.type === 'thinking')
            .map((b) => (b as { thinking?: string }).thinking ?? '')
            .join('');
        expect(think).toContain('秘密结果');
    });

    it('ask-user 透传:真实 ask_user toolCall 边界(toolUse done;不套 agents_tool)', async () => {
        const events = await runMappedStream((emit) => {
            emit({ kind: 'node-start', nodeKey: 'a', label: '询问', visit: 1, isAgent: true });
            emit({ kind: 'thinking-delta', sourceKey: 'a#1', sourceLabel: '询问', delta: '想想' });
            emit({
                kind: 'ask-user',
                sourceKey: 'a#1',
                sourceLabel: '询问',
                ask: {
                    questions: [
                        { id: 'q1', question: '去哪?' },
                        { id: 'q2', question: '几点?' },
                    ],
                },
            });
        }, '问题已提交');
        const types = assertEventShape(events);

        const done = events.find((e) => e.type === 'done') as {
            reason: string;
            message: { content: Array<{ type: string; name?: string; arguments?: unknown }> };
        };
        expect(done.reason).toBe('toolUse');

        // 真实 ask_user 调用(非 agents_tool 占位):宿主执行 pi-web 本体
        const calls = done.message.content.filter((b) => b.type === 'toolCall');
        expect(calls).toHaveLength(1);
        const call = calls[0] as { name: string; arguments: { questions: unknown[] } };
        expect(call.name).toBe('ask_user');
        expect(call.arguments.questions).toHaveLength(2);
        expect(call.arguments.questions[0]).toEqual({ id: 'q1', question: '去哪?' });
        // 边界消息块序 = [thinking, toolCall]
        expect(done.message.content.map((b) => b.type)).toEqual(['thinking', 'toolCall']);
        void types;
    });
});

describe('AbortedError', () => {
    it('name 与缺省消息', () => {
        const e = new AbortedError();
        expect(e.name).toBe('AbortedError');
        expect(e.message).toBe('用户中断');
    });
});
