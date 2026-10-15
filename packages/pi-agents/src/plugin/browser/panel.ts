/**
 * pi-agents 面板(docs/70 §2.1/2.2):目录区(工作流/智能体)+ 运行图区。
 *
 * - 目录只信 catalog 帧(扩展唯一真相,D23/70 §5);简易展示(Q6)
 * - 运行图:静态结构来自 catalog,动态来自 wake/node/edge/spawn 帧重放(70 §2.2)
 * - 布局在 graph-layout.ts(@dagrejs/dagre 二维分层 + 长链蛇形换行);
 *   SVG 渲染在 graph-render.ts;本文件 = 元素/帧重放/目录/spawn 子图拼接
 * - spawn 的子智能体/子工作流在运行时拼接进图(子图组 + 连接虚线)
 * - 帧文本一律 Lit 默认转义;channel/abort 正确清理
 */
import { LitElement, css, html, svg, nothing, type TemplateResult } from 'lit';
import type { JsonValue, PluginPeerChannel, WorkspacePanelContext } from '@jmfederico/pi-web/plugin-api';
import type { AgentFrame, CatalogAgent, CatalogFlow, ServerFrame } from '../../shared/protocol.js';
import { panelStyles } from './panel-css.js';
import { layoutFlow, composeLayouts, type GraphLayout, type SubGraphSpec } from './graph-layout.js';
import {
    STATUS_COLOR,
    renderEdges,
    renderNodes,
    renderSubGraphs,
    renderSubLinks,
    type RunView,
} from './graph-render.js';

/* ------------------------------------------------------------------ */
/*  视图状态                                                            */
/* ------------------------------------------------------------------ */

/** 动态状态(按帧重放) */
interface RunState {
    wake: number;
    flow: string;
    status: 'running' | 'completed' | 'failed' | 'aborted';
    current?: string;
    /** 节点 visit 计数 */
    visits: Map<string, number>;
    /** 节点终态颜色:'ok' | 'error' */
    exits: Map<string, 'ok' | 'error'>;
    /** spawn 徽章:parentPath → {name, refKind, status, label}[] */
    spawns: Map<string, Array<{ name: string; refKind: 'sub' | 'subflow'; status?: string; label: string }>>;
    maxIterationsHit: Set<string>;
    /** 走过的边("from>to";edge 帧轨迹,渲染点亮) */
    walkedEdges: Set<string>;
    inputPreview?: string;
    terminalPreview?: string;
}

const PANEL_TAG = 'pi-agents-panel';

/** 面板注册表(browser index 的 render 每次新建元素,attachPanel 供 invalidation 用) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const panelRef: { current: any } = { current: null };
export const attachPanel = {
    get current(): PiAgentsPanelElement | null {
        return panelRef.current as PiAgentsPanelElement | null;
    },
    set(el: PiAgentsPanelElement | null) {
        panelRef.current = el;
    },
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/*  面板元素                                                            */
/* ------------------------------------------------------------------ */

export class PiAgentsPanelElement extends LitElement {
    static properties = {
        panelCtx: { attribute: false, state: true },
    };

    panelCtx?: WorkspacePanelContext;

    static styles = panelStyles;

    /* 目录/图状态 */
    private catalog?: SnapshotCatalog;
    private selectedFlow?: string; // 目录点选 → 静态图
    private expanded = { flows: true, agents: true };
    private showWarnings = false;

    /* 运行图状态(帧重放) */
    private run?: RunState;
    private banner?: string;
    private extensionMissing = false;

    /* live channel */
    private channel?: PluginPeerChannel;
    private liveSessionId?: string;
    private channelAbort?: AbortController;
    private seq = 0;

    connectedCallback(): void {
        super.connectedCallback();
        attachPanel.set(this);
        void this.refresh();
    }

    disconnectedCallback(): void {
        attachPanel.set(null);
        this.closeChannel();
        this.channelAbort?.abort();
        super.disconnectedCallback();
    }

    protected willUpdate(changed: Map<string, unknown>): void {
        if (changed.has('panelCtx') && this.panelCtx) {
            const workspaceId = this.panelCtx.workspace.id;
            if (this.lastWorkspaceId !== workspaceId) {
                this.lastWorkspaceId = workspaceId;
                this.catalog = undefined;
                this.run = undefined;
                this.banner = undefined;
                this.extensionMissing = false;
                this.closeChannel();
                void this.refresh();
            }
        }
        // 会话切换 → 图随 selectedSession 变化(70 §7)
        const sessionId = this.sessionId();
        if (sessionId !== this.lastSessionId) {
            this.lastSessionId = sessionId;
            this.closeChannel();
            this.run = undefined;
            void this.refresh();
        }
    }

    /** 宿主失效通知(workspacePanels 贡献 onInvalidate):重查会话切换 + 刷数据 */
    onHostInvalidate(): void {
        const sessionId = this.sessionId();
        if (sessionId !== this.lastSessionId) {
            this.lastSessionId = sessionId;
            this.closeChannel();
            this.run = undefined;
            void this.refresh();
        }
    }

    private lastWorkspaceId?: string;
    private lastSessionId?: string;

    private sessionId(): string | undefined {
        const session = this.panelCtx?.state?.selectedSession;
        return session && !session.pending ? session.id : undefined;
    }

    /* ---------------- 数据 ---------------- */

    async refresh(): Promise<void> {
        const seq = ++this.seq;
        const sessionId = this.sessionId();
        this.ensureLiveChannel(sessionId);
        const request = this.peerRequest();
        if (!request) {
            if (seq === this.seq) this.banner = '面板未连接到宿主 peer';
            return;
        }
        try {
            const result = (await request('snapshot', sessionId ? { sessionId } : {})) as unknown;
            if (seq !== this.seq) return;
            const snap = result as { catalog?: SnapshotCatalog; active?: RunSnapshotActive };
            this.catalog = snap.catalog;
            this.extensionMissing = false;
            this.banner = undefined;
            if (snap.active) this.replayActive(snap.active);
        } catch (error) {
            if (seq !== this.seq) return;
            // snapshot 失败 = 扩展未装/未启用(70 §4.5):面板提示不报错
            this.extensionMissing = true;
            this.banner = `无法获取快照(本工作区可能未启用 pi-agents 扩展):${errorText(error)}`;
        }
        this.requestUpdate();
    }

    /** 快照 active 载荷 → 逐帧重放重建 RunState */
    private replayActive(active: RunSnapshotActive): void {
        const run: RunState = {
            wake: active.wake,
            flow: active.flow,
            status: active.status,
            visits: new Map(),
            exits: new Map(),
            spawns: new Map(),
            maxIterationsHit: new Set(),
            walkedEdges: new Set(),
        };
        for (const frame of active.frames) this.applyFrame(run, frame);
        this.run = run;
    }

    private applyFrame(run: RunState, frame: AgentFrame): void {
        switch (frame.kind) {
            case 'wake-start':
                run.current = undefined;
                run.visits.clear();
                run.exits.clear();
                run.spawns.clear();
                run.maxIterationsHit.clear();
                run.inputPreview = frame.inputPreview;
                break;
            case 'node-enter':
                run.current = frame.node;
                // visit 以帧内显式值为准(扩展层 state.counters 维护,权威计数);
                // 不在浏览器端 +1——重放/重连/重复帧时自累加会虚高(实测 ×2 假象)
                if (typeof frame.visit === 'number') run.visits.set(frame.node, frame.visit);
                else run.visits.set(frame.node, (run.visits.get(frame.node) ?? 0) + 1);
                run.exits.delete(frame.node);
                break;
            case 'node-exit':
                run.exits.set(frame.node, frame.status);
                break;
            case 'edge':
                run.walkedEdges.add(`${frame.from}>${frame.to}`);
                if (frame.via === 'maxIterations') run.maxIterationsHit.add(frame.from);
                break;
            case 'spawn-start': {
                const list = run.spawns.get(frame.parentPath) ?? [];
                list.push({ name: frame.name, refKind: frame.refKind, label: frame.label });
                run.spawns.set(frame.parentPath, list);
                break;
            }
            case 'spawn-end': {
                const list = run.spawns.get(frame.parentPath);
                if (list) {
                    const item = [...list].reverse().find((s) => s.name === frame.name && s.status === undefined);
                    if (item) item.status = frame.status;
                }
                break;
            }
            case 'wake-end':
                run.status = frame.status;
                run.terminalPreview = frame.terminalPreview;
                run.current = undefined;
                break;
            default:
                break;
        }
    }

    /* ---------------- live channel ---------------- */

    private peerRequest(): ((operation: string, input?: unknown) => Promise<unknown>) | undefined {
        const peer = this.panelCtx?.peer as
            | { request?: (operation: string, input?: unknown) => Promise<unknown> }
            | undefined;
        return peer?.request;
    }

    private ensureLiveChannel(sessionId: string | undefined): void {
        if (!sessionId || (sessionId === this.liveSessionId && this.channel)) return;
        this.closeChannel();
        const peer = this.panelCtx?.peer;
        if (!peer?.openChannel) return;
        this.liveSessionId = sessionId;
        this.channelAbort = new AbortController();
        const signal = this.channelAbort.signal;
        const thisSeq = ++this.seq;
        void (async () => {
            try {
                const channel = await peer.openChannel!(
                    'live',
                    { sessionId },
                    { signal, onData: (data: JsonValue) => this.onFrame(data) },
                );
                if (this.liveSessionId !== sessionId || signal.aborted) {
                    channel.close('superseded');
                    return;
                }
                this.channel = channel;
                // 快照打底 + 目录补发由服务端 openChannel 负责(snap.catalog 为空时自动向扩展
                // 补要一次 refresh-catalog);此处无需再请求。
            } catch (error) {
                if (thisSeq === this.seq) {
                    this.banner = `实时帧通道打开失败:${errorText(error)}`;
                    this.requestUpdate();
                }
            }
        })();
    }

    private closeChannel(): void {
        this.channel?.close('panel disconnected');
        this.channel = undefined;
        this.liveSessionId = undefined;
    }

    private onFrame(data: JsonValue): void {
        if (!data || typeof data !== 'object') return;
        const frame = data as ServerFrame;
        if (frame.kind === 'error') {
            this.banner = frame.message;
            this.requestUpdate();
            return;
        }
        if (frame.kind === 'snapshot') {
            this.catalog = frame.catalog;
            if (frame.active) this.replayActive(frame.active as RunSnapshotActive);
            this.requestUpdate();
            return;
        }
        // AgentFrame:目录帧/运行帧
        if (frame.kind === 'catalog') {
            this.catalog = frame;
            this.requestUpdate();
            return;
        }
        if (frame.kind === 'wake-start') {
            // 新唤醒重置(70 §2.2)
            this.run = {
                wake: frame.wake,
                flow: frame.flow,
                status: 'running',
                visits: new Map(),
                exits: new Map(),
                spawns: new Map(),
                maxIterationsHit: new Set(),
                walkedEdges: new Set(),
                inputPreview: frame.inputPreview,
            };
            this.selectedFlow = undefined; // 静态图让位实时图
            this.requestUpdate();
            return;
        }
        if (this.run) {
            this.applyFrame(this.run, frame as AgentFrame);
            this.requestUpdate();
        }
    }

    /* ---------------- 渲染 ---------------- */

    protected render(): TemplateResult {
        const flows = this.catalog?.flows ?? [];
        const agents = this.catalog?.agents ?? [];
        const warnings = this.catalog?.warnings ?? [];

        return html`
            ${this.banner ? html`<div class="banner">${this.banner}</div>` : nothing}
            <h3>
                目录
                <span class="muted count">${flows.length + agents.length}</span>
                ${warnings.length > 0
                    ? html`<span
                          class="badge warn-badge"
                          title=${warnings.join('\n')}
                          @click=${() => (this.showWarnings = !this.showWarnings)}
                          >⚠${warnings.length}</span
                      >`
                    : nothing}
                <span class="grow"></span>
                <button @click=${() => void this.refreshCatalog()}>刷新</button>
            </h3>
            ${this.showWarnings && warnings.length > 0
                ? html`<div class="banner">${warnings.map((w) => html`<div>• ${w}</div>`)}</div>`
                : nothing}
            ${flows.length + agents.length === 0 && !this.extensionMissing
                ? html`<div class="muted">
                      目录为空。在 <code>.pi/chlamydomonos-agents/</code> 创建 Agent 与工作流(见文档 50)。
                  </div>`
                : nothing}

            <div class="group">
                <div
                    class="group-title"
                    @click=${() => (this.expanded = { ...this.expanded, flows: !this.expanded.flows })}
                >
                    ${this.expanded.flows ? '▾' : '▸'} 工作流 <span class="muted count">(${flows.length})</span>
                </div>
                ${this.expanded.flows
                    ? flows.map(
                          (f) => html`
                              <div class="row" @click=${() => this.selectFlow(f.name)}>
                                  <span class="dot flow ${this.selectedFlow === f.name ? 'selected' : ''}"></span>
                                  <span class="name">${f.name}</span>
                                  ${f.title ? html`<span class="title">${f.title}</span>` : nothing}
                                  <span class="grow"></span>
                                  <span class="badge">${f.source === 'workspace' ? '工作区' : '全局'}</span>
                              </div>
                          `,
                      )
                    : nothing}
            </div>

            <div class="group">
                <div
                    class="group-title"
                    @click=${() => (this.expanded = { ...this.expanded, agents: !this.expanded.agents })}
                >
                    ${this.expanded.agents ? '▾' : '▸'} 智能体 <span class="muted count">(${agents.length})</span>
                </div>
                ${this.expanded.agents
                    ? agents.map(
                          (a) => html`
                              <div class="row">
                                  <span class="dot"></span>
                                  <span class="name">${a.name}</span>
                                  ${a.title ? html`<span class="title">${a.title}</span>` : nothing}
                                  <span class="grow"></span>
                                  <span class="badge">${a.source === 'workspace' ? '工作区' : '全局'}</span>
                              </div>
                          `,
                      )
                    : nothing}
            </div>

            ${this.renderGraphArea(flows)}
        `;
    }

    /** 目录点选工作流 → 静态定义图(无动态;再点取消) */
    private selectFlow(name: string): void {
        this.selectedFlow = this.selectedFlow === name ? undefined : name;
        this.requestUpdate();
    }

    private async refreshCatalog(): Promise<void> {
        const sessionId = this.sessionId();
        const request = this.peerRequest();
        if (!request || !sessionId) {
            await this.refresh();
            return;
        }
        try {
            await request('refresh-catalog', { sessionId });
            // catalog 帧经 live channel 回来;无 channel 时兜底全刷
            if (!this.channel) await this.refresh();
        } catch (error) {
            this.banner = `刷新失败:${errorText(error)}`;
            this.requestUpdate();
        }
    }

    /* ---------------- 图拼接(70 §2.2 升级:spawn 子图) ---------------- */

    /**
     * 当前 run 的 spawn 帧 → 子图规格列表。
     * subflow 引用:catalog 同名 flow 的完整布局;sub 引用:单节点迷你图。
     * parentKey 由 parentPath 第一段解析(与节点 label/键宽松匹配)。
     */
    private subGraphSpecs(
        run: RunState | undefined,
        flows: CatalogFlow[],
    ): Array<SubGraphSpec & { parentKey?: string }> {
        if (!run) return [];
        const out: Array<SubGraphSpec & { parentKey?: string }> = [];
        let seq = 0;
        for (const [path, list] of run.spawns) {
            // parentPath 链(flow:<flow>#<label> [> sub:<name>]*):只拼接顶层节点的直接 spawn
            const first = path.split('>')[0] ?? '';
            const label = first.split('#')[1] ?? '';
            const parentKey = this.nodeKeyForLabel(
                label,
                flows.find((f) => f.name === run.flow),
            );
            for (const s of list) {
                seq++;
                if (s.refKind === 'subflow') {
                    const sub = flows.find((f) => f.name === s.name);
                    if (!sub) continue;
                    out.push({
                        id: `${path}#${s.name}#${seq}`,
                        originX: 0,
                        originY: 0,
                        layout: layoutFlow(sub),
                        title: sub.title || s.name,
                        refKind: 'subflow',
                        running: s.status === undefined,
                        parentKey,
                    });
                } else {
                    // sub 引用:Agent 无图 → 单节点迷你图(spawn label 即内容)
                    const mini: CatalogFlow = {
                        name: s.name,
                        title: s.label,
                        description: '',
                        source: 'workspace',
                        entry: 'root',
                        nodes: [{ key: 'root', label: s.label, kind: 'agent' }],
                        edges: [{ from: 'root', to: 'done', via: 'static' }],
                    };
                    out.push({
                        id: `${path}#${s.name}#${seq}`,
                        originX: 0,
                        originY: 0,
                        layout: layoutFlow(mini),
                        title: s.label,
                        refKind: 'sub',
                        running: s.status === undefined,
                        status: s.status,
                        parentKey,
                    });
                }
            }
        }
        return out;
    }

    /** spawn 徽章按节点收拢(旧 spawnsFor 的展示语义保留在节点下方) */
    private spawnBadgesFor(
        run: RunState | undefined,
        flows: CatalogFlow[],
        nodeKey: string,
        nodeLabel: string,
    ): Array<{ text: string; color: string; title: string }> {
        if (!run) return [];
        const out: Array<{ text: string; color: string; title: string }> = [];
        for (const [path, list] of run.spawns) {
            const first = path.split('>')[0] ?? '';
            const label = first.split('#')[1] ?? '';
            if (!label || (label !== nodeLabel && label !== nodeKey)) continue;
            for (const s of list) {
                out.push({
                    text: `${s.refKind === 'sub' ? 'sub:' : 'subflow:'}${s.name}`,
                    color: STATUS_COLOR[s.status ?? 'running'],
                    title: s.label,
                });
            }
        }
        void flows;
        return out;
    }

    /** label → 节点键(先精确键,再 label 匹配;用于连接虚线起点) */
    private nodeKeyForLabel(label: string, flow: CatalogFlow | undefined): string | undefined {
        if (!flow || !label) return undefined;
        if (flow.nodes.some((n) => n.key === label)) return label;
        return flow.nodes.find((n) => (n.label ?? n.key) === label)?.key;
    }

    private renderGraphArea(flows: CatalogFlow[]): TemplateResult {
        const run = this.run;
        const flowName = run?.flow ?? this.selectedFlow;
        if (!flowName) {
            return html`<h3>运行图</h3>
                <div class="muted">选择一个工作流模型并对话后,此处显示运行图;或在目录中点选工作流查看静态结构。</div>`;
        }
        const flow = flows.find((f) => f.name === flowName);
        if (!flow) {
            return html`<h3>运行图</h3>
                <div class="status-line">
                    <span class="muted">工作流 "${flowName}" 不在当前目录中(定义已变更?/reload 后恢复)。</span>
                </div>`;
        }
        const isLive = run !== undefined && run.flow === flowName;
        // 主图 + spawn 子图拼接(静态图无 run → 无子图)
        const subs = this.subGraphSpecs(isLive ? run : undefined, flows);
        const main = layoutFlow(flow);
        const composed = subs.length > 0 ? composeLayouts(main, subs) : { ...main, subs: [] };
        const layout: GraphLayout = composed;
        // 渲染用拼接后的子图(composeLayouts 已写入 origin 偏移;parentKey 经 spread 保留)
        const placedSubs = composed.subs as Array<SubGraphSpec & { parentKey?: string }>;
        // 运行中 spawn 的父节点保持 current 高亮(subflow 内部 node-enter 会把 run.current 抢走)
        const runningParents = new Set(
            placedSubs.filter((s) => s.running && s.parentKey).map((s) => s.parentKey as string),
        );
        const runView: RunView | undefined = isLive
            ? {
                  current: run!.current,
                  visits: run!.visits,
                  exits: run!.exits,
                  maxIterationsHit: run!.maxIterationsHit,
                  walkedEdges: run!.walkedEdges,
                  runningParents,
              }
            : undefined;

        const statusLabel = run
            ? { running: '运行中', completed: '完成', failed: '失败', aborted: '已中断' }[run.status]
            : '静态结构';

        return html`
            <h3>
                运行图
                <span class="muted">${flowName}</span>
            </h3>
            ${isLive
                ? html`<div class="status-line">
                      <span>唤醒 #${run!.wake}</span>
                      <span style="color:${STATUS_COLOR[run!.status]}">${statusLabel}</span>
                      ${run!.current ? html`<span class="muted">当前:${run!.current}</span>` : nothing}
                  </div>`
                : html`<div class="status-line muted">静态定义图(目录点选)</div>`}
            <div class="graph-scroll">
                <svg width=${layout.width} height=${layout.height} viewBox="0 0 ${layout.width} ${layout.height}">
                    ${renderSubLinks(main, placedSubs)} ${renderSubGraphs(placedSubs, runView)}
                    ${renderEdges(layout, runView)} ${renderNodes(layout, flow, runView)}
                </svg>
            </div>
        `;
    }
}

/** 快照 active 的宽松类型(协议层 ActiveWakeSnapshot) */
interface RunSnapshotActive {
    wake: number;
    flow: string;
    status: RunState['status'];
    frames: AgentFrame[];
}

/** 快照 catalog 的宽松类型(协议层 CatalogFrame) */
interface SnapshotCatalog {
    source?: string;
    flows: CatalogFlow[];
    agents: CatalogAgent[];
    warnings?: string[];
}

if (!customElements.get(PANEL_TAG)) {
    customElements.define(PANEL_TAG, PiAgentsPanelElement);
}
