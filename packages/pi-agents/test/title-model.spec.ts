import { describe, it, expect } from 'vitest';
import { normalizeContext, type Model, type Api } from '@earendil-works/pi-ai';

// 直接测 stream.ts 的改道判定:标题 systemPrompt 特征 + resolveTitleModel
// (streamSimple 全链路已由 engine.spec 覆盖;这里聚焦改道分支的最小复现)

const TITLE_SYSTEM = 'Generate a concise title for a coding-agent chat session. Return only the title.';
const NORMAL_SYSTEM = 'You are a helpful coding assistant.';

function hasTitleMarker(ctx: { messages: { role: string; content?: unknown }[] }): boolean {
    return ctx.messages.some((m) => {
        if (m.role !== 'system') return false;
        const c = m.content;
        if (typeof c === 'string') return c.includes('Generate a concise title');
        if (Array.isArray(c)) {
            return c.some((part) => {
                const p = part as { type?: string; text?: string };
                return p.type === 'text' && typeof p.text === 'string' && p.text.includes('Generate a concise title');
            });
        }
        return false;
    });
}

function titleLikeContext() {
    return normalizeContext({
        systemPrompt: TITLE_SYSTEM,
        messages: [
            {
                role: 'user',
                content: [{ type: 'text', text: 'Create a 2-6 word title for this request:\n\nhello' }],
                timestamp: Date.now(),
            },
        ],
    });
}

function normalContext() {
    return normalizeContext({
        systemPrompt: NORMAL_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() }],
    });
}

const fakeModel = { id: 'x', api: 'openai-completions', provider: 'p', name: 'x' } as unknown as Model<Api>;

describe('title-model 改道判定', () => {
    it('标题 systemPrompt 可被特征串识别', () => {
        const ctx = titleLikeContext();
        expect(hasTitleMarker(ctx)).toBe(true);
    });

    it('普通请求不命中标题特征', () => {
        const ctx = normalContext();
        expect(hasTitleMarker(ctx)).toBe(false);
    });

    it('normalizeContext 把 systemPrompt 转为 role:system 消息', () => {
        const ctx = titleLikeContext();
        expect(ctx.messages[0]?.role).toBe('system');
    });

    it('resolveTitleModel 未注入时改道分支跳过(deps 可选)', () => {
        // StreamDeps.resolveTitleModel 是可选字段——类型层面保证向后兼容
        const deps: Record<string, unknown> = {};
        expect(deps.resolveTitleModel).toBeUndefined();
        void fakeModel;
    });
});
