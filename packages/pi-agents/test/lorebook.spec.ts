import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { LorebookContext, LorebookEntry } from '../src/extension/types.js';
import {
    composeSystemPrompt,
    entryId,
    insertDepthMessages,
    planDepthInsertions,
    resolveLorebook,
    type DepthMessage,
    type LorebookSource,
    type ResolvedEntry,
} from '../src/extension/session/lorebook.js';
import { createLorebookHook, LOREBOOK_ENTRY_TYPE, toLorebookMessages } from '../src/extension/session/lorebook-hook.js';

/* ------------------------------------------------------------------ */
/*  帮手                                                                */
/* ------------------------------------------------------------------ */

const baseCtx = (): LorebookContext => ({
    agent: 'writer',
    messages: [],
    flow: null,
    extra: undefined,
    requestIndex: 1,
});

const res = (entry: LorebookEntry, level: 0 | 1 | 2 = 0, sourceName = 's'): ResolvedEntry => ({
    entry,
    id: entryId(entry),
    level,
    sourceName,
});

const src = (spec: LorebookSource['spec'], level: 0 | 1 | 2, name: string): LorebookSource => ({ spec, level, name });

/** 最小 system 消息(与 pi 实际形态一致:content 为字符串) */
const sysMsg = (text: string): AgentMessage =>
    ({ role: 'system', content: text, timestamp: 0 }) as unknown as AgentMessage;
const userMsg = (text: string): AgentMessage =>
    ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }) as unknown as AgentMessage;

/** 捕获 context_with_system handler 的假 pi */
function fakePi() {
    const handlers = new Map<string, (event: { messages: AgentMessage[] }) => Promise<unknown>>();
    const pi = {
        on: (event: string, fn: never) => {
            handlers.set(event, fn as (e: { messages: AgentMessage[] }) => Promise<unknown>);
        },
    };
    return { pi: pi as unknown as Parameters<ExtensionFactory>[0], handlers };
}

/** 单实例 hook 驱动器:同一 hook 可多次 drive(跨请求状态持续累积) */
function makeDriver(opts: { sources?: LorebookSource[]; base?: string[]; warn?: (m: string) => void }) {
    const { pi, handlers } = fakePi();
    const appends: string[] = [];
    const appendCustomMessageEntry = vi.fn((t: string, content: string) => {
        appends.push(content);
        return 'id';
    });
    const { factory, stats } = createLorebookHook(
        {
            sourcesOf: () => opts.sources ?? [],
            baseSystemPrompt: opts.base ?? [],
            makeContext: (msgs, requestIndex) => ({ ...baseCtx(), messages: toLorebookMessages(msgs), requestIndex }),
            warn: opts.warn,
        },
        { appendCustomMessageEntry } as unknown as {
            appendCustomMessageEntry: (t: string, c: string, d: boolean) => string;
        },
    );
    factory(pi);
    const handler = handlers.get('context_with_system');
    if (!handler) throw new Error('hook 未注册 context_with_system');
    return {
        drive: async (messages: AgentMessage[]) =>
            ((await handler({ messages: [...messages] })) as { messages: AgentMessage[] }).messages,
        appends,
        appendCustomMessageEntry,
        stats,
    };
}

/* ------------------------------------------------------------------ */
/*  entryId(docs/10 §5.3)                                               */
/* ------------------------------------------------------------------ */

describe('entryId', () => {
    it('显式 id 直接使用', () => {
        expect(entryId({ content: 'x', id: 'custom-1' })).toBe('custom-1');
    });

    it('缺省 = content sha1 前 12 位且稳定', () => {
        const a = entryId({ content: '世界书条目' });
        const b = entryId({ content: '世界书条目' });
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{12}$/);
        expect(a).not.toBe(entryId({ content: '另一条目' }));
    });
});

/* ------------------------------------------------------------------ */
/*  resolveLorebook(§5.2 三级合并)                                       */
/* ------------------------------------------------------------------ */

describe('resolveLorebook', () => {
    it('三级来源按 level 升序评估,id 重复高层级胜出', async () => {
        const entryA: LorebookEntry = { content: '共同内容', id: 'shared' };
        const sources = [
            src({ entries: [{ ...entryA, content: '工作区版' }] }, 2, 'ws'),
            src({ entries: [{ ...entryA, content: '工作流版' }] }, 1, 'flow'),
            src({ entries: [{ ...entryA, content: 'Agent 版' }] }, 0, 'agent'),
        ];
        const r = await resolveLorebook(sources, baseCtx());
        expect(r.depth).toHaveLength(1);
        expect(r.depth[0]?.entry.content).toBe('Agent 版');
        expect(r.depth[0]?.level).toBe(0);
        expect(r.skipped).toEqual([]);
    });

    it('entries 函数 + trigger 并集去重', async () => {
        const sources = [
            src(
                {
                    entries: () => Promise.resolve([{ content: '静态', id: 'a' }]),
                    trigger: () =>
                        Promise.resolve([
                            { content: '动态', id: 'b' },
                            { content: '静态', id: 'a' },
                        ]),
                },
                0,
                's0',
            ),
        ];
        const r = await resolveLorebook(sources, baseCtx());
        expect(r.depth.map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('单级抛错 → 该级跳过进 skipped,其余级不受影响', async () => {
        const sources = [
            src({ entries: [{ content: '好的', id: 'ok' }] }, 0, 'good'),
            src({ entries: () => Promise.reject(new Error('boom')) }, 1, 'bad'),
        ];
        const r = await resolveLorebook(sources, baseCtx());
        expect(r.skipped).toEqual(['bad']);
        expect(r.depth.map((e) => e.id)).toEqual(['ok']);
    });

    it('target: system 与 depth 分流', async () => {
        const sources = [
            src(
                {
                    entries: [
                        { content: '深度', depth: 1 },
                        { content: '系统', target: 'system' },
                    ],
                },
                0,
                's',
            ),
        ];
        const r = await resolveLorebook(sources, baseCtx());
        expect(r.depth.map((e) => e.entry.content)).toEqual(['深度']);
        expect(r.system.map((e) => e.entry.content)).toEqual(['系统']);
    });

    it('spec 为 null 的级直接忽略', async () => {
        const r = await resolveLorebook(
            [src(null, 0, 'none'), src({ entries: [{ content: 'x' }] }, 2, 'ws')],
            baseCtx(),
        );
        expect(r.depth).toHaveLength(1);
        expect(r.skipped).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/*  composeSystemPrompt(§5.1 槽位)                                       */
/* ------------------------------------------------------------------ */

describe('composeSystemPrompt', () => {
    it('文档示例:slot:0 条目插在基座第 0 项之后', () => {
        const out = composeSystemPrompt(
            ['角色设定', '输出格式'],
            [res({ content: '补充约束', target: 'system', slot: 0 })],
        );
        expect(out).toBe('角色设定\n\n补充约束\n\n输出格式');
    });

    it('slot 缺省 = 追加末尾;slot 超长 = 追加末尾不报错', () => {
        const base = ['A', 'B'];
        expect(composeSystemPrompt(base, [res({ content: 'Z', target: 'system' })])).toBe('A\n\nB\n\nZ');
        expect(composeSystemPrompt(base, [res({ content: 'Z', target: 'system', slot: 99 })])).toBe('A\n\nB\n\nZ');
    });

    it('同槽位条目按 order 升序,插在基座锚(order 0)之后', () => {
        const out = composeSystemPrompt(
            ['B'],
            [
                res({ content: 'late', target: 'system', slot: 0, order: 5 }),
                res({ content: 'early', target: 'system', slot: 0, order: 1 }),
            ],
        );
        expect(out).toBe('B\n\nearly\n\nlate');
    });

    it('跨级优先序 = 解析顺序(resolveLorebook 已按优先序输出,此处保序)', () => {
        const out = composeSystemPrompt(
            ['B'],
            [
                res({ content: 'Agent', target: 'system', slot: 0 }, 0, 'agent'),
                res({ content: '工作区', target: 'system', slot: 0 }, 2, 'ws'),
            ],
        );
        // resolveLorebook 输出已按优先序;composeSystemPrompt 稳定保序
        expect(out).toBe('B\n\nAgent\n\n工作区');
    });

    it('空基座时条目照常组装', () => {
        expect(composeSystemPrompt([], [res({ content: '只有条目', target: 'system' })])).toBe('只有条目');
    });
});

/* ------------------------------------------------------------------ */
/*  depth 插入(§5.3)                                                    */
/* ------------------------------------------------------------------ */

describe('planDepthInsertions/insertDepthMessages', () => {
    /** 投影:字符串保持,DepthMessage 取 content(便于断言插入位置) */
    const contents = (out: ReadonlyArray<string | DepthMessage>) =>
        out.map((m) => (typeof m === 'string' ? m : m.content));

    it('depth 从注入前列表末尾计数:0 = 最新一条之前', () => {
        const msgs = ['m1', 'm2', 'm3'];
        const plan = planDepthInsertions([res({ content: '注入', depth: 0 })], msgs.length);
        expect(plan[0]?.index).toBe(2); // 3 - 1 - 0
        const out = insertDepthMessages(msgs, plan);
        // depth 0 = 最新一条(m3)之前 → [m1, m2, 注入, m3]
        expect(contents(out)).toEqual(['m1', 'm2', '注入', 'm3']);
    });

    it('先深后浅插入不错位;越界插到最前', () => {
        const msgs = ['m1', 'm2'];
        const plan = planDepthInsertions(
            [res({ content: '浅', depth: 0 }), res({ content: '深', depth: 5 }), res({ content: '中', depth: 1 })],
            msgs.length,
        );
        const out = insertDepthMessages(msgs, plan);
        // 深(index = 2-1-5 = -4 → clamp 0)→ 最前;中 depth1 → index 0(m1 前);浅 depth0 → index 1(m2 前)
        expect(contents(out)).toEqual(['深', '中', 'm1', '浅', 'm2']);
    });

    it('同深度多条按 order 升序排列', () => {
        const msgs = ['m1'];
        const plan = planDepthInsertions(
            [res({ content: 'second', depth: 0, order: 9 }), res({ content: 'first', depth: 0, order: 1 })],
            msgs.length,
        );
        const out = insertDepthMessages(msgs, plan);
        // depth 0 = 最新一条(m1)之前;同深度两条保持 order 升序
        expect(contents(out)).toEqual(['first', 'second', 'm1']);
    });

    it('role 缺省 user,显式 assistant 保留', () => {
        const plan = planDepthInsertions(
            [res({ content: 'a', depth: 0, role: 'assistant' }), res({ content: 'b', depth: 0 })],
            1,
        );
        expect(plan.map((p) => p.message.role)).toEqual(['assistant', 'user']);
    });
});

/* ------------------------------------------------------------------ */
/*  createLorebookHook(context_with_system 通道)                         */
/* ------------------------------------------------------------------ */

describe('createLorebookHook', () => {
    it('system 条目:改写首个 system 消息文本(基座 + 槽位)', async () => {
        const sources = [src({ entries: [{ content: '补充约束', target: 'system', slot: 0 }] }, 0, 's')];
        const d = makeDriver({ sources, base: ['角色设定', '输出格式'] });
        const out = await d.drive([sysMsg('角色设定\n\n输出格式'), userMsg('你好')]);
        expect(out).toHaveLength(2);
        expect((out[0] as { content: string }).content).toBe('角色设定\n\n补充约束\n\n输出格式');
        expect((out[1] as { role: string }).role).toBe('user');
    });

    it('system 文本未变化时不替换消息对象(引用保持)', async () => {
        const sources = [src({ entries: [{ content: '输出格式', target: 'system' }] }, 0, 's')];
        const original = sysMsg('角色设定\n\n输出格式');
        const d = makeDriver({ sources, base: ['角色设定'] });
        const out = await d.drive([original, userMsg('hi')]);
        expect(out[0]).toBe(original); // 同一引用 = 未重写
    });

    it('无 system 消息时 system 条目静默不崩', async () => {
        const sources = [src({ entries: [{ content: 'X', target: 'system' }] }, 0, 's')];
        const d = makeDriver({ sources });
        const out = await d.drive([userMsg('hi')]);
        expect(out).toHaveLength(1);
    });

    it('非持久化 depth 条目:每次请求动态插入,不写 sessionManager', async () => {
        const sources = [src({ entries: [{ content: '注入', depth: 0 }] }, 0, 's')];
        const d = makeDriver({ sources });
        const first = await d.drive([userMsg('hi')]);
        expect(d.appends).toEqual([]);
        expect(first.map((m) => roleOf(m))).toEqual(['user', 'user']);
        const second = await d.drive([userMsg('hi')]);
        expect(d.appends).toEqual([]);
        expect(second).toHaveLength(2);
    });

    it('持久化 depth 条目:首次写入 appendCustomMessageEntry,之后判重不再注入', async () => {
        const persistentSrc = src({ persistent: true, entries: [{ content: '常驻', depth: 0, id: 'perm' }] }, 0, 'p');
        const d = makeDriver({ sources: [persistentSrc] });
        const first = await d.drive([userMsg('hi')]);
        expect(d.appends).toEqual(['常驻']);
        expect(d.appendCustomMessageEntry).toHaveBeenCalledWith(LOREBOOK_ENTRY_TYPE, '常驻', false);
        expect(d.stats().persisted).toEqual(['perm']);
        // 第二次请求:已持久化 → 不再写、不再插入
        const second = await d.drive([userMsg('hi')]);
        expect(d.appends).toEqual(['常驻']);
        expect(second).toHaveLength(1);
    });

    it('requestIndex 递增传给 makeContext(trigger 可按请求轮次过滤)', async () => {
        let seenIndex = 0;
        const sources = [
            src(
                {
                    entries: (ctx) => {
                        seenIndex = ctx.requestIndex;
                        return [{ content: `第${String(ctx.requestIndex)}轮`, depth: 0 }];
                    },
                },
                0,
                's',
            ),
        ];
        const d = makeDriver({ sources });
        await d.drive([userMsg('hi')]);
        expect(seenIndex).toBe(1);
        await d.drive([userMsg('hi')]);
        expect(seenIndex).toBe(2);
    });

    it('评估抛错 → warning 记录,输出保持原样', async () => {
        const warns: string[] = [];
        const sources = [src({ entries: () => Promise.reject(new Error('boom')) }, 0, 'bad')];
        const { pi, handlers } = fakePi();
        const { factory } = createLorebookHook(
            {
                sourcesOf: () => sources,
                baseSystemPrompt: [],
                makeContext: (msgs, requestIndex) => ({
                    ...baseCtx(),
                    messages: toLorebookMessages(msgs),
                    requestIndex,
                }),
                warn: (m) => warns.push(m),
            },
            { appendCustomMessageEntry: vi.fn(() => 'id') },
        );
        factory(pi);
        const result = (await handlers.get('context_with_system')!({ messages: [userMsg('hi')] })) as {
            messages: AgentMessage[];
        };
        expect(warns.join('\n')).toContain('bad');
        expect(result.messages).toHaveLength(1);
    });
});

function roleOf(m: AgentMessage): string {
    return (m as { role: string }).role;
}
