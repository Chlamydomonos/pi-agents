import { describe, expect, it } from 'vitest';
import {
    appendPathSegment,
    aggregateUsageEntries,
    formatDuration,
    formatTokens,
    formatUsageTable,
    nodePathPrefix,
    subAgentSegment,
    subflowSegment,
    UsageLedger,
    USAGE_ENTRY_TYPE,
    EMPTY_PATH_USAGE,
} from '../src/extension/session/usage.js';

/* ------------------------------------------------------------------ */
/*  agentPath 组装(§6 键格式)                                          */
/* ------------------------------------------------------------------ */

describe('agentPath 组装', () => {
    it('节点路径 = flow:<flow>#<label>', () => {
        expect(nodePathPrefix('dev-loop', '实现')).toBe('flow:dev-loop#实现');
    });

    it('链式追加:sub 与 subflow 任意交错(10 §6.1)', () => {
        const base = nodePathPrefix('review-loop', 'coder');
        expect(appendPathSegment(base, subAgentSegment('reviewer-quick'))).toBe(
            'flow:review-loop#coder > sub:reviewer-quick',
        );
        const nested = appendPathSegment(base, subflowSegment('dev-loop', 'code'));
        expect(nested).toBe('flow:review-loop#coder > subflow:dev-loop#code');
        expect(appendPathSegment(nested, subAgentSegment('coder'))).toBe(
            'flow:review-loop#coder > subflow:dev-loop#code > sub:coder',
        );
    });
});

/* ------------------------------------------------------------------ */
/*  UsageLedger                                                        */
/* ------------------------------------------------------------------ */

describe('UsageLedger', () => {
    it('按路径累加;缺省字段不覆盖', () => {
        const l = new UsageLedger();
        l.record('flow:f#n', { input: 100, output: 10, requests: 1 });
        l.record('flow:f#n', { input: 50, cacheRead: 5, toolCalls: 2, durationMs: 1200 });
        const s = l.snapshot().get('flow:f#n');
        expect(s?.input).toBe(150);
        expect(s?.output).toBe(10);
        expect(s?.cacheRead).toBe(5);
        expect(s?.toolCalls).toBe(2);
        expect(s?.durationMs).toBe(1200);
    });

    it('merge 并表(嵌套 subflow 归并)', () => {
        const a = new UsageLedger();
        a.record('flow:f#n > sub:x', { input: 10, requests: 1 });
        const b = new UsageLedger();
        b.record('flow:f#n > subflow:g#t', { input: 20, requests: 2 });
        a.merge(b);
        expect(a.size).toBe(2);
        expect(a.snapshot().get('flow:f#n > subflow:g#t')?.input).toBe(20);
    });

    it('total 汇总全路径', () => {
        const l = new UsageLedger();
        l.record('a', { input: 1, requests: 1, durationMs: 1000 });
        l.record('b', { input: 2, requests: 2, durationMs: 500 });
        const t = l.total();
        expect(t.input).toBe(3);
        expect(t.requests).toBe(3);
        expect(t.durationMs).toBe(1500);
    });
});

/* ------------------------------------------------------------------ */
/*  entry 聚合(resume 恢复)                                            */
/* ------------------------------------------------------------------ */

describe('aggregateUsageEntries', () => {
    it('只认 custom + USAGE_ENTRY_TYPE;数据缺失跳过不崩', () => {
        const { byPath, wakeCount } = aggregateUsageEntries([
            { type: 'message' },
            {
                type: 'custom',
                customType: USAGE_ENTRY_TYPE,
                data: { wake: 1, byPath: { 'flow:f#n': { input: 100, requests: 2 } } },
            },
            { type: 'custom', customType: 'other', data: { wake: 2 } },
            { type: 'custom', customType: USAGE_ENTRY_TYPE, data: undefined },
            {
                type: 'custom',
                customType: USAGE_ENTRY_TYPE,
                data: { wake: 3, byPath: { 'flow:f#n': { input: 50 }, 'sub:x': { output: 7 } } },
            },
        ]);
        expect(wakeCount).toBe(3);
        expect(byPath.get('flow:f#n')?.input).toBe(150);
        expect(byPath.get('flow:f#n')?.requests).toBe(2);
        expect(byPath.get('sub:x')?.output).toBe(7);
    });

    it('空输入 → 空表', () => {
        const r = aggregateUsageEntries([]);
        expect(r.wakeCount).toBe(0);
        expect(r.byPath.size).toBe(0);
    });
});

/* ------------------------------------------------------------------ */
/*  格式化(§7 输出)                                                    */
/* ------------------------------------------------------------------ */

describe('formatTokens/formatDuration', () => {
    it('token k 缩写:<1000 原样;1 位小数;≥100k 取整', () => {
        expect(formatTokens(999)).toBe('999');
        expect(formatTokens(182300)).toBe('182.3k');
        expect(formatTokens(24100)).toBe('24.1k');
        expect(formatTokens(1554000)).toBe('1554k');
    });

    it('时长:22s / 2m03s / 1h02m', () => {
        expect(formatDuration(22_000)).toBe('22s');
        expect(formatDuration(123_000)).toBe('2m03s');
        expect(formatDuration(3_720_000)).toBe('1h02m');
    });
});

describe('formatUsageTable', () => {
    it('含标题/表头/路径行/合计行(§7 样式)', () => {
        const byPath = new Map<string, typeof EMPTY_PATH_USAGE>();
        byPath.set('flow:dev-loop#实现', {
            ...EMPTY_PATH_USAGE,
            input: 182_300,
            output: 24_100,
            cacheRead: 96_400,
            requests: 31,
            durationMs: 372_000,
        });
        byPath.set('flow:dev-loop#实现 > sub:reviewer', {
            ...EMPTY_PATH_USAGE,
            input: 12_000,
            output: 1_200,
            cacheRead: 8_100,
            requests: 3,
            durationMs: 22_000,
        });
        const out = formatUsageTable({ title: 'pi-agents 用量(session:x1,x2 次唤醒)', byPath });
        expect(out).toContain('pi-agents 用量');
        expect(out).toContain('路径');
        expect(out).toContain('flow:dev-loop#实现');
        expect(out).toContain('182.3k');
        expect(out).toContain('sub:reviewer');
        expect(out).toContain('合计');
        expect(out).toContain('194.3k'); // 182300+12000
        expect(out).toContain('34'); // 31+3
    });

    it('空路径 → 仅标题+表头(无合计行)', () => {
        const out = formatUsageTable({ title: 't', byPath: new Map() });
        expect(out.split('\n')).toHaveLength(2);
        expect(out).not.toContain('合计');
    });
});
