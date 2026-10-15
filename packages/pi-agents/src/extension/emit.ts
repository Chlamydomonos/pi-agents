/**
 * 事件发射器(docs/40 §13,D23):pi-web 插件数据源。
 *
 * 消费扩展内部的装载结果与引擎轨迹,`pi.events.emit(AGENTS_CHANNEL, frame)` 发给
 * 服务端插件(协议见 src/shared/protocol.ts;**帧内无图片、preview ≤200 字**)。
 *
 * 设计:
 *   - emit 失败被吞(pi.events 无订阅者/序列化失败)——插件不在 = 零开销旁路
 *   - catalog 来自 LoadAllResult(扩展是唯一真相,D23);引擎帧由 stream/runtime
 *     回调(emit.ts 导出的轻量挂钩)提供
 *   - 全部函数纯同步;parentPath 复用 usage 的 agentPath 链格式(40 §6)
 */
import {
    AGENTS_CHANNEL,
    PREVIEW_LIMIT,
    type AgentFrame,
    type CatalogAgent,
    type CatalogEdge,
    type CatalogFlow,
    type CatalogNode,
    type NodeKind,
} from '../shared/protocol.js';
import type { LoadAllResult } from './loader/load.js';
import type { FlowDefinition, NodeSpec } from './types.js';

/** 截断到 PREVIEW_LIMIT(单行化:换行→空格;面板行内展示) */
export function preview(text: string | undefined | null, limit = PREVIEW_LIMIT): string {
    if (typeof text !== 'string') return '';
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

/** catalog 帧:装载结果 → 协议载荷(source 徽章/节点 kinds/边 via/targets) */
export function catalogFrom(result: LoadAllResult): Extract<AgentFrame, { kind: 'catalog' }> {
    const agents: CatalogAgent[] = result.agents.map((a) => ({
        name: a.def.name,
        title: a.def.title ?? '',
        description: a.def.description ?? '',
        source: a.workspace ? 'workspace' : 'global',
    }));
    const flows: CatalogFlow[] = result.flows.map((f) => flowToCatalog(f.def, f.workspace));
    return { kind: 'catalog', agents, flows, warnings: result.warnings.slice(0, 50) };
}

function flowToCatalog(def: FlowDefinition, workspace: boolean): CatalogFlow {
    const nodes: CatalogNode[] = Object.entries(def.nodes).map(([key, spec]) => ({
        key,
        ...(spec.label ? { label: spec.label } : {}),
        kind: nodeKind(spec),
        ...(spec.agent ? { agent: spec.agent } : {}),
    }));
    const edges: CatalogEdge[] = [];
    for (const [from, edge] of Object.entries(def.edges)) {
        if (typeof edge === 'string') {
            edges.push({ from, to: edge, via: 'static' });
        } else {
            // 条件边:静态目标未知 → to 未知;targets 声明即候选;否则画 ? 标记(70 §2.2)
            if (edge.targets && edge.targets.length > 0) {
                for (const t of edge.targets) {
                    edges.push({ from, to: t, via: 'route', ...(t === 'done' ? {} : {}) });
                }
            } else {
                edges.push({ from, to: 'done', via: 'route' }); // 无 targets:渲染端按 route 边画 ?
            }
        }
    }
    return {
        name: def.name,
        title: def.title ?? '',
        description: def.description ?? '',
        source: workspace ? 'workspace' : 'global',
        entry: def.entry,
        nodes,
        edges,
    };
}

function nodeKind(spec: NodeSpec): NodeKind {
    return spec.run ? 'fn' : 'agent';
}

/** 唤醒帧构造器(wakeIndex/flow 由 stream 层提供) */
export function wakeStartFrame(
    hostSessionId: string,
    wake: number,
    flow: string,
    inputPreview: string,
): Extract<AgentFrame, { kind: 'wake-start' }> {
    return { kind: 'wake-start', hostSessionId, wake, flow, inputPreview: preview(inputPreview) };
}

export function nodeEnterFrame(
    wake: number,
    node: string,
    visit: number,
    nodeKind: NodeKind,
): Extract<AgentFrame, { kind: 'node-enter' }> {
    return { kind: 'node-enter', wake, node, visit, nodeKind };
}

export function nodeExitFrame(
    wake: number,
    node: string,
    visit: number,
    status: 'ok' | 'error',
    durationMs: number,
    textPreview?: string,
): Extract<AgentFrame, { kind: 'node-exit' }> {
    return {
        kind: 'node-exit',
        wake,
        node,
        visit,
        status,
        durationMs,
        ...(textPreview ? { textPreview: preview(textPreview) } : {}),
    };
}

export function edgeFrame(
    wake: number,
    from: string,
    to: string | 'done',
    via: 'static' | 'route' | 'maxIterations',
): Extract<AgentFrame, { kind: 'edge' }> {
    return { kind: 'edge', wake, from, to, via };
}

export function spawnStartFrame(
    wake: number,
    parentPath: string,
    spawnKind: 'sub' | 'subflow',
    name: string,
    label: string,
): Extract<AgentFrame, { kind: 'spawn-start' }> {
    return { kind: 'spawn-start', wake, parentPath, refKind: spawnKind, name, label: preview(label) };
}

export function spawnEndFrame(
    wake: number,
    parentPath: string,
    name: string,
    status: 'ok' | 'error' | 'aborted',
    durationMs: number,
): Extract<AgentFrame, { kind: 'spawn-end' }> {
    return { kind: 'spawn-end', wake, parentPath, name, status, durationMs };
}

export function wakeEndFrame(
    wake: number,
    status: 'completed' | 'failed' | 'aborted',
    terminalPreview?: string,
): Extract<AgentFrame, { kind: 'wake-end' }> {
    return {
        kind: 'wake-end',
        wake,
        status,
        ...(terminalPreview ? { terminalPreview: preview(terminalPreview) } : {}),
    };
}

/**
 * 发射器工厂(index.ts 持有):emit 失败静默(无订阅者/宿主异常)。
 * 返回 null-safe emit(测试可注入假 sink)。
 */
export interface Emitter {
    (frame: AgentFrame): void;
}

export function createEmitter(sink: (frame: AgentFrame) => void): Emitter {
    return (frame) => {
        try {
            sink(frame);
        } catch {
            /* 无订阅者/通道关闭:零开销旁路(40 §13) */
        }
    };
}

/** pi.events 上的标准发射器 */
export function piEventEmitter(events: { emit: (channel: string, data: unknown) => void }): Emitter {
    return createEmitter((frame) => {
        events.emit(AGENTS_CHANNEL, frame);
    });
}
