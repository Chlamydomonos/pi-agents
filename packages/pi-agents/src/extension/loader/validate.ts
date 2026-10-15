/**
 * 校验器(docs/10 §2.2、docs/20 §2.3)。纯函数:输入未知对象,输出规范化结果或错误列表。
 * M1 范围:结构校验 + Agent/Flow 静态规则;引用解析与环检测在 load.ts 全量装载后做。
 */
import {
    NAME_PATTERN,
    type AgentDefinition,
    type FlowDefinition,
    type LorebookEntry,
    type LorebookSpec,
    type WorkspaceLorebook,
} from '../types.js';

export type Warn = (message: string) => void;

export interface Invalid {
    reasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '';
}

function validName(value: unknown): value is string {
    return typeof value === 'string' && NAME_PATTERN.test(value);
}

/* ------------------------------------------------------------------ */
/*  世界书(docs/10 §5)                                                 */
/* ------------------------------------------------------------------ */

export function validateLorebookSpec(value: unknown, where: string, reasons: string[]): void {
    if (value === undefined) return;
    if (!isRecord(value)) {
        reasons.push(`${where}.lorebook 必须是对象`);
        return;
    }
    const lb = value as LorebookSpec & Record<string, unknown>;
    if (lb.persistent !== undefined && typeof lb.persistent !== 'boolean') {
        reasons.push(`${where}.lorebook.persistent 必须是布尔`);
    }
    if (lb.entries !== undefined) {
        if (typeof lb.entries !== 'function' && !Array.isArray(lb.entries)) {
            reasons.push(`${where}.lorebook.entries 必须是数组或函数`);
        } else if (Array.isArray(lb.entries)) {
            lb.entries.forEach((e, i) => validateEntry(e, `${where}.lorebook.entries[${i}]`, reasons));
        }
    }
    if (lb.trigger !== undefined && typeof lb.trigger !== 'function') {
        reasons.push(`${where}.lorebook.trigger 必须是函数`);
    }
}

export function validateWorkspaceLorebook(value: unknown, where: string, reasons: string[]): void {
    if (!isRecord(value)) {
        reasons.push(`${where}: 缺少 default 导出对象`);
        return;
    }
    const lb = value as WorkspaceLorebook & Record<string, unknown>;
    if (lb.entries !== undefined) {
        if (typeof lb.entries !== 'function' && !Array.isArray(lb.entries)) {
            reasons.push(`${where}: entries 必须是数组或函数`);
        } else if (Array.isArray(lb.entries)) {
            lb.entries.forEach((e, i) => validateEntry(e, `${where}.entries[${i}]`, reasons));
        }
    }
    if (lb.trigger !== undefined && typeof lb.trigger !== 'function') {
        reasons.push(`${where}: trigger 必须是函数`);
    }
}

/** 条目级校验(target/slot/depth 合法性,docs/10 §2.2) */
export function validateEntry(value: unknown, where: string, reasons: string[]): void {
    if (!isRecord(value)) {
        reasons.push(`${where} 必须是对象`);
        return;
    }
    const e = value as Partial<LorebookEntry> & Record<string, unknown>;
    if (!nonEmptyString(e.content)) reasons.push(`${where}.content 必须是非空字符串`);
    if (e.target !== undefined && e.target !== 'depth' && e.target !== 'system') {
        reasons.push(`${where}.target 无效(${String(e.target)}),只能是 "depth" | "system"`);
    }
    const target = e.target ?? 'depth';
    if (target === 'depth') {
        if (typeof e.depth !== 'number' || !Number.isInteger(e.depth) || e.depth < 0) {
            reasons.push(`${where}.depth 必须是非负整数`);
        }
        if (e.role !== undefined && e.role !== 'user' && e.role !== 'assistant') {
            reasons.push(`${where}.role 无效(${String(e.role)})`);
        }
    }
    if (e.slot !== undefined && (typeof e.slot !== 'number' || !Number.isInteger(e.slot) || e.slot < 0)) {
        reasons.push(`${where}.slot 必须是非负整数`);
    }
    if (e.order !== undefined && (typeof e.order !== 'number' || !Number.isInteger(e.order))) {
        reasons.push(`${where}.order 必须是整数`);
    }
    if (e.id !== undefined && !nonEmptyString(e.id)) reasons.push(`${where}.id 必须是非空字符串`);
}

/* ------------------------------------------------------------------ */
/*  Agent(docs/10 §2.2)                                                */
/* ------------------------------------------------------------------ */

/** 结构校验。返回规范化 AgentDefinition 或错误列表(不查引用)。 */
export function validateAgent(mod: unknown, filePath: string): AgentDefinition | Invalid {
    const reasons: string[] = [];
    if (!isRecord(mod) || !isRecord((mod as { default?: unknown }).default)) {
        return { reasons: ['缺少 default 导出对象'] };
    }
    const g = (mod as { default: Record<string, unknown> }).default;

    if (!validName(g.name)) reasons.push(`name "${String(g.name)}" 不合法(须匹配 [a-z][a-z0-9-]{0,63})`);
    if (!nonEmptyString(g.title)) reasons.push('title 必须是非空字符串');
    if (!nonEmptyString(g.description)) reasons.push('description 必须是非空字符串');

    // systemPrompt:非空字符串或非空字符串数组(数组每项均非空)
    if (nonEmptyString(g.systemPrompt)) {
        // ok
    } else if (Array.isArray(g.systemPrompt)) {
        if (g.systemPrompt.length === 0) reasons.push('systemPrompt 数组不能为空');
        else if (!g.systemPrompt.every((s) => nonEmptyString(s))) reasons.push('systemPrompt 数组每项必须是非空字符串');
    } else {
        reasons.push('systemPrompt 必须是非空字符串或非空字符串数组');
    }

    if (g.model !== undefined && !nonEmptyString(g.model)) reasons.push('model 必须是非空字符串("provider/id")');
    if (
        g.thinkingLevel !== undefined &&
        !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(g.thinkingLevel as string)
    ) {
        reasons.push(`thinkingLevel 无效(${String(g.thinkingLevel)})`);
    }

    if (g.tools !== undefined) {
        if (!Array.isArray(g.tools) || !g.tools.every((t) => typeof t === 'string')) {
            reasons.push('tools 必须是字符串数组');
        }
    }

    if (g.subagents !== undefined) {
        if (!Array.isArray(g.subagents)) {
            reasons.push('subagents 必须是数组');
        } else {
            g.subagents.forEach((s, i) => {
                if (typeof s === 'string') {
                    if (!validName(s)) reasons.push(`subagents[${i}] 名字 "${s}" 不合法`);
                } else if (isRecord(s)) {
                    if (!validName(s.name)) reasons.push(`subagents[${i}].name 不合法`);
                    if (s.appendSystemPrompt !== undefined && !nonEmptyString(s.appendSystemPrompt)) {
                        reasons.push(`subagents[${i}].appendSystemPrompt 必须是非空字符串`);
                    }
                    if (s.session !== undefined && s.session !== 'stateless' && s.session !== 'inherit') {
                        reasons.push(`subagents[${i}].session 无效(${String(s.session)})`);
                    }
                } else {
                    reasons.push(`subagents[${i}] 必须是字符串或对象`);
                }
            });
        }
    }

    validateLorebookSpec(g.lorebook, filePath, reasons);

    if (reasons.length > 0) return { reasons };
    return g as unknown as AgentDefinition;
}

/* ------------------------------------------------------------------ */
/*  Flow(docs/20 §2.3)                                                 */
/* ------------------------------------------------------------------ */

const NODE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/; // 节点名:允许大写驼峰(docs/20 §2.3)

export interface ValidatedFlow {
    def: FlowDefinition;
    /** 装载告警(不判死):如函数节点写了 Agent 专属字段被忽略 */
    warnings: string[];
}

/** 结构校验。返回规范化结果或错误列表(不查 Agent 引用、不做环检测)。 */
export function validateFlow(mod: unknown, filePath: string): ValidatedFlow | Invalid {
    const reasons: string[] = [];
    const warnings: string[] = [];
    if (!isRecord(mod) || !isRecord((mod as { default?: unknown }).default)) {
        return { reasons: ['缺少 default 导出对象'] };
    }
    const f = (mod as { default: Record<string, unknown> }).default;

    if (!validName(f.name)) reasons.push(`name "${String(f.name)}" 不合法(须匹配 [a-z][a-z0-9-]{0,63})`);
    if (!nonEmptyString(f.title)) reasons.push('title 必须是非空字符串');
    if (!nonEmptyString(f.description)) reasons.push('description 必须是非空字符串');

    if (!isRecord(f.nodes)) {
        reasons.push('nodes 必须是对象');
    } else {
        const nodeKeys = Object.keys(f.nodes);
        if (nodeKeys.length === 0) {
            reasons.push('nodes 不能为空');
        } else {
            for (const key of nodeKeys) {
                if (!NODE_KEY_PATTERN.test(key)) {
                    reasons.push(`节点名 "${key}" 不合法(须匹配 [A-Za-z][A-Za-z0-9_-]{0,63})`);
                    continue;
                }
                validateNode(key, (f.nodes as Record<string, unknown>)[key], reasons, warnings);
            }
        }
    }

    if (!nonEmptyString(f.entry)) {
        reasons.push('entry 必须是非空字符串');
    } else if (isRecord(f.nodes) && !(f.entry in f.nodes)) {
        reasons.push(`entry "${f.entry}" 不在 nodes 中`);
    }

    if (!isRecord(f.edges)) {
        reasons.push('edges 必须是对象');
    } else if (isRecord(f.nodes)) {
        const nodes = f.nodes as Record<string, unknown>;
        for (const [key, edge] of Object.entries(f.edges)) {
            if (!(key in nodes)) {
                reasons.push(`edges.${key}: 节点不存在`);
                continue;
            }
            validateEdge(key, edge, nodes, reasons);
        }
    }

    if (f.initialInput !== undefined && typeof f.initialInput !== 'function') {
        reasons.push('initialInput 必须是函数');
    }
    if (f.pass !== undefined) {
        validatePassSpec(f.pass, 'pass', reasons, true);
    }

    validateLorebookSpec(f.lorebook, filePath, reasons);

    if (reasons.length > 0) return { reasons };
    return { def: f as unknown as FlowDefinition, warnings };
}

function validateNode(key: string, value: unknown, reasons: string[], warnings: string[]): void {
    if (!isRecord(value)) {
        reasons.push(`nodes.${key} 必须是对象`);
        return;
    }
    const n = value as Record<string, unknown>;
    const hasAgent = n.agent !== undefined;
    const hasRun = n.run !== undefined;
    if (hasAgent === hasRun) {
        reasons.push(`nodes.${key}: agent 与 run 必须恰好一个`);
        return;
    }
    if (hasAgent) {
        if (typeof n.agent !== 'string' || !NAME_PATTERN.test(n.agent as string)) {
            reasons.push(`nodes.${key}.agent 不合法`);
        }
        if (n.sessionMode !== undefined && n.sessionMode !== 'fresh' && n.sessionMode !== 'inherit') {
            reasons.push(`nodes.${key}.sessionMode 无效(${String(n.sessionMode)})`);
        }
        if (n.model !== undefined && !nonEmptyString(n.model)) reasons.push(`nodes.${key}.model 必须是非空字符串`);
        if (
            n.thinkingLevel !== undefined &&
            !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(n.thinkingLevel as string)
        ) {
            reasons.push(`nodes.${key}.thinkingLevel 无效(${String(n.thinkingLevel)})`);
        }
        if (n.appendSystemPrompt !== undefined && !nonEmptyString(n.appendSystemPrompt)) {
            reasons.push(`nodes.${key}.appendSystemPrompt 必须是非空字符串`);
        }
    }
    if (hasRun && typeof n.run !== 'function') {
        reasons.push(`nodes.${key}.run 必须是函数`);
    }
    if (n.label !== undefined && !nonEmptyString(n.label)) reasons.push(`nodes.${key}.label 必须是非空字符串`);

    // 函数节点忽略 Agent 节点专属字段(docs/20 §2.2):告警不判死
    if (hasRun) {
        const ignored = (['sessionMode', 'model', 'thinkingLevel', 'appendSystemPrompt'] as const).filter(
            (k) => n[k] !== undefined,
        );
        if (ignored.length > 0) {
            warnings.push(`nodes.${key}: 函数节点忽略 ${ignored.join('/')}`);
        }
    }
}

function validateEdge(key: string, edge: unknown, nodes: Record<string, unknown>, reasons: string[]): void {
    if (typeof edge === 'string') {
        if (edge !== 'done' && !(edge in nodes)) reasons.push(`edges.${key}: 目标 "${edge}" 不在 nodes 中`);
        return;
    }
    if (!isRecord(edge)) {
        reasons.push(`edges.${key} 必须是字符串或对象`);
        return;
    }
    if (typeof edge.route !== 'function') {
        reasons.push(`edges.${key}.route 必须是函数`);
    }
    if (
        edge.maxIterations !== undefined &&
        (typeof edge.maxIterations !== 'number' || !Number.isInteger(edge.maxIterations) || edge.maxIterations < 1)
    ) {
        reasons.push(`edges.${key}.maxIterations 必须是正整数`);
    }
    // targets:纯展示候选(D24)——数组 + 成员必须是节点键
    if (edge.targets !== undefined) {
        if (!Array.isArray(edge.targets) || edge.targets.some((t) => typeof t !== 'string')) {
            reasons.push(`edges.${key}.targets 必须是节点键字符串数组`);
        } else {
            for (const t of edge.targets) {
                if (t === 'done') continue; // 允许显式声明 done 候选(渲染端点)
                if (!(t in nodes)) reasons.push(`edges.${key}.targets: "${t}" 不在 nodes 中`);
            }
        }
    }
    if (edge.pass !== undefined) {
        validatePassSpec(edge.pass, `edges.${key}.pass`, reasons, false);
    }
}

function validatePassSpec(pass: unknown, where: string, reasons: string[], allowResolver: boolean): void {
    if (typeof pass === 'function') {
        if (!allowResolver) reasons.push(`${where}: pass 解析器只能写在顶层`);
        return;
    }
    if (!isRecord(pass)) {
        reasons.push(`${where} 必须是对象或函数`);
        return;
    }
    const mode = (pass as { mode?: unknown }).mode;
    if (mode === 'text' || mode === 'none') {
        if (mode === 'text' && (pass as { images?: unknown }).images !== undefined) {
            if ((pass as { images?: unknown }).images !== 'forward') {
                reasons.push(`${where}.images 只支持 'forward'`);
            }
        }
        return;
    }
    if (mode === 'template') {
        if (!nonEmptyString((pass as { template?: unknown }).template))
            reasons.push(`${where}.template 必须是非空字符串`);
        return;
    }
    if (mode === 'custom') {
        if (typeof (pass as { transform?: unknown }).transform !== 'function')
            reasons.push(`${where}.transform 必须是函数`);
        return;
    }
    reasons.push(`${where}.mode 无效(${String(mode)})`);
}
