/**
 * 会话池(docs/40 §3):工作流节点子会话的内存缓存。
 *
 * 键 = flowName + hostSessionId + nodeName;fresh 模式每次唤醒替换对象
 * (identity 编入唤醒批次,失配即弃旧建新),inherit 模式跨唤醒复用
 * (首唤醒 seed 宿主历史摘要,§4.2)。
 * 生命周期:session_shutdown / session_tree 时整体清空(§3.2/§8/§9);
 * Esc 中断后,本次唤醒涉及的 inherit 节点由 runtime 调 evict 弃池(§8)。
 */

import type { AgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

export interface NodeSession {
    session: AgentSession;
    sessionManager: SessionManager;
    /** inherit 首唤醒已注入宿主历史(docs/40 §4.2) */
    seeded: boolean;
    /** 节点身份指纹(agent/sessionMode/唤醒批次变了 → 弃用重建,§2.2/§3.2) */
    identity: string;
    /** 建池时的唤醒序号(调试/展示) */
    wakeIndex: number;
}

export interface AcquireArgs {
    flowName: string;
    nodeKey: string;
    hostSessionId: string;
    /** 节点身份指纹;与池中不同 → 弃旧建新 */
    identity: string;
    wakeIndex: number;
    /** 创建新 session(池不管怎么建,只管何时复用/替换) */
    create: () => Promise<{ session: AgentSession; sessionManager: SessionManager }>;
}

export class SessionPool {
    private node = new Map<string, NodeSession>();

    private key(flowName: string, hostSessionId: string, nodeKey: string): string {
        return `${flowName}#${hostSessionId}#${nodeKey}`;
    }

    /** 取子会话:命中且身份一致 → 复用;否则弃旧建新 */
    async acquire(args: AcquireArgs): Promise<NodeSession> {
        const k = this.key(args.flowName, args.hostSessionId, args.nodeKey);
        const hit = this.node.get(k);
        if (hit && hit.identity === args.identity) return hit;
        await this.disposeKey(k);
        const built = await args.create();
        const ns: NodeSession = {
            session: built.session,
            sessionManager: built.sessionManager,
            seeded: false,
            identity: args.identity,
            wakeIndex: args.wakeIndex,
        };
        this.node.set(k, ns);
        return ns;
    }

    /** 标记 inherit 已 seed */
    markSeeded(flowName: string, nodeKey: string, hostSessionId: string): void {
        const hit = this.node.get(this.key(flowName, hostSessionId, nodeKey));
        if (hit) hit.seeded = true;
    }

    /** 中断污染清理(docs/40 §8):指定键弃池 */
    async evict(flowName: string, nodeKey: string, hostSessionId: string): Promise<void> {
        await this.disposeKey(this.key(flowName, hostSessionId, nodeKey));
    }

    /** 幂等整体清理(session_shutdown 可触发多次,docs/60 §7) */
    async disposeAll(): Promise<void> {
        const entries = [...this.node.values()];
        this.node.clear();
        for (const ns of entries) await disposeNodeSession(ns);
    }

    /** 内部:单个键的 dispose(abort + dispose 防泄漏) */
    private async disposeKey(k: string): Promise<void> {
        const hit = this.node.get(k);
        if (!hit) return;
        this.node.delete(k);
        await disposeNodeSession(hit);
    }
}

async function disposeNodeSession(ns: NodeSession): Promise<void> {
    try {
        await ns.session.abort();
    } catch {
        /* 已 idle 时 abort 可能报错;忽略 */
    }
    try {
        ns.session.dispose();
    } catch {
        /* 幂等 */
    }
}
