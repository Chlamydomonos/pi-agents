/**
 * M9 pi-web 插件测试(docs/70 §7 验收:协议铁律 + 快照状态机 + 目录映射):
 * - 协议铁律:帧 JSON-safe、无图片数据、preview ≤200
 * - emit:preview 截断/单行化;catalogFrom 映射(nodes/edges/targets/source);帧构造器
 * - server 快照:catalog 替换、wake-start 重建、wake-end 落定、256 环形、孤帧丢弃
 * - validate:EdgeSpec.targets 成员校验(D24)
 */
import { describe, expect, it } from 'vitest';
import { AGENTS_CHANNEL, PREVIEW_LIMIT, type ActiveWakeSnapshot, type AgentFrame } from '../src/shared/protocol.js';
import {
    catalogFrom,
    createEmitter,
    edgeFrame,
    nodeEnterFrame,
    nodeExitFrame,
    piEventEmitter,
    preview,
    spawnEndFrame,
    spawnStartFrame,
    wakeEndFrame,
    wakeStartFrame,
} from '../src/extension/emit.js';
import {
    applyFrameToSnapshot,
    emptySnapshot,
    sessionBucket,
    MAX_WAKE_FRAMES,
    pushFrame,
    type WorkspaceSnapshot,
} from '../src/plugin/server/snapshot.js';
import type { AgentDefinition, FlowDefinition } from '../src/extension/types.js';
import type { LoadAllResult, LoadedAgent, LoadedFlow } from '../src/extension/loader/load.js';

/* ------------------------------------------------------------------ */
/*  帮手                                                                */
/* ------------------------------------------------------------------ */

/** 递归断言帧内无图片数据(base64 data: URI / 1KB+ 长字符串) */
function assertNoImages(value: unknown, path = ''): void {
    if (typeof value === 'string') {
        expect(value.startsWith('data:image/'), `${path}: 图片 data URI 禁入帧`).toBe(false);
        expect(value.length, `${path}: 单字段 ≤2KB(无图片载荷)`).toBeLessThan(2048);
        return;
    }
    if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) assertNoImages(v, `${path}[${i}]`);
        return;
    }
    if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            expect(k.toLowerCase()).not.toMatch(/image|base64|blob/);
            assertNoImages(v, `${path}.${k}`);
        }
    }
}

/** 帧可 JSON 序列化(线协议铁律) */
function assertJsonSafe(frame: AgentFrame): void {
    expect(() => JSON.stringify(frame)).not.toThrow();
}

const agentDef = (name: string, workspace = false): LoadedAgent => ({
    def: { name, title: `${name} 标题`, description: '', systemPrompt: '', subagents: [] } as AgentDefinition,
    filePath: `/x/${name}.ts`,
    workspace,
    subagentRefs: [],
});

const flowDef = (def: Partial<FlowDefinition> & { name: string }): LoadedFlow => ({
    def: {
        title: '',
        description: '',
        nodes: {},
        entry: 'a',
        edges: {},
        ...def,
    } as FlowDefinition,
    filePath: `/x/${def.name}.ts`,
    workspace: false,
});

const loadResult = (over: Partial<LoadAllResult> = {}): LoadAllResult => ({
    agents: [],
    flows: [],
    lorebooks: [],
    warnings: [],
    invalid: [],
    ...over,
});

/* ------------------------------------------------------------------ */
/*  协议常量                                                            */
/* ------------------------------------------------------------------ */

describe('protocol', () => {
    it('常量与文档一致(70 §4)', () => {
        expect(AGENTS_CHANNEL).toBe('pi-agents');
        expect(PREVIEW_LIMIT).toBe(200);
    });
});

/* ------------------------------------------------------------------ */
/*  preview / 帧构造器                                                  */
/* ------------------------------------------------------------------ */

describe('preview', () => {
    it('单行化:换行/多空白折叠', () => {
        expect(preview('a\nb\r\nc  d')).toBe('a b c d');
    });
    it('超 200 截断并加省略号', () => {
        const long = 'x'.repeat(PREVIEW_LIMIT + 50);
        const out = preview(long);
        expect(out.length).toBe(PREVIEW_LIMIT + 1);
        expect(out.endsWith('…')).toBe(true);
    });
    it('恰好 200 不截断', () => {
        expect(preview('y'.repeat(200)).length).toBe(200);
    });
    it('非字符串安全返回空', () => {
        expect(preview(undefined)).toBe('');
        expect(preview(null)).toBe('');
    });
});

describe('frame builders', () => {
    it('各帧 JSON-safe 且无图片数据', () => {
        const frames: AgentFrame[] = [
            wakeStartFrame('host-1', 0, 'dev-loop', '用户输入 '.repeat(40)),
            nodeEnterFrame(0, 'code', 1, 'agent'),
            nodeExitFrame(0, 'code', 1, 'ok', 1234, '产出文本 '.repeat(60)),
            edgeFrame(0, 'code', 'done', 'static'),
            spawnStartFrame(0, 'flow:dev-loop#code', 'sub', 'writer', '写手'),
            spawnEndFrame(0, 'flow:dev-loop#code', 'writer', 'ok', 99),
            wakeEndFrame(0, 'completed', '终端输出 '.repeat(80)),
            { kind: 'catalog', agents: [], flows: [], warnings: [] },
        ];
        for (const f of frames) {
            assertJsonSafe(f);
            assertNoImages(f);
        }
    });

    it('wake-start 帧形状(70 §4.1)', () => {
        const f = wakeStartFrame('host-1', 2, 'dev-loop', 'hi');
        expect(f).toMatchObject({
            kind: 'wake-start',
            hostSessionId: 'host-1',
            wake: 2,
            flow: 'dev-loop',
            inputPreview: 'hi',
        });
    });

    it('超限 preview 在构造器出口截断', () => {
        const f = wakeStartFrame('h', 0, 'f', 'z'.repeat(500));
        expect(f.inputPreview.length).toBe(PREVIEW_LIMIT + 1);
    });

    it('edge 帧 via 三态', () => {
        expect(edgeFrame(0, 'a', 'b', 'static').via).toBe('static');
        expect(edgeFrame(0, 'a', 'b', 'route').via).toBe('route');
        expect(edgeFrame(0, 'a', 'done', 'maxIterations').via).toBe('maxIterations');
    });
});

/* ------------------------------------------------------------------ */
/*  catalogFrom:LoadAllResult → catalog 帧                              */
/* ------------------------------------------------------------------ */

describe('catalogFrom', () => {
    it('映射 agents/flows 与 source 徽章', () => {
        const result = loadResult({
            agents: [agentDef('writer'), agentDef('reviewer', true)],
            flows: [flowDef({ name: 'dev-loop' }), flowDef({ name: 'other', nodes: { a: { agent: 'writer' } } })],
        });
        result.flows[1]!.workspace = true;
        const frame = catalogFrom(result);
        expect(frame.kind).toBe('catalog');
        assertJsonSafe(frame);
        assertNoImages(frame);
        expect(frame.agents).toEqual([
            { name: 'writer', title: 'writer 标题', description: '', source: 'global' },
            { name: 'reviewer', title: 'reviewer 标题', description: '', source: 'workspace' },
        ]);
        expect(frame.flows.map((f) => f.name)).toEqual(['dev-loop', 'other']);
        expect(frame.flows[1]!.source).toBe('workspace');
    });

    it('静态边 via:static;条件边 targets → route 候选边;无 targets → done 候选', () => {
        const frame = catalogFrom(
            loadResult({
                flows: [
                    flowDef({
                        name: 'f',
                        nodes: { a: { agent: 'w' }, b: { run: () => 'x' } },
                        entry: 'a',
                        edges: {
                            a: 'b',
                            b: {
                                route: () => 'wrap',
                                targets: ['wrap', 'done'],
                            },
                        },
                    }),
                ],
            }),
        );
        const flow = frame.flows[0]!;
        expect(flow.nodes).toEqual([
            { key: 'a', kind: 'agent', agent: 'w' },
            { key: 'b', kind: 'fn' },
        ]);
        expect(flow.edges).toEqual([
            { from: 'a', to: 'b', via: 'static' },
            { from: 'b', to: 'wrap', via: 'route' },
            { from: 'b', to: 'done', via: 'route' },
        ]);
    });

    it('label/agent 可选字段与 warnings 截 50', () => {
        const frame = catalogFrom(
            loadResult({
                flows: [flowDef({ name: 'f', nodes: { a: { agent: 'w', label: '写' } }, edges: {} })],
                warnings: Array.from({ length: 70 }, (_, i) => `w${i}`),
            }),
        );
        expect(frame.flows[0]!.nodes[0]).toEqual({ key: 'a', label: '写', kind: 'agent', agent: 'w' });
        expect(frame.warnings).toHaveLength(50);
    });
});

/* ------------------------------------------------------------------ */
/*  Emitter                                                            */
/* ------------------------------------------------------------------ */

describe('emitter', () => {
    it('piEventEmitter 发到 AGENTS_CHANNEL', () => {
        const sent: Array<{ channel: string; data: unknown }> = [];
        const emit = piEventEmitter({ emit: (channel, data) => sent.push({ channel, data }) });
        emit(wakeStartFrame('h', 0, 'f', 'x'));
        expect(sent).toHaveLength(1);
        expect(sent[0]!.channel).toBe(AGENTS_CHANNEL);
        expect((sent[0]!.data as AgentFrame).kind).toBe('wake-start');
    });

    it('createEmitter 吞掉 sink 异常(零开销旁路)', () => {
        const emit = createEmitter(() => {
            throw new Error('boom');
        });
        expect(() => emit(wakeStartFrame('h', 0, 'f', 'x'))).not.toThrow();
    });
});

/* ------------------------------------------------------------------ */
/*  server 快照状态机                                                   */
/* ------------------------------------------------------------------ */

describe('server snapshot', () => {
    const wakeStart = (wake: number, flow = 'dev-loop'): AgentFrame => ({
        kind: 'wake-start',
        hostSessionId: 'h',
        wake,
        flow,
        inputPreview: 'q',
    });

    it('catalog 帧替换;无 active 时 node 帧被丢弃', () => {
        const snap = emptySnapshot();
        const catalog: AgentFrame = { kind: 'catalog', agents: [], flows: [], warnings: [] };
        applyFrameToSnapshot(snap, catalog, 's1');
        expect(snap.catalog).toBe(catalog);
        applyFrameToSnapshot(snap, { kind: 'node-enter', wake: 0, node: 'a', visit: 1, nodeKind: 'agent' }, 's1');
        expect(sessionBucket(snap, 's1').active).toBeUndefined();
        const catalog2: AgentFrame = { kind: 'catalog', agents: [], flows: [], warnings: ['x'] };
        applyFrameToSnapshot(snap, catalog2, 's1');
        expect(snap.catalog).toBe(catalog2);
    });

    it('wake-start 重建缓冲;node/edge/spawn 入栈;wake-end 落定 status', () => {
        const snap = emptySnapshot();
        applyFrameToSnapshot(snap, wakeStart(3), 's1');
        applyFrameToSnapshot(snap, { kind: 'node-enter', wake: 3, node: 'code', visit: 1, nodeKind: 'agent' }, 's1');
        applyFrameToSnapshot(snap, { kind: 'edge', wake: 3, from: 'code', to: 'done', via: 'static' }, 's1');
        applyFrameToSnapshot(
            snap,
            {
                kind: 'spawn-start',
                wake: 3,
                parentPath: 'flow:dev-loop#code',
                refKind: 'sub',
                name: 'writer',
                label: '写手',
            },
            's1',
        );
        applyFrameToSnapshot(snap, { kind: 'wake-end', wake: 3, status: 'completed', terminalPreview: 'done' }, 's1');
        expect(sessionBucket(snap, 's1').active).toBeDefined();
        expect(sessionBucket(snap, 's1').active!.wake).toBe(3);
        expect(sessionBucket(snap, 's1').active!.status).toBe('completed');
        expect(sessionBucket(snap, 's1').active!.frames.map((f) => f.kind)).toEqual([
            'wake-start',
            'node-enter',
            'edge',
            'spawn-start',
            'wake-end',
        ]);
    });

    it('第二次唤醒覆盖(替换 active);wake-end 孤帧丢弃', () => {
        const snap = emptySnapshot();
        applyFrameToSnapshot(snap, wakeStart(0), 's1');
        applyFrameToSnapshot(snap, { kind: 'wake-end', wake: 0, status: 'failed' }, 's1');
        applyFrameToSnapshot(snap, { kind: 'wake-end', wake: 1, status: 'completed' }, 's1'); // 无 start:丢弃
        expect(sessionBucket(snap, 's1').active!.status).toBe('failed');
        applyFrameToSnapshot(snap, wakeStart(1), 's1');
        expect(sessionBucket(snap, 's1').active!.wake).toBe(1);
        expect(sessionBucket(snap, 's1').active!.status).toBe('running');
        expect(sessionBucket(snap, 's1').active!.frames).toHaveLength(1);
    });

    it('会话隔离:同工作区两个会话的运行图互不串;catalog 共享', () => {
        const snap = emptySnapshot();
        // 会话 A:dev-loop 唤醒 1
        applyFrameToSnapshot(snap, wakeStart(1, 'dev-loop'), 'sessA');
        applyFrameToSnapshot(snap, { kind: 'node-enter', wake: 1, node: 'plan', visit: 1, nodeKind: 'agent' }, 'sessA');
        // 会话 B:fn-test 唤醒 1(独立 wake 号也独立图)
        applyFrameToSnapshot(snap, wakeStart(1, 'fn-test'), 'sessB');
        applyFrameToSnapshot(snap, { kind: 'node-enter', wake: 1, node: 'a', visit: 1, nodeKind: 'fn' }, 'sessB');
        // 各自的 active 互不干扰
        const a = sessionBucket(snap, 'sessA').active as ActiveWakeSnapshot;
        const b = sessionBucket(snap, 'sessB').active as ActiveWakeSnapshot;
        expect(a.flow).toBe('dev-loop');
        expect(a.frames).toHaveLength(2);
        expect(b.flow).toBe('fn-test');
        expect(b.frames).toHaveLength(2);
        // 同 wake 号的帧进对桶:帧不校验节点归属,只按 sessionId 分桶
        applyFrameToSnapshot(
            snap,
            { kind: 'node-exit', wake: 1, node: 'a', visit: 1, status: 'ok', durationMs: 1, textPreview: '' },
            'sessA',
        );
        expect(a.frames).toHaveLength(3);
        expect(b.frames).toHaveLength(2); // B 桶不受影响
        // catalog 是工作区级:任一会话发的 catalog 都落到共享位置
        applyFrameToSnapshot(snap, { kind: 'catalog', agents: [], flows: [], warnings: [] }, 'sessB');
        expect(snap.catalog).toBeDefined();
        expect(snap.sessions.size).toBe(2);
    });

    it('环形缓冲:超 256 丢最旧(含 wake-start)', () => {
        const snap = emptySnapshot();
        applyFrameToSnapshot(snap, wakeStart(0), 's1');
        const total = MAX_WAKE_FRAMES + 20;
        for (let i = 0; i < total; i++) {
            applyFrameToSnapshot(snap, { kind: 'node-enter', wake: 0, node: 'a', visit: i + 1, nodeKind: 'fn' }, 's1');
        }
        const active = sessionBucket(snap, 's1').active as ActiveWakeSnapshot;
        expect(active.frames).toHaveLength(MAX_WAKE_FRAMES);
        expect(active.frames[0]!.kind).toBe('node-enter');
        expect((active.frames[0] as Extract<AgentFrame, { kind: 'node-enter' }>).visit).toBe(
            total - MAX_WAKE_FRAMES + 1,
        );
        expect((active.frames[MAX_WAKE_FRAMES - 1] as Extract<AgentFrame, { kind: 'node-enter' }>).visit).toBe(total);
    });

    it('pushFrame 直接环形', () => {
        const active: ActiveWakeSnapshot = { wake: 0, flow: 'f', status: 'running', frames: [] };
        for (let i = 0; i < MAX_WAKE_FRAMES + 5; i++) {
            pushFrame(active, { kind: 'node-enter', wake: 0, node: 'a', visit: i + 1, nodeKind: 'fn' });
        }
        expect(active.frames).toHaveLength(MAX_WAKE_FRAMES);
    });
});
