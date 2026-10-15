import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import type { AgentDefinition, FlowDefinition, SubagentSpec } from '../src/extension/types.js';
import {
    normalizeSubagentSpecs,
    spawnInputText,
    spawnToolDescription,
    spawnToolName,
    createSpawnTools,
    runSpawn,
    SPAWN_TOOL_PREFIX,
    type SpawnDeps,
} from '../src/extension/session/spawn.js';
import type { RunNodeEnv } from '../src/extension/session/run-node.js';
import { AbortedError } from '../src/extension/session/run-node.js';
import { FlowError } from '../src/extension/engine/runner.js';
import { DEFAULT_CONFIG } from '../src/extension/config.js';

/* ------------------------------------------------------------------ */
/*  帮手                                                                */
/* ------------------------------------------------------------------ */

const parentAgent: AgentDefinition = {
    name: 'planner',
    title: '规划者',
    description: '拆解任务',
    systemPrompt: '你是规划者',
    subagents: [
        'coder',
        { name: 'reviewer', title: '快速评审', appendSystemPrompt: '只关注正确性' },
        { name: 'dev-loop' },
    ],
};

const coderAgent: AgentDefinition = {
    name: 'coder',
    title: '编码者',
    description: '写代码',
    systemPrompt: '你是编码者',
};

const devLoopFlow: FlowDefinition = {
    name: 'dev-loop',
    title: '开发循环',
    description: '完整开发循环',
    nodes: { code: { agent: 'coder' } },
    entry: 'code',
    edges: {},
};

function fakeEnv(over: Partial<RunNodeEnv> = {}): RunNodeEnv {
    return {
        flowName: 'main-flow',
        pool: { acquire: vi.fn() } as unknown as RunNodeEnv['pool'],
        config: DEFAULT_CONFIG,
        agentsByName: new Map([
            ['planner', parentAgent],
            ['coder', coderAgent],
        ]),
        hostToolNames: new Set(['read', 'ls']),
        cwd: () => '/tmp',
        resolveModel: () => undefined,
        flowByName: (name) => (name === 'dev-loop' ? devLoopFlow : undefined),
        ...over,
    } as RunNodeEnv;
}

/** 假子会话:prompt 记录输入,末条 assistant 可控 */
function fakeSession(opts: { lastText?: string; stopReason?: string; errorMessage?: string } = {}) {
    const inputs: string[] = [];
    const listeners: Array<(e: never) => void> = [];
    const messages: AgentMessage[] = [];
    const session = {
        prompt: vi.fn(async (input: string) => {
            inputs.push(input);
            messages.push({ role: 'user', content: input, timestamp: Date.now() } as unknown as AgentMessage);
            messages.push({
                role: 'assistant',
                content: [{ type: 'text', text: opts.lastText ?? '子代理输出' }],
                stopReason: opts.stopReason ?? 'stop',
                ...(opts.errorMessage ? { errorMessage: opts.errorMessage } : {}),
                timestamp: Date.now(),
            } as unknown as AgentMessage);
        }),
        messages: messages as AgentMessage[],
        getLastAssistantText: () => opts.lastText ?? '子代理输出',
        subscribe: (fn: (e: never) => void) => {
            listeners.push(fn);
            return () => {};
        },
    };
    return { session, inputs };
}

function fakeDeps(over: Partial<SpawnDeps> = {}): SpawnDeps {
    return {
        parentAgent,
        env: fakeEnv(),
        outputVisible: true,
        poolScope: {
            flowName: 'main-flow',
            nodeKey: 'plan',
            hostSessionId: 'h1',
            wakeIndex: 3,
            agentPath: 'flow:main-flow#plan',
        },
        flowByName: (name) => (name === 'dev-loop' ? devLoopFlow : undefined),
        ...over,
    };
}

/* ------------------------------------------------------------------ */
/*  纯函数(名称/输入/归一化/描述)                                          */
/* ------------------------------------------------------------------ */

describe('spawn 命名与输入', () => {
    it('工具名固定 spawn_<name>(10 §6)', () => {
        expect(spawnToolName('coder')).toBe('spawn_coder');
        expect(SPAWN_TOOL_PREFIX).toBe('spawn_');
    });

    it('normalizeSubagentSpecs:string 与对象两态', () => {
        const specs = normalizeSubagentSpecs(parentAgent);
        expect(specs.map((s) => s.name)).toEqual(['coder', 'reviewer', 'dev-loop']);
        expect(specs[1]?.title).toBe('快速评审');
        expect(specs[1]?.appendSystemPrompt).toBe('只关注正确性');
    });

    it('spawnInputText:context 拼第二段;空 context 忽略(§6.2)', () => {
        expect(spawnInputText('任务', '约束')).toBe('任务\n\n约束');
        expect(spawnInputText('任务', undefined)).toBe('任务');
        expect(spawnInputText('任务', '   ')).toBe('任务');
    });

    it('description 由被引用对象 title/description 组合', () => {
        const d = spawnToolDescription(coderAgent);
        expect(d).toContain('编码者');
        expect(d).toContain('coder');
        expect(d).toContain('写代码');
    });
});

/* ------------------------------------------------------------------ */
/*  工具生成                                                            */
/* ------------------------------------------------------------------ */

describe('createSpawnTools', () => {
    it('每个 subagents 条目一个工具;参数只有 task/context', () => {
        const tools = createSpawnTools(fakeDeps()) as Array<ToolDefinition<TSchema, unknown>>;
        expect(tools.map((t) => t.name)).toEqual(['spawn_coder', 'spawn_reviewer', 'spawn_dev-loop']);
        expect(tools[0]?.label).toBe('调用子代理 coder');
        expect(tools[1]?.label).toBe('调用子代理 快速评审'); // spec.title 覆盖
        for (const t of tools) {
            const props = (t.parameters as { properties: Record<string, unknown> }).properties;
            expect(Object.keys(props).sort()).toEqual(['context', 'task']);
        }
    });

    it('description:Agent 引用取 Agent;工作流引用取工作流', () => {
        const tools = createSpawnTools(fakeDeps()) as Array<ToolDefinition<TSchema, unknown>>;
        expect(tools[0]?.description ?? '').toContain('写代码');
        expect(tools[2]?.description ?? '').toContain('完整开发循环');
    });
});

/* ------------------------------------------------------------------ */
/*  Agent 引用执行                                                       */
/* ------------------------------------------------------------------ */

describe('runSpawn:Agent 引用', () => {
    it('stateless 缺省:新建子会话,输入 = task(+context),返回最终文本', async () => {
        const built = fakeSession({ lastText: '代码写完了' });
        const deps = fakeDeps({
            createSubSessionOf: vi.fn(async () => ({ session: built.session as never, sessionManager: {} as never })),
        });
        const r = await runSpawn({ name: 'coder' }, '实现功能\n\n注意边界', deps);
        expect(r.text).toBe('代码写完了');
        expect(built.inputs).toEqual(['实现功能\n\n注意边界']);
        expect(r.durationMs).toBeGreaterThanOrEqual(0);
        // stateless 不进池
        expect(deps.env.pool.acquire).not.toHaveBeenCalled();
    });

    it('inherit:复用池条目(键 = 父键 + sub:<name>,§3.3)', async () => {
        const built = fakeSession({});
        const acquire = vi.fn<
            (args: { nodeKey: string; hostSessionId: string; wakeIndex: number }) => Promise<unknown>
        >(async () => ({
            session: built.session as never,
            sessionManager: {} as never,
            identity: 'x',
            wakeIndex: 3,
        }));
        const deps = fakeDeps({
            env: fakeEnv({ pool: { acquire } as unknown as RunNodeEnv['pool'] }),
            createSubSessionOf: vi.fn(async () => ({ session: built.session as never, sessionManager: {} as never })),
        });
        await runSpawn({ name: 'coder', session: 'inherit' }, '第二轮任务', deps);
        expect(acquire).toHaveBeenCalledTimes(1);
        const args = acquire.mock.calls[0]![0];
        expect(args.nodeKey).toBe('plan>sub:coder');
        expect(args.hostSessionId).toBe('h1');
        expect(args.wakeIndex).toBe(3);
    });

    it('session 缺省取全局配置 subagentSession(D7)', async () => {
        const acquire = vi.fn(async () => {
            const built = fakeSession({});
            return {
                session: built.session as never,
                sessionManager: {} as never,
                identity: 'x',
                wakeIndex: 1,
            };
        });
        const config = { ...DEFAULT_CONFIG, subagentSession: 'inherit' as const };
        const deps = fakeDeps({
            env: fakeEnv({ pool: { acquire } as unknown as RunNodeEnv['pool'], config }),
            createSubSessionOf: vi.fn(async () => {
                const built = fakeSession({});
                return { session: built.session as never, sessionManager: {} as never };
            }),
        });
        await runSpawn({ name: 'coder' }, '任务', deps);
        expect(acquire).toHaveBeenCalled(); // 全局 inherit → 进池
    });

    it('子会话 stopReason=aborted → AbortedError 穿透(引擎按中断收尾)', async () => {
        const built = fakeSession({ stopReason: 'aborted', errorMessage: '用户中断' });
        const deps = fakeDeps({
            createSubSessionOf: vi.fn(async () => ({ session: built.session as never, sessionManager: {} as never })),
        });
        await expect(runSpawn({ name: 'coder' }, '任务', deps)).rejects.toBeInstanceOf(AbortedError);
    });

    it('子会话 stopReason=error → Error(errorMessage)', async () => {
        const built = fakeSession({ stopReason: 'error', errorMessage: '模型返回错误' });
        const deps = fakeDeps({
            createSubSessionOf: vi.fn(async () => ({ session: built.session as never, sessionManager: {} as never })),
        });
        await expect(runSpawn({ name: 'coder' }, '任务', deps)).rejects.toThrow('模型返回错误');
    });
});

/* ------------------------------------------------------------------ */
/*  工作流引用执行                                                       */
/* ------------------------------------------------------------------ */

describe('runSpawn:工作流引用', () => {
    it('一次完整唤醒:链式 hostSessionId;终点文本 = 返回值', async () => {
        const wakeRun = vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({
            ok: true as const,
            result: { text: '循环终点输出', terminal: 'code', trail: [] },
            wake: { input: 'x', images: [], hostSessionId: 'y', wakeIndex: 1 },
        }));
        const deps = fakeDeps({ wakeRun: wakeRun as unknown as SpawnDeps['wakeRun'] });
        const r = await runSpawn({ name: 'dev-loop' }, '跑一遍开发循环', deps);
        expect(r.text).toBe('循环终点输出');
        expect(wakeRun).toHaveBeenCalledTimes(1);
        const args = wakeRun.mock.calls[0]?.[0] as {
            flow: FlowDefinition;
            hostSessionId: string;
            env: { flowContext: FlowDefinition | null };
        };
        expect(args.flow.name).toBe('dev-loop');
        // 链式键(§3.3):flow#node>hostId
        expect(args.hostSessionId).toBe('main-flow#plan>h1');
        // 子流 flowContext = 目标工作流(工作流级世界书生效,10 §6.2)
        expect(args.env.flowContext?.name).toBe('dev-loop');
    });

    it('appendSystemPrompt/session 对工作流引用无效 → warning(10 §6.1)', async () => {
        const warns: string[] = [];
        const deps = fakeDeps({
            wakeRun: vi.fn(async () => ({
                ok: true as const,
                result: { text: 'ok', terminal: 't', trail: [] },
                wake: { input: 'x', images: [], hostSessionId: 'y', wakeIndex: 1 },
            })),
            warn: (m) => warns.push(m),
        });
        await runSpawn({ name: 'dev-loop', appendSystemPrompt: 'x', session: 'inherit' }, '任务', deps);
        expect(warns.join('\n')).toContain('不适用');
    });

    it('子工作流 FlowError → 工具层上抛(§6.2 内部报错 → isError)', async () => {
        const deps = fakeDeps({
            wakeRun: vi.fn(async () => ({ ok: false as const, aborted: false, error: new FlowError('节点爆炸') })),
        });
        await expect(runSpawn({ name: 'dev-loop' }, '任务', deps)).rejects.toThrow('节点爆炸');
    });

    it('子工作流中断 → AbortedError 穿透', async () => {
        const deps = fakeDeps({
            wakeRun: vi.fn(async () => ({ ok: false as const, aborted: true, error: new AbortedError() })),
        });
        await expect(runSpawn({ name: 'dev-loop' }, '任务', deps)).rejects.toBeInstanceOf(AbortedError);
    });
});

/* ------------------------------------------------------------------ */
/*  引用校验(§6.2 步骤 1)                                                */
/* ------------------------------------------------------------------ */

describe('runSpawn:引用校验', () => {
    it('Agent/工作流都找不到 → 报错提示重载', async () => {
        const deps = fakeDeps();
        await expect(runSpawn({ name: 'ghost' }, '任务', deps)).rejects.toThrow('装载无效');
    });

    it('同名冲突:Agent 优先(load 同名规则)', async () => {
        const built = fakeSession({});
        const wakeRun = vi.fn();
        const env = fakeEnv({
            agentsByName: new Map([
                ['coder', coderAgent],
                ['dev-loop', coderAgent], // 同名:Agent 存在 → 工作流引用不生效
            ]),
        });
        const deps = fakeDeps({
            env,
            wakeRun,
            createSubSessionOf: vi.fn(async () => ({ session: built.session as never, sessionManager: {} as never })),
        });
        await runSpawn({ name: 'dev-loop' }, '任务', deps);
        expect(wakeRun).not.toHaveBeenCalled(); // 走了 Agent 引用
        expect(built.inputs).toEqual(['任务']);
    });
});
