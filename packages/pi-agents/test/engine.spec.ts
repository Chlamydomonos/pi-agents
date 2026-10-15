/**
 * 引擎单元测试(M2,docs/60 §4.1):NodeExecutor 注入假执行器,
 * 覆盖 route/maxIterations/maxHops/pass/函数节点/scratch/trail 语义(docs/20 §3-§6,docs/40 §4.3/§5)。
 */
import { describe, expect, it } from 'vitest';
import { FlowError, runFlow } from '../src/extension/engine/runner.js';
import { renderTemplate } from '../src/extension/engine/pass.js';
import type { FlowDefinition, HostSessionView, NodeOutput, WakeContext } from '../src/extension/types.js';

function wake(input = '你好'): WakeContext {
    return { input, images: [], hostSessionId: 'host-1', wakeIndex: 1 };
}

/** 假执行器:按 agent 名返回脚本化输出;记录调用 */
function fakeExecutor(script: Record<string, (input: string, visit: number) => string>) {
    const calls: Array<{ agent: string; input: string; visit: number }> = [];
    const exec = async (
        agentName: string,
        input: string,
        _spec: unknown,
        ctx: { visit: number },
    ): Promise<NodeOutput> => {
        calls.push({ agent: agentName, input, visit: ctx.visit });
        const fn = script[agentName];
        if (!fn) throw new Error(`假执行器缺脚本:${agentName}`);
        return {
            text: fn(input, ctx.visit),
            stats: {
                durationMs: 1,
                llmRequests: 1,
                toolCalls: 0,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        };
    };
    return { exec, calls };
}

function agentFlow(partial: Partial<FlowDefinition>): FlowDefinition {
    return {
        name: 'f',
        title: 'T',
        description: 'D',
        nodes: { a: { agent: 'x' }, b: { agent: 'y' } },
        entry: 'a',
        edges: { a: 'b' },
        ...partial,
    } as FlowDefinition;
}

describe('runFlow 基本路径', () => {
    it('线性两节点:静态边;输出 = 终点文本;trail 顺序正确', async () => {
        const { exec, calls } = fakeExecutor({ x: (i) => `X(${i})`, y: (i) => `Y(${i})` });
        const r = await runFlow(agentFlow({}), wake('hi'), { executeAgentNode: exec });
        expect(r).toMatchObject({ text: 'Y(X(hi))', terminal: 'b' });
        expect(r.trail.map((t) => t.node)).toEqual(['a', 'b']);
        expect(calls.map((c) => c.agent)).toEqual(['x', 'y']);
        expect(calls[1]?.input).toBe('X(hi)'); // text 缺省 pass
    });

    it('route 返回 done:当前节点即终点', async () => {
        const { exec } = fakeExecutor({ x: () => 'first', y: () => 'second' });
        const flow = agentFlow({ edges: { a: { route: () => 'done' } } });
        const r = await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(r).toMatchObject({ text: 'first', terminal: 'a' });
        expect(r.trail).toHaveLength(1);
    });

    it('无出边键 = 终点(单节点工作流,docs/20 §7)', async () => {
        const { exec } = fakeExecutor({ x: (i) => i });
        const flow = agentFlow({ nodes: { a: { agent: 'x' } }, edges: {} });
        const r = await runFlow(flow, wake('solo'), { executeAgentNode: exec });
        expect(r).toMatchObject({ text: 'solo', terminal: 'a' });
    });

    it('initialInput 只加工入口节点(docs/20 §5.3)', async () => {
        const { exec, calls } = fakeExecutor({ x: (i) => `X(${i})`, y: (i) => `Y(${i})` });
        const flow = agentFlow({ initialInput: (w) => `加工:${w.input}` });
        await runFlow(flow, wake('raw'), { executeAgentNode: exec });
        expect(calls[0]?.input).toBe('加工:raw');
        expect(calls[1]?.input).toBe('X(加工:raw)'); // 后续由 pass 决定,不经 initialInput
    });

    it('环 + route done:每次进入 visit 递增;scratch 跨节点共享', async () => {
        const { exec, calls } = fakeExecutor({ x: (i, v) => `X#${v}(${i})`, y: (i) => `Y(${i})` });
        const flow = agentFlow({
            edges: {
                a: 'b',
                b: { route: (out) => (out.text.includes('#2') ? 'done' : 'a') },
            },
        });
        const seenScratch: number[] = [];
        const flow2: FlowDefinition = {
            ...flow,
            nodes: {
                ...flow.nodes,
                a: { agent: 'x' },
                b: { agent: 'y' },
            },
        };
        // 用 route 检查 scratch 共享:首轮写 n=1;次轮读 → push 快照
        const flow3 = {
            ...flow2,
            edges: {
                a: 'b',
                b: {
                    route: (out: { text: string }, ctx: { scratch: Record<string, unknown> }) => {
                        if (ctx.scratch.n === undefined) ctx.scratch.n = 1;
                        else seenScratch.push(ctx.scratch.n as number);
                        return out.text.includes('#2') ? 'done' : 'a';
                    },
                },
            },
        };
        const r = await runFlow(flow3, wake(), { executeAgentNode: exec });
        expect(r.terminal).toBe('b');
        expect(r.trail.map((t) => `${t.node}:${t.visit}`)).toEqual(['a:1', 'b:1', 'a:2', 'b:2']);
        expect(seenScratch).toEqual([1]); // 第二次进入 route 读到首轮写入
        expect(calls.filter((c) => c.agent === 'x').map((c) => c.visit)).toEqual([1, 2]);
    });
});

describe('runFlow 边界与错误流', () => {
    it('route 指向不存在节点 → FlowError 原始消息(docs/20 §3.3)', async () => {
        const { exec } = fakeExecutor({ x: () => 't' });
        const flow = agentFlow({ edges: { a: { route: () => 'ghost' } } });
        await expect(runFlow(flow, wake(), { executeAgentNode: exec })).rejects.toThrow(FlowError);
        await expect(runFlow(flow, wake(), { executeAgentNode: exec })).rejects.toThrow('ghost');
    });

    it('route 抛错 → error 流,原始消息透传', async () => {
        const { exec } = fakeExecutor({ x: () => 't' });
        const flow = agentFlow({
            edges: {
                a: {
                    route: () => {
                        throw new Error('route炸了');
                    },
                },
            },
        });
        await expect(runFlow(flow, wake(), { executeAgentNode: exec })).rejects.toThrow('route炸了');
    });

    it('maxIterations:目标节点超次不再执行,输出 = 最近完成节点(docs/20 §3.3)', async () => {
        const { exec, calls } = fakeExecutor({ x: (_i, v) => `X#${v}`, y: (i) => `Y(${i})` });
        const flow = agentFlow({
            edges: { a: 'b', b: { route: () => 'a', maxIterations: 3 } },
        });
        const warnings: string[] = [];
        const r = await runFlow(flow, wake(), { executeAgentNode: exec, warn: (m) => warnings.push(m) });
        // a 进入 3 次后,第 4 次被拦 → 输出 = 最近完成的 b 的文本
        expect(calls.filter((c) => c.agent === 'x')).toHaveLength(3);
        expect(r.terminal).toBe('b');
        expect(r.text).toMatch(/^Y\(X#3\)/);
        expect(warnings.join('\n')).toContain('maxIterations(3)');
    });

    it('maxIterations 未触发时 route done 正常结束', async () => {
        const { exec } = fakeExecutor({ x: (_i, v) => (v >= 2 ? 'LGTM' : 'again'), y: () => 'r' });
        const flow = agentFlow({
            edges: { a: 'b', b: { route: (out) => (out.text === 'LGTM' ? 'done' : 'a'), maxIterations: 5 } },
        });
        const r = await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(r).toMatchObject({ text: 'r', terminal: 'b' });
    });

    it('maxHops 超限 → FlowError 专属消息(区别于 maxIterations)', async () => {
        const { exec } = fakeExecutor({ x: () => 't', y: () => 'u' });
        const flow = agentFlow({ edges: { a: 'b', b: 'a' } }); // 无限环无 maxIterations
        await expect(runFlow(flow, wake(), { executeAgentNode: exec, maxHops: 6 })).rejects.toThrow('超过 maxHops(6)');
    });

    it('initialInput 抛错 → error 流', async () => {
        const { exec } = fakeExecutor({});
        const flow = agentFlow({
            initialInput: () => {
                throw new Error('入口炸了');
            },
        });
        await expect(runFlow(flow, wake(), { executeAgentNode: exec })).rejects.toThrow('入口炸了');
    });
});

describe('pass 语义(docs/20 §5)', () => {
    it('mode none:下游收到「继续你的任务」', async () => {
        const { exec, calls } = fakeExecutor({ x: () => '长文本', y: (i) => i });
        const flow = agentFlow({ edges: { a: 'b' }, pass: { mode: 'none' } });
        await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(calls[1]?.input).toBe('继续你的任务');
    });

    it('mode template:{{text}}/{{visit}}/{{data.path}};未知变量空串', async () => {
        const out: NodeOutput = {
            text: '上游文本',
            data: { a: { b: 'val' }, n: 42 },
            stats: {
                durationMs: 0,
                llmRequests: 0,
                toolCalls: 0,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        };
        expect(
            renderTemplate('T={{text}} V={{visit}} D={{data.a.b}} N={{data.n}} X={{data.missing}}', out, {
                to: 'b',
                visit: 3,
            }),
        ).toBe('T=上游文本 V=3 D=val N=42 X=');
    });

    it('template 转义:{{{{x}} → 原样 {{x}}(docs/20 §5.2)', async () => {
        const out: NodeOutput = {
            text: 'T',
            stats: {
                durationMs: 0,
                llmRequests: 0,
                toolCalls: 0,
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
        };
        expect(renderTemplate('{{{{text}}}}', out, { to: 'b', visit: 1 })).toBe('{{text}}');
    });

    it('边级 pass 覆盖顶层(docs/20 §5.1)', async () => {
        const { exec, calls } = fakeExecutor({ x: () => 'up', y: (i) => i });
        const flow = agentFlow({
            pass: { mode: 'none' },
            edges: { a: { route: () => 'b', pass: { mode: 'template', template: '[{{text}}]' } } },
        });
        await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(calls[1]?.input).toBe('[up]');
    });

    it('顶层 PassResolver 按下游节点给 PassSpec', async () => {
        const { exec, calls } = fakeExecutor({ x: () => 'up', y: (i) => i });
        const flow = agentFlow({ pass: (to) => (to === 'b' ? { mode: 'none' } : { mode: 'text' }) });
        await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(calls[1]?.input).toBe('继续你的任务');
    });

    it('custom transform:string 返回;data 记录进上游 NodeOutput.data(docs/20 §5.1)', async () => {
        const { exec, calls } = fakeExecutor({ x: () => 'raw', y: (i) => `got:${i}` });
        const flow = agentFlow({
            edges: {
                a: {
                    route: () => 'b',
                    pass: {
                        mode: 'custom',
                        transform: (o) => ({ userMessage: '加工过', data: { round: 7 } }),
                    },
                },
            },
        });
        const r = await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(calls[1]?.input).toBe('加工过');
        const a = r.trail.find((t) => t.node === 'a');
        expect(a?.data).toEqual({ round: 7 });
    });

    it('custom transform userMessage 空 = 不发新消息(空串输入,docs/20 §5.1)', async () => {
        const { exec, calls } = fakeExecutor({ x: () => 'raw', y: (i) => i });
        const flow = agentFlow({
            edges: { a: { route: () => 'b', pass: { mode: 'custom', transform: () => ({ data: 'only-data' }) } } },
        });
        const r = await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(calls[1]?.input).toBe(''); // userMessage 缺省 = 空串,不发新消息
        expect(r.trail.find((t) => t.node === 'a')?.data).toBe('only-data');
    });

    it('transform 抛错 → error 流原始消息(docs/20 §5.2)', async () => {
        const { exec } = fakeExecutor({ x: () => 'raw' });
        const flow = agentFlow({
            edges: {
                a: {
                    route: () => 'b',
                    pass: {
                        mode: 'custom',
                        transform: () => {
                            throw new Error('transform炸了');
                        },
                    },
                },
            },
        });
        await expect(runFlow(flow, wake(), { executeAgentNode: exec })).rejects.toThrow('transform炸了');
    });
});

describe('函数节点(docs/40 §5)', () => {
    it('string 返回:文本进入下游 pass;stats 零记账', async () => {
        const { exec, calls } = fakeExecutor({ x: () => 'agent-out' });
        const flow: FlowDefinition = {
            name: 'f',
            title: 'T',
            description: 'D',
            nodes: { a: { agent: 'x' }, parse: { run: (i) => JSON.stringify({ got: i.text }) } },
            entry: 'a',
            edges: { a: 'parse' },
        };
        const r = await runFlow(flow, wake(), { executeAgentNode: exec });
        expect(r.text).toBe(JSON.stringify({ got: 'agent-out' }));
        expect(r.terminal).toBe('parse');
        const t = r.trail.find((x) => x.node === 'parse');
        expect(t?.text).toBe('{"got":"agent-out"}');
        expect(exec).toBeDefined();
        expect(calls).toHaveLength(1); // 函数节点不走执行器
    });

    it('对象返回 {text,data}:data 经 trail 供下游 transform 消费', async () => {
        const flow: FlowDefinition = {
            name: 'f',
            title: 'T',
            description: 'D',
            nodes: {
                src: { run: () => ({ text: '带数据', data: { k: 'v' } }) },
                use: {
                    run: (i) => `data=${JSON.stringify(i.data)} text=${i.text}`,
                },
            },
            entry: 'src',
            edges: { src: 'use' },
        };
        const r = await runFlow(flow, wake('go'), {
            executeAgentNode: async () => {
                throw new Error('不该被调用');
            },
        });
        expect(r.text).toContain('data={"k":"v"}');
        expect(r.text).toContain('text=带数据');
    });

    it('run 抛错 → error 流原始消息(docs/40 §5)', async () => {
        const flow: FlowDefinition = {
            name: 'f',
            title: 'T',
            description: 'D',
            nodes: {
                bad: {
                    run: () => {
                        throw new Error('run炸了');
                    },
                },
            },
            entry: 'bad',
            edges: {},
        };
        await expect(
            runFlow(flow, wake(), {
                executeAgentNode: async () => {
                    throw new Error('x');
                },
            }),
        ).rejects.toThrow('run炸了');
    });

    it('run 返回非法值 → error 流', async () => {
        const flow: FlowDefinition = {
            name: 'f',
            title: 'T',
            description: 'D',
            // @ts-expect-error 故意非法返回值
            nodes: { bad: { run: () => 42 } },
            entry: 'bad',
            edges: {},
        };
        await expect(
            runFlow(flow, wake(), {
                executeAgentNode: async () => {
                    throw new Error('x');
                },
            }),
        ).rejects.toThrow('返回值必须为');
    });

    it('函数节点 thinking 行发出(「—— 函数节点 X ——」)', async () => {
        const flow: FlowDefinition = {
            name: 'f',
            title: 'T',
            description: 'D',
            nodes: { step: { run: () => 'ok', label: '解析' } },
            entry: 'step',
            edges: {},
        };
        const lines: string[] = [];
        await runFlow(flow, wake(), {
            executeAgentNode: async () => {
                throw new Error('x');
            },
            onThinking: (l) => lines.push(l),
        });
        expect(lines.join('\n')).toContain('—— 函数节点 解析 ——');
    });

    it('函数节点 ctx:visit 递增 + wake/scratch/extra 透传', async () => {
        const seen: Array<{ visit: number; wake: WakeContext; extra: unknown; scratch: unknown }> = [];
        const flow: FlowDefinition = {
            name: 'metaflow',
            title: 'T',
            description: 'D',
            meta: { tag: 'M' },
            nodes: {
                a: { agent: 'x' },
                loop: {
                    run: (_i, ctx) => {
                        seen.push({ visit: ctx.visit, wake: ctx.wake, extra: ctx.extra, scratch: { ...ctx.scratch } }); // 快照(scratch 是活对象)
                        ctx.scratch.n = ((ctx.scratch.n as number | undefined) ?? 0) + 1;
                        return ctx.visit >= 2 ? 'stop' : 'again';
                    },
                },
            },
            entry: 'a',
            edges: { a: 'loop', loop: { route: (out) => (out.text === 'stop' ? 'done' : 'loop') } },
        };
        const r = await runFlow(flow, wake('q'), {
            executeAgentNode: async () => ({
                text: 'go',
                stats: {
                    durationMs: 0,
                    llmRequests: 0,
                    toolCalls: 0,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
            }),
        });
        expect(seen.map((s) => s.visit)).toEqual([1, 2]);
        expect(seen[0]?.wake.input).toBe('q');
        expect(seen[0]?.extra).toEqual({ tag: 'M' });
        expect(seen[1]?.scratch).toMatchObject({ n: 1 }); // 首轮写入可见
        expect(r.text).toBe('stop');
    });

    it('函数节点 ctx.host:宿主会话只读视图透传(deps.hostView,docs/20 §2.2)', async () => {
        const seen: unknown[] = [];
        const flow: FlowDefinition = {
            name: 'hostview',
            title: 'T',
            description: 'D',
            nodes: {
                peek: {
                    run: (_i, ctx) => {
                        seen.push({ ...ctx.host, messages: [...ctx.host.messages] }); // 快照(readonly)
                        return 'ok';
                    },
                },
            },
            entry: 'peek',
            edges: {},
        };
        const hostView: HostSessionView = {
            sessionId: 'host-1',
            wakeIndex: 3,
            lastInput: 'q',
            lastOutput: '上一轮输出',
            messages: [
                { role: 'user', content: '早前问题' },
                { role: 'assistant', content: '早前回答' },
                { role: 'user', content: 'q' },
            ],
        };
        const r = await runFlow(flow, wake('q'), {
            executeAgentNode: async () => {
                throw new Error('不该被调用');
            },
            hostView,
        });
        expect(r.text).toBe('ok');
        expect(seen[0]).toMatchObject({
            sessionId: 'host-1',
            wakeIndex: 3,
            lastInput: 'q',
            lastOutput: '上一轮输出',
        });
        expect((seen[0] as { messages: unknown[] }).messages).toHaveLength(3);
        expect((seen[0] as { messages: Array<{ role: string }> }).messages[2]?.role).toBe('user');
    });

    it('函数节点 ctx.host:deps.hostView 缺省 = 空 view(防御,docs/20 §2.2)', async () => {
        let captured: unknown;
        const flow: FlowDefinition = {
            name: 'hostempty',
            title: 'T',
            description: 'D',
            nodes: {
                peek: { run: (_i, ctx) => ((captured = { ...ctx.host, messages: [...ctx.host.messages] }), 'ok') },
            },
            entry: 'peek',
            edges: {},
        };
        await runFlow(flow, wake('q'), {
            executeAgentNode: async () => {
                throw new Error('x');
            },
        });
        expect(captured).toMatchObject({ sessionId: '', wakeIndex: 0, lastInput: '' });
        expect((captured as { messages: unknown[] }).messages).toHaveLength(0);
    });
});
