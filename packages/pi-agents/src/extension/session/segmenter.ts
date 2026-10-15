/**
 * 虚拟消息分段器(M10,docs/30 §6):NodeEvent 流 → 虚拟 assistant 消息段。
 *
 * 契约:宿主(pi)每收到一条含 toolCall 的 assistant 消息 → 执行工具 → 再调一次
 * streamSimple(续跑)。本分段器把工作流的子会话事件切成与 pi 原生形态一致的
 * 消息段:
 *   - 一段 = 一次「LLM 可见回合」:thinking 块(可选) + text 块(可选) +
 *     toolCall 块(可选,占位 agents_tool);
 *   - 占位 toolCall 是唯一的「续跑请求」;其余情况该段以 text 收尾;
 *   - 终点文本 = 最终 text(无 toolCall),天然成为工作流回答——无终点预估。
 *
 * 事件语义(与 run-node/spawn 的透传包对齐):
 *   node-start        → 换来源:前缀行进 thinking;fn 节点不产生段内容(状态行走 status)
 *   thinking-delta    → 当前段 thinking
 *   text-delta        → 当前段 text(中间与终点同路径;终点判别交给 outcome 层)
 *   tool-call         → 关闭当前段 → 新段仅含该 toolCall → 段边界(宿主将续跑)
 *   tool-result       → 关闭 toolCall 段(结果由宿主占位返回,续跑段承载摘要行)
 *   node-text         → 语义冗余(流式已承载),忽略
 *
 * 状态行(onThinking 的引擎行)不在段内:它们是跨段全局信息,由 stream 层
 * append 到「下一续跑段」的 thinking 开头(见 flushStatusLines)。
 */

import type { JsonObject } from '@earendil-works/pi-ai';
import type { NodeEvent, PlaceholderToolCall } from './stream-events.js';
import { PLACEHOLDER_TOOL_NAME } from './stream-events.js';

/** 单个内容块(流式期间的形式) */
export type SegmentBlock =
    | { type: 'thinking'; thinking: string }
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: JsonObject };

/** 一个虚拟消息段:流式期间推送的部分积攒,边界处由 stream 层收口 */
export interface FlowSegment {
    /** 段 id(单调递增;调试/追踪用) */
    id: number;
    blocks: SegmentBlock[];
    /** true = 本段以占位 toolCall 收尾(宿主将执行并续跑) */
    endsWithToolCall: boolean;
    /** 本段涉及text 内容的节点键集合(§3.1 收口纠偏:与终点节点比对) */
    textNodeKeys: Set<string>;
}

/** 分段器输出(段边界通知) */
export type SegmentEvent =
    /** 上一段已完结(可能为空段:如 tool-result 摘要行的专属段) */
    | { type: 'segment-end'; segment: FlowSegment }
    /** 块级增量(流式;contentIndex 为段内序号) */
    | { type: 'thinking-delta'; segmentId: number; contentIndex: number; delta: string }
    | { type: 'text-delta'; segmentId: number; contentIndex: number; delta: string };

export class FlowSegmenter {
    private current: FlowSegment | null = null;
    private seq = 0;
    private toolSeq = 0;
    /** 待刷状态行(引擎行;下一段 thinking 开头插入) */
    private statusLines: string[] = [];
    /** 前缀行待发标记(进入新来源时插一次;§3.2) */
    private prefixPending = false;
    private curPrefix = '';

    /**
     * @param toolCallIdOf 占位 toolCall id 工厂(stream 层注入全局唯一 id;
     *                     缺省为实例内自增——单 run 使用安全,多 run 会撞)
     */
    constructor(private toolCallIdOf: () => string = () => `agents-${this.toolSeq++}`) {}

    /** 引擎状态行(跨段;由 stream 层从 onThinking 转入) */
    pushStatusLine(line: string): void {
        if (line) this.statusLines.push(line.endsWith('\n') ? line : line + '\n');
    }

    /** 来源前缀(§3.2;node-start 时设置,首个内容 delta 时落盘) */
    setPrefix(label: string, visit: number, enabled: boolean): void {
        this.curPrefix = enabled ? `【${label} #${visit}】` : '';
        this.prefixPending = enabled;
    }

    /**
     * 喂入一个 NodeEvent;返回需要立即广播的段事件。
     * tool-call 事件返回 [segment-end(prev), thinking-delta(新段状态行/前缀)] 之外的
     * toolcall 边界由 endsWithToolCall 标注——stream 层收口推送。
     */
    feed(ev: NodeEvent, opts: { prefixes: boolean }): SegmentEvent[] {
        void opts;
        switch (ev.kind) {
            case 'node-start': {
                if (!ev.isAgent) break;
                this.closeCurrent();
                this.setPrefix(ev.label, ev.visit, opts.prefixes);
                break;
            }
            case 'thinking-delta': {
                this.ensureOpen();
                this.flushStatusLines();
                this.flushPendingPrefix();
                const idx = this.thinkingIndex();
                this.currentBlock('thinking').thinking += ev.delta;
                this.out.push({
                    type: 'thinking-delta',
                    segmentId: this.current!.id,
                    contentIndex: idx,
                    delta: ev.delta,
                });
                break;
            }
            case 'text-delta': {
                this.ensureOpen();
                this.flushStatusLines();
                this.flushPendingPrefix();
                // §3.1 可见性分流:visible=false → 全部进 thinking(不流式 text);
                // visible=true → 先进 text(若收口判定非终点,由 stream 层纠偏)
                if (ev.outputVisible === false) {
                    const idx = this.thinkingIndex();
                    this.currentBlock('thinking').thinking += ev.delta;
                    this.out.push({
                        type: 'thinking-delta',
                        segmentId: this.current!.id,
                        contentIndex: idx,
                        delta: ev.delta,
                    });
                    break;
                }
                if (ev.nodeKey) this.current!.textNodeKeys.add(ev.nodeKey);
                const idx = this.textIndex();
                this.currentBlock('text').text += ev.delta;
                this.out.push({ type: 'text-delta', segmentId: this.current!.id, contentIndex: idx, delta: ev.delta });
                break;
            }
            case 'tool-call': {
                // 关闭当前段 → 工具专属段
                this.closeCurrent();
                this.ensureOpen();
                this.flushStatusLines();
                this.flushPendingPrefix();
                const call = {
                    type: 'toolCall' as const,
                    id: this.toolCallIdOf(),
                    name: PLACEHOLDER_TOOL_NAME,
                    arguments: {
                        agent: ev.toolCall.agent,
                        tool: ev.toolCall.tool,
                        arguments: ev.toolCall.arguments,
                    } as JsonObject,
                };
                this.current!.blocks.push(call);
                this.current!.endsWithToolCall = true;
                // 工具段在 tool-call 即完整(宿主在此执行占位工具并续跑)→ 立即出段;
                // 后续 tool-result 只贡献状态行(摘要),不再持有段
                this.closeCurrent();
                break;
            }
            case 'tool-result': {
                // 工具结果摘要行 → 状态行通道(下一段 thinking 开头 flush;段已在 tool-call 闭合)
                this.pushStatusLine(ev.line);
                break;
            }
            case 'node-text':
                // 流式已承载;忽略(旧 M4 纠偏通道作废)
                break;
        }
        return this.out.splice(0);
    }

    /** 工作流落定(outcome)→ 关闭当前段;返回末段(可能为 null) */
    finish(): FlowSegment | null {
        const seg = this.current;
        this.current = null;
        return seg;
    }

    /** 取出全部状态行(下一段 thinking 前置) */
    drainStatusLines(): string[] {
        return this.statusLines.splice(0);
    }

    /* ---------------- internals ---------------- */

    private out: SegmentEvent[] = [];

    private ensureOpen(): void {
        if (this.current) return;
        this.current = { id: ++this.seq, blocks: [], endsWithToolCall: false, textNodeKeys: new Set() };
    }

    private closeCurrent(): void {
        if (!this.current) return;
        const seg = this.current;
        this.current = null;
        // 空段(tool-result 后无内容)不通知?——通知,stream 层决定是否推送空段
        this.out.push({ type: 'segment-end', segment: seg });
    }

    /** 状态行落盘(下一段/当前段 thinking 开头;续跑后首个 delta 前调用) */
    private flushStatusLines(): void {
        for (const line of this.statusLines.splice(0)) this.appendThinking(line);
    }

    private flushPendingPrefix(): void {
        if (!this.prefixPending) return;
        this.prefixPending = false;
        if (this.curPrefix) this.appendThinking(this.curPrefix + '\n');
    }

    private appendThinking(text: string): void {
        if (!text) return;
        this.ensureOpen();
        const idx = this.thinkingIndex();
        this.currentBlock('thinking').thinking += text;
        // 真流式:前缀/状态行写入也要产生 delta 事件(旧实现靠收口整块兜底,已废)
        this.out.push({ type: 'thinking-delta', segmentId: this.current!.id, contentIndex: idx, delta: text });
    }

    private currentBlock(type: 'thinking'): { type: 'thinking'; thinking: string };
    private currentBlock(type: 'text'): { type: 'text'; text: string };
    private currentBlock(type: 'thinking' | 'text'): SegmentBlock {
        const blocks = this.current!.blocks;
        const last = blocks[blocks.length - 1];
        if (last && last.type === type) return last;
        const fresh: SegmentBlock =
            type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' };
        blocks.push(fresh);
        return fresh;
    }

    private thinkingIndex(): number {
        const blocks = this.current!.blocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i]!.type === 'thinking') return i;
        }
        return -1;
    }

    private textIndex(): number {
        const blocks = this.current!.blocks;
        for (let i = blocks.length - 1; i >= 0; i--) {
            if (blocks[i]!.type === 'text') return i;
        }
        return -1;
    }
}
