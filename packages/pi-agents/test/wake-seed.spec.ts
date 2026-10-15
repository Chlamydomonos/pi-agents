/**
 * wakeFlow 契约测试:函数节点 ctx.host(宿主会话只读视图,docs/20 §2.2)。
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
                messages.push({
                    role: 'assistant',
                    content: [{ type: 'text', text: '回复:' + input }],
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
                            .join('');
                    }
                }
                return '';
            },
        },
    };
}

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
                        identity: 'i',
                        wakeIndex: 2,
                    }),
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

describe('wakeFlow ask 挂起(ask_user 桥接 → 工作流提前落定)', () => {
    it('节点末轮以 ask_user toolUse 收尾 → AskPostedError → ok 落定(terminal=该节点;后续节点不跑)', async () => {
        // ask 后还有下一个节点:若挂起失效,peek 会执行并成为终点 → 用它反证
        const askFlow: FlowDefinition = {
            name: 'ask-flow',
            title: 't',
            description: 't',
            nodes: {
                main: { agent: 'notetaker', sessionMode: 'fresh' },
                peek: { run: () => '不该执行' },
            },
            entry: 'main',
            edges: { main: 'peek' },
        };
        const prompts: string[] = [];
        const messages: AgentMessage[] = [];
        const ns = fakeNodeSession(prompts, messages);
        // 覆写 prompt:ask 场景末轮补 toolUse 收尾消息(末块 ask_user)
        (ns.session as { prompt: (input: string) => Promise<void> }).prompt = async (input: string) => {
            prompts.push(input);
            messages.push({
                role: 'assistant',
                content: [{ type: 'toolCall', id: 't1', name: 'ask_user', arguments: { questions: [] } }],
                stopReason: 'toolUse',
            } as unknown as AgentMessage);
        };
        const args: WakeArgs = {
            flow: askFlow,
            hostMessages: [{ role: 'user', content: '本次输入' }] as unknown as AgentMessage[],
            wakeIndex: 1,
            hostSessionId: 'h',
            maxHops: 8,
            env: {
                flowName: 'ask-flow',
                pool: {
                    acquire: async () => ({
                        session: ns.session,
                        sessionManager: {} as never,
                        identity: 'i',
                        wakeIndex: 1,
                    }),
                },
                config,
                agentsByName: new Map([
                    [
                        'notetaker',
                        { name: 'notetaker', title: 't', description: 't', systemPrompt: 'x', tools: ['ask_user'] },
                    ],
                ]),
                hostToolNames: new Set<string>(['ask_user']),
                cwd: () => '/tmp',
                resolveModel: () => undefined,
                warn: () => {},
                lorebookOf: () => [],
                flowContext: askFlow,
                flowByName: () => askFlow,
                usageLedger: () => undefined,
            } as unknown as WakeArgs['env'],
        };
        const outcome = await wakeFlow(args);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        // 提前落定:terminal = 提问节点;后续 fn 节点未执行
        expect(outcome.result.terminal).toBe('main');
        expect(outcome.result.text).toBe('');
        expect(outcome.result.trail).toEqual([{ node: 'main', visit: 1, text: '' }]);
    });
});
