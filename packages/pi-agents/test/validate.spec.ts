/**
 * 校验器表驱动(docs/60 §4.1):各字段非法值 → 精确 reason 前缀;
 * 合法对象 → 通过且不产生 reasons。
 */
import { describe, expect, it } from 'vitest';
import {
    validateAgent,
    validateEntry,
    validateFlow,
    validateWorkspaceLorebook,
} from '../src/extension/loader/validate.js';

const VALID_AGENT = {
    default: {
        name: 'coder',
        title: '实现者',
        description: '写代码',
        systemPrompt: ['角色', '格式'],
        tools: ['read'],
    },
};

const VALID_FLOW = {
    default: {
        name: 'notes',
        title: '纪要',
        description: '单节点',
        nodes: { main: { agent: 'notetaker', sessionMode: 'inherit' } },
        entry: 'main',
        edges: {},
    },
};

function reasonsOf(out: unknown): string[] {
    return (out as { reasons?: string[] }).reasons ?? [];
}

describe('validateAgent', () => {
    it('合法 Agent 通过', () => {
        const out = validateAgent(VALID_AGENT, 'x.ts');
        expect(reasonsOf(out)).toEqual([]);
        expect((out as { name: string }).name).toBe('coder');
    });

    it('缺 default 导出(default 非对象)→ 报缺少 default', () => {
        const out = validateAgent({ nope: 1 }, 'x.ts');
        expect(reasonsOf(out).join('\n')).toContain('缺少 default 导出对象');
    });

    it.each([
        ['空 default 对象', {}, 'name "undefined" 不合法'],
        ['name 大写开头', { ...VALID_AGENT.default, name: 'Coder' }, 'name'],
        ['name 含下划线', { ...VALID_AGENT.default, name: 'a_b' }, 'name'],
        ['title 空串', { ...VALID_AGENT.default, title: '  ' }, 'title'],
        ['description 缺失', { name: 'x', title: 't' }, 'description'],
        ['systemPrompt 空数组', { ...VALID_AGENT.default, systemPrompt: [] }, 'systemPrompt'],
        ['systemPrompt 数组含空串', { ...VALID_AGENT.default, systemPrompt: ['ok', ''] }, 'systemPrompt'],
        ['systemPrompt 非字符串', { ...VALID_AGENT.default, systemPrompt: 42 }, 'systemPrompt'],
        ['tools 含非字符串', { ...VALID_AGENT.default, tools: ['read', 1] }, 'tools'],
        ['subagents 非数组', { ...VALID_AGENT.default, subagents: 'coder' }, 'subagents'],
        ['subagents 元素非法', { ...VALID_AGENT.default, subagents: [42] }, 'subagents[0]'],
        ['subagents 对象缺 name', { ...VALID_AGENT.default, subagents: [{ title: 'x' }] }, 'subagents[0].name'],
        [
            'subagents.session 无效',
            { ...VALID_AGENT.default, subagents: [{ name: 'c', session: 'fresh' }] },
            'subagents[0].session',
        ],
        ['model 非字符串', { ...VALID_AGENT.default, model: 7 }, 'model'],
        ['thinkingLevel 无效', { ...VALID_AGENT.default, thinkingLevel: 'ultra' }, 'thinkingLevel'],
        [
            'lorebook.entries 既非数组也非函数',
            { ...VALID_AGENT.default, lorebook: { entries: 'x' } },
            'lorebook.entries',
        ],
        ['lorebook.trigger 非函数', { ...VALID_AGENT.default, lorebook: { trigger: 1 } }, 'lorebook.trigger'],
    ])('%s → 报错', (_label, def, fragment) => {
        const out = validateAgent({ default: def }, 'x.ts');
        expect(reasonsOf(out).join('\n')).toContain(fragment);
    });
});

describe('validateFlow', () => {
    it('合法工作流通过', () => {
        const out = validateFlow(VALID_FLOW, 'x.ts');
        expect(reasonsOf(out)).toEqual([]);
    });

    it.each([
        ['name 大写开头', { ...VALID_FLOW.default, name: 'Notes' }, 'name'],
        ['nodes 空', { ...VALID_FLOW.default, nodes: {} }, 'nodes 不能为空'],
        ['nodes 非对象', { ...VALID_FLOW.default, nodes: [] }, 'nodes 必须是对象'],
        ['节点 agent 与 run 都缺', { ...VALID_FLOW.default, nodes: { a: {} } }, '恰好一个'],
        ['节点 agent 与 run 都有', { ...VALID_FLOW.default, nodes: { a: { agent: 'x', run: () => '' } } }, '恰好一个'],
        ['entry 不在 nodes', { ...VALID_FLOW.default, entry: 'nope' }, 'entry'],
        ['edges 指向不存在节点', { ...VALID_FLOW.default, edges: { main: 'ghost' } }, 'edges.main'],
        ['edges 目标 done 合法', null, ''], // 单独用例见下
        [
            'maxIterations 非正整数',
            { ...VALID_FLOW.default, edges: { main: { route: (): string => 'done', maxIterations: 0 } } },
            'maxIterations',
        ],
        ['route 非函数', { ...VALID_FLOW.default, edges: { main: { route: 'x' } } }, 'route'],
        [
            '顶层 pass 解析器写在边上',
            { ...VALID_FLOW.default, edges: { main: { route: (): string => 'done', pass: () => undefined } } },
            'pass 解析器只能写在顶层',
        ],
        ['pass.mode 无效', { ...VALID_FLOW.default, pass: { mode: 'magic' } }, 'mode 无效'],
        ['template 空', { ...VALID_FLOW.default, pass: { mode: 'template', template: '' } }, 'template'],
        ['custom 无 transform', { ...VALID_FLOW.default, pass: { mode: 'custom' } }, 'transform'],
    ])('%s', (_label, def, fragment) => {
        if (def === null) return; // 占位行
        const out = validateFlow({ default: def as object }, 'x.ts');
        expect(reasonsOf(out).join('\n')).toContain(fragment);
    });

    it('边目标 done 不报错', () => {
        const out = validateFlow({ default: { ...VALID_FLOW.default, edges: { main: 'done' } } }, 'x.ts');
        expect(reasonsOf(out)).toEqual([]);
    });

    it('节点名允许大写驼峰(docs/20 §2.3 放宽)', () => {
        const def = {
            ...VALID_FLOW.default,
            nodes: { parseReview: { run: () => 'ok' }, main: { agent: 'x' } },
            entry: 'main',
            edges: { main: 'parseReview', parseReview: 'done' },
        };
        const out = validateFlow({ default: def }, 'x.ts');
        expect(reasonsOf(out)).toEqual([]);
    });

    it('节点名拒绝非法字符', () => {
        const def = { ...VALID_FLOW.default, nodes: { 'a b': { run: () => '' } }, entry: 'a b', edges: {} };
        const out = validateFlow({ default: def }, 'x.ts');
        expect(reasonsOf(out).join('\n')).toContain('节点名 "a b" 不合法');
    });

    it('函数节点写 Agent 专属字段:不判死,进 warnings 通道(偏差修正)', () => {
        const def = {
            ...VALID_FLOW.default,
            nodes: { fn: { run: () => '', sessionMode: 'inherit', model: 'a/b' } },
            entry: 'fn',
        };
        const out = validateFlow({ default: def }, 'x.ts');
        expect(reasonsOf(out)).toEqual([]); // 无 invalid reasons
        expect((out as { warnings?: string[] }).warnings?.join('\n')).toContain(
            'nodes.fn: 函数节点忽略 sessionMode/model',
        );
    });

    it('initialInput 必须是函数', () => {
        const out = validateFlow({ default: { ...VALID_FLOW.default, initialInput: 'x' } }, 'x.ts');
        expect(reasonsOf(out).join('\n')).toContain('initialInput 必须是函数');
    });
});

describe('validateEntry / validateWorkspaceLorebook', () => {
    it.each([
        ['content 空', { depth: 0, content: '' }, 'content'],
        ['target 无效', { depth: 0, content: 'x', target: 'prompt' }, 'target'],
        ['depth 缺失(depth 条目)', { content: 'x' }, 'depth'],
        ['depth 负数', { depth: -1, content: 'x' }, 'depth'],
        ['role 无效', { depth: 0, content: 'x', role: 'system' }, 'role'],
        ['slot 负数', { target: 'system', content: 'x', slot: -1 }, 'slot'],
        ['order 非整数', { depth: 0, content: 'x', order: 1.5 }, 'order'],
    ])('%s → 报错', (_label, entry, fragment) => {
        const reasons: string[] = [];
        validateEntry(entry, 'e[0]', reasons);
        expect(reasons.join('\n')).toContain(fragment);
    });

    it('system 条目无需 depth(docs/50 §4.4 形态)', () => {
        const reasons: string[] = [];
        validateEntry({ target: 'system', slot: 0, content: '规范' }, 'e[0]', reasons);
        expect(reasons).toEqual([]);
    });

    it('工作区世界书:entries 函数合法;非数组非函数报错', () => {
        const ok: string[] = [];
        validateWorkspaceLorebook({ entries: () => [] }, 'x.ts', ok);
        expect(ok).toEqual([]);

        const bad: string[] = [];
        validateWorkspaceLorebook({ entries: 'x' }, 'x.ts', bad);
        expect(bad.join('\n')).toContain('entries 必须是数组或函数');
    });

    it('非对象 → 缺少 default 导出对象', () => {
        const reasons: string[] = [];
        validateWorkspaceLorebook('nope', 'x.ts', reasons);
        expect(reasons.join('\n')).toContain('缺少 default 导出对象');
    });
});
