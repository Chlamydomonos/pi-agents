/**
 * wakeFlow 转发契约测试(docs/40 §4.2 防回归):
 * seedInputOf 声明在 WakeArgs 顶层(index 构造),run-node 从 env.seedInputOf 读取。
 * 曾因 wakeFlow 未把顶层字段转发进 executor env,导致 inherit 首唤醒
 * 永远拿不到宿主历史(resume 后记忆丢失,真实环境验收暴露)。
 *
 * 行为级验证:桩 NodeSession 捕获 seed prompt 的实际文本——
 * seed 生效 → session.prompt 第一次收到 digest;断链复发 → 不再触发 seed prompt。
 */
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { wakeFlow } from '../src/extension/session/runtime.js';
import type { WakeArgs } from '../src/extension/session/runtime.js';
import type { FlowDefinition } from '../src/extension/types.js';
import type { PiAgentsConfig } from '../src/extension/config.js';

const flow: FlowDefinition = {
    name: 'notes',
    title: 'notes',
    description: 't',
    nodes: { main: { agent: 'notetaker', sessionMode: 'inherit' } },
    entry: 'main',
    edges: {},
};

const config = { usage: false, maxHops: 8, streamPrefixes: true } as unknown as PiAgentsConfig;

/** 桩子会话:记录 prompt 收到的文本;消息列表可控(结局判定用) */
function fakeNodeSession(prompts: string[], messages: AgentMessage[]) {
    return {
        session: {
            subscribe: (_fn: (e: { type: string }) => void) => () => {},
            prompt: async (input: string) => {
                prompts.push(input);
                // 每次 prompt 后补一条 assistant 消息,保证 lastAssistant 存在且结局为 stop
                messages.push({
                    role: 'assistant',
                    content: [{ type: 'text', text: `回复:${input}` }],
                    stopReason: 'stop',
                } as unknown as AgentMessage);
            },
            abort: async () => {},
            dispose: async () => {},
            get messages() {
                return messages;
            },
            getLastAssistantText: () => {
                for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i] as { role?: string; content?: { type: string; text?: string }[] };
                    if (m && m.role === 'assistant') {
                        return (m.content ?? [])
                            .filter((b) => b.type === 'text')
                            .map((b) => b.text ?? '')
                            .join('\n');
                    }
                }
                return '';
            },
        },
    };
}

function makeArgs(seedInputOf: WakeArgs['seedInputOf']): {
    args: WakeArgs;
    seedPrompts: string[];
} {
    const seedPrompts: string[] = [];
    const messages: AgentMessage[] = [];
    const ns = fakeNodeSession(seedPrompts, messages);
    const args: WakeArgs = {
        flow,
        hostMessages: [
            { role: 'user', content: '旧问题' },
            { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
            { role: 'user', content: '本次输入' },
        ] as unknown as AgentMessage[],
        wakeIndex: 1,
        hostSessionId: 'h',
        maxHops: 8,
        ...(seedInputOf !== undefined ? { seedInputOf } : {}),
        env: {
            flowName: 'notes',
            pool: {
                acquire: async () => ({
                    session: ns.session,
                    sessionManager: {} as never,
                    seeded: false,
                    identity: 'i',
                    wakeIndex: 1,
                }),
                markSeeded: () => {},
            },
            config,
            agentsByName: new Map([
                [
                    'notetaker',
                    {
                        name: 'notetaker',
                        title: '纪要员',
                        description: 't',
                        systemPrompt: '整理纪要',
                        tools: [],
                        sessionMode: 'inherit',
                    },
                ],
            ]),
            hostToolNames: new Set<string>(),
            cwd: () => '/tmp',
            resolveModel: () => undefined,
            warn: () => {},
            lorebookOf: () => [],
            flowContext: flow,
            flowByName: () => flow,
            usageLedger: () => undefined,
        } as unknown as WakeArgs['env'],
    };
    return { args, seedPrompts };
}

describe('wakeFlow seedInputOf 转发契约(防回归:resume 后 inherit 记忆丢失)', () => {
    it('WakeArgs 顶层的 seedInputOf 必须生效:首唤醒先注入 digest', async () => {
        const { args, seedPrompts } = makeArgs(() => '<宿主历史摘要>旧问题/旧回答');
        const outcome = await wakeFlow(args);
        expect(outcome.ok).toBe(true);
        expect(seedPrompts.length).toBe(2); // seed digest + 本次输入
        expect(seedPrompts[0]).toContain('<宿主历史摘要>');
    });

    it('顶层无 seedInputOf 时回退 env.seedInputOf(子流程/测试直接挂 env 的路径)', async () => {
        const { args, seedPrompts } = makeArgs(undefined);
        (args.env as { seedInputOf?: () => string }).seedInputOf = () => '<env 级摘要>';
        const outcome = await wakeFlow(args);
        expect(outcome.ok).toBe(true);
        expect(seedPrompts.length).toBe(2);
        expect(seedPrompts[0]).toContain('<env 级摘要>');
    });

    it('无任何 seedInputOf(历史为空场景)→ 跳过 seed,直接注入本次输入', async () => {
        const { args, seedPrompts } = makeArgs(undefined);
        const outcome = await wakeFlow(args);
        expect(outcome.ok).toBe(true);
        expect(seedPrompts).toEqual(['本次输入']);
    });
});

describe('wakeFlow → 函数节点 ctx.host(宿主会话只读视图,docs/20 §2.2)', () => {
    it('函数节点拿到宿主请求消息的 role 投影;view 字段与 wake 一致', async () => {
        let seen:
            | {
                  sessionId: string;
                  wakeIndex: number;
                  lastInput: string;
                  lastOutput?: string;
                  messages: Array<{ role: string; content: unknown }>;
              }
            | undefined;
        const hostFlow: FlowDefinition = {
            name: 'peek-host',
            title: 't',
            description: 't',
            nodes: {
                main: { agent: 'notetaker', sessionMode: 'fresh' },
                peek: {
                    run: (_i, ctx) => {
                        seen = { ...ctx.host, messages: [...ctx.host.messages] } as typeof seen;
                        return ctx.host.messages.map((m) => String(m.role)).join(',');
                    },
                },
            },
            entry: 'main',
            edges: { main: 'peek' },
        };
        const prompts: string[] = [];
        const messages: AgentMessage[] = [];
        const ns = fakeNodeSession(prompts, messages);
        const args: WakeArgs = {
            flow: hostFlow,
            hostMessages: [
                { role: 'user', content: '旧问题' },
                { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
                { role: 'user', content: '本次输入' },
            ] as unknown as AgentMessage[],
            wakeIndex: 2,
            hostSessionId: 'h',
            lastOutput: '上一轮',
            maxHops: 8,
            env: {
                flowName: 'peek-host',
                pool: {
                    acquire: async () => ({
                        session: ns.session,
                        sessionManager: {} as never,
                        seeded: false,
                        identity: 'i',
                        wakeIndex: 2,
                    }),
                    markSeeded: () => {},
                },
                config,
                agentsByName: new Map([
                    [
                        'notetaker',
                        {
                            name: 'notetaker',
                            title: '纪要员',
                            description: 't',
                            systemPrompt: '整理纪要',
                            tools: [],
                        },
                    ],
                ]),
                hostToolNames: new Set<string>(),
                cwd: () => '/tmp',
                resolveModel: () => undefined,
                warn: () => {},
                lorebookOf: () => [],
                flowContext: hostFlow,
                flowByName: () => hostFlow,
                usageLedger: () => undefined,
            } as unknown as WakeArgs['env'],
        };
        const outcome = await wakeFlow(args);
        expect(outcome.ok).toBe(true);
        expect(outcome.ok && outcome.result.text).toBe('user,assistant,user');
        expect(seen?.sessionId).toBe('h');
        expect(seen?.wakeIndex).toBe(2);
        expect(seen?.lastInput).toBe('本次输入');
        expect(seen?.lastOutput).toBe('上一轮');
        expect(seen?.messages[0]).toMatchObject({ role: 'user', content: '旧问题' });
        expect(seen?.messages[1]?.role).toBe('assistant');
    });
});
