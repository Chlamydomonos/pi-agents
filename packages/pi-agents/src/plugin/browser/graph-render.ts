/**
 * 运行图 SVG 渲染(docs/70 §2.2):纯函数层,消费 graph-layout 的视图模型。
 * 帧文本一律 Lit 默认转义;动态状态(run)由 panel 层传入。
 */
import { html, svg, nothing, type TemplateResult } from 'lit';
import type { CatalogFlow } from '../../shared/protocol.js';
import type { EdgeLine, GraphLayout, NodeBox, SubGraphSpec } from './graph-layout.js';

export const STATUS_COLOR: Record<string, string> = {
    running: 'var(--pi-agents-running, #4a9eff)',
    ok: 'var(--pi-agents-ok, #4caf7d)',
    error: 'var(--pi-agents-error, #e05c5c)',
    aborted: 'var(--pi-agents-abort, #e0a030)',
    completed: 'var(--pi-agents-ok, #4caf7d)',
    failed: 'var(--pi-agents-error, #e05c5c)',
};

/** 运行动态状态(渲染所需投影;panel 层的 RunState 收窄) */
export interface RunView {
    current?: string;
    visits: Map<string, number>;
    exits: Map<string, 'ok' | 'error'>;
    maxIterationsHit: Set<string>;
    /** 走过的边("from>to") */
    walkedEdges: Set<string>;
    /** 运行中 spawn 的父节点(subflow 内部帧会抢走 current;这些节点保持蓝色) */
    runningParents?: Set<string>;
}

export function edgePath(layout: GraphLayout, e: EdgeLine): string {
    const a = layout.nodes.find((n) => n.key === e.from);
    if (!a) return '';
    if (e.to === 'done') {
        // 图外终点:框底向下出线 + ⏹ 端点
        const x = a.x + a.w / 2;
        const y2 = a.y + a.h + 18;
        return `M ${x} ${a.y + a.h} L ${x} ${y2}`;
    }
    const b = layout.nodes.find((n) => n.key === e.to);
    if (!b) return '';
    // 前向水平流(dagre LR 同行):右缘出 → 左缘入
    if (b.y === a.y && b.x > a.x) {
        const y = a.y + a.h / 2;
        return `M ${a.x + a.w} ${y} L ${b.x} ${y}`;
    }
    // 前向跨行(蛇形换行/分支跨层):右缘出 → 途经中点 → 左缘入(正交折线,不穿节点)
    if (b.x > a.x) {
        const y1 = a.y + a.h / 2;
        const y2 = b.y + b.h / 2;
        const mx = (a.x + a.w + b.x) / 2;
        return `M ${a.x + a.w} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${b.x} ${y2}`;
    }
    // 回边(目标在上方/左侧,环/跳转):右侧绕行曲线
    const x1 = a.x + a.w;
    const x2 = b.x + b.w;
    const cx = Math.max(x1, x2) + 36;
    const y1 = a.y + a.h / 2;
    const y2 = b.y + b.h / 2;
    return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2 + 6} ${y2}`;
}

/** done 端点标记坐标 */
function headX(layout: GraphLayout, e: EdgeLine): number {
    const a = layout.nodes.find((n) => n.key === e.from);
    return (a?.x ?? 0) + (a?.w ?? 0) / 2 - 4;
}

function headY(layout: GraphLayout, e: EdgeLine): number {
    const a = layout.nodes.find((n) => n.key === e.from);
    return (a?.y ?? 0) + (a?.h ?? 0) + 30;
}

export function renderEdges(layout: GraphLayout, run: RunView | undefined): TemplateResult[] {
    return layout.edges.map((e) => {
        const d = edgePath(layout, e);
        const walked = run !== undefined && run.walkedEdges.has(`${e.from}>${e.to}`);
        const cls = `edge${e.dashed ? ' dashed' : ''}${walked ? ' walked' : ''}`;
        const head = e.to === 'done' ? (e.unknown ? '?' : '⏹') : '';
        return svg`
            <path class=${cls} d=${d} />
            ${head ? svg`<text class="entry-mark" x=${headX(layout, e)} y=${headY(layout, e)}>${head}</text>` : nothing}
        `;
    });
}

/** 单节点渲染(spawn 徽章由 panel 层按组计算传入) */
function renderNode(
    n: NodeBox,
    flow: CatalogFlow,
    run: RunView | undefined,
    spawnBadges: Array<{ text: string; color: string; title: string }>,
): TemplateResult {
    const isCurrent = run?.current === n.key || (run?.runningParents?.has(n.key) ?? false);
    const exit = run?.exits.get(n.key);
    const visits = run?.visits.get(n.key) ?? 0;
    const cls = [
        'node-rect',
        n.kind === 'fn' ? 'fn' : '',
        isCurrent ? 'current pulse' : '',
        exit === 'ok' ? 'ok' : '',
        exit === 'error' ? 'error' : '',
    ]
        .filter(Boolean)
        .join(' ');
    const maxHit = run?.maxIterationsHit.has(n.key) ?? false;
    return svg`
        <g>
            <rect class=${cls} x=${n.x} y=${n.y} rx="7" width=${n.w} height=${n.h}></rect>
            ${n.key === flow.entry ? svg`<text class="entry-mark" x=${n.x - 12} y=${n.y + 16}>▶</text>` : nothing}
            <text class="node-label" x=${n.x + 10} y=${n.y + 18}>${n.label}</text>
            ${n.agent ? svg`<text class="node-agent" x=${n.x + 10} y=${n.y + 32}>${n.agent}</text>` : nothing}
            ${visits > 1 ? svg`<text class="visit-badge" x=${n.x + n.w - 22} y=${n.y + 14}>×${visits}</text>` : nothing}
            ${maxHit ? svg`<text class="max-badge" x=${n.x + n.w - 30} y=${n.y + 34}>max</text>` : nothing}
            ${spawnBadges.map(
                (s, i) => svg`
                <text class="spawn-badge" x=${n.x + 6} y=${n.y + n.h + 14 + i * 13} fill=${s.color} title=${s.title}>
                    ${s.text}
                </text>`,
            )}
        </g>
    `;
}

export function renderNodes(layout: GraphLayout, flow: CatalogFlow, run: RunView | undefined): TemplateResult[] {
    return layout.nodes.map((n) => renderNode(n, flow, run, []));
}

/**
 * 子图组渲染:组框 + 标题 + 子图节点边。
 * sub 引用(单节点迷你图)与 subflow(整图)统一处理。
 */
export function renderSubGraphs(subs: SubGraphSpec[], run: RunView | undefined): TemplateResult[] {
    return subs.map((s) => {
        const inner: CatalogFlow = {
            name: s.id,
            title: s.title,
            description: '',
            source: 'workspace',
            entry: s.layout.nodes[0]?.key ?? '',
            nodes: s.layout.nodes.map((n) => ({ key: n.key, label: n.label, agent: n.agent, kind: n.kind })),
            edges: s.layout.edges.map((e) => ({ from: e.from, to: e.to, via: e.via, targets: undefined })),
        };
        // sub 引用:迷你节点的运行动态由 spawn 帧推导(无 node-enter 帧,主图 current/exit 不适用)
        const subRun: RunView | undefined =
            s.refKind !== 'sub'
                ? run
                : {
                      current: s.running ? 'root' : undefined,
                      visits: new Map(),
                      exits:
                          !s.running && s.status !== undefined
                              ? new Map([['root', s.status === 'ok' ? 'ok' : ('error' as const)]])
                              : new Map(),
                      maxIterationsHit: new Set(),
                      walkedEdges: new Set(),
                  };
        return svg`
            <g class="subgraph">
                <rect
                    class="subgraph-frame"
                    x=${s.originX - 14}
                    y=${s.originY - 26}
                    rx="9"
                    width=${s.layout.width + 28}
                    height=${s.layout.height + 40}
                ></rect>
                <text class="subgraph-title" x=${s.originX - 6} y=${s.originY - 8}>
                    ${s.refKind === 'sub' ? 'sub:' : 'subflow:'}${s.title}
                </text>
                ${renderEdges(s.layout, subRun)}
                ${s.layout.nodes.map((n) => renderNode(n, inner, subRun, []))}
            </g>
        `;
    });
}

/** 父节点 → 子图组的连接虚线(父节点底缘中点 → 子图组框顶缘中点,正交折线) */
export function renderSubLinks(
    main: GraphLayout,
    subs: Array<SubGraphSpec & { parentKey?: string }>,
): TemplateResult[] {
    return subs.map((s) => {
        if (!s.parentKey) return nothing;
        const p = main.nodes.find((n) => n.key === s.parentKey);
        if (!p) return nothing;
        const x1 = p.x + p.w / 2;
        const y1 = p.y + p.h;
        const x2 = s.originX + s.layout.width / 2;
        const y2 = s.originY - 26;
        const my = (y1 + y2) / 2;
        return svg`<path
            class="sublink"
            d="M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2}"
        ></path>`;
    }) as TemplateResult[];
}
