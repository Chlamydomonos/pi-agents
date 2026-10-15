/**
 * 工作流引擎:单次唤醒的节点执行主循环(docs/40 §4.3 伪代码)。
 *
 * 依赖注入:引擎对「Agent 节点执行」的依赖抽象为 NodeExecutor(docs/60 §4.1),
 * 单元测试注入假执行器返回脚本化输出;M3 由 session 层提供真实实现
 * (池 acquire + runNode + 事件映射)。
 *
 * 语义要点:
 * - maxIterations:声明在**当前节点的出边**上,约束 route 返回的目标节点——
 *   目标节点本次唤醒内已执行次数 ≥ N 时不再执行,工作流温和结束,
 *   输出 = 最近完成节点的文本(docs/20 §3.3/§8)。
 * - maxHops:总跳数硬上限(缺省 64),防 route 永不 done 又无 maxIterations;
 *   超限 = error 流(docs/40 §4.3),区别于 maxIterations 的温和结束。
 * - route/pass/函数节点 run/initialInput 抛错 → error 流,原始消息原样透传(docs/60 §7)。
 */

import type {
    FlowDefinition,
    FuncNodeContext,
    FuncFileHelpers,
    HostSessionView,
    ImageContent,
    NodeImage,
    NodeOutput,
    NodeSpec,
    PassSpec,
    WakeContext,
} from '../types.js';
import { createRunState, funcNodeExtra, peekVisit, routeContext, type RunState } from './context.js';
import { applyPass, resolvePass } from './pass.js';
import { embedFinalImages, imageShapeError, type ImageLimits } from '../shared/images.js';
import type { AgentFrame } from '../../shared/protocol.js';

/** Agent 节点执行器抽象(docs/60 §4.1)。M3 由 session 层实现;测试注入假执行器。 */
export type NodeExecutor = (
    agentName: string,
    input: string,
    nodeSpec: Pick<
        NodeSpec,
        'label' | 'sessionMode' | 'model' | 'thinkingLevel' | 'appendSystemPrompt' | 'outputVisible'
    >,
    ctx: {
        visit: number;
        wake: WakeContext;
        scratch: Record<string, unknown>;
        extra: unknown;
        /** 节点键(节点名;session 层透传前缀/终点标注用,M4) */
        node: string;
        /** 本节点 prompt 附带图片(D21:入口节点 = wake.images;后续 = pass 转发结果;docs/20 §9.3/9.4) */
        images: ImageContent[];
    },
) => Promise<NodeOutput>;

/** 工作流错误(docs/20 D17):message 为原始错误消息或引擎专属提示 */
export class FlowError extends Error {
    constructor(
        message: string,
        /** 触发节点;入口前错误(如 initialInput)为 undefined */
        readonly node?: string,
    ) {
        super(message);
        this.name = 'FlowError';
    }
}

export interface RunFlowDeps {
    /** Agent 节点执行器(必填;纯函数节点工作流不会用到) */
    executeAgentNode: NodeExecutor;
    /** 总跳数硬上限;缺省 64(docs/40 §4.3) */
    maxHops?: number;
    /** 告警输出(maxIterations 触发等;调用方接 console.warn / ui.notify) */
    warn?: (msg: string) => void;
    /** 思维链行(「—— 函数节点 X ——」/ maxIterations 提示;调用方接 thinking 流) */
    onThinking?: (line: string) => void;
    /** M8:函数节点 ctx.files 工作区助手(docs/20 §9.5);不设 = 函数节点用 files 抛错 */
    fileHelpers?: FuncFileHelpers;
    /** M8:图片上限(config.images;docs/20 §9.2) */
    imageLimits?: ImageLimits;
    /** M8:终点嵌图开关(config.images.embedFinalImages;缺省 markdown) */
    embedFinalImages?: 'markdown' | 'off';
    /** M9:插件事件发射(node-enter/exit/edge;40 §13;缺省 = 不发射) */
    emit?: (frame: AgentFrame) => void;
    /** 宿主会话只读视图(函数节点 ctx.host,docs/20 §2.2);不设 = 空 view(防御) */
    hostView?: HostSessionView;
}

export interface RunFlowResult {
    /** 工作流输出 = 终点节点最终文本(docs/20 §4;嵌图开启时末尾含图行,docs/20 §9.7) */
    text: string;
    /** 终点节点名 */
    terminal: string;
    /** 输出轨迹(docs/20 §6,按执行顺序) */
    trail: Array<{ node: string; visit: number; text: string; data?: unknown }>;
    /** M8:终点节点产出的图片(嵌图源;调用方可做统计/面板展示) */
    images?: NodeOutput['images'];
    /** M8:嵌图统计(attached = 附加图行数;skipped = 无 src 跳过数) */
    embed?: { attached: number; skipped: number };
}

const ZERO_STATS = { llmRequests: 0, toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

/** deps.hostView 缺省时的空视图(防御;正常链路 runtime 恒提供) */
const EMPTY_HOST_VIEW: HostSessionView = { sessionId: '', wakeIndex: 0, lastInput: '', messages: [] };

/** 执行一次唤醒。抛 FlowError = error 流。 */
export async function runFlow(flow: FlowDefinition, wake: WakeContext, deps: RunFlowDeps): Promise<RunFlowResult> {
    const state: RunState = createRunState(flow, wake, deps.hostView ?? EMPTY_HOST_VIEW);
    const maxHops = deps.maxHops ?? 64;
    const limits: ImageLimits = deps.imageLimits ?? {
        maxWakeImages: 4,
        maxImageBytes: 2 * 1024 * 1024,
        maxNodeImages: 8,
    };

    // 入口输入:initialInput 只加工入口节点(docs/20 §5.3)
    let node = flow.entry;
    let input: string;
    try {
        input = (await flow.initialInput?.(wake)) ?? wake.input;
    } catch (error) {
        throw new FlowError(errMsg(error), undefined);
    }

    // 图片通道(D21):入口节点自动带 wake.images(docs/20 §9.3);后续节点 = pass 转发(§9.4)
    let nextImages: ImageContent[] = wake.images;

    let hops = 0;
    for (;;) {
        // maxHops 兜底:超限 = error 流(docs/40 §4.3)
        if (hops >= maxHops) {
            throw new FlowError(`超过 maxHops(${maxHops}):工作流在节点 "${node}" 处超过最大跳数`, node);
        }
        hops++;

        const visit = (state.counters.get(node) ?? 0) + 1;
        state.counters.set(node, visit);

        const spec = requireNode(flow, node);
        const nodeImages = nextImages;
        const emit = deps.emit;
        const wakeNo = wake.wakeIndex;
        const nodeKind: 'agent' | 'fn' = spec.run ? 'fn' : 'agent';
        emit?.({ kind: 'node-enter', wake: wakeNo, node, visit, nodeKind });
        const tNode0 = Date.now();
        let output: NodeOutput;
        if (spec.run) {
            output = await runFnNode(spec, node, input, state, visit, deps, limits);
        } else {
            output = await deps.executeAgentNode(spec.agent!, input, spec, {
                visit,
                wake: state.wake,
                scratch: state.scratch,
                extra: state.flow.meta,
                node,
                images: nodeImages,
            });
        }
        state.trail.push({ node, visit, text: output.text, data: output.data });
        emit?.({
            kind: 'node-exit',
            wake: wakeNo,
            node,
            visit,
            status: 'ok',
            durationMs: Date.now() - tNode0,
            ...(output.text ? { textPreview: output.text } : {}),
        });

        // 出边:无键 = 终点(docs/20 §4);终点文本 = 本节点最终文本 + 嵌图收尾(§9.7)
        const edge = flow.edges[node];
        if (edge === undefined) {
            const embedded = finishTerminal(output, deps, limits);
            return {
                text: embedded.text,
                terminal: node,
                trail: state.trail,
                ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
                ...(embedded.stats.attached + embedded.stats.skipped > 0 ? { embed: embedded.stats } : {}),
            };
        }

        // route:下一节点名或 "done";抛错 → error 流(docs/20 §3.3)
        let next: string;
        try {
            next = await (typeof edge === 'string' ? edge : edge.route(output, routeContext(state, visit)));
        } catch (error) {
            throw new FlowError(errMsg(error), node);
        }
        if (next === 'done') {
            emit?.({
                kind: 'edge',
                wake: wakeNo,
                from: node,
                to: 'done',
                via: typeof edge === 'string' ? 'static' : 'route',
            });
            const embedded = finishTerminal(output, deps, limits);
            return {
                text: embedded.text,
                terminal: node,
                trail: state.trail,
                ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
                ...(embedded.stats.attached + embedded.stats.skipped > 0 ? { embed: embedded.stats } : {}),
            };
        }
        if (!(next in flow.nodes)) {
            throw new FlowError(`route 返回了不存在的节点 "${next}"`, node);
        }

        // maxIterations:声明在当前出边上,约束目标节点 next(docs/20 §3.3)
        const mi = typeof edge === 'object' ? edge.maxIterations : undefined;
        if (mi !== undefined && (state.counters.get(next) ?? 0) >= mi) {
            deps.warn?.(`工作流 ${flow.name}:节点 "${next}" 达到 maxIterations(${mi}),强制结束`);
            deps.onThinking?.(`—— 达到 maxIterations(${mi}),以最近完成节点 "${node}" 的输出结束 ——`);
            emit?.({ kind: 'edge', wake: wakeNo, from: node, to: next, via: 'maxIterations' });
            const embedded = finishTerminal(output, deps, limits);
            return {
                text: embedded.text,
                terminal: node,
                trail: state.trail,
                ...(output.images && output.images.length > 0 ? { images: output.images } : {}),
                ...(embedded.stats.attached + embedded.stats.skipped > 0 ? { embed: embedded.stats } : {}),
            };
        }

        // pass:边级覆盖顶层(docs/20 §5.1);transform/template 抛错 → error 流
        const edgePass = typeof edge === 'object' ? (edge.pass as PassSpec | undefined) : undefined;
        const passSpec = resolvePass(flow, next, peekVisit(state, next), edgePass);
        let outcome;
        try {
            outcome = await applyPass(passSpec, output, {
                to: next,
                visit: peekVisit(state, next),
                wake: state.wake,
                scratch: state.scratch,
                extra: state.flow.meta,
            });
        } catch (error) {
            throw new FlowError(errMsg(error), node);
        }
        // transform 的 data 记录进上游节点执行后的 NodeOutput.data(docs/20 §5.1)
        if (outcome.data !== undefined) {
            const t = state.trail[state.trail.length - 1];
            if (t) t.data = outcome.data;
        }

        emit?.({
            kind: 'edge',
            wake: wakeNo,
            from: node,
            to: next,
            via: typeof edge === 'string' ? 'static' : 'route',
        });
        node = next;
        input = outcome.userMessage;
        // pass 转发的图片给下一节点 prompt(§9.4);无转发集 = 空(不继承)
        nextImages = outcome.images ?? [];
    }
}

function requireNode(flow: FlowDefinition, key: string): NodeSpec {
    const spec = flow.nodes[key];
    if (spec === undefined) throw new FlowError(`节点 "${key}" 不在 nodes 中`, key); // 装载已保证;防御
    return spec;
}

/** 函数节点执行(docs/40 §5):无池无子会话;stats = durationMs + 其余 0;抛错原样上抛 */
async function runFnNode(
    spec: NodeSpec,
    key: string,
    input: string,
    state: RunState,
    visit: number,
    deps: RunFlowDeps,
    limits: ImageLimits,
): Promise<NodeOutput> {
    deps.onThinking?.(`—— 函数节点 ${spec.label ?? key} ——`);
    const dataIn = state.trail[state.trail.length - 1]?.data;
    const t0 = Date.now();
    let result: unknown;
    try {
        const ctx: FuncNodeContext = {
            visit,
            wake: state.wake,
            scratch: state.scratch,
            extra: funcNodeExtra(state),
            files: deps.fileHelpers ?? missingFileHelpers,
            host: state.host,
        };
        result = await spec.run!({ text: input, data: dataIn }, ctx);
    } catch (error) {
        throw new FlowError(errMsg(error), key);
    }
    const durationMs = Date.now() - t0;
    if (typeof result === 'string') return { text: result, stats: { durationMs, ...ZERO_STATS } };
    if (typeof result === 'object' && result !== null && typeof (result as { text?: unknown }).text === 'string') {
        const r = result as { text: string; data?: unknown };
        // 图片产出校验(docs/20 §9.6):形(imageShapeError 接收整组)与数量(maxNodeImages)
        const rawImages = (result as { images?: unknown }).images;
        let images: NodeImage[] | undefined;
        if (rawImages !== undefined) {
            if (!Array.isArray(rawImages)) {
                throw new FlowError(`函数节点 "${spec.label ?? key}" 的 images 必须是数组`, key);
            }
            if (rawImages.length > limits.maxNodeImages) {
                throw new FlowError(
                    `函数节点 "${spec.label ?? key}" 产出 ${rawImages.length} 张图片,超过上限 ${limits.maxNodeImages}`,
                    key,
                );
            }
            const shErr = imageShapeError(rawImages);
            if (shErr) {
                throw new FlowError(`函数节点 "${spec.label ?? key}" 图片格式错误:${shErr}`, key);
            }
            images = (rawImages as Array<{ data: string; mimeType: string; src?: unknown }>).map((img) => ({
                image: { type: 'image' as const, data: img.data, mimeType: img.mimeType },
                ...(typeof img.src === 'string' && img.src.length > 0 ? { src: img.src } : {}),
            }));
        }
        return {
            text: r.text,
            ...(r.data !== undefined ? { data: r.data } : {}),
            ...(images !== undefined ? { images } : {}),
            stats: { durationMs, ...ZERO_STATS },
        };
    }
    throw new FlowError(`函数节点 "${key}" 返回值必须为 string 或 { text, data? }`, key);
}

/** 无 fileHelpers 时的 ctx.files 占位:调用即抛错(docs/20 §9.5) */
const missingFileHelpers: FuncFileHelpers = {
    readImage: () => Promise.reject(new Error('函数节点 files 助手未启用(需要 RunFlowDeps.fileHelpers)')),
    readText: () => Promise.reject(new Error('函数节点 files 助手未启用(需要 RunFlowDeps.fileHelpers)')),
    list: () => Promise.reject(new Error('函数节点 files 助手未启用(需要 RunFlowDeps.fileHelpers)')),
};

/**
 * 终点收尾(docs/20 §9.7):embedFinalImages='markdown' 且终点节点有带 src 的图 →
 * 最终文本尾部追加 markdown 图行(每张一行,"w:N" alt);'off' 或无图 = 原文本。
 */
function finishTerminal(
    output: NodeOutput,
    deps: RunFlowDeps,
    limits: ImageLimits,
): { text: string; stats: { attached: number; skipped: number } } {
    const enabled = (deps.embedFinalImages ?? 'markdown') === 'markdown';
    if (!enabled || !output.images || output.images.length === 0) {
        return { text: output.text, stats: { attached: 0, skipped: 0 } };
    }
    const result = embedFinalImages(output.text, output.images);
    if (result.attached > 0) {
        deps.onThinking?.(`—— 最终回答已附加 ${result.attached} 张图片 ——`);
    }
    return { text: result.text, stats: { attached: result.attached, skipped: result.skipped } };
}

function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
