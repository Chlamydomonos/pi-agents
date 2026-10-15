/**
 * 运行图布局(docs/70 §2.2,升级版):@dagrejs/dagre 自动分层布局。
 *
 * - rankdir='LR':执行流从左到右;同层节点纵向排列,分支图自然二维展开
 * - 长链(每层 1 节点)整体仍是一条水平线 → 超过 maxPerRow 时按深度重新打包成
 *   多行(蛇形):前 N 层第一行,继续的层第二行……避免单链图被拉得极宽
 * - 输出统一 NodeBox/EdgeLine/Size 视图模型,渲染层(graph-render)不感知 dagre
 * - 子图拼接:主图 + 若干子图(spawn 引用展开)各自布局后平移拼合,
 *   连接线由渲染层按 parentKey → childGroupId 画虚线
 */
import * as dagre from '@dagrejs/dagre';
import type { CatalogFlow } from '../../shared/protocol.js';

export interface NodeBox {
    key: string;
    label: string;
    agent?: string;
    kind: 'agent' | 'fn';
    x: number;
    y: number;
    w: number;
    h: number;
    /** 布局层(dagre rank;换列打包后仅作排序参考) */
    depth: number;
}

export interface EdgeLine {
    from: string;
    to: string | 'done';
    via: 'static' | 'route';
    /** 条件边候选(route) */
    dashed: boolean;
    /** 无 targets 声明的 route 边:目标未知,渲染 ? 标记(70 §2.2) */
    unknown?: boolean;
    /** 已走过的边(运行时点亮) */
    walked?: boolean;
    viaRuntime?: 'static' | 'route' | 'maxIterations';
}

export interface GraphLayout {
    nodes: NodeBox[];
    edges: EdgeLine[];
    width: number;
    height: number;
}

/* ---------------- 单图布局(dagre + 长链换行) ---------------- */

const NODE_W = 132;
const NODE_H = 40;
const NODE_GAP_X = 56;
const NODE_GAP_Y = 28;
const MARGIN = 24;
/** 单行最大节点数:超过即蛇形换行(长链二维化) */
const MAX_PER_ROW = 4;

/** dagre 布局一个 CatalogFlow → 节点坐标 + 边(dagre 逆序边用于回边检测) */
function dagreLayout(flow: CatalogFlow): { boxes: NodeBox[]; edges: EdgeLine[]; backEdges: Set<string> } {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: NODE_GAP_Y, ranksep: NODE_GAP_X, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of flow.nodes) {
        g.setNode(n.key, { width: NODE_W, height: NODE_H });
    }
    const keySet = new Set(flow.nodes.map((n) => n.key));
    const edges: EdgeLine[] = [];
    const backEdges = new Set<string>();
    for (const e of flow.edges) {
        edges.push({
            from: e.from,
            to: e.to,
            via: e.via,
            dashed: e.via === 'route',
            ...(e.via === 'route' && !e.targets ? { unknown: true } : {}),
        });
        if (e.to === 'done' || !keySet.has(e.to)) continue;
        // 回边探测:目标深度不大于自身 → dagre 会画环;交给 dagre 自行处理(它支持环)
        g.setEdge(e.from, e.to);
    }
    dagre.layout(g);

    // 深度(ranks)取 dagre 输出重算:节点 y 排序分层仅用于 visit 徽章等辅助信息
    const boxes: NodeBox[] = flow.nodes.map((n) => {
        const dn = g.node(n.key) as { x: number; y: number; width: number; height: number; _rank?: number };
        return {
            key: n.key,
            label: n.label ?? n.key,
            agent: n.agent,
            kind: n.kind,
            x: dn.x - dn.width / 2,
            y: dn.y - dn.height / 2,
            w: dn.width,
            h: dn.height,
            depth: (dn as unknown as { _rank?: number })._rank ?? 0,
        };
    });
    return { boxes, edges, backEdges };
}

/** 把一条水平长链按 MAX_PER_ROW 蛇形换行(仅当图整体过于水平时) */
function snakeWrap(boxes: NodeBox[]): NodeBox[] {
    if (boxes.length <= MAX_PER_ROW) return boxes;
    // 全图接近单行(高度只够 1 行)才需要换行;分支图交给 dagre 原生布局
    const ys = boxes.map((b) => b.y);
    const height = Math.max(...ys) + NODE_H - Math.min(...ys);
    if (height > NODE_H + NODE_GAP_Y / 2) return boxes;

    // 按 x 排序 = 执行顺序;每 MAX_PER_ROW 个换一行
    const sorted = [...boxes].sort((a, b) => a.x - b.x);
    const rows = Math.ceil(sorted.length / MAX_PER_ROW);
    return sorted.map((b, i) => {
        const row = Math.floor(i / MAX_PER_ROW);
        const inRow = i % MAX_PER_ROW;
        const reversed = row % 2 === 1; // 蛇形:偶数行左→右,奇数行右→左
        const col = reversed ? MAX_PER_ROW - 1 - inRow : inRow;
        return {
            ...b,
            x: MARGIN + col * (NODE_W + NODE_GAP_X),
            y: MARGIN + row * (NODE_H + NODE_GAP_Y),
            depth: i,
        };
    });
}

/** 布局一个流(主图或子图通用):dagre → 长链换行 → 平移到非负区 */
export function layoutFlow(flow: CatalogFlow): GraphLayout {
    const { boxes, edges } = dagreLayout(flow);
    const wrapped = snakeWrap(boxes);
    // 归一化到非负(换行后直接算;未换行时 dagre 可能给负坐标)
    const minX = Math.min(0, ...wrapped.map((b) => b.x));
    const minY = Math.min(0, ...wrapped.map((b) => b.y));
    const nodes = wrapped.map((b) => ({ ...b, x: b.x - minX + MARGIN, y: b.y - minY + MARGIN }));
    // 包络 = 平移后节点实际范围(双端含 MARGIN;不再二次补偿,旧式 -(minX-MARGIN) 会双计)
    const width = Math.max(NODE_W + MARGIN * 2, ...nodes.map((n) => n.x + n.w + MARGIN));
    const height = Math.max(NODE_H + MARGIN * 2, ...nodes.map((n) => n.y + n.h + MARGIN));
    return { nodes, edges, width, height };
}

/* ---------------- 子图拼接(70 §2.2 升级) ---------------- */

/** 一个待拼接的子图组:spawn 引用展开(refKind sub = 单节点迷你图;subflow = 整图) */
export interface SubGraphSpec {
    /** 组 id(parentPath 唯一标识一次 spawn) */
    id: string;
    /** 拼接偏移(由 composeLayouts 计算;渲染层直接用节点绝对坐标) */
    originX: number;
    originY: number;
    /** 子图布局(绝对坐标已含 origin) */
    layout: GraphLayout;
    /** 展示标题(spawn label / flow title) */
    title: string;
    refKind: 'sub' | 'subflow';
    /** sub 引用专用:spawn-start 已见、spawn-end 未到(迷你节点高亮依据) */
    running?: boolean;
    /** sub 引用专用:spawn 终态(ok/error/aborted;迷你节点着色依据) */
    status?: string;

    width?: number;
    height?: number;
}

/** 拼合主图与子图:子图依次纵向堆叠在主图下方(连接虚线垂直向下) */
export function composeLayouts(main: GraphLayout, subs: SubGraphSpec[]): GraphLayout & { subs: SubGraphSpec[] } {
    const GAP = 72; // 主图底缘与首个子图组框的间距(留给连接虚线)
    let offsetX = MARGIN;
    let offsetY = main.height + GAP;
    const placed: SubGraphSpec[] = [];
    for (const s of subs) {
        const originX = offsetX;
        const originY = offsetY;
        placed.push({
            ...s,
            originX,
            originY,
            layout: {
                ...s.layout,
                nodes: s.layout.nodes.map((n) => ({ ...n, x: n.x + originX, y: n.y + originY })),
            },
            // 宽高记录用原始布局尺寸(渲染画组框)
            width: s.layout.width,
            height: s.layout.height,
        });
        offsetY += s.layout.height + 56; // 组框(顶部 -26 底部 +14 出框)之间留出视觉间距
    }
    const subMaxW = Math.max(0, ...subs.map((s) => s.layout.width));
    return {
        nodes: [...main.nodes, ...placed.flatMap((p) => p.layout.nodes)],
        edges: [...main.edges, ...placed.flatMap((p) => p.layout.edges)],
        width: Math.max(main.width, subMaxW + MARGIN * 2),
        height: offsetY,
        subs: placed,
    };
}
