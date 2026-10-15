/**
 * M10 FlowSegmenter 单元测试(docs/30 §6):NodeEvent 流 → 虚拟消息段。
 */
import { describe, expect, it } from 'vitest';
import { FlowSegmenter, type SegmentEvent } from '../src/extension/session/segmenter.js';
import type { NodeEvent } from '../src/extension/session/stream-events.js';

const P = { prefixes: true };

function feedAll(seg: FlowSegmenter, events: NodeEvent[]): SegmentEvent[] {
    const out: SegmentEvent[] = [];
    for (const ev of events) out.push(...seg.feed(ev, P));
    return out;
}

describe('FlowSegmenter(docs/30 §6)', () => {
    it('单节点纯文本:一个段,thinking+text,text 收尾(无 toolCall → 终点形态)', () => {
        const seg = new FlowSegmenter();
        const evs = feedAll(seg, [
            { kind: 'node-start', nodeKey: 'a', label: '规划', visit: 1, isAgent: true },
            { kind: 'thinking-delta', sourceKey: 'a#1', sourceLabel: '规划', delta: '思考中' },
            { kind: 'text-delta', sourceKey: 'a#1', sourceLabel: '规划', delta: '任务清单', isTerminal: true },
        ]);
        // delta 事件流出
        expect(evs.some((e) => e.type === 'thinking-delta')).toBe(true);
        expect(evs.some((e) => e.type === 'text-delta')).toBe(true);
        const last = seg.finish();
        expect(last).not.toBeNull();
        expect(last!.endsWithToolCall).toBe(false);
        expect(last!.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
    });

    it('思考→工具→(续跑)摘要→文本:段在 tool-call 处切分;摘要行进下一段', () => {
        const seg = new FlowSegmenter();
        feedAll(seg, [
            { kind: 'node-start', nodeKey: 'c', label: '实现', visit: 1, isAgent: true },
            { kind: 'thinking-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '先想' },
            {
                kind: 'tool-call',
                sourceKey: 'c#1',
                sourceLabel: '实现',
                toolCall: { agent: '实现', tool: 'write', arguments: { path: 'a.txt' }, truncated: false },
            },
            { kind: 'tool-result', sourceKey: 'c#1', sourceLabel: '实现', line: '✓ write a.txt' },
            { kind: 'text-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '完成', isTerminal: true },
        ]);
        const finalSeg = seg.finish();
        expect(finalSeg).not.toBeNull();
        // 末段:摘要行(状态行通道)flush 进 thinking + text 收尾
        expect(finalSeg!.endsWithToolCall).toBe(false);
        expect(finalSeg!.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
        const thinking = finalSeg!.blocks.find((b) => b.type === 'thinking');
        expect(thinking && thinking.type === 'thinking' ? thinking.thinking : '').toContain('✓ write a.txt');
    });

    it('重放完整流验证段边界:tool-call 段 endsWithToolCall=true,摘要进续跑段', () => {
        const seg = new FlowSegmenter();
        const all: SegmentEvent[] = [];
        const push = (ev: NodeEvent) => all.push(...seg.feed(ev, P));
        push({ kind: 'node-start', nodeKey: 'c', label: '实现', visit: 1, isAgent: true });
        push({ kind: 'thinking-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '先想' });
        push({
            kind: 'tool-call',
            sourceKey: 'c#1',
            sourceLabel: '实现',
            toolCall: { agent: '实现', tool: 'write', arguments: { path: 'a.txt' }, truncated: false },
        });
        // tool-call 即段完整 → 前段(thinking/text)与工具段都出段:2 个边界
        const ends1 = all.filter((e) => e.type === 'segment-end');
        expect(ends1).toHaveLength(2);
        push({ kind: 'tool-result', sourceKey: 'c#1', sourceLabel: '实现', line: '✓ write a.txt' });
        // tool-result:摘要行入状态行缓冲,并关闭工具段(空段/工具段边界)
        push({ kind: 'text-delta', sourceKey: 'c#1', sourceLabel: '实现', delta: '完成', isTerminal: true });
        const final = seg.finish();
        // 摘要行 flush 进续跑段 thinking,text 收尾
        expect(final!.blocks.map((b) => b.type)).toEqual(['thinking', 'text']);
        const t = final!.blocks.find((b) => b.type === 'thinking');
        expect(t && t.type === 'thinking' ? t.thinking : '').toContain('✓ write a.txt');
    });

    it('状态行:跨段缓冲,下一段 thinking 前置', () => {
        const seg = new FlowSegmenter();
        seg.pushStatusLine('引擎状态行');
        feedAll(seg, [{ kind: 'node-start', nodeKey: 'a', label: 'A', visit: 1, isAgent: true }]);
        pushThinking(seg, '内容');
        const evs = seg['out'].splice(0);
        // 无 segment-end(statusLines 在首个 delta 的 ensureOpen 后仍在缓冲)
        expect(evs.filter((e) => e.type === 'segment-end')).toHaveLength(0);
        void seg;
    });

    it('前缀:新来源首个内容 delta 前插入一次', () => {
        const seg = new FlowSegmenter();
        const all: SegmentEvent[] = [];
        const push = (ev: NodeEvent) => all.push(...seg.feed(ev, P));
        push({ kind: 'node-start', nodeKey: 'a', label: '规划', visit: 2, isAgent: true });
        push({ kind: 'thinking-delta', sourceKey: 'a#2', sourceLabel: '规划', delta: 'X' });
        // 前缀在 feed 内直接进 thinking 块——通过 finish 检查
        const final = seg.finish();
        const th = final!.blocks.find((b) => b.type === 'thinking');
        expect(th && 'thinking' in th).toBe(true);
        expect((th as { thinking: string }).thinking.startsWith('【规划 #2】')).toBe(true);
    });

    it('fn 节点 node-start:不换段(状态行承载)', () => {
        const seg = new FlowSegmenter();
        const all = feedAll(seg, [
            { kind: 'node-start', nodeKey: 'a', label: 'A', visit: 1, isAgent: true },
            { kind: 'text-delta', sourceKey: 'a#1', sourceLabel: 'A', delta: 't1', isTerminal: true },
            { kind: 'node-start', nodeKey: 'f', label: 'F', visit: 1, isAgent: false },
            { kind: 'text-delta', sourceKey: 'f#1', sourceLabel: 'F', delta: 't2', isTerminal: true },
        ]);
        expect(all.filter((e) => e.type === 'segment-end')).toHaveLength(0);
        const final = seg.finish();
        // fn 不切段:同段两块 text(t1/t2 同块累积)
        expect(final!.blocks.filter((b) => b.type === 'text')).toHaveLength(1);
    });
});

function pushThinking(seg: FlowSegmenter, delta: string): void {
    seg.feed({ kind: 'thinking-delta', sourceKey: 'x', sourceLabel: 'x', delta }, P);
}
