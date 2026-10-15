/**
 * spawn_* 工具生成与执行(docs/10 §6/§6.1/§6.2,D6/D7)。
 *
 * 每个 Agent 引用的 subagents 条目生成一个工具:
 *   - Agent 引用:子会话语义(§6.1)——stateless 缺省/每次新建即弃;
 *     inherit 复用「父会话键 + sub:<name>」池条目(task 作为新 user 消息追加);
 *   - 工作流引用:一次完整唤醒(§6.1)——复用 wakeFlow/引擎/池,
 *     hostSessionId 换成链式键(§3.3),终点文本 = 工具返回值;
 *   - 递归委派:子会话 createSubSession 时同样注册它自己的 spawn_*(§6.1)。
 *
 * 关键 SDK 事实(已核实):customTools 也受 tools 白名单过滤
 * (_isAllowedTool 作用于 allCustomTools),因此 spawn_* 名字必须并入
 * 子会话 tools 白名单(createSubSession 消费 subagentToolNames)。
 */

import { Type, type TSchema, type Static } from 'typebox';
import { defineTool, type ToolDefinition, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { spawnStartFrame, spawnEndFrame } from '../emit.js';
import type { AgentFrame } from '../../shared/protocol.js';
import type { JsonObject } from '@earendil-works/pi-ai';
import type { AgentDefinition, FlowDefinition, SubagentSpec } from '../types.js';
import type { WakeOutcome } from './runtime.js';
import { wakeFlow } from './runtime.js';
import type { RunNodeEnv, UsageDelta } from './run-node.js';
import { AskPostedError, AbortedError } from './run-node.js';
import type { NodeSession } from './pool.js';
import { ASK_USER_TOOL_NAME, type AskUserQuestionPayload } from './stream-events.js';
import { appendPathSegment, subAgentSegment, subflowSegment } from './usage.js';

/** spawn_* 工具名前缀(10 §6) */
export const SPAWN_TOOL_PREFIX = 'spawn_';

/** 一次 spawn 执行的产物(工具 execute 与测试共用) */
export interface SpawnResult {
    text: string;
    usage: UsageDelta;
    durationMs: number;
}

/** spawn 工具执行依赖(execute 闭包捕获;测试可替换 runner/prompt) */
export interface SpawnDeps {
    /** 父 Agent 定义(解析链/工具白名单/世界书来源) */
    parentAgent: AgentDefinition;
    /** 当前运行环境(与节点执行共用;lorebookOf/flowContext 随 env 走) */
    env: RunNodeEnv;
    /** §3.1 输出可见性:子代理文本继承所属节点配置(随父节点 outputVisible) */
    outputVisible: boolean;
    /** 父会话池键要素(子 Agent inherit 键 = 父键 + sub:<name>) */
    /** 父会话池键要素(子 Agent inherit 键 = 父键 + sub:<name>)+ M7 记账父路径 */
    poolScope: { flowName: string; nodeKey: string; hostSessionId: string; wakeIndex: number; agentPath: string };
    /** 工作流名 → 定义(引用校验/工具描述;index 提供) */
    flowByName?: (name: string) => FlowDefinition | undefined;
    /** 子会话创建工厂(Agent 引用;run-node 组装,复用 createSubSession 含 spawn 递归) */
    createSubSessionOf?: (
        agentDef: AgentDefinition,
        spec: SubagentSpec,
        refName: string,
    ) => Promise<{ session: AgentSession; sessionManager: SessionManager }>;
    /** 工作流引用执行(默认 wakeFlow;测试可替换) */
    wakeRun?: (args: Parameters<typeof wakeFlow>[0]) => Promise<WakeOutcome>;
    /** Agent 引用:子会话获取(stateless 新建;inherit 复用池;测试可替换) */
    subSessionOf?: (agentName: string, spec: SubagentSpec) => Promise<NodeSession>;
    /** 中断信号(宿主 Esc 级联;穿透到子工作流/子会话) */
    signal?: AbortSignal;
    warn?: (msg: string) => void;
}

/** SubagentSpec 归一化:string → {name}(10 §6.1) */
export function normalizeSubagentSpecs(def: AgentDefinition): SubagentSpec[] {
    return (def.subagents ?? []).map((s) => (typeof s === 'string' ? { name: s } : s));
}

/** spawn 工具名(10 §6:固定 spawn_<被引用name>) */
export function spawnToolName(name: string): string {
    return `${SPAWN_TOOL_PREFIX}${name}`;
}

/** 工具 description(10 §6:被引用对象 title/description 组合) */
export function spawnToolDescription(target: AgentDefinition | FlowDefinition): string {
    const who = `${target.title}（${target.name}）`;
    return `启动子代理 ${who}: ${target.description} 传给它一段任务描述,阻塞直到完成,返回它的最终输出文本。`;
}

const spawnParams = Type.Object({
    task: Type.String({ description: '交给子代理的任务描述(它会以此为用户消息开始工作)' }),
    context: Type.Optional(Type.String({ description: '补充上下文/约束,拼在 task 之后的第二段' })),
});

/** spawn 输入 → 子代理 user 消息文本(§6.2:task + "\n\n" + context) */
export function spawnInputText(task: string, context: string | undefined): string {
    return context && context.trim().length > 0 ? `${task}\n\n${context}` : task;
}

/**
 * 为父 Agent 生成全部 spawn_* 工具(每个 subagents 条目一个)。
 * 引用有效性由装载期保证(悬空已滤,load.ts 步骤 3b);运行期再校验一次(§6.2 步骤 1)。
 */
export function createSpawnTools(deps: SpawnDeps): ToolDefinition<TSchema, unknown>[] {
    const specs = normalizeSubagentSpecs(deps.parentAgent);
    const tools: ToolDefinition<TSchema, unknown>[] = [];
    for (const spec of specs) {
        tools.push(createOneSpawnTool(spec, deps));
    }
    return tools;
}

function createOneSpawnTool(spec: SubagentSpec, deps: SpawnDeps): ToolDefinition<TSchema, unknown> {
    const toolName = spawnToolName(spec.name);
    return defineTool({
        name: toolName,
        label: `调用子代理 ${spec.title ?? spec.name}`,
        description: spawnDescriptionBestEffort(spec.name, deps),
        parameters: spawnParams,
        defaultActive: true,
        execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
            const input = spawnInputText(params.task, params.context);
            const result = await runSpawn(spec, input, { ...deps, signal: signal ?? deps.signal });
            return {
                content: [{ type: 'text', text: result.text }],
                details: { name: spec.name, usage: result.usage, durationMs: result.durationMs },
            };
        },
    }) as unknown as ToolDefinition<TSchema, unknown>;
}

/** description 组装(引用对象缺失时降级;装载期已滤悬空,此为防御) */
function spawnDescriptionBestEffort(name: string, deps: SpawnDeps): string {
    const agent = deps.env.agentsByName.get(name);
    if (agent) return spawnToolDescription(agent);
    const flow = deps.flowByName?.(name);
    if (flow) return spawnToolDescription(flow);
    return `启动子代理 ${name},阻塞直到完成,返回它的最终输出文本。`;
}

/**
 * spawn 执行(§6.2):Agent 引用走子会话;工作流引用走一次性唤醒。
 * 内部报错 → 上抛(工具层 isError 由 SDK 包);AbortedError 原样穿透(引擎/流按 aborted 收尾)。
 */
export async function runSpawn(
    spec: SubagentSpec,
    input: string,
    deps: SpawnDeps & { signal?: AbortSignal },
): Promise<SpawnResult> {
    const t0 = Date.now();

    /* 引用校验(§6.2 步骤 1):装载有效;工作流引用优先级 = Agent 优先(load 同名规则) */
    const agentDef = deps.env.agentsByName.get(spec.name);
    const flowDef = agentDef ? undefined : deps.flowByName?.(spec.name);
    if (!agentDef && !flowDef) {
        throw new Error(`子代理 "${spec.name}" 当前装载无效或已失效(尝试 /agents reload 后重试)`);
    }

    if (agentDef) {
        return runAgentRef(spec, agentDef, input, deps, t0);
    }
    return runFlowRef(spec, flowDef!, input, deps, t0);
}

/** spawn-start/end 帧发射(parentPath = agentPath 链,40 §6/§13) */
function emitSpawn(deps: SpawnDeps, frame: AgentFrame): void {
    deps.env.onAgentEvent?.(frame);
}

/** spawn-start 的 parentPath(usage 的 agentPath 链;spawn-start 帧与其一致) */
function spawnParentPath(deps: SpawnDeps): string {
    return deps.poolScope.agentPath;
}

/* ------------------------------------------------------------------ */
/*  Agent 引用(§6.1 session 语义)                                       */
/* ------------------------------------------------------------------ */

async function runAgentRef(
    spec: SubagentSpec,
    agentDef: AgentDefinition,
    input: string,
    deps: SpawnDeps & { signal?: AbortSignal },
    t0: number,
): Promise<SpawnResult> {
    const sessionMode = spec.session ?? deps.env.config.subagentSession ?? 'stateless';
    const ns = await (deps.subSessionOf
        ? deps.subSessionOf(spec.name, spec)
        : defaultSubSession(spec.name, spec, sessionMode, agentDef, deps));

    const parentPath = spawnParentPath(deps);
    emitSpawn(deps, spawnStartFrame(deps.poolScope.wakeIndex, parentPath, 'sub', spec.name, label0(spec)));
    try {
        // 透传包(sub 会话 → NodeEvent;来源标注 = spec.title ?? name)
        const label = spec.title ?? spec.name;
        const stop = pipeSubSessionEvents(ns, label, deps.env, deps.outputVisible);
        try {
            const { usage } = await promptSubSession(ns, input, deps);
            const text = ns.session.getLastAssistantText() ?? '';
            // ask 挂起:子代理末轮以桥接 ask_user 收尾 → 上抛挂起(父工作流止于此;
            // runtime 捕获落定;宿主执行 pi-web ask_user 后本轮终止)
            const lastMsg = lastAssistantMsg(ns.session.messages as AgentMessage[]);
            if (lastMsg && lastMsg.stopReason === 'toolUse' && endsWithAskCall(lastMsg)) {
                throw new AskPostedError(deps.poolScope.nodeKey, text, deps.poolScope.wakeIndex);
            }
            // M7 记账(docs/40 §6):父路径 > sub:<name>
            deps.env.usageLedger?.()?.record(appendPathSegment(deps.poolScope.agentPath, subAgentSegment(spec.name)), {
                ...usage,
                durationMs: Date.now() - t0,
            });
            emitSpawn(deps, spawnEndFrame(deps.poolScope.wakeIndex, parentPath, spec.name, 'ok', Date.now() - t0));
            return { text, usage, durationMs: Date.now() - t0 };
        } catch (error) {
            const status = error instanceof AbortedError ? 'aborted' : error instanceof AskPostedError ? 'ok' : 'error';
            emitSpawn(deps, spawnEndFrame(deps.poolScope.wakeIndex, parentPath, spec.name, status, Date.now() - t0));
            throw error;
        } finally {
            stop();
        }
    } catch (error) {
        // defaultSubSession 失败也发 end 帧(错误路径完整性)
        if (!(error instanceof AbortedError) && !(error instanceof Error && error.message.includes('内部错误'))) {
            emitSpawn(deps, spawnEndFrame(deps.poolScope.wakeIndex, parentPath, spec.name, 'error', Date.now() - t0));
        }
        throw error;
    }
}

/** spawn-start 的 label(spec.title ?? name) */
function label0(spec: SubagentSpec): string {
    return spec.title ?? spec.name;
}

/** 默认子会话获取:stateless 新建即弃;inherit 复用父池条目(§3.3 键 = 父键 + sub:<name>) */
async function defaultSubSession(
    name: string,
    spec: SubagentSpec,
    sessionMode: 'stateless' | 'inherit',
    agentDef: AgentDefinition,
    deps: SpawnDeps,
): Promise<NodeSession> {
    // sub 会话创建链(与 createSubSession 同一工厂;在 run-node.ts 组装时注入)
    if (!deps.createSubSessionOf) {
        throw new Error('内部错误:spawn 未注入 createSubSessionOf');
    }
    if (sessionMode === 'inherit') {
        // 键 = 父会话键 + sub:<name>;identity 稳定(随父池生命周期,父弃 → 池键随父清理)
        return deps.env.pool.acquire({
            flowName: deps.poolScope.flowName,
            nodeKey: `${deps.poolScope.nodeKey}>sub:${name}`,
            hostSessionId: deps.poolScope.hostSessionId,
            identity: `${agentDef.name}:inherit`,
            wakeIndex: deps.poolScope.wakeIndex,
            create: () => deps.createSubSessionOf!(agentDef, spec, name),
        });
    }
    // stateless:不进池(每次新建;调用方用后即弃,无池清理义务)
    const built = await deps.createSubSessionOf(agentDef, spec, name);
    return {
        session: built.session,
        sessionManager: built.sessionManager,
        identity: `${agentDef.name}:stateless`,
        wakeIndex: deps.poolScope.wakeIndex,
    };
}

/* ------------------------------------------------------------------ */
/*  工作流引用(§6.1 一次完整唤醒)                                       */
/* ------------------------------------------------------------------ */

async function runFlowRef(
    spec: SubagentSpec,
    flowDef: FlowDefinition,
    input: string,
    deps: SpawnDeps & { signal?: AbortSignal },
    t0: number,
): Promise<SpawnResult> {
    if (spec.appendSystemPrompt !== undefined || spec.session !== undefined) {
        deps.warn?.(`subagent "${spec.name}" 为工作流引用,appendSystemPrompt/session 不适用(已忽略,10 §6.1)`);
    }
    // 链式键(§3.3):外层 spawn 的子会话作为「宿主」标识
    const chainedHostId = `${deps.poolScope.flowName}#${deps.poolScope.nodeKey}>${deps.poolScope.hostSessionId}`;
    const parentPath = spawnParentPath(deps);
    const wakeNo = deps.poolScope.wakeIndex;
    emitSpawn(
        deps,
        spawnStartFrame(wakeNo, parentPath, 'subflow', spec.name, spec.title ?? flowDef.title ?? spec.name),
    );
    const run = deps.wakeRun ?? wakeFlow;
    try {
        const outcome = await run({
            flow: flowDef,
            hostMessages: [{ role: 'user', content: input, timestamp: Date.now() } as AgentMessage],
            wakeIndex: 1, // 子流独立计数
            hostSessionId: chainedHostId,
            env: { ...deps.env, flowContext: flowDef },
            signal: deps.signal,
            maxHops: deps.env.config.maxHops,
        });
        if (outcome.ok) {
            // M7 记账(docs/40 §6):父路径 > subflow:<flow>#<terminal>(终点文本即返回值,§6.2);
            // 子工作流内部各节点的用量已在同一 ledger 记账(env 是共享引用),此处补链路父段汇总。
            deps.env
                .usageLedger?.()
                ?.record(
                    appendPathSegment(deps.poolScope.agentPath, subflowSegment(flowDef.name, outcome.result.terminal)),
                    { durationMs: Date.now() - t0 },
                );
            emitSpawn(deps, spawnEndFrame(wakeNo, parentPath, spec.name, 'ok', Date.now() - t0));
            return { text: outcome.result.text, usage: zeroUsage(), durationMs: Date.now() - t0 };
        }
        if (outcome.aborted) {
            emitSpawn(deps, spawnEndFrame(wakeNo, parentPath, spec.name, 'aborted', Date.now() - t0));
            throw outcome.error;
        }
        emitSpawn(deps, spawnEndFrame(wakeNo, parentPath, spec.name, 'error', Date.now() - t0));
        throw outcome.error;
    } catch (error) {
        // 上面未发 end 帧的异常路径(wakeRun 抛错等)补发
        if (error instanceof AbortedError) {
            emitSpawn(deps, spawnEndFrame(wakeNo, parentPath, spec.name, 'aborted', Date.now() - t0));
        } else {
            emitSpawn(deps, spawnEndFrame(wakeNo, parentPath, spec.name, 'error', Date.now() - t0));
        }
        throw error;
    }
}

/* ------------------------------------------------------------------ */
/*  子会话事件透传 / prompt / 结局                                        */
/* ------------------------------------------------------------------ */

/** 子会话 → NodeEvent 透传(文本/思考增量 + 占位工具;结构同 run-node execute) */
function pipeSubSessionEvents(ns: NodeSession, label: string, env: RunNodeEnv, visible: boolean): () => void {
    let sourceSeq = 0;
    let curSourceKey = '';
    let curSourceLabel = label;
    const emit = (event: Parameters<NonNullable<RunNodeEnv['onNodeEvent']>>[0]) => env.onNodeEvent?.(event);
    return ns.session.subscribe((event) => {
        if (event.type === 'message_update') {
            const e = event.assistantMessageEvent;
            if (e.type === 'thinking_delta') {
                emit({ kind: 'thinking-delta', sourceKey: curSourceKey, sourceLabel: curSourceLabel, delta: e.delta });
            } else if (e.type === 'text_delta') {
                // §3.1:子代理文本继承所属节点的 outputVisible(segmenter 据此分流);
                // 若收口判定非终点,与节点文本一同纠偏为 thinking
                emit({
                    kind: 'text-delta',
                    sourceKey: curSourceKey,
                    sourceLabel: curSourceLabel,
                    delta: e.delta,
                    isTerminal: false,
                    outputVisible: visible,
                });
            } else if (e.type === 'text_start' || e.type === 'thinking_start') {
                sourceSeq++;
                curSourceKey = `sub:${label}#${sourceSeq}`;
                curSourceLabel = label;
            } else if (e.type === 'toolcall_end') {
                // ask_user 桥接调用 → 真实透传(宿主执行 pi-web 本体,浏览器弹表单);
                // 其余工具调用 → 占位 agents_tool 包装。载荷畸形时退回占位包装(防御)。
                const q =
                    e.toolCall.name === ASK_USER_TOOL_NAME
                        ? (e.toolCall.arguments as { questions?: AskUserQuestionPayload[] } | undefined)?.questions
                        : undefined;
                if (Array.isArray(q) && q.length > 0) {
                    emit({
                        kind: 'ask-user',
                        sourceKey: curSourceKey,
                        sourceLabel: curSourceLabel,
                        ask: { questions: q },
                    });
                } else {
                    emit({
                        kind: 'tool-call',
                        sourceKey: curSourceKey,
                        sourceLabel: curSourceLabel,
                        toolCall: {
                            agent: label,
                            tool: e.toolCall.name,
                            arguments: safeArgs(e.toolCall.arguments),
                            truncated: false,
                        },
                    });
                }
            }
        }
    });
}

/** 子会话 prompt + usage 记账 + 结局判定(结构同 run-node execute;错误上抛) */
async function promptSubSession(
    ns: NodeSession,
    input: string,
    deps: SpawnDeps & { signal?: AbortSignal },
): Promise<{ usage: UsageDelta }> {
    const usage: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const unsubUsage = ns.session.subscribe((event) => {
        if (event.type === 'message_end') {
            const msg = event.message as {
                role?: string;
                usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
            };
            if (msg.role === 'assistant' && msg.usage) {
                usage.input += msg.usage.input;
                usage.output += msg.usage.output;
                usage.cacheRead += msg.usage.cacheRead;
                usage.cacheWrite += msg.usage.cacheWrite;
            }
        }
    });
    try {
        await ns.session.prompt(input, { expandPromptTemplates: false, source: 'extension' });
    } catch (error) {
        throw new Error(`子代理执行失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        unsubUsage();
    }
    // 结局判定(§6.2:内部报错 → isError;SDK 以 stopReason 表达)
    for (let i = (ns.session.messages as AgentMessage[]).length - 1; i >= 0; i--) {
        const m = (ns.session.messages as AgentMessage[])[i];
        if (m && m.role === 'assistant') {
            const stop = (m as { stopReason?: string }).stopReason;
            if (stop === 'aborted') throw new AbortedError((m as { errorMessage?: string }).errorMessage ?? '用户中断');
            if (stop === 'error') {
                throw new Error((m as { errorMessage?: string }).errorMessage ?? '子代理返回错误');
            }
            break;
        }
    }
    return { usage };
}

function safeArgs(args: unknown): JsonObject {
    return typeof args === 'object' && args !== null ? (args as JsonObject) : {};
}

function lastAssistantMsg(messages: AgentMessage[]): { stopReason?: string; content?: unknown } | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') return m as { stopReason?: string; content?: unknown };
    }
    return undefined;
}

/** 末条 assistant 消息的最后一个 toolCall 是否 ask_user(桥接挂起判定) */
function endsWithAskCall(msg: { content?: unknown }): boolean {
    const content = msg.content;
    if (!Array.isArray(content)) return false;
    const calls = content.filter((b) => (b as { type?: string }).type === 'toolCall') as Array<{ name?: string }>;
    return calls[calls.length - 1]?.name === ASK_USER_TOOL_NAME;
}

function zeroUsage(): UsageDelta {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}
