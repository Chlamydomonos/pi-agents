/**
 * pi-web 插件 wire 协议(docs/70 §4,唯一真相;三方共用):
 * pi 扩展(pi.events 帧)→ 服务端插件(桥接/扇出/快照)→ 浏览器面板。
 *
 * 铁律:帧内禁止图片数据;preview 字段 ≤200 字(emit.ts 负责截断);
 * 全部 JSON-safe 纯类型与常量,零依赖。
 */

/** 扩展 ↔ 服务端插件事件通道名(70 §4) */
export const AGENTS_CHANNEL = 'pi-agents';

/** preview 截断长度(emit 出口统一执行;协议层只作约定) */
export const PREVIEW_LIMIT = 200;

/** 节点种类:Agent 子会话节点 / 函数节点 */
export type NodeKind = 'agent' | 'fn';

/* ------------------------------------------------------------------ */
/*  catalog(目录帧载荷,§4.1)                                          */
/* ------------------------------------------------------------------ */

export interface CatalogAgent {
    name: string;
    title: string;
    description: string;
    source: 'global' | 'workspace';
}

export interface CatalogNode {
    key: string;
    label?: string;
    kind: NodeKind;
    /** kind:'agent' 时的 Agent 名 */
    agent?: string;
}

export interface CatalogEdge {
    from: string;
    /** 'done' = 图外终点 */
    to: string | 'done';
    via: 'static' | 'route';
    /** 条件边展示候选(EdgeSpec.targets);无声明省略 */
    targets?: string[];
}

export interface CatalogFlow {
    name: string;
    title: string;
    description: string;
    source: 'global' | 'workspace';
    entry: string;
    nodes: CatalogNode[];
    edges: CatalogEdge[];
}

export interface CatalogWarnings {
    agents: CatalogAgent[];
    flows: CatalogFlow[];
    warnings: string[];
}

/* ------------------------------------------------------------------ */
/*  AgentFrame:扩展 → 服务端(pi.events.emit,无回放,§4.1)             */
/* ------------------------------------------------------------------ */

export type AgentFrame =
    | ({ kind: 'catalog' } & CatalogWarnings)
    | { kind: 'wake-start'; hostSessionId: string; wake: number; flow: string; inputPreview: string }
    | { kind: 'node-enter'; wake: number; node: string; visit: number; nodeKind: NodeKind }
    | {
          kind: 'node-exit';
          wake: number;
          node: string;
          visit: number;
          status: 'ok' | 'error';
          durationMs: number;
          textPreview?: string;
      }
    | { kind: 'edge'; wake: number; from: string; to: string | 'done'; via: 'static' | 'route' | 'maxIterations' }
    | { kind: 'spawn-start'; wake: number; parentPath: string; refKind: 'sub' | 'subflow'; name: string; label: string }
    | {
          kind: 'spawn-end';
          wake: number;
          parentPath: string;
          name: string;
          status: 'ok' | 'error' | 'aborted';
          durationMs: number;
      }
    | { kind: 'wake-end'; wake: number; status: 'completed' | 'failed' | 'aborted'; terminalPreview?: string };

/* ------------------------------------------------------------------ */
/*  BrowserFrame:浏览器 → 服务端(channel receive,§4.2)               */
/* ------------------------------------------------------------------ */

export type BrowserFrame = { kind: 'cmd'; action: 'refresh-catalog' };

/* ------------------------------------------------------------------ */
/*  ServerFrame:服务端 → 浏览器(channel send,§4.3)                    */
/* ------------------------------------------------------------------ */

/** 进行中/最近一次唤醒的快照缓冲(帧按序重放) */
export interface ActiveWakeSnapshot {
    wake: number;
    flow: string;
    status: 'running' | 'completed' | 'failed' | 'aborted';
    /** wake-start 起的全部帧(wake-end 后 status 落定) */
    frames: AgentFrame[];
}

export type ServerFrame =
    | AgentFrame
    | {
          kind: 'snapshot';
          catalog?: CatalogWarnings;
          active?: ActiveWakeSnapshot;
      }
    | { kind: 'error'; message: string };
