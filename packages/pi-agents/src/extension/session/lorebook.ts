/**
 * 世界书注入核心(docs/10 §5,D8/D9/D10/D20)。
 *
 * 职责:
 *   - 三级来源评估:Agent 级 > 工作流级 > 工作区级(§5.2);每级独立评估,
 *     单级抛错 → 该级本轮跳过 + warning,不影响其他级;
 *   - id 去重:entry 稳定 id(缺省 = content sha1 前 12 位)跨级重复 → 高层级胜出;
 *   - system 条目槽位组装(§5.1):基座列表 + 条目按 slot/order 插入,"\n\n" 连接;
 *   - depth 条目按深度插入消息列表(§5.3):先深后浅一次完成,转 user/assistant 文本消息。
 *
 * 注入通道在 lorebook-hook.ts(context_with_system 事件,每请求重算)。
 */

import { createHash } from 'node:crypto';
import type { LorebookContext, LorebookEntry, LorebookSpec } from '../types.js';

/** 注入深度层级:层级越小优先级越高(0 = Agent 级) */
export type LorebookLevel = 0 | 1 | 2;

/** 三级来源描述(调用方组装;def 为 null = 该级无世界书) */
export interface LorebookSource {
    spec: LorebookSpec | null;
    level: LorebookLevel;
    /** warning/调试用来源名 */
    name: string;
}

/** 去重后的选中条目(带来源信息) */
export interface ResolvedEntry {
    entry: LorebookEntry;
    id: string;
    level: LorebookLevel;
    sourceName: string;
    /** 被高层级遮蔽(仅诊断;/agent-usage -v 用,M7) */
    shadowed?: never;
}

export interface LorebookResolution {
    depth: ResolvedEntry[];
    system: ResolvedEntry[];
    /** 评估期间被跳过的级(抛错;warning 已在上层记录) */
    skipped: string[];
}

/** entry 稳定 id(§5.3:缺省 = content sha1 前 12 位) */
export function entryId(e: LorebookEntry): string {
    return e.id ?? createHash('sha1').update(e.content, 'utf8').digest('hex').slice(0, 12);
}

/** 单个来源评估:entries 静态/函数 + trigger,并集去重;抛错上抛(调用方按级捕获) */
async function evaluateSpec(spec: LorebookSpec, ctx: LorebookContext): Promise<LorebookEntry[]> {
    const out: LorebookEntry[] = [];
    const seen = new Set<string>();
    const push = (e: LorebookEntry) => {
        const id = entryId(e);
        if (seen.has(id)) return;
        seen.add(id);
        out.push(e);
    };
    const statics = typeof spec.entries === 'function' ? await spec.entries(ctx) : (spec.entries ?? []);
    for (const e of statics) push(e);
    if (spec.trigger) {
        const triggered = await spec.trigger(ctx);
        for (const e of triggered) push(e);
    }
    return out;
}

/**
 * 三级评估 + id 去重(§5.2)。
 * 某级抛错 → 记入 skipped(该级本轮跳过);order 在插入时排,这里不排。
 */
export async function resolveLorebook(sources: LorebookSource[], ctx: LorebookContext): Promise<LorebookResolution> {
    const depth = new Map<string, ResolvedEntry>();
    const system = new Map<string, ResolvedEntry>();
    const skipped: string[] = [];

    // level 升序 = 优先级降序(Agent 0 先注册,高层级胜出 = 先到先得)
    for (const source of [...sources].sort((a, b) => a.level - b.level)) {
        if (!source.spec) continue;
        let entries: LorebookEntry[];
        try {
            entries = await evaluateSpec(source.spec, ctx);
        } catch {
            skipped.push(source.name);
            continue;
        }
        for (const e of entries) {
            const id = entryId(e);
            const target = e.target === 'system' ? system : depth;
            if (target.has(id)) continue; // 高层级胜出(§5.2)
            target.set(id, { entry: e, id, level: source.level, sourceName: source.name });
        }
    }
    return { depth: [...depth.values()], system: [...system.values()], skipped };
}

/* ------------------------------------------------------------------ */
/*  system 条目槽位组装(§5.1)                                          */
/* ------------------------------------------------------------------ */

interface SystemSeg {
    /** 基座项 = 其基座下标;条目 = slot(缺省 = 基座长度,追加末尾) */
    slot: number;
    /** 排序键:基座项 0(同槽位基座在前);条目 = order ?? 0 */
    order: number;
    /** 同键稳定性:基座项按原位;条目按解析顺序(跨级优先序) */
    seq: number;
    text: string;
}

/**
 * 系统提示词组装(§5.1):基座列表 + system 条目按 slot 插入,"\n\n" 连接。
 * - slot 超过基座长度 = 追加末尾(不报错);
 * - 同槽位:条目按 order 升序,order 相同按跨级优先序(Agent > 工作流 > 工作区,即解析顺序);
 * - 基座项固定在第 i 槽末尾(基座 [A,B] + slot:0 条目 X → A、X、B)。
 */
export function composeSystemPrompt(base: string[], systemEntries: ResolvedEntry[]): string {
    const segs: SystemSeg[] = [];
    base.forEach((text, i) => segs.push({ slot: i, order: 0, seq: i, text }));
    systemEntries.forEach((r, i) => {
        const slot = r.entry.slot;
        segs.push({
            slot: typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 ? slot : base.length,
            order: r.entry.order ?? 0,
            seq: base.length + i,
            text: r.entry.content,
        });
    });
    segs.sort((a, b) => a.slot - b.slot || a.order - b.order || a.seq - b.seq);
    return segs
        .map((s) => s.text)
        .filter((t) => t.length > 0)
        .join('\n\n');
}

/* ------------------------------------------------------------------ */
/*  depth 条目插入(§5.3)                                               */
/* ------------------------------------------------------------------ */

/** depth 消息形态:role 缺省 user;content 为单文本块;order 为同深度排序键 */
export interface DepthMessage {
    role: 'user' | 'assistant';
    content: string;
    order: number;
}

/** depth 条目 → 注入消息(按 order 稳定排序) */
export function depthMessages(entries: ResolvedEntry[]): DepthMessage[] {
    return [...entries]
        .sort((a, b) => (a.entry.depth ?? 0) - (b.entry.depth ?? 0) || (a.entry.order ?? 0) - (b.entry.order ?? 0))
        .map((r) => ({
            role: r.entry.role ?? 'user',
            content: r.entry.content,
            order: r.entry.order ?? 0,
        }));
}

/**
 * 把注入消息按深度插入消息列表(§5.3):以**注入前**列表从末尾计数,
 * depth 0 = 最新一条之前;越界 = 插到最前;同深度多条保持 order 顺序。
 * 返回新列表(不改入参)。
 */
export function insertDepthMessages<T>(
    messages: readonly T[],
    injections: Array<{ index: number; message: DepthMessage }>,
): T[] {
    // 先深(大 index)后浅插入;同 index 按 order 降序插(splice 总是插在
    // 同位置已有项之前,后插 = 最终靠前 → 最终顺序 = order 升序,§5.3)
    const sorted = [...injections].sort((a, b) => b.index - a.index || b.message.order - a.message.order);
    const out = [...messages];
    for (const inj of sorted) {
        const at = Math.max(0, Math.min(inj.index, out.length));
        out.splice(at, 0, inj.message as unknown as T);
    }
    return out;
}

/** depth 条目 → 插入计划(index 相对注入前列表;深度 d → 末尾倒数,0 = 最新一条之前) */
export function planDepthInsertions(
    entries: ResolvedEntry[],
    messageCount: number,
): Array<{ index: number; message: DepthMessage }> {
    // 先按 depth/order 稳定排序,与消息一一对应取 depth
    const sorted = [...entries].sort(
        (a, b) => (a.entry.depth ?? 0) - (b.entry.depth ?? 0) || (a.entry.order ?? 0) - (b.entry.order ?? 0),
    );
    return sorted.map((r) => ({
        index: messageCount - 1 - (r.entry.depth ?? 0),
        message: { role: r.entry.role ?? 'user', content: r.entry.content, order: r.entry.order ?? 0 },
    }));
}
