/**
 * usage 记账与展示(docs/40 §6/§7,D15)。
 *
 * - 记账键:(hostSessionId, agentPath);agentPath = flow:<flow>#<label>
 *   [> sub:<agentName> | subflow:<flowName>#<label>]*(10 §6.1,链任意交错);
 * - 进程内:UsageLedger 按路径累计(每唤醒一个 per-工作流 ledger 亦可);
 * - 持久化:每次唤醒结束 `pi.appendEntry("pi-agents:usage", {wake, byPath})`
 *   (非模型上下文;resume 后 /agent-usage 沿分支 getBranch 聚合恢复);
 * - 展示:/agent-usage 汇总表(输入/输出/缓存读/调用次数/耗时;千位 k 缩写)。
 */

/** 单路径用量(输入/输出/缓存读/缓存写 token + 请求次数 + 工具次数 + 累计耗时 ms) */
export interface PathUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests: number;
    toolCalls: number;
    durationMs: number;
}

export const EMPTY_PATH_USAGE: PathUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    requests: 0,
    toolCalls: 0,
    durationMs: 0,
};

/** 记账增量(message_end 单条 assistant 消息 / 节点完成汇总) */
export interface UsageTick {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    requests?: number;
    toolCalls?: number;
    durationMs?: number;
}

/* ------------------------------------------------------------------ */
/*  agentPath 组装(§6 键格式)                                          */
/* ------------------------------------------------------------------ */

/** 工作流节点路径前缀:flow:<flowName>#<nodeLabel> */
export function nodePathPrefix(flowName: string, nodeLabel: string): string {
    return `flow:${flowName}#${nodeLabel}`;
}

/** 在已有路径后追加一段(Agent 引用/subflow 引用通用) */
export function appendPathSegment(prefix: string, segment: string): string {
    return `${prefix} > ${segment}`;
}

/** Agent 引用段:sub:<agentName> */
export function subAgentSegment(agentName: string): string {
    return `sub:${agentName}`;
}

/** 工作流引用段:subflow:<flowName>#<terminal>(终点节点文本即返回值,§6.2) */
export function subflowSegment(flowName: string, terminal: string): string {
    return `subflow:${flowName}#${terminal}`;
}

/* ------------------------------------------------------------------ */
/*  UsageLedger(进程内累计器)                                          */
/* ------------------------------------------------------------------ */

/** 累计器:按 agentPath 累加 UsageTick;可并表(嵌套链:子层 flush 进父层) */
export class UsageLedger {
    private byPath = new Map<string, PathUsage>();

    record(path: string, tick: UsageTick): void {
        const cur = this.byPath.get(path) ?? { ...EMPTY_PATH_USAGE };
        cur.input += tick.input ?? 0;
        cur.output += tick.output ?? 0;
        cur.cacheRead += tick.cacheRead ?? 0;
        cur.cacheWrite += tick.cacheWrite ?? 0;
        cur.requests += tick.requests ?? 0;
        cur.toolCalls += tick.toolCalls ?? 0;
        cur.durationMs += tick.durationMs ?? 0;
        this.byPath.set(path, cur);
    }

    /** 把另一 ledger 的全部路径并进来(嵌套 subflow 归并) */
    merge(other: UsageLedger): void {
        for (const [path, usage] of other.byPath) {
            this.record(path, usage);
        }
    }

    snapshot(): Map<string, PathUsage> {
        return new Map(this.byPath);
    }

    /** 全路径合计(汇总表「合计」行) */
    total(): PathUsage {
        const t = { ...EMPTY_PATH_USAGE };
        for (const u of this.byPath.values()) {
            t.input += u.input;
            t.output += u.output;
            t.cacheRead += u.cacheRead;
            t.cacheWrite += u.cacheWrite;
            t.requests += u.requests;
            t.toolCalls += u.toolCalls;
            t.durationMs += u.durationMs;
        }
        return t;
    }

    get size(): number {
        return this.byPath.size;
    }
}

/* ------------------------------------------------------------------ */
/*  持久化 entry 形态(docs/40 §6)                                       */
/* ------------------------------------------------------------------ */

/** pi-agents:usage entry 的 data 形态(appendEntry 载荷 / getBranch 聚合输入) */
export interface UsageEntryData {
    /** 唤醒标识(宿主 session 内自增) */
    wake: number;
    /** 该次唤醒各路径用量(键 = agentPath) */
    byPath: Record<string, PathUsage>;
}

/** USAGE_ENTRY_TYPE(pi.appendEntry 的 customType;非模型上下文) */
export const USAGE_ENTRY_TYPE = 'pi-agents:usage';

/** 从 session 分支的 custom entry 汇总(resume/fork 后 /agent-usage 数据源) */
export function aggregateUsageEntries(entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>): {
    byPath: Map<string, PathUsage>;
    wakeCount: number;
} {
    const byPath = new Map<string, PathUsage>();
    let wakeCount = 0;
    for (const e of entries) {
        if (e.type !== 'custom' || e.customType !== USAGE_ENTRY_TYPE) continue;
        wakeCount++;
        const data = e.data as UsageEntryData | undefined;
        if (!data || typeof data !== 'object') continue;
        for (const [path, usage] of Object.entries(data.byPath ?? {})) {
            const u = usage as Partial<PathUsage> | undefined;
            if (!u || typeof u !== 'object') continue;
            const cur = byPath.get(path) ?? { ...EMPTY_PATH_USAGE };
            cur.input += u.input ?? 0;
            cur.output += u.output ?? 0;
            cur.cacheRead += u.cacheRead ?? 0;
            cur.cacheWrite += u.cacheWrite ?? 0;
            cur.requests += u.requests ?? 0;
            cur.toolCalls += u.toolCalls ?? 0;
            cur.durationMs += u.durationMs ?? 0;
            byPath.set(path, cur);
        }
    }
    return { byPath, wakeCount };
}

/* ------------------------------------------------------------------ */
/*  展示(§7 输出表)                                                    */
/* ------------------------------------------------------------------ */

/** token 数 → 1 位小数 k 缩写(182.3k; <1000 原样) */
export function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    const k = n / 1000;
    return `${Math.round(k * 10) / 10}k`;
}

/** ms → 可读时长(22s / 2m03s / 1h02m) */
export function formatDuration(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

/** 列宽:中文字符按 2 列计 */
function displayWidth(s: string): number {
    let w = 0;
    for (const ch of s) w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
    return w;
}

function pad(s: string, width: number): string {
    return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * /agent-usage 汇总表(§7 样式):
 * 表头 + 路径行 + 合计行;路径行保持传入顺序(嵌套链自然缩进)。
 */
export function formatUsageTable(opts: { title: string; byPath: ReadonlyMap<string, PathUsage> }): string {
    const rows: Array<{ path: string; usage: PathUsage }> = [...opts.byPath].map(([path, usage]) => ({ path, usage }));
    const total = rows.reduce(
        (acc, r) => ({
            input: acc.input + r.usage.input,
            output: acc.output + r.usage.output,
            cacheRead: acc.cacheRead + r.usage.cacheRead,
            requests: acc.requests + r.usage.requests,
            durationMs: acc.durationMs + r.usage.durationMs,
        }),
        { input: 0, output: 0, cacheRead: 0, requests: 0, durationMs: 0 },
    );

    const pathWidth =
        Math.max(displayWidth('路径'), ...rows.map((r) => displayWidth(r.path)), displayWidth('合计')) + 2;
    const numWidth = 8;
    const lines: string[] = [];
    lines.push(opts.title);
    lines.push(
        [
            pad('路径', pathWidth),
            pad('输入', numWidth),
            pad('输出', numWidth),
            pad('缓存读', numWidth),
            pad('调用', numWidth),
            '耗时',
        ].join(''),
    );
    for (const r of rows) {
        lines.push(
            [
                pad(r.path, pathWidth),
                pad(formatTokens(r.usage.input), numWidth),
                pad(formatTokens(r.usage.output), numWidth),
                pad(formatTokens(r.usage.cacheRead), numWidth),
                pad(String(r.usage.requests), numWidth),
                formatDuration(r.usage.durationMs),
            ].join(''),
        );
    }
    if (rows.length > 0) {
        lines.push(
            [
                pad('合计', pathWidth),
                pad(formatTokens(total.input), numWidth),
                pad(formatTokens(total.output), numWidth),
                pad(formatTokens(total.cacheRead), numWidth),
                pad(String(total.requests), numWidth),
                formatDuration(total.durationMs),
            ].join(''),
        );
    }
    return lines.join('\n');
}

/** /agent-usage -v 细节行:缓存写/工具次数(追加在表尾) */
export function formatUsageDetails(byPath: ReadonlyMap<string, PathUsage>): string {
    const lines: string[] = ['—— 细节(-v)——'];
    for (const [path, u] of byPath) {
        lines.push(`${path}: 工具 x${u.toolCalls}, 缓存写 ${formatTokens(u.cacheWrite)}, 请求 ${u.requests}`);
    }
    return lines.join('\n');
}
