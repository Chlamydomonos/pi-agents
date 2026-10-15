/**
 * 引擎上下文构造(docs/20 §3.2/§5.3、docs/40 §4.3)。
 *
 * RouteContext / FuncNodeContext / PassContext 都共享同一 scratch 桶与 trail;
 * 这里提供一致的构造入口,保证 ctx.extra 语义统一(flow meta)。
 */

import type { FlowDefinition, HostSessionView, RouteContext, WakeContext } from '../types.js';

/** 一次唤醒内的运行期共享状态(runner 持有;ctx 拿到的是只读投影或同一可变桶) */
export interface RunState {
    flow: FlowDefinition;
    wake: WakeContext;
    /** 跨节点/跨轮共享便签桶(docs/20 §3.2) */
    scratch: Record<string, unknown>;
    /** 已完成节点输出轨迹(docs/20 §6) */
    trail: Array<{ node: string; visit: number; text: string; data?: unknown }>;
    /** 节点执行计数(该唤醒内,从 1 起) */
    counters: Map<string, number>;
    /** 宿主会话只读视图(docs/20 §2.2 ctx.host;由 runtime 从宿主请求消息投影) */
    host: HostSessionView;
}

export function createRunState(flow: FlowDefinition, wake: WakeContext, host: HostSessionView): RunState {
    return { flow, wake, scratch: {}, trail: [], counters: new Map(), host };
}

/** 构造 RouteContext(extra = flow meta,docs/20 §3.2) */
export function routeContext(state: RunState, visit: number): RouteContext {
    return { visit, wake: state.wake, scratch: state.scratch, extra: state.flow.meta };
}

/** 函数节点 ctx extra 同样取 flow meta(docs/20 §2.2) */
export function funcNodeExtra(state: RunState): unknown {
    return state.flow.meta;
}

/** 下游节点本次的进入序号(counters 预读,不自增) */
export function peekVisit(state: RunState, node: string): number {
    return (state.counters.get(node) ?? 0) + 1;
}
