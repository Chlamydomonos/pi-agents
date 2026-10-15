/**
 * 服务端插件快照状态(docs/70 §3.2):纯逻辑,便于单测(test/plugin.spec.ts)。
 * catalog = 最近一帧;active = 进行中/最近一次唤醒的帧缓冲(环形 ≤256)。
 * 按会话隔离:active 归产生它的会话,切会话互不串图;catalog 工作区级共享
 * (同一工作区目录一致,保留 workspace 级合并,避免每会话重复刷目录)。
 */
import type { ActiveWakeSnapshot, AgentFrame } from '../../shared/protocol.js';

/** 唤醒帧缓冲上限(环形,70 §3.2) */
export const MAX_WAKE_FRAMES = 256;

/** 单会话快照:active 来自该会话的扩展帧 */
export interface SessionSnapshot {
    /** 进行中/最近一次唤醒(覆盖式;status 非 running = 已落定) */
    active?: ActiveWakeSnapshot;
}

/** 工作区快照 = 共享 catalog + 每会话独立运行图 */
export interface WorkspaceSnapshot {
    /** 最近一次 catalog 帧(无 = 扩展还没发过;工作区级共享) */
    catalog?: Extract<AgentFrame, { kind: 'catalog' }>;
    /** sessionId → 会话运行图快照 */
    sessions: Map<string, SessionSnapshot>;
}

export function emptySnapshot(): WorkspaceSnapshot {
    return { sessions: new Map() };
}

/** 取(或建)某会话的快照桶 */
export function sessionBucket(snap: WorkspaceSnapshot, sessionId: string): SessionSnapshot {
    let s = snap.sessions.get(sessionId);
    if (!s) {
        s = {};
        snap.sessions.set(sessionId, s);
    }
    return s;
}

/** 帧进快照:catalog 工作区级直接替换;wake 帧按 sessionId 进各自会话桶 */
export function applyFrameToSnapshot(snap: WorkspaceSnapshot, frame: AgentFrame, sessionId: string): void {
    if (frame.kind === 'catalog') {
        snap.catalog = frame;
        return;
    }
    const bucket = sessionBucket(snap, sessionId);
    if (frame.kind === 'wake-start') {
        bucket.active = {
            wake: frame.wake,
            flow: frame.flow,
            status: 'running',
            frames: [frame],
        };
        return;
    }
    const active = bucket.active;
    // 孤帧/跨唤醒帧(wake 号与当前 active 不符):丢弃(70 §4.5 错误恢复)
    if (!active || frame.wake !== active.wake) return;
    if (frame.kind === 'wake-end') {
        active.status = frame.status;
        pushFrame(active, frame);
        return;
    }
    // node/edge/spawn 帧入栈
    pushFrame(active, frame);
}

export function pushFrame(active: ActiveWakeSnapshot, frame: AgentFrame): void {
    active.frames.push(frame);
    if (active.frames.length > MAX_WAKE_FRAMES) active.frames.shift(); // 环形:丢最旧
}
