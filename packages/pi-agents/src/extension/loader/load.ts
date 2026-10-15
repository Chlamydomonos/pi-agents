/**
 * 装载器(docs/40 §2):
 *   - jiti 直载 TS;每文件 mtime 缓存;重装失败保留旧定义(warning),首次失败判无效
 *   - 全量装载后做引用解析与环检测(docs/40 §2.3)
 *   - jiti alias:@chlamydomonos/pi-agents → 本包 types.ts(作者 import type 兜底,docs/60 §2;
 *     旧名 `pi-agents` 保留为兼容别名)
 */
import { createJiti, type Jiti } from 'jiti';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { scanAll, statMtimeMs, type ScanEntry, type ScanRoots } from './scan.js';
import {
    validateAgent,
    validateFlow,
    validateWorkspaceLorebook,
    type Invalid,
    type ValidatedFlow,
} from './validate.js';
import type { AgentDefinition, FlowDefinition, SubagentSpec, WorkspaceLorebook } from '../types.js';

export type Warn = (message: string) => void;

/* ------------------------------------------------------------------ */
/*  jiti 单例                                                          */
/* ------------------------------------------------------------------ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let jitiLoader: Jiti | null = null;

function typesTsPath(): string {
    // 本文件 = src/extension/loader/load.ts → types.ts = ../types.ts
    return fileURLToPath(new URL('../types.ts', import.meta.url));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getJiti(): any {
    if (!jitiLoader) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        jitiLoader = createJiti(import.meta.url, {
            // cache:false 只关文件系统缓存,不关 jiti 的内存 moduleCache(改坏文件后仍拿到旧模块,
            // 重装失败语义失效);必须显式同时关 moduleCache/fsCache,新旧由本文件的 mtime 缓存裁决。
            cache: false,
            moduleCache: false,
            fsCache: false,
            alias: {
                // 作者文件 import type { ... } from '@chlamydomonos/pi-agents'
                // 在未安装本包时也能类型擦除通过;旧名 'pi-agents' 保留兼容。
                '@chlamydomonos/pi-agents': typesTsPath(),
                'pi-agents': typesTsPath(),
            },
        });
    }
    return jitiLoader;
}

/* ------------------------------------------------------------------ */
/*  单文件装载(mtime 缓存)                                            */
/* ------------------------------------------------------------------ */

export interface LoadOutcome<T> {
    value: T | Invalid;
    mtimeMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const moduleCache = new Map<string, { mtimeMs: number; mod: any | null }>();

/** jiti 装载 + mtime 缓存;失败缓存 null(deterministic rethrow) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function importModule(filePath: string): Promise<any> {
    const mtimeMs = statMtimeMs(filePath);
    const cached = moduleCache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
        if (cached.mod === null) throw new Error('模块此前加载失败(缓存)');
        return cached.mod;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await getJiti().import(filePath);
        moduleCache.set(filePath, { mtimeMs, mod });
        return mod;
    } catch (error) {
        moduleCache.set(filePath, { mtimeMs, mod: null });
        throw error instanceof Error ? error : new Error(String(error));
    }
}

/** 测试用:清空模块 mtime 缓存与上次成功定义缓存 */
export function clearModuleCache(): void {
    moduleCache.clear();
    lastGoodDefs.clear();
}

/**
 * 每文件上次成功装载且通过校验的定义(跨 loadAll 调用存活,docs/40 §2.2 重装失败保留旧定义的依据)。
 * filePath → def;文件被改坏时 loadWithFallback 从这里取旧定义。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastGoodDefs = new Map<string, any>();

/**
 * 带旧版保留的重装语义(docs/40 §2.2):此前成功装载过、这次失败 → 返回旧定义 + warning;
 * 首次装载失败 → Invalid。
 */
async function loadWithFallback<T extends object>(
    filePath: string,
    kindLabel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parse: (mod: any, filePath: string) => T | Invalid,
    warn: Warn,
): Promise<T | Invalid> {
    try {
        const mod = await importModule(filePath);
        const out = parse(mod, filePath);
        if ('def' in out && 'warnings' in out) lastGoodDefs.set(filePath, out.def);
        else if (!('reasons' in out)) lastGoodDefs.set(filePath, out);
        return out;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const prev = lastGoodDefs.get(filePath);
        if (prev !== undefined) {
            warn(`${kindLabel} 重装失败,保留旧定义 (${filePath}): ${message}`);
            return prev as T;
        }
        return { reasons: [message] };
    }
}

/* ------------------------------------------------------------------ */
/*  装载结果模型                                                       */
/* ------------------------------------------------------------------ */

export interface LoadedAgent {
    def: AgentDefinition;
    filePath: string;
    workspace: boolean;
    subagentRefs: Array<{ spec: SubagentSpec | null; name: string }>;
}

export interface LoadedFlow {
    def: FlowDefinition;
    filePath: string;
    workspace: boolean;
}

export interface LoadedLorebook {
    def: WorkspaceLorebook;
    filePath: string;
    /** 相对 kind 目录的来源名(工作区同名覆盖全局判重键) */
    sourceName: string;
    workspace: boolean;
}

export interface LoadAllResult {
    agents: LoadedAgent[];
    flows: LoadedFlow[];
    /** 通过校验的工作区级世界书 */
    lorebooks: LoadedLorebook[];
    /** 完整 warning 列表(校验不过/重装失败/覆盖/引用解析) */
    warnings: string[];
    /** 装载失败清单(校验不过的对象,reasons 非空) */
    invalid: Array<{ file: string; reasons: string[] }>;
}

/* ------------------------------------------------------------------ */
/*  全量装载 + 引用解析(docs/40 §2.3)                                  */
/* ------------------------------------------------------------------ */

/** Agent/Flow 覆盖判重键 */
function defKey(kind: ScanEntry['kind'], sourceName: string): string {
    return `${kind}:${sourceName}`;
}

export async function loadAll(root: ScanRoots, warn: Warn): Promise<LoadAllResult> {
    const result: LoadAllResult = { agents: [], flows: [], lorebooks: [], warnings: [], invalid: [] };
    const emit = (message: string) => {
        result.warnings.push(message);
        warn(message);
    };

    const entries = scanAll(root);

    // 第一遍:按 (kind, sourceName) 去重(后装载者覆盖全局;扫描顺序已保证全局在前)
    const winners = new Map<string, ScanEntry>();
    for (const e of entries) {
        const key = defKey(e.kind, e.sourceName);
        const prev = winners.get(key);
        if (prev && prev.filePath !== e.filePath) {
            emit(`${e.kind}/${e.sourceName}: 工作区覆盖全局 (${prev.filePath} → ${e.filePath})`);
        }
        winners.set(key, e);
    }

    // 第二遍:装载三类对象(prev 旧定义由模块级 lastGoodDefs 提供)
    const agentByKey = new Map<string, LoadedAgent | Invalid>();
    const flowByKey = new Map<string, LoadedFlow | Invalid>();

    for (const e of winners.values()) {
        const key = defKey(e.kind, e.sourceName);
        if (e.kind === 'agents') {
            const out = await loadWithFallback<AgentDefinition>(e.filePath, 'Agent', validateAgent, emit);
            if ('reasons' in out) {
                result.invalid.push({ file: e.filePath, reasons: out.reasons });
                agentByKey.set(key, out);
            } else {
                const loaded: LoadedAgent = {
                    def: out,
                    filePath: e.filePath,
                    workspace: e.workspace,
                    subagentRefs: normalizeSubagentRefs(out),
                };
                agentByKey.set(key, loaded);
                result.agents.push(loaded);
            }
        } else if (e.kind === 'agent-flows') {
            const out = await loadWithFallback<ValidatedFlow>(e.filePath, '工作流', validateFlow, emit);
            if ('reasons' in out) {
                result.invalid.push({ file: e.filePath, reasons: out.reasons });
                flowByKey.set(key, out);
            } else {
                for (const w of out.warnings) emit(`工作流 ${out.def.name}: ${w}`);
                const loaded: LoadedFlow = { def: out.def, filePath: e.filePath, workspace: e.workspace };
                flowByKey.set(key, loaded);
                result.flows.push(loaded);
            }
        } else {
            const out = await loadWithFallback<WorkspaceLorebook>(
                e.filePath,
                '世界书',
                (mod, fp) => {
                    const reasons: string[] = [];
                    validateWorkspaceLorebook(mod, fp, reasons);
                    return reasons.length > 0 ? { reasons } : (mod as WorkspaceLorebook);
                },
                emit,
            );
            if ('reasons' in out) {
                result.invalid.push({ file: e.filePath, reasons: out.reasons });
            } else {
                result.lorebooks.push({
                    def: out,
                    filePath: e.filePath,
                    sourceName: e.sourceName,
                    workspace: e.workspace,
                });
            }
        }
    }

    resolveReferences(result, agentByKey, flowByKey, emit);
    return result;
}

function normalizeSubagentRefs(def: AgentDefinition): LoadedAgent['subagentRefs'] {
    const refs: LoadedAgent['subagentRefs'] = [];
    for (const s of def.subagents ?? []) {
        if (typeof s === 'string') refs.push({ spec: null, name: s });
        else refs.push({ spec: s, name: s.name });
    }
    return refs;
}

/**
 * 引用解析与环检测(docs/40 §2.3 步骤 3–4):
 *   1. subagents 悬空引用 → 条目忽略 + warning(同名:Agent 优先)
 *   2. 工作流节点 agent 悬空 → 工作流无效
 *   3. 引用图(节点→Agent、Agent→subagent、subagent→工作流)DFS 查环;环上成员全部判无效
 */
function resolveReferences(
    result: LoadAllResult,
    agentByKey: Map<string, LoadedAgent | Invalid>,
    flowByKey: Map<string, LoadedFlow | Invalid>,
    emit: Warn,
): void {
    // Agent 名字表(已通过校验者)
    const agentsByName = new Map<string, LoadedAgent>();
    for (const a of result.agents) agentsByName.set(a.def.name, a);
    const flowsByName = new Map<string, LoadedFlow>();
    for (const f of result.flows) flowsByName.set(f.def.name, f);

    // --- 步骤 3a:工作流节点 agent 引用(悬空 → 工作流无效) ---
    const deadFlows = new Set<string>();
    for (const f of result.flows) {
        for (const [nodeKey, node] of Object.entries(f.def.nodes)) {
            if (node.agent === undefined) continue;
            if (!agentsByName.has(node.agent)) {
                emit(`工作流 ${f.def.name}: 节点 ${nodeKey} 引用的 Agent "${node.agent}" 不存在 → 工作流无效`);
                deadFlows.add(f.def.name);
            }
        }
    }

    // --- 步骤 3b:subagents 悬空引用(条目忽略 + warning) ---
    for (const a of result.agents) {
        a.subagentRefs = a.subagentRefs.filter((ref) => {
            if (agentsByName.has(ref.name)) return true;
            if (flowsByName.has(ref.name)) return true;
            emit(`Agent ${a.def.name}: subagent "${ref.name}" 不存在(Agent/工作流均未找到)→ 条目忽略`);
            return false;
        });
    }

    // --- 步骤 4:引用图查环 ---
    // 图节点:agent:<name> | flow:<name>;边:agent → subagent 引用;flow 的 agent 节点 → 被引 Agent
    const adj = new Map<string, string[]>();
    for (const a of result.agents) {
        adj.set(
            `agent:${a.def.name}`,
            a.subagentRefs.map((r) => (agentsByName.has(r.name) ? `agent:${r.name}` : `flow:${r.name}`)),
        );
    }
    for (const f of result.flows) {
        const targets: string[] = [];
        for (const node of Object.values(f.def.nodes)) {
            if (node.agent !== undefined && agentsByName.has(node.agent)) targets.push(`agent:${node.agent}`);
        }
        adj.set(`flow:${f.def.name}`, targets);
    }

    const color = new Map<string, 'white' | 'gray' | 'black'>();
    for (const key of adj.keys()) color.set(key, 'white');
    const stack: string[] = [];
    const cycles: string[][] = [];

    const dfs = (u: string): void => {
        color.set(u, 'gray');
        stack.push(u);
        for (const v of adj.get(u) ?? []) {
            // 引用悬空工作流(已在 3a 判死)不进图
            if (v.startsWith('flow:') && deadFlows.has(v.slice(5))) continue;
            const c = color.get(v);
            if (c === undefined || c === 'black') continue;
            if (c === 'white') dfs(v);
            else if (c === 'gray') {
                const i = stack.indexOf(v);
                if (i >= 0) cycles.push([...stack.slice(i), v]);
            }
        }
        stack.pop();
        color.set(u, 'black');
    };
    for (const key of [...adj.keys()]) {
        if (color.get(key) === 'white') dfs(key);
    }

    if (cycles.length > 0) {
        // 环上成员(引用图意义下)全部判无效;工作流自引用同样在此覆盖
        const deadNodes = new Set<string>();
        for (const cyc of cycles) {
            emit(`引用环: ${cyc.map(label).join(' → ')} → 环上成员全部无效`);
            for (const n of cyc) deadNodes.add(n);
        }
        for (const n of deadNodes) {
            if (n.startsWith('agent:')) {
                const name = n.slice(6);
                const a = agentsByName.get(name);
                if (a) {
                    result.agents = result.agents.filter((x) => x !== a);
                    result.invalid.push({ file: a.filePath, reasons: [`引用环成员: ${name}`] });
                }
            } else {
                const name = n.slice(5);
                const f = flowsByName.get(name);
                if (f && !deadFlows.has(name)) {
                    deadFlows.add(name);
                    result.flows = result.flows.filter((x) => x !== f);
                    result.invalid.push({ file: f.filePath, reasons: [`引用环成员: ${name}`] });
                }
            }
        }
    }

    // 步骤 3a 判死的工作流:移出 flows,写入 invalid
    for (const name of deadFlows) {
        const f = flowsByName.get(name);
        if (!f || !result.flows.includes(f)) continue; // 已在环处理中移除
        result.flows = result.flows.filter((x) => x !== f);
        result.invalid.push({ file: f.filePath, reasons: [`节点 Agent 引用悬空: ${name}`] });
    }
}

function label(node: string): string {
    return node.replace(/^(agent|flow):/, '$1 ');
}

/** 便捷:默认根(全局 + 工作区) */
export function defaultRoots(cwd: string, homeDir: string = homedir()): ScanRoots {
    return { homeDir, cwd, agentDirName: 'chlamydomonos-agents' };
}
