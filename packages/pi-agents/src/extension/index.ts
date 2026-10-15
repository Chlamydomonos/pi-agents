/**
 * pi-agents 扩展入口(docs/60 §1)。
 *
 * M3:M1 装载 + 会话层接线(session_start 扫描、provider 注册、池生命周期)。
 * M4:虚拟模型完整化(docs/30)——
 *   - 占位工具 agents_tool 固定名注册(§4.2,defaultActive: false);
 *   - model_select 激活控制:选中工作流模型 → setActiveTools 加入 agents_tool,
 *     切走 → 移除(保留宿主原有活跃集,§4.4);
 *   - streamSimple 完整映射:前缀化 thinking/占位 toolcall/工具摘要(§3);
 *   - 唤醒成功 → lastOutputs 写回(下一唤醒的 WakeContext.lastOutput)。
 * 世界书注入/subagent spawn_* 工具属 M5/M6。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import {
    defineTool,
    type ExtensionAPI,
    type ExtensionContext,
    type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
    AssistantMessageEventStream,
    Model,
    Api,
    TranscriptContext,
    SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import { registerApiProvider, unregisterApiProviders } from '@earendil-works/pi-ai/compat';
import { loadConfig } from './config.js';
import { loadAll, defaultRoots, type LoadAllResult } from './loader/load.js';
import { catalogFrom, piEventEmitter, type Emitter } from './emit.js';
import type { AgentFrame, BrowserFrame } from '../shared/protocol.js';
import type { Warn } from './loader/validate.js';
import { AGENT_SUBDIRS, scaffoldAgentsDir } from './scaffold.js';
import { SessionPool } from './session/pool.js';
import { buildHistoryDigest } from './session/runtime.js';
import { createStreamSimple, type StreamDeps } from './session/stream.js';
import type { RunNodeEnv } from './session/run-node.js';
import type { LorebookSource } from './session/lorebook.js';
import {
    USAGE_ENTRY_TYPE,
    UsageLedger,
    aggregateUsageEntries,
    formatUsageDetails,
    formatUsageTable,
    type PathUsage,
    type UsageEntryData,
} from './session/usage.js';
import { PLACEHOLDER_RESULT_TEXT, PLACEHOLDER_TOOL_NAME, type NodeEvent } from './session/stream-events.js';
import type { AgentDefinition, FlowDefinition } from './types.js';

/* ------------------------------------------------------------------ */
/*  装载表展示(M1 的「warning/表」验收形态)                            */
/* ------------------------------------------------------------------ */

function formatTable(result: LoadAllResult, cwd: string): string {
    const lines: string[] = [];
    const rel = (p: string): string => (p.startsWith(cwd) ? p.slice(cwd.length + 1) : p);

    if (result.agents.length > 0) {
        lines.push(`Agents (${result.agents.length}):`);
        for (const a of result.agents) {
            const subs = a.subagentRefs.map((r) => r.name);
            lines.push(
                `  ${a.def.name}  — ${a.def.description}  [${rel(a.filePath)}]${subs.length > 0 ? ` → sub: ${subs.join(', ')}` : ''}`,
            );
        }
    }
    if (result.flows.length > 0) {
        lines.push(`Agent flows (${result.flows.length}):`);
        for (const f of result.flows) {
            const nodeNames = Object.entries(f.def.nodes)
                .map(([k, n]) => `${k}${n.agent ? `(${n.agent})` : '(fn)'}`)
                .join(' ');
            lines.push(`  ${f.def.name}  — ${f.def.description}  [${rel(f.filePath)}]  nodes: ${nodeNames}`);
        }
    }
    if (result.lorebooks.length > 0) {
        lines.push(`Workspace lorebooks (${result.lorebooks.length}):`);
        for (const lb of result.lorebooks) {
            lines.push(`  ${lb.sourceName}  [${rel(lb.filePath)}]`);
        }
    }
    if (result.invalid.length > 0) {
        lines.push(`Invalid (${result.invalid.length}):`);
        for (const inv of result.invalid) {
            lines.push(`  ${rel(inv.file)}`);
            for (const r of inv.reasons) lines.push(`    - ${r}`);
        }
    }
    if (lines.length === 0) lines.push('(未装载到任何 Agent/工作流/世界书)');
    return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  占位工具(docs/30 §4.2,D14):固定名惰性集                            */
/* ------------------------------------------------------------------ */

function placeholderTool() {
    return defineTool({
        name: PLACEHOLDER_TOOL_NAME,
        label: '工作流工具调用(展示用)',
        description:
            '此工具由 pi-agents 工作流引擎调用,表示某个 Agent 在工作流内部真实执行了一次工具。返回值仅为占位说明。',
        parameters: Type.Object({
            agent: Type.String({ description: '执行该工具的 Agent/节点标注' }),
            tool: Type.String({ description: '真实工具名' }),
            arguments: Type.Record(Type.String(), Type.Unknown(), { description: '真实调用参数(原样展示)' }),
        }),
        execute: async (_toolCallId, params) => ({
            content: [{ type: 'text', text: PLACEHOLDER_RESULT_TEXT }],
            details: { placeholder: true, tool: params.tool },
        }),
        // 活跃性由 model_select → setActiveTools 控制(§4.4):仅选中工作流模型时激活
        defaultActive: false,
    });
}

/* ------------------------------------------------------------------ */
/*  激活控制(docs/30 §4.4):snapshot → 增删 agents_tool                  */
/* ------------------------------------------------------------------ */

/** 宿主原有活跃集快照(首次切换时捕获,切走时恢复) */
function snapshotActiveOnce(pi: ExtensionAPI, state: { snapshot: string[] | null }): void {
    if (state.snapshot !== null) return;
    try {
        state.snapshot = [...pi.getActiveTools()];
    } catch {
        state.snapshot = [];
    }
}

/** 选中工作流模型 → 加入 agents_tool;切走 → 恢复宿主原集(§4.4) */
function applyWorkflowActivation(pi: ExtensionAPI, state: { snapshot: string[] | null }, active: boolean): void {
    snapshotActiveOnce(pi, state);
    const base = state.snapshot ?? [];
    try {
        if (active) {
            if (!base.includes(PLACEHOLDER_TOOL_NAME)) pi.setActiveTools([...base, PLACEHOLDER_TOOL_NAME]);
        } else {
            // 恢复宿主原集(移除期间动态加入的 agents_tool)
            const current = pi.getActiveTools();
            if (current.includes(PLACEHOLDER_TOOL_NAME)) {
                pi.setActiveTools(current.filter((t) => t !== PLACEHOLDER_TOOL_NAME));
            }
        }
    } catch (error) {
        console.warn(`[pi-agents] setActiveTools 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** 宿主消息 provider 是否为本扩展虚拟模型 */
function isVirtualModel(model: unknown): boolean {
    return (model as { provider?: string } | undefined)?.provider === 'pi-workflows';
}

/* ------------------------------------------------------------------ */
/*  工厂                                                                */
/* ------------------------------------------------------------------ */

const PROVIDER_NAME = 'pi-workflows';

/** streamSimple 稳定包装签名(pi-ai SimpleStreamOptions 形参顺序与 createStreamSimple 产物一致) */
type StreamSimpleFn = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/*
 * pi-web 全局冻结策略(docs/60 §7)只放行 models-only 的 provider 重注册:除 models 外
 * 全部字段须与 baseline deep-equal,函数字段按引用比较。而扩展工厂在 pi-web 里每个
 * 会话各建一次 createStreamSimple 闭包(jiti 模块缓存隔离下引用必然不等),直接把
 * streamSimple 放进 provider config 会被冻结忽略。
 * 解法:provider config 只留纯静态字段(models-only 检查必然通过);流式调用改走
 * pi-ai 的进程级 API registry(registerApiProvider,不受冻结策略约束),注册同一个
 * 虚拟 api id,调用时委托最近一次工厂创建的实现。CLI 直连 pi 无冻结,此方案同样成立。
 */
let activeStreamSimple: StreamSimpleFn | undefined;
const stableStreamSimple: StreamSimpleFn = (model, context, options) => {
    if (!activeStreamSimple) throw new Error('pi-agents:streamSimple 尚未初始化');
    return activeStreamSimple(model, context, options);
};
const VIRTUAL_API_ID = 'pi-agents-virtual';
const VIRTUAL_API_SOURCE = 'pi-agents';
// 幂等:先撤后注,避免重复注册报错(同 api id 覆盖亦可,显式撤注更稳)
unregisterApiProviders(VIRTUAL_API_SOURCE);
registerApiProvider(
    {
        api: VIRTUAL_API_ID as never,
        stream: () => {
            throw new Error('pi-agents:非 simple 流式调用不支持(虚拟工作流模型仅走 streamSimple)');
        },
        streamSimple: stableStreamSimple,
    },
    VIRTUAL_API_SOURCE,
);

const extension: ExtensionFactory = async (pi: ExtensionAPI) => {
    const warn = (message: string) => {
        console.warn(`[pi-agents] ${message}`);
    };

    let lastResult: LoadAllResult | null = null;

    // per-运行时状态:会话池(docs/40 §12:池随扩展运行时走,键带 hostSessionId)
    const pool = new SessionPool();
    // 当前有效工作流表(model.id → def;注册 provider 时重建)
    let flowByName = new Map<string, FlowDefinition>();
    // 各宿主 session 的唤醒序号(docs/40 §4 WakeContext.wakeIndex,从 1 起)
    const wakeCounters = new Map<string, number>();
    // 各宿主 session 上一次唤醒输出(WakeContext.lastOutput;M4 接线)
    const lastOutputs = new Map<string, string>();
    // 激活控制状态(§4.4):宿主原活跃集快照
    const activation = { snapshot: null as string[] | null };

    // M9:插件事件发射器(pi.events 无订阅者时零开销旁路,40 §13)
    const agentEmit: Emitter = piEventEmitter(pi.events);
    // M9:浏览器 refresh-catalog cmd → 重发 catalog 帧(先订阅后收帧铁律)
    pi.events.on('pi-agents', (data) => {
        const frame = data as BrowserFrame;
        if (!frame || typeof frame !== 'object' || frame.kind !== 'cmd' || frame.action !== 'refresh-catalog') return;
        if (lastResult) agentEmit(catalogFrom(lastResult));
    });

    // 最近一次事件上下文(streamSimple 无 ctx 参数;会话内事件期间捕获)
    let currentCtx: ExtensionContext | undefined;
    // Agent 定义表(装载结果;streamSimple 唤醒时消费)
    const agentTable = new Map<string, AgentDefinition>();

    const makeLorebookSources = (
        agentName: string,
        flowName: string,
        agents: Map<string, AgentDefinition>,
        flows: Map<string, FlowDefinition>,
        loaded: LoadAllResult | null,
    ): LorebookSource[] => {
        const sources: LorebookSource[] = [];
        const agentDef = agents.get(agentName);
        if (agentDef?.lorebook) {
            // 级 0:Agent 级(优先级最高,docs/10 §5.2)
            sources.push({ spec: agentDef.lorebook, level: 0, name: `agent:${agentName}` });
        }
        const flowDef = flows.get(flowName);
        if (flowDef?.lorebook) {
            // 级 1:工作流级
            sources.push({ spec: flowDef.lorebook, level: 1, name: `flow:${flowName}` });
        }
        if (loaded && loaded.lorebooks.length > 0) {
            // 级 2:工作区级(lorebooks/*.ts;按 ctx.agent 筛选交给 LorebookContext.agent)
            for (const lb of loaded.lorebooks) {
                sources.push({ spec: lb.def, level: 2, name: `lorebook:${lb.sourceName}` });
            }
        }
        return sources;
    };

    // 本工厂实例的 streamSimple(委托目标;见模块级 stableStreamSimple 注释)
    const streamSimple = createStreamSimple({
        get flowByName() {
            return flowByName;
        },
        streamPrefixes: () => {
            try {
                return currentCtx ? loadConfig(currentCtx.cwd, () => {}).streamPrefixes : true;
            } catch {
                return true;
            }
        },
        signalOf: (options) => options?.signal,
        resolveTitleModel: () => {
            // 宿主标题生成请求改道(config.titleModel;识别与调用在 stream.ts)
            const ctx = currentCtx;
            if (!ctx) return undefined;
            const spec = loadConfig(ctx.cwd, () => {}).titleModel;
            if (!spec) return undefined;
            const slash = spec.indexOf('/');
            if (slash <= 0 || slash === spec.length - 1) return undefined;
            try {
                return ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) as Model<Api> | undefined;
            } catch {
                return undefined;
            }
        },
        logError: (msg) => console.error(msg),
        onWakeOk: (_modelId, hostSessionId, text) => {
            // 写回 lastOutput(docs/40 §4 WakeContext.lastOutput;M4 接线)
            lastOutputs.set(hostSessionId, text);
        },
        buildWakeArgs: (model, context) => {
            // 此闭包在每次唤醒时执行;需要 ctx —— 由 session 事件期间捕获的最近上下文提供
            const ctx = currentCtx;
            if (!ctx) throw new Error('pi-agents:扩展上下文未就绪');
            const hostSessionId = ctx.sessionManager.getSessionId();
            const wakeIndex = (wakeCounters.get(hostSessionId) ?? 0) + 1;
            wakeCounters.set(hostSessionId, wakeIndex);
            const config = loadConfig(ctx.cwd, warn);
            // 工具表来自工厂入口的 pi(ExtensionAPI.getAllTools);ctx 上没有此方法
            const hostToolNames: ReadonlySet<string> = new Set(pi.getAllTools().map((t) => t.name));
            const hostMessages = context.messages.filter((m) => m.role !== 'system') as AgentMessage[];
            const flow = flowByName.get(model.id);
            if (!flow) throw new Error(`工作流 "${model.id}" 未注册`);
            // §4.2:inherit 首唤醒用宿主历史(去 system)生成压缩脚本
            const seededNodes = new Set<string>();
            for (const key of Object.keys(flow.nodes)) {
                if (flow.nodes[key]?.sessionMode === 'inherit') seededNodes.add(key);
            }
            // M7:每唤醒一个记账器(config.usage 开关;onWakeOk 时 flush appendEntry,§6)
            const ledger = config.usage ? new UsageLedger() : undefined;
            return {
                hostMessages,
                wakeIndex,
                hostSessionId,
                ...(lastOutputs.has(hostSessionId) ? { lastOutput: lastOutputs.get(hostSessionId) } : {}),
                maxHops: config.maxHops,
                seedInputOf: (nodeKey) => {
                    if (!seededNodes.has(nodeKey)) return undefined;
                    const digest = buildHistoryDigest(hostMessages, '');
                    return digest.length > 0 ? digest : undefined;
                },
                onAbortCleanup: (nodeKeys) => {
                    void (async () => {
                        for (const key of nodeKeys) await pool.evict(model.id, key, hostSessionId);
                        warn(`工作流 ${model.id}:中断,inherit 节点已弃池(${nodeKeys.join(', ')})`);
                    })();
                },
                env: {
                    flowName: model.id,
                    pool,
                    config,
                    agentsByName: agentTable,
                    hostToolNames,
                    cwd: () => ctx.cwd,
                    resolveModel: (providerId, modelId) => ctx.modelRegistry.find(providerId, modelId),
                    warn,
                    lorebookOf: (agentName) =>
                        makeLorebookSources(agentName, model.id, agentTable, flowByName, lastResult),
                    flowContext: flow,
                    // M6:spawn_* 工作流引用所需(name → 定义;引用校验/工具描述/唤醒)
                    flowByName: (name) => flowByName.get(name),
                    // M7:当前唤醒记账器(节点/子代理完成后 record,§6)
                    usageLedger: () => ledger,
                    // M9:spawn/node/edge 帧发射(40 §13;wake 帧由 stream 层发)
                    onAgentEvent: (frame: AgentFrame) => agentEmit(frame),
                } satisfies RunNodeEnv,
                // M7:唤醒结束 flush(entry 载荷在 stream onWakeOk 时经此构造)
                usageFlush: ledger
                    ? () => {
                          if (ledger.size === 0) return;
                          const byPath: Record<string, PathUsage> = {};
                          for (const [path, usage] of ledger.snapshot()) byPath[path] = usage;
                          pi.appendEntry(USAGE_ENTRY_TYPE, { wake: wakeIndex, byPath } satisfies UsageEntryData);
                      }
                    : undefined,
            };
        },
    });
    // 稳定包装的委托目标指向本工厂实例(见 stableStreamSimple 注释;后创建者覆盖先创建者,
    // pi-web 里最后一次工厂调用即当前活跃会话所在进程的实例)
    activeStreamSimple = streamSimple;

    const registerProvider = (result: LoadAllResult) => {
        // 幂等:先撤旧注册(reload/重扫后模型集可能变化;工厂期 pending 队列同样生效)
        pi.unregisterProvider(PROVIDER_NAME);
        flowByName = new Map(result.flows.map((f) => [f.def.name, f.def]));
        // pi-web 全局冻结策略(docs/60 §7):bootstrap 在空 cwd 里装载本扩展并捕获 provider
        // baseline 后冻结注册;之后所有注册/撤销都被 no-op——唯一放行是 models-only 更新
        // (baseline 已有该 provider 且新 config 除 models 外逐字段 deep-equal,函数字段须同引用)。
        // 因此工厂期即使扫不到工作流也要注册 models:[] 占位,把 pi-workflows 写进 baseline;
        // 会话期重扫(session_start/reload)只替换 models → 命中放行,模型目录对会话可见。
        // CLI 直连 pi 无此冻结,占位注册同样无害。
        pi.registerProvider(PROVIDER_NAME, {
            name: 'Pi Workflows',
            baseUrl: 'http://pi-workflows.invalid',
            apiKey: 'not-needed',
            api: VIRTUAL_API_ID as never,
            models: [...flowByName.values()].map((f) => ({
                id: f.name,
                name: f.title,
                reasoning: true,
                input: ['text' as const],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1_000_000,
                maxTokens: 1_000_000,
            })),
        });
    };

    /** 一次装载 + 填 agentTable + 注册 provider(工厂期与 session_start 共用) */
    async function scanAndRegister(cwd: string, hasUI: boolean): Promise<LoadAllResult> {
        const result = await loadAll(defaultRoots(cwd), warn);

        const table = formatTable(result, cwd);
        console.warn(
            `[pi-agents] 装载完成:${result.agents.length} agent(s), ${result.flows.length} flow(s), ${result.lorebooks.length} lorebook(s), ${result.invalid.length} invalid, ${result.warnings.length} warning(s)\n${table}`,
        );

        if (hasUI) {
            const firstInvalid = result.invalid[0];
            if (firstInvalid) {
                const fileName = firstInvalid.file.split('/').pop() ?? firstInvalid.file;
                currentCtx?.ui.notify(
                    `pi-agents:${result.invalid.length} 个文件装载失败(首个:${fileName} — ${firstInvalid.reasons[0] ?? ''}),详情见日志(/agents 查看)`,
                    'error',
                );
            } else if (result.warnings.length > 0) {
                currentCtx?.ui.notify(
                    `pi-agents:${result.warnings.length} 条告警(如工作区覆盖全局),详情见日志(/agents 查看)`,
                    'warning',
                );
            }
        }

        agentTable.clear();
        for (const a of result.agents) agentTable.set(a.def.name, a.def);
        registerProvider(result);
        // M9:目录帧(装载完成即发;面板打开早于装载时由 refresh-catalog cmd 补)
        agentEmit(catalogFrom(result));
        return result;
    }

    pi.on('session_start', async (event, ctx) => {
        currentCtx = ctx;
        // reload/startup 都全量重扫(mtime 缓存让未变更文件零成本)
        lastResult = await scanAndRegister(ctx.cwd, ctx.hasUI);
        // startup/reload/new → 空池;resume/fork → 按 docs/40 §9 不恢复(M3 先清空,
        // 下次唤醒 inherit 按「首唤醒」重新导入,M5 前不做 thinking 提示)
        await pool.disposeAll();
        void event;
    });

    pi.on('session_shutdown', () => {
        // 幂等清理(docs/40 §3.2/§8);错误静默(清理失败不影响宿主退出)
        void pool.disposeAll();
        // 切走恢复宿主原活跃集(§4.4;shutdown 时保守还原)
        applyWorkflowActivation(pi, activation, false);
    });

    pi.on('session_tree', () => {
        // 分支切换:保守清空全部 inherit 池(docs/40 §3.2)
        void pool.disposeAll();
    });

    // 激活控制(docs/30 §4.4):选中工作流模型 ↔ agents_tool 增删
    pi.on('model_select', (event) => {
        const toVirtual = isVirtualModel(event.model);
        const fromVirtual = isVirtualModel(event.previousModel);
        if (toVirtual && !fromVirtual) applyWorkflowActivation(pi, activation, true);
        else if (!toVirtual && fromVirtual) applyWorkflowActivation(pi, activation, false);
    });

    // 占位工具(§4.2):工厂内注册一次;激活由 model_select 控制
    pi.registerTool(placeholderTool());

    pi.registerCommand('agents', {
        description: 'pi-agents:显示已装载的 Agent/工作流/世界书装载表',
        handler: async (_args, cmdCtx) => {
            if (lastResult) {
                cmdCtx.ui.notify(formatTable(lastResult, cmdCtx.cwd), 'info');
            } else {
                lastResult = await scanAndRegister(cmdCtx.cwd, cmdCtx.hasUI);
            }
        },
    });

    // /agent-init(docs/50 §1):建立 chlamydomonos-agents 目录 + tsconfig + 类型定义,
    // 使编辑器在编写 Agent/工作流时获得类型提示(不依赖 npm 安装本包)。
    // 默认工作区目录;带 `--global` 则用全局 ~/.pi/agent/chlamydomonos-agents。
    pi.registerCommand('agent-init', {
        description:
            'pi-agents:初始化 chlamydomonos-agents 目录(agents/agent-flows/lorebooks + tsconfig.json + 类型定义)',
        handler: async (args, cmdCtx) => {
            const useGlobal = args.trim().split(/\s+/).includes('--global');
            const baseDir = useGlobal
                ? join(homedir(), '.pi', 'agent', 'chlamydomonos-agents')
                : join(cmdCtx.cwd, '.pi', 'chlamydomonos-agents');
            // 本包作者契约 types.ts 路径(与 loader 的 jiti alias 同源)
            const typesPath = fileURLToPath(new URL('./types.ts', import.meta.url));
            try {
                const result = scaffoldAgentsDir({ baseDir, typesPath });
                const lines = [
                    `pi-agents:已初始化 ${result.baseDir}`,
                    `   子目录:${AGENT_SUBDIRS.join(', ')}`,
                    `   生成:${result.created.length > 0 ? result.created.join(', ') : '(无,已是最新)'}`,
                    ...(result.skipped.length > 0 ? [`   跳过(已存在):${result.skipped.join(', ')}`] : []),
                    '   下一步:编写 agents/*.ts 或 agent-flows/*.ts,然后 /reload 生效',
                ];
                cmdCtx.ui.notify(lines.join('\n'), 'info');
            } catch (error) {
                cmdCtx.ui.notify(
                    `pi-agents:初始化失败 — ${error instanceof Error ? error.message : String(error)}`,
                    'error',
                );
            }
        },
    });

    // /agent-usage(docs/40 §7):本 session 分支内全部 pi-agents:usage entry 聚合展示
    pi.registerCommand('agent-usage', {
        description: 'pi-agents:查看各 Agent/工作流路径的真实 token 用量(-v 含细节)',
        handler: async (args, cmdCtx) => {
            const entries = cmdCtx.sessionManager.getBranch();
            const { byPath, wakeCount } = aggregateUsageEntries(entries);
            if (byPath.size === 0) {
                cmdCtx.ui.notify('pi-agents:本 session 尚无用量记录(需要至少一次成功的工作流唤醒)', 'info');
                return;
            }
            const table = formatUsageTable({
                title: `pi-agents 用量(session:${cmdCtx.sessionManager.getSessionId()},x${String(wakeCount)} 次唤醒)`,
                byPath: byPath as ReadonlyMap<string, PathUsage>,
            });
            const detail = args.trim().startsWith('-v') ? `\n${formatUsageDetails(byPath)}` : '';
            cmdCtx.ui.notify(table + detail, 'info');
        },
    });

    // 工厂期预装载(pi v1.1.0 实测):loading 态的 registerProvider 入 pending 队列,
    // createAgentSessionServices 在 CLI --model 解析之前 flush——不放这里的话,
    // `pi --model pi-workflows/dev-loop` 启动即报 Model not found(session_start 太晚)。
    // ExtensionAPI 无 cwd 属性,工厂以 process.cwd() 探测(pi 默认即此);
    // session_start 会用 ctx.cwd 精确重扫,此处仅保证启动期模型可见。
    await scanAndRegister(process.cwd(), false);
};

export default extension;
/** 透传包类型再导出(run-node/stream 内部消费;供测试导入) */
export type { NodeEvent };
