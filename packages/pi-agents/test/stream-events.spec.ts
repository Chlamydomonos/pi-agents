/**
 * M4 stream-events 单元测试(docs/30 §4.2/§4.3/§3.2/§3.3):
 * 占位参数包装与 32KiB 截断、来源前缀、工具结果摘要行。
 */
import { describe, expect, it } from 'vitest';
import {
    PLACEHOLDER_TOOL_NAME,
    PLACEHOLDER_RESULT_TEXT,
    TOOL_ARGS_LIMIT,
    wrapToolArguments,
    sourcePrefix,
    toolResultLine,
    ASK_USER_TOOL_NAME,
    ASK_USER_POSTED_TEXT,
} from '../src/extension/session/stream-events.js';

describe('wrapToolArguments(docs/30 §4.2/§4.3)', () => {
    it('常规参数:原样内嵌 {agent, tool, arguments},不截断', () => {
        const pc = wrapToolArguments('read', { path: 'a.txt' }, 'main');
        expect(pc.tool).toBe('read');
        expect(pc.agent).toBe('main');
        expect(pc.arguments).toEqual({ path: 'a.txt' });
        expect(pc.truncated).toBe(false);
    });

    it('null/undefined 参数 → 空对象', () => {
        expect(wrapToolArguments('t', undefined, 'a').arguments).toEqual({});
        expect(wrapToolArguments('t', null, 'a').arguments).toEqual({});
    });

    it('超过 32KiB → {truncated, bytes, preview}(§4.3)', () => {
        const big = { blob: 'x'.repeat(TOOL_ARGS_LIMIT + 10) };
        const pc = wrapToolArguments('read', big, 'main');
        expect(pc.truncated).toBe(true);
        expect(pc.arguments.truncated).toBe(true);
        expect(typeof pc.arguments.bytes).toBe('number');
        expect(pc.arguments.bytes as number).toBeGreaterThan(TOOL_ARGS_LIMIT);
        const preview = pc.arguments.preview as string;
        expect(preview.length).toBeLessThan(500);
        expect(preview.startsWith('{"blob"')).toBe(true);
    });

    it('恰好不超限 → 不截断', () => {
        const small = { blob: 'x'.repeat(100) };
        expect(wrapToolArguments('t', small, 'a').truncated).toBe(false);
    });
});

describe('占位工具常量(docs/30 §4)', () => {
    it('固定名与固定文案', () => {
        expect(PLACEHOLDER_TOOL_NAME).toBe('agents_tool');
        expect(PLACEHOLDER_RESULT_TEXT).toContain('占位');
    });
});

describe('ask_user 桥接常量(真实透传给宿主 pi-web)', () => {
    it('真实工具名与 posted 文案', () => {
        expect(ASK_USER_TOOL_NAME).toBe('ask_user');
        expect(ASK_USER_POSTED_TEXT).toContain('问题已提交');
    });
});

describe('sourcePrefix / toolResultLine(docs/30 §3.2/§3.3)', () => {
    it('前缀格式【label #visit】;关闭 → 空串', () => {
        expect(sourcePrefix('实现', 2, true)).toBe('【实现 #2】');
        expect(sourcePrefix('实现', 2, false)).toBe('');
    });

    it('摘要行:成功 ✓ / 失败 ✗', () => {
        expect(toolResultLine('read', true, '12ms')).toBe('✓ read (12ms)');
        expect(toolResultLine('bash', false, 'exit 1')).toBe('✗ bash: exit 1');
    });
});
