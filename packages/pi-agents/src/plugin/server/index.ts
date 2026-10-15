/**
 * pi-agents 服务端插件(server v3,docs/70 §3):
 * 桥接 pi 扩展事件(AGENTS_CHANNEL)→ 浏览器面板;唯一有状态职责 = 内存快照。
 *
 * - 会话桥接:每 (project, workspace, session) 一条 events 连接 + 一次订阅;
 *   先订阅后收帧铁律(pi-comfyui 30 §3.1 同款)
 * - 快照:catalog(最近一帧)+ 进行中/最近一次唤醒的帧缓冲(≤256 环形);
 *   openChannel 即发 snapshot;无磁盘持久化(Q5 只做实时)
 * - 扇出:每帧发全部订阅者;send 抛错(超限)→ 摘除该订阅者
 * - 服务端不读工作区、不做装载——扩展是唯一真相(D23)
 */
import { createHash } from 'node:crypto';
import {
    PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY,
    type PiWebHostPiSessionConnection,
    type PiWebHostPiSessionEventsV1,
    type PiWebServerPlugin,
    type ProjectInput,
    type ServerPluginActivation,
    type ServerPluginActivationContext,
    type ServerPluginPeerChannel,
    type ServerPluginPeerChannelOpenContext,
    type ServerPluginPeerRequestContext,
} from '@jmfederico/pi-web/server-plugin-api';
import { AGENTS_CHANNEL, type BrowserFrame, type AgentFrame } from '../../shared/protocol.js';
import { applyFrameToSnapshot, emptySnapshot, type WorkspaceSnapshot } from './snapshot.js';

type JsonValue = Parameters<ServerPluginPeerChannelOpenContext['send']>[0];

function toJson<T>(value: T): JsonValue {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function sha12(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

/* ------------------------------------------------------------------ */
/*  服务端插件:快照纯逻辑在 ./snapshot.ts(单测覆盖);此处接线           */
/* ------------------------------------------------------------------ */

export const agentsServerPlugin: PiWebServerPlugin = {
    apiVersion: 3,
    name: 'Pi Agents',
    requires: [PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],

    activate(context: ServerPluginActivationContext): ServerPluginActivation {
        const { logger, lifetimeSignal } = context;

        /** project+workspace key → 快照 */
        const snapshots = new Map<string, WorkspaceSnapshot>();
        /** sessionKey → events 连接 */
        const connections = new Map<string, PiWebHostPiSessionConnection>();
        /** sessionKey → 订阅取消函数 */
        const unsubscribers = new Map<string, () => void>();
        /** channel 订阅者(实时扇出用;close 时摘除) */
        const liveUnsubs = new Set<() => void>();
        let eventsV1: PiWebHostPiSessionEventsV1 | null = null;
        let disposed = false;

        const snapshotKey = (project: ProjectInput, workspacePath: string): string =>
            `${sha12(project.path)}|${sha12(workspacePath)}`;

        function getSnapshot(project: ProjectInput, workspacePath: string): WorkspaceSnapshot {
            const key = snapshotKey(project, workspacePath);
            let snap = snapshots.get(key);
            if (!snap) {
                snap = emptySnapshot();
                snapshots.set(key, snap);
            }
            return snap;
        }

        /* ---------------- pi-session events 桥接 ---------------- */

        async function connectSession(
            project: ProjectInput,
            workspaceId: string,
            sessionId: string,
        ): Promise<PiWebHostPiSessionConnection> {
            const key = `${project.id}/${workspaceId}/${sessionId}`;
            const existing = connections.get(key);
            if (existing) return existing;
            if (!eventsV1) throw new Error('插件尚未完成启动,无法连接会话事件');
            const connection = await eventsV1.connect({ projectId: project.id, workspaceId, sessionId });
            connections.set(key, connection);
            const onAbort = () => {
                connections.delete(key);
                const unsub = unsubscribers.get(key);
                if (unsub) {
                    unsub();
                    unsubscribers.delete(key);
                }
            };
            if (connection.signal.aborted) onAbort();
            else connection.signal.addEventListener('abort', onAbort, { once: true });
            return connection;
        }

        /** 每会话一次订阅:扩展帧 → 更新快照 + 扇出全部订阅者(先订阅后收帧) */
        function ensureSessionSubscription(
            project: ProjectInput,
            workspaceId: string,
            workspacePath: string,
            sessionId: string,
        ): void {
            const key = `${project.id}/${workspaceId}/${sessionId}`;
            if (unsubscribers.has(key)) return;
            const snap = getSnapshot(project, workspacePath);
            const handler = (data: unknown) => {
                const frame = data as AgentFrame;
                if (!frame || typeof frame !== 'object' || typeof frame.kind !== 'string') return;
                try {
                    // 帧归产生它的会话桶(运行图按会话隔离;catalog 除外——工作区级)
                    applyFrameToSnapshot(snap, frame, sessionId);
                } catch (error) {
                    logger.warn('pi-agents: 帧处理失败', { error: String(error) });
                }
                // 扇出是 connection.on 回调之外的事:每个 openChannel 的实时订阅各自转发,
                // 这里无需重复(见 openChannel:liveUnsubs 挂同一 connection)。
            };
            void connectSession(project, workspaceId, sessionId)
                .then((connection) => {
                    const unsub = connection.on(AGENTS_CHANNEL, handler);
                    unsubscribers.set(key, () => {
                        unsub();
                    });
                })
                .catch((error) => {
                    logger.warn('pi-agents: 会话事件订阅失败', { sessionId, error: String(error) });
                });
        }

        /* ---------------- lifecycle ---------------- */

        const activation: ServerPluginActivation = {
            start({ capabilities }) {
                eventsV1 = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
                logger.info('pi-agents: 服务端插件已启动', { pluginId: context.pluginId });
            },

            peer: {
                request: async (rc: ServerPluginPeerRequestContext): Promise<JsonValue> => {
                    try {
                        const snap = getSnapshot(rc.project, rc.workspace.path);
                        if (rc.operation === 'snapshot') {
                            // active 按请求的会话取(运行图会话隔离);catalog 工作区级
                            const input = (rc.input ?? {}) as { sessionId?: string };
                            const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
                            const bucket = sessionId ? snap.sessions.get(sessionId) : undefined;
                            return toJson({ catalog: snap.catalog, active: bucket?.active });
                        }
                        if (rc.operation === 'extension-status') {
                            // 该 workspace 是否有活着的会话订阅(诊断;70 §3.3)
                            return toJson({ connected: unsubscribers.size > 0 });
                        }
                        if (rc.operation === 'refresh-catalog') {
                            const input = (rc.input ?? {}) as { sessionId?: string };
                            const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
                            if (!sessionId) {
                                return toJson({ ok: false, error: '需要当前会话 ID 才能转发刷新命令' });
                            }
                            const connection = await connectSession(rc.project, rc.workspace.id, sessionId);
                            const frame: BrowserFrame = { kind: 'cmd', action: 'refresh-catalog' };
                            connection.emit(AGENTS_CHANNEL, frame);
                            return toJson({ ok: true });
                        }
                        return toJson({ ok: false, error: `未知操作:${rc.operation}` });
                    } catch (error) {
                        return toJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
                    }
                },

                openChannel: (ctx): ServerPluginPeerChannel | Promise<ServerPluginPeerChannel> => {
                    const input = (ctx.input ?? {}) as { sessionId?: string };
                    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
                    const snap = getSnapshot(ctx.project, ctx.workspace.path);

                    return (async (): Promise<ServerPluginPeerChannel> => {
                        let liveUnsub: (() => void) | null = null;
                        if (sessionId) {
                            ensureSessionSubscription(ctx.project, ctx.workspace.id, ctx.workspace.path, sessionId);
                            try {
                                const connection = await connectSession(ctx.project, ctx.workspace.id, sessionId);
                                // 实时扇出到本浏览器频道;send 抛错 → 摘除(超限关 channel,70 §3)
                                liveUnsub = connection.on(AGENTS_CHANNEL, (data: unknown) => {
                                    try {
                                        ctx.send(toJson(data));
                                    } catch (error) {
                                        logger.warn('pi-agents: 通道发送失败,摘除订阅', { error: String(error) });
                                        const u = liveUnsub;
                                        if (u) {
                                            liveUnsubs.delete(u);
                                            u();
                                            liveUnsub = null;
                                        }
                                    }
                                });
                                liveUnsubs.add(liveUnsub);
                            } catch (error) {
                                try {
                                    ctx.send(
                                        toJson({
                                            kind: 'error',
                                            message: `无法订阅会话事件:${error instanceof Error ? error.message : String(error)}`,
                                        }),
                                    );
                                } catch {
                                    /* channel may already be closed */
                                }
                            }
                        }
                        // 快照打底(断线重连/daemon 重启后浏览器 reload 由此恢复,70 §3.2);
                        // active 取本频道会话桶(会话隔离),catalog 工作区级
                        try {
                            const bucket = sessionId ? snap.sessions.get(sessionId) : undefined;
                            ctx.send(toJson({ kind: 'snapshot', catalog: snap.catalog, active: bucket?.active }));
                        } catch {
                            /* channel may already be closed */
                        }
                        // 快照无目录 → 向扩展补要一次(pi-web/插件重启后服务端快照清空,而扩展在
                        // session_start 发的 catalog 帧早于本订阅;经 AGENTS_CHANNEL 转发 refresh-catalog
                        // 让扩展从内存目录重发,订阅已在位,帧会扇回本 channel 并更新快照)
                        if (sessionId && !snap.catalog) {
                            void connectSession(ctx.project, ctx.workspace.id, sessionId)
                                .then((connection) =>
                                    connection.emit(AGENTS_CHANNEL, {
                                        kind: 'cmd',
                                        action: 'refresh-catalog',
                                    } satisfies BrowserFrame),
                                )
                                .catch((error) =>
                                    logger.warn('pi-agents: 打开频道补发 refresh-catalog 失败', {
                                        error: String(error),
                                    }),
                                );
                        }
                        const channelUnsub = liveUnsub;
                        const channel: ServerPluginPeerChannel = {
                            receive(data, _signal) {
                                // 浏览器 cmd 帧:refresh-catalog 转发给扩展;其余忽略
                                const frame = data as BrowserFrame;
                                if (
                                    frame &&
                                    typeof frame === 'object' &&
                                    frame.kind === 'cmd' &&
                                    frame.action === 'refresh-catalog' &&
                                    sessionId
                                ) {
                                    void connectSession(ctx.project, ctx.workspace.id, sessionId)
                                        .then((connection) =>
                                            connection.emit(AGENTS_CHANNEL, {
                                                kind: 'cmd',
                                                action: 'refresh-catalog',
                                            } satisfies BrowserFrame),
                                        )
                                        .catch((error) =>
                                            logger.warn('pi-agents: refresh-catalog 转发失败', {
                                                error: String(error),
                                            }),
                                        );
                                }
                            },
                            close() {
                                if (channelUnsub) {
                                    liveUnsubs.delete(channelUnsub);
                                    channelUnsub();
                                }
                            },
                        };
                        return channel;
                    })();
                },
            },

            async dispose() {
                if (disposed) return;
                disposed = true;
                for (const unsub of unsubscribers.values()) {
                    try {
                        unsub();
                    } catch {
                        /* already gone */
                    }
                }
                unsubscribers.clear();
                for (const unsub of liveUnsubs) {
                    try {
                        unsub();
                    } catch {
                        /* already gone */
                    }
                }
                liveUnsubs.clear();
                for (const connection of connections.values()) {
                    try {
                        connection.close();
                    } catch {
                        /* already gone */
                    }
                }
                connections.clear();
                snapshots.clear();
                logger.info('pi-agents: 服务端插件已释放');
            },

            health() {
                return { status: 'healthy' as const, message: 'pi-agents 目录与运行图帧通道就绪' };
            },
        };

        if (lifetimeSignal.aborted) void activation.dispose?.(lifetimeSignal);
        else lifetimeSignal.addEventListener('abort', () => void activation.dispose?.(lifetimeSignal), { once: true });

        return activation;
    },
};

export default agentsServerPlugin;
