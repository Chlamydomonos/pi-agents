/**
 * 真实 NodeExecutor(docs/40 §5 runNode / §3 会话池 / 10 §3.1 解析链)。
 *
 * Agent 节点执行:
 *   1. 池 acquire(fresh 同唤醒内复用;inherit 跨唤醒复用 + seed 标记)
 *   2. 解析链:节点 > Agent > 全局配置 > pi 默认(模型/思考级别)
 *   3. tools = 白名单 ∩ 宿主可用(缺失静默忽略,10 §4)
 *   4. session.prompt 等待 settle;usage 增量记账;错误/中断以最终消息
 *      stopReason 判定(SDK 不以 reject 表达 LLM 失败)
 *
 * M4:子会话流事件透传(env.onNodeEvent → stream 层映射,docs/30 §3);
 * M5:世界书注入(三级评估 + system 槽位 + depth 动态/持久化,docs/10 §5);
 * M6:spawn_* 子代理工具(customTools 注册 + 白名单并入,docs/10 §6,递归委派);
 * onThinking/warn 由上层注入,便于单测与 UI 分离。
 */

import {
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    createAgentSession,
    type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentDefinition, FlowDefinition, FlowRunContext, LorebookContext, NodeSpec } from '../types.js';
import type { NodeExecutor } from '../engine/runner.js';
import type { PiAgentsConfig } from '../config.js';
import { SessionPool, type NodeSession } from './pool.js';
import { wrapToolArguments } from './stream-events.js';
import { createLorebookHook, toLorebookMessages } from './lorebook-hook.js';
import type { LorebookSource } from './lorebook.js';
import { createSpawnTools, normalizeSubagentSpecs, spawnToolName } from './spawn.js';
import {
    ASK_USER_POSTED_TEXT,
    ASK_USER_TOOL_NAME,
    type AskUserQuestionPayload,
    type NodeEvent,
} from './stream-events.js';
import type { FlowDefinition as FlowDef, SubagentSpec } from '../types.js';
import { nodePathPrefix, UsageLedger } from './usage.js';
import type { AgentFrame } from '../../shared/protocol.js';

/* ------------------------------------------------------------------ */
/*  环境依赖(runtime 组装;测试可替换)                                  */
/* ------------------------------------------------------------------ */

export interface RunNodeEnv {
    /** 所属工作流名(池键组成部分) */
    flowName: string;
    pool: SessionPool;
    /** 全局配置(解析链第 3 级) */
    config: PiAgentsConfig;
    /** Agent 定义表(装载结果) */
    agentsByName: Map<string, AgentDefinition>;
    /** 宿主可用工具名集合(白名单 ∩) */
    hostToolNames: ReadonlySet<string>;
    /** 工作目录(子会话与宿主共享 cwd,docs/40 §5.1) */
    cwd: () => string;
    /** 物理模型解析:provider/id → Model 对象;undefined = 目录中不存在 */
    resolveModel: (providerId: string, modelId: string) => unknown | undefined;
    /** thinking 行 */
    onThinking?: (line: string) => void;
    /** 子会话事件透传包(docs/30 §3 → stream 层映射);不设 = 不透传 */
    onNodeEvent?: (event: NodeEvent) => void;
    /** 告警 */
    warn?: (msg: string) => void;
    /** usage 增量记账(M7 持久化;M3 聚合到返回值) */
    onUsage?: (usage: UsageDelta) => void;
    /** 宿主中断信号(Esc 级联,D16) */
    signal?: AbortSignal;
    /**
     * 世界书三级来源(M5,docs/10 §5.2):agentName → 来源列表(Agent/工作流/工作区)。
     * 不设 = 无世界书;单级抛错由评估器按级跳过(§5.2)。
     */
    lorebookOf?: (agentName: string) => LorebookSource[];
    /** 工作流级世界书上下文(M5):Agent 节点所属工作流定义;subagent 身份 = null */
    flowContext?: FlowDef | null;
    /** 工作流名 → 定义(M6 spawn 工作流引用/描述;index 提供;缺省 = 无工作流可引) */
    flowByName?: (name: string) => FlowDef | undefined;
    /** M7:当前唤醒的记账器(index 每唤醒新建,onWakeOk 时 flush appendEntry;缺省 = 不记账) */
    usageLedger?: () => UsageLedger | undefined;
    /** M9:插件事件发射(spawn 帧;40 §13;缺省 = 不发射) */
    onAgentEvent?: (frame: AgentFrame) => void;
}

/** 世界书 flow 投影的可变桥(execute 每次执行前更新;hook makeContext 每请求读) */
interface FlowStateRef {
    current: FlowRunContext | null;
}

/** usage 增量 */
export interface UsageDelta {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

const ZERO: UsageDelta = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/* ------------------------------------------------------------------ */
/*  解析链(docs/10 §3.1)                                              */
/* ------------------------------------------------------------------ */

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
type PiThinkingLevel = (typeof THINKING_LEVELS)[number];

interface ResolvedModel {
    /** undefined = 走 pi 默认 */
    model: unknown | undefined;
    /** 显式指定的 provider/id;存在性由调用方校验 */
    requested?: string;
    thinkingLevel: PiThinkingLevel | undefined;
}

function resolveChain(spec: NodeSpec, agent: AgentDefinition, env: RunNodeEnv): ResolvedModel {
    const modelStr = spec.model ?? agent.model ?? (env.config.model || undefined);
    let model: unknown | undefined;
    let requested: string | undefined;
    if (modelStr) {
        requested = modelStr;
        const slash = modelStr.indexOf('/');
        if (slash <= 0 || slash === modelStr.length - 1) {
            env.warn?.(`模型 "${modelStr}" 不是 provider/id 形式,回退默认`);
            requested = undefined;
        } else {
            model = env.resolveModel(modelStr.slice(0, slash), modelStr.slice(slash + 1));
        }
    }
    const tlRaw = spec.thinkingLevel ?? agent.thinkingLevel ?? (env.config.thinkingLevel || undefined);
    const thinkingLevel =
        tlRaw && (THINKING_LEVELS as readonly string[]).includes(tlRaw) ? (tlRaw as PiThinkingLevel) : undefined;
    return { model, requested, thinkingLevel };
}

/* ------------------------------------------------------------------ */
/*  子会话创建                                                          */
/* ------------------------------------------------------------------ */

function subagentTools(agent: AgentDefinition, env: RunNodeEnv): string[] {
    const allow = agent.tools;
    const spawnNames = normalizeSubagentSpecs(agent).map((s) => spawnToolName(s.name));
    if (!allow || allow.length === 0) return spawnNames; // 缺省 = 仅 spawn_*(10 §2.1 + §6)
    // ask_user 不做宿主存在性过滤:子会话由本扩展的桥接工具同名提供(宿主工具表
    // 的 ask_user 是 pi-web 注册在宿主 session 的,pi.getAllTools() 在工作流唤醒
    // 时不一定可见——实测导致桥接未注册,模型只能以文本硬输出问题)。
    // 其余工具仍按白名单 ∩ 宿主(缺失静默忽略,10 §4)。
    const bridged = allow.includes(ASK_USER_TOOL_NAME) ? [ASK_USER_TOOL_NAME] : [];
    const rest = allow.filter((t) => t !== ASK_USER_TOOL_NAME && env.hostToolNames.has(t));
    return [...rest, ...bridged].concat(spawnNames);
}

/** M6 池键透传(spawn inherit 键 = 父键 + sub:<name>;§3.3)+ M7 记账父路径(§6) */
export interface PoolScope {
    flowName: string;
    nodeKey: string;
    hostSessionId: string;
    wakeIndex: number;
    /** 当前节点的 agentPath 前缀(spawn 在其后追加 sub:/subflow: 段) */
    agentPath: string;
    /** §3.1 输出可见性(节点配置;spawn 内子代理文本继承) */
    outputVisible: boolean;
}

async function createSubSession(
    agent: AgentDefinition,
    appendSystemPrompt: string | undefined,
    env: RunNodeEnv,
    flowState: FlowStateRef,
    model: unknown | undefined,
    thinkingLevel: PiThinkingLevel | undefined,
    /** M6:父会话池键要素(节点执行时传当前值;缺省 = 无 subagent 池定位) */
    poolScope?: PoolScope,
): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
    const sessionManager = SessionManager.inMemory(env.cwd());
    const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false }, // 超限直接报错(docs/40 §3.2)
    });

    // M5 世界书注入通道(docs/10 §5):inline extension 挂 context_with_system 事件,
    // 每次 LLM 请求前重算(已核实 agent-loop.transformContext → runner.emitContext)。
    const agentName = agent.name;
    const sources = () => env.lorebookOf?.(agentName) ?? [];
    const hook = createLorebookHook(
        {
            sourcesOf: sources,
            baseSystemPrompt: systemPromptBase(agent, appendSystemPrompt),
            makeContext: (messages, requestIndex) =>
                ({
                    agent: agentName,
                    messages: toLorebookMessages(messages),
                    flow: flowState.current,
                    extra: agent.extra,
                    requestIndex,
                }) satisfies LorebookContext,
            warn: env.warn,
        },
        // appendCustomMessageEntry 签名兼容(customType, content, display)
        sessionManager as unknown as Parameters<typeof createLorebookHook>[1],
    );

    // 系统提示词基座:resourceLoader.systemPromptOverride 在 reload 时计算;
    // 世界书 system 条目在 context_with_system 里每请求重写首个 system 消息(§5.1)。
    const resourceLoader = new DefaultResourceLoader({
        cwd: env.cwd(),
        agentDir: `${env.cwd()}/.pi`,
        settingsManager,
        noExtensions: true, // 禁磁盘扩展(子会话干净)
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [hook.factory],
        systemPromptOverride: () => systemPromptBase(agent, appendSystemPrompt).join('\n\n'),
    });
    await resourceLoader.reload();

    // M6 spawn_* 工具(docs/10 §6):本 Agent 的 subagents 列表 → 每条目一个工具;
    // 递归委派:子会话工厂递归调 createSubSession(子 Agent 定义里的 subagents 同样生效)。
    const scope: PoolScope = poolScope ?? {
        flowName: env.flowName,
        nodeKey: '',
        hostSessionId: '',
        wakeIndex: 0,
        agentPath: '',
        outputVisible: true,
    };
    const spawnDeps = {
        parentAgent: agent,
        env,
        outputVisible: scope.outputVisible,
        poolScope: scope,
        flowByName: env.flowByName,
        createSubSessionOf: (childAgent: AgentDefinition, childSpec: SubagentSpec) => {
            const childChain = resolveChain({ agent: childAgent.name }, childAgent, env);
            return createSubSession(
                childAgent,
                childSpec.appendSystemPrompt,
                env,
                flowState,
                // 子代理模型解析链(docs/10 §3.1):childAgent.model → config.model;
                // 不传 → pi 内置默认(glm-5.2),违背「模型默认走配置」
                childChain.model,
                childChain.thinkingLevel,
                // 子代理身份的池键 = 父键 + sub:<name>(§3.3;继承键链)
                { ...scope, nodeKey: `${scope.nodeKey}>sub:${childSpec.name}` },
            );
        },
        signal: env.signal,
        warn: env.warn,
        onAgentEvent: env.onAgentEvent,
    };
    const spawnTools = createSpawnTools(spawnDeps);

    // ask_user 桥接工具(见 stream-events.ASK_USER_TOOL_NAME):白名单含 ask_user
    // 即注册同名桥接(不依赖宿主工具表——pi.getAllTools() 在工作流唤醒时未必可见
    // pi-web 的 ask_user,实测此门槛导致桥接未注册)。execute 只返回 terminate 结果,
    // 真实执行在宿主 agent loop(pi-web 本体;pi-web 侧需开启 askUser 配置,否则
    // 宿主执行时报 unknown tool,模型会看到该错误)。事件由 execute 里的订阅
    // (toolcall_end)发出——不用创建时 env 发(池内 inherit 复用会引用旧唤醒的
    // segmenter,导致事件丢失/串唤醒)。
    const askTools: ToolDefinition[] = subagentTools(agent, env).includes(ASK_USER_TOOL_NAME)
        ? [createAskUserBridgeTool()]
        : [];
    const customTools = [...spawnTools, ...askTools];

    const { session } = await createAgentSession({
        cwd: env.cwd(),
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: subagentTools(agent, env),
        ...(customTools.length > 0 ? { customTools } : {}),
        ...(model !== undefined ? { model: model as never } : {}),
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    });
    return { session, sessionManager };
}

/**
 * ask_user 桥接工具(子会话侧):参数 schema 与 pi-web askUserTool 对齐
 * (id/question/detail/options/multiple),execute 返回 terminate:true——子会话
 * run 即止;ask-user NodeEvent 由节点执行订阅在 toolcall_end 时发出(不带 env 闭包)。
 */
function createAskUserBridgeTool(): ToolDefinition {
    return defineTool({
        name: ASK_USER_TOOL_NAME,
        label: 'Ask user',
        description:
            'Post a set of questions to the user as a browser form and end this run. Answers arrive later as a follow-up message; the user may leave any question unanswered.',
        parameters: Type.Object({
            questions: Type.Array(
                Type.Object({
                    id: Type.String({
                        description: 'Unique within this call; used as the answer key reported back to you.',
                    }),
                    question: Type.String({ description: 'The question itself, as one plain-text line.' }),
                    detail: Type.Optional(
                        Type.String({ description: 'Optional supporting context shown under the question.' }),
                    ),
                    options: Type.Optional(
                        Type.Array(
                            Type.Object({
                                value: Type.String({
                                    description:
                                        'Stable machine value reported back to you when the user picks this option.',
                                }),
                                label: Type.String({ description: 'Short label the user reads, ideally a few words.' }),
                                detail: Type.Optional(
                                    Type.String({ description: 'Optional clarification shown under the label.' }),
                                ),
                            }),
                            { description: 'Options to choose from. Omit when free text is the whole answer.' },
                        ),
                    ),
                    multiple: Type.Optional(
                        Type.Boolean({
                            description: 'Allow several options at once. Default: one answer per question.',
                        }),
                    ),
                }),
                { minItems: 1, description: 'The questions to post, in the order the user should read them.' },
            ),
        }),
        execute: async () => ({
            content: [{ type: 'text', text: ASK_USER_POSTED_TEXT }],
            details: { bridged: true },
            terminate: true,
        }),
    }) as unknown as ToolDefinition;
}

/** 系统提示词基座列表(10 §5.1:string 视为单元素) */
function systemPromptBase(agent: AgentDefinition, appendSystemPrompt: string | undefined): string[] {
    const base = typeof agent.systemPrompt === 'string' ? [agent.systemPrompt] : agent.systemPrompt;
    const out = [...base];
    if (appendSystemPrompt) out.push(appendSystemPrompt);
    return out;
}

/* ------------------------------------------------------------------ */
/*  NodeExecutor 组装                                                    */
/* ------------------------------------------------------------------ */

/** Esc 中断级联(D16):宿主 signal → 子会话 abort */
function bindAbort(signal: AbortSignal | undefined, session: AgentSession): void {
    if (!signal) return;
    if (signal.aborted) {
        session.abort().catch(() => {});
        return;
    }
    signal.addEventListener('abort', () => session.abort().catch(() => {}), { once: true });
}

/** 中断标记错误(引擎/流按 aborted 收尾;docs/40 §8) */
export class AbortedError extends Error {
    constructor(message = '用户中断') {
        super(message);
        this.name = 'AbortedError';
    }
}

/**
 * ask 挂起错误:节点末轮以桥接 ask_user 调用收尾(terminate 即止),工作流在
 * 此提前落定——提问已转发宿主,回答以 followUp 唤醒(新唤醒),继续跑后续节点
 * 只会浪费 token 且结果无人消费。runtime 捕获后按正常落定形态收尾
 * (text = 提问节点已产出的文本,terminal = 该节点)。
 */
export class AskPostedError extends Error {
    constructor(
        /** 发起提问的节点键(工作流提前终点) */
        readonly nodeKey: string,
        /** 提问节点已产出的文本(桥接 terminate 前的末轮文本,常为空) */
        readonly partialText: string,
        /** 该节点本次唤醒的执行轮次(trail 记录用) */
        readonly visit: number,
    ) {
        super('ask_user 已把问题提交给用户,工作流在此挂起等待回答');
        this.name = 'AskPostedError';
    }
}

export interface NodeExecutorFactory {
    execute: NodeExecutor;
    /** 进程内 usage 汇总(M7 之前用于调试) */
    collectUsage: () => UsageDelta;
}

/**
 * Agent 节点执行(docs/40 §5):池 acquire + 子会话 prompt + 事件透传。
 * ctx.node = 节点键(stream 层来源前缀/终点判定用;引擎传入)。
 */
export function createNodeExecutor(env: RunNodeEnv): NodeExecutorFactory {
    let usageTotal: UsageDelta = { ...ZERO };

    const execute: NodeExecutor = async (agentName, input, spec, ctx) => {
        const agent = env.agentsByName.get(agentName);
        if (!agent) {
            // 装载期已保证非悬空;防御
            throw new Error(`[pi-agents] Agent "${agentName}" 未装载`);
        }

        const chain = resolveChain(spec, agent, env);
        // 10 §3.1:显式 provider/id 在目录中不存在 → 运行期错误(error 流)
        if (chain.requested !== undefined && chain.model === undefined) {
            throw new Error(`模型 "${chain.requested}" 在模型目录中不存在(检查 provider/id 拼写与凭据)`);
        }

        const sessionMode = spec.sessionMode ?? 'fresh';
        const nodeKey = ctx.node ?? spec.label ?? agentName;
        const displayLabel = spec.label ?? nodeKey;
        // §3.1 输出可见性:节点配置(缺省 true);spawn 内子代理文本继承本值
        const outputVisible = spec.outputVisible ?? true;
        const wakeId = `${ctx.wake.hostSessionId}:${ctx.wake.wakeIndex}`;
        // fresh:identity 编入唤醒批次 → 跨唤醒必重建(池失配即弃旧建新);
        // inherit:稳定 identity 跨唤醒复用。
        const poolIdentity =
            sessionMode === 'fresh' ? `${agentName}:${sessionMode}@${wakeId}` : `${agentName}:${sessionMode}`;

        // 世界书 flow 投影(M5):节点执行期间,子会话每次 LLM 请求读到的 FlowRunContext。
        // 先初始化(trail 迄今 = ctx 不可见;scratch 共享同桶);节点完成后补 trail。
        const flowState: FlowStateRef = {
            current: env.flowContext
                ? {
                      flow: {
                          name: env.flowContext.name,
                          title: env.flowContext.title,
                          meta: env.flowContext.meta,
                      },
                      currentNode: nodeKey,
                      visit: ctx.visit,
                      wake: ctx.wake,
                      trail: [],
                      scratch: ctx.scratch,
                  }
                : null,
        };

        let ns: NodeSession;
        try {
            ns = await env.pool.acquire({
                flowName: env.flowName,
                nodeKey,
                hostSessionId: ctx.wake.hostSessionId,
                identity: poolIdentity,
                wakeIndex: ctx.wake.wakeIndex,
                create: () =>
                    createSubSession(
                        agent,
                        spec.appendSystemPrompt,
                        env,
                        flowState,
                        chain.model,
                        chain.thinkingLevel,
                        // M6:父会话池键 = 当前节点键(spawn inherit 键 = 此键 + sub:<name>,§3.3);
                        // M7:agentPath = 本节点路径(spawn 在其后追加 sub:/subflow: 段,§6)
                        {
                            flowName: env.flowName,
                            nodeKey,
                            hostSessionId: ctx.wake.hostSessionId,
                            wakeIndex: ctx.wake.wakeIndex,
                            agentPath: nodePathPrefix(env.flowName, displayLabel),
                            // §3.1:spawn 内子代理文本继承本节点输出可见性
                            outputVisible,
                        },
                    ),
            });
        } catch (error) {
            throw new Error(`子会话创建失败(${agentName}): ${error instanceof Error ? error.message : String(error)}`);
        }

        // usage 增量记账(docs/40 §6;M7 持久化)+ 流事件透传(docs/30 §3)
        const usageAcc: UsageDelta = { ...ZERO };
        let llmRequests = 0;
        let toolCalls = 0;
        // 节点内当前流式来源的 sourceKey/label(前缀只在新来源时换,§3.2)
        let curSourceKey = '';
        let curSourceLabel = '';
        let sourceSeq = 0;
        const emit = (event: NodeEvent) => env.onNodeEvent?.(event);
        // 节点开始(前缀来源标注;stream 层进入新来源时插一次前缀,§3.2)
        emit({ kind: 'node-start', nodeKey, label: displayLabel, visit: ctx.visit, isAgent: true });
        const emitDelta = (kind: 'thinking-delta' | 'text-delta', delta: string) => {
            if (kind === 'thinking-delta') {
                emit({ kind, sourceKey: curSourceKey, sourceLabel: curSourceLabel, delta });
            } else {
                emit({
                    kind,
                    sourceKey: curSourceKey,
                    sourceLabel: curSourceLabel,
                    delta,
                    isTerminal: true,
                    outputVisible,
                    nodeKey,
                });
            }
        };
        const unsubscribe = ns.session.subscribe((event) => {
            if (event.type === 'message_update') {
                // 子会话逐字流(message_update 携带原始 AssistantMessageEvent)
                const e = event.assistantMessageEvent;
                if (e.type === 'thinking_delta') {
                    emitDelta('thinking-delta', e.delta);
                } else if (e.type === 'text_delta') {
                    emitDelta('text-delta', e.delta);
                } else if (e.type === 'text_start' || e.type === 'thinking_start') {
                    // 新文本/思考块开启:换来源标注(同一子会话多次请求分段)
                    sourceSeq++;
                    curSourceKey = `${nodeKey}#${sourceSeq}`;
                    curSourceLabel = displayLabel;
                } else if (e.type === 'toolcall_end') {
                    toolCalls++;
                    // ask_user 桥接调用 → 真实透传事件(宿主执行 pi-web 本体,浏览器弹表单);
                    // 其余工具调用 → 占位 agents_tool 透传(§4)。载荷畸形时退占位(防御)。
                    const askQ =
                        e.toolCall.name === ASK_USER_TOOL_NAME
                            ? (e.toolCall.arguments as { questions?: AskUserQuestionPayload[] } | undefined)?.questions
                            : undefined;
                    if (Array.isArray(askQ) && askQ.length > 0) {
                        emit({
                            kind: 'ask-user',
                            sourceKey: curSourceKey,
                            sourceLabel: curSourceLabel,
                            ask: { questions: askQ },
                        });
                        return;
                    }
                    emit({
                        kind: 'tool-call',
                        sourceKey: curSourceKey,
                        sourceLabel: curSourceLabel,
                        toolCall: wrapToolArguments(e.toolCall.name, e.toolCall.arguments, displayLabel),
                    });
                }
            } else if (event.type === 'message_end') {
                const msg = event.message as AssistantMessage;
                if (msg.role === 'assistant') {
                    llmRequests++;
                    const u = msg.usage;
                    if (u) {
                        usageAcc.input += u.input;
                        usageAcc.output += u.output;
                        usageAcc.cacheRead += u.cacheRead;
                        usageAcc.cacheWrite += u.cacheWrite;
                        env.onUsage?.({
                            input: u.input,
                            output: u.output,
                            cacheRead: u.cacheRead,
                            cacheWrite: u.cacheWrite,
                        });
                    }
                }
            } else if (event.type === 'tool_execution_end') {
                // 工具结果摘要行(§3.3);detail = ms 或错误首行
                const ok = !event.isError;
                const detail = ok
                    ? `${Math.round(event.durationMs ?? 0)}ms`
                    : (String(event.result ?? '').split('\n')[0] ?? '执行失败');
                emit({
                    kind: 'tool-result',
                    sourceKey: curSourceKey,
                    sourceLabel: curSourceLabel,
                    line: `${ok ? '✓' : '✗'} ${event.toolName} (${detail})`,
                });
            }
        });

        bindAbort(env.signal, ns.session);
        const t0 = Date.now();
        try {
            // M8:prompt 附带图片(ctx.images;pi 宿主原生支持,docs/20 §9.3/9.4)
            await ns.session.prompt(input, {
                expandPromptTemplates: false,
                source: 'extension',
                ...(ctx.images && ctx.images.length > 0 ? { images: ctx.images } : {}),
            });
        } catch (error) {
            // prompt reject:模型未选/无 key 等同步失败(docs/40 §8)
            throw new Error(
                `节点 "${nodeKey}" 子会话执行失败: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            unsubscribe();
        }

        // 结局判定:最后 assistant 消息 stopReason(docs/40 §8)
        const lastMsg = lastAssistant(ns.session.messages as AgentMessage[]);
        if (lastMsg && lastMsg.stopReason === 'aborted') {
            throw new AbortedError(lastMsg.errorMessage ?? '用户中断');
        }
        if (lastMsg && lastMsg.stopReason === 'error') {
            throw new Error(lastMsg.errorMessage ?? '子会话返回错误');
        }

        // ask 挂起检测:末轮以 ask_user 桥接调用收尾(terminate:true → 工作流止于此)
        if (lastMsg && endsWithAskUser(lastMsg)) {
            throw new AskPostedError(nodeKey, ns.session.getLastAssistantText() ?? '', ctx.visit);
        }

        const text = ns.session.getLastAssistantText() ?? '';
        usageTotal = {
            input: usageTotal.input + usageAcc.input,
            output: usageTotal.output + usageAcc.output,
            cacheRead: usageTotal.cacheRead + usageAcc.cacheRead,
            cacheWrite: usageTotal.cacheWrite + usageAcc.cacheWrite,
        };

        // M4 结果回补(§3 终点判定):引擎在结果上标注 isFlowTerminal,
        // stream 层据此纠偏首个 Agent 节点的预估 text 流。
        emit({ kind: 'node-text', nodeKey, text, isFlowTerminal: false });

        // M7 记账(docs/40 §6):本节点路径一次汇总(请求/工具/耗时/token)
        env.usageLedger?.()?.record(nodePathPrefix(env.flowName, displayLabel), {
            ...usageAcc,
            requests: llmRequests,
            toolCalls,
            durationMs: Date.now() - t0,
        });

        env.onThinking?.(`—— 节点 ${displayLabel} 完成(${llmRequests} 次请求,${Date.now() - t0}ms)——`);

        return {
            text,
            message: lastMsg,
            stats: {
                durationMs: Date.now() - t0,
                llmRequests,
                toolCalls,
                usage: { ...usageAcc },
            },
        };
    };

    return { execute, collectUsage: () => ({ ...usageTotal }) };
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m && m.role === 'assistant') return m as AssistantMessage;
    }
    return undefined;
}

/** 末条 assistant 消息是否以 ask_user 工具调用收尾(stopReason toolUse + 末块 ask_user) */
function endsWithAskUser(msg: AssistantMessage): boolean {
    if (msg.stopReason !== 'toolUse') return false;
    const calls = msg.content.filter((b) => (b as { type?: string }).type === 'toolCall');
    const last = calls[calls.length - 1] as { name?: string } | undefined;
    return last?.name === ASK_USER_TOOL_NAME;
}
