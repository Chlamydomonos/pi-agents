/**
 * 装载器集成测试(docs/60 §4.1):fixture 目录 → 有效/无效/覆盖/环引用/悬空引用。
 * 不发 LLM 请求;装载经真实 jiti(练习 import type 'pi-agents' alias 兜底——
 * 此处沿用旧包名以顺带覆盖兼容别名;主名见 test/alias.spec.ts)。
 */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearModuleCache, defaultRoots, loadAll, type LoadAllResult } from '../src/extension/loader/load.js';

let root: string; // fake homeDir
let cwd: string; // fake workspace

const agentDir = (workspace: boolean) =>
    workspace
        ? join(cwd, '.pi', 'chlamydomonos-agents', 'agents')
        : join(root, '.pi', 'agent', 'chlamydomonos-agents', 'agents');
const flowDir = (workspace: boolean) =>
    workspace
        ? join(cwd, '.pi', 'chlamydomonos-agents', 'agent-flows')
        : join(root, '.pi', 'agent', 'chlamydomonos-agents', 'agent-flows');
const loreDir = (workspace: boolean) =>
    workspace
        ? join(cwd, '.pi', 'chlamydomonos-agents', 'lorebooks')
        : join(root, '.pi', 'agent', 'chlamydomonos-agents', 'lorebooks');

function writeAgent(dir: string, name: string, body: string): string {
    mkdirSync(dir, { recursive: true });
    const p = join(dir, `${name}.ts`);
    writeFileSync(p, body);
    return p;
}

const AGENT = (name: string) => `import type { AgentDefinition } from 'pi-agents';
export default { name: '${name}', title: 'T', description: 'D', systemPrompt: 'S' } satisfies AgentDefinition;
`;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-agents-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'pi-agents-cwd-'));
    clearModuleCache();
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
});

function load(): Promise<LoadAllResult> {
    const warnings: string[] = [];
    return loadAll(defaultRoots(cwd, root), (m) => warnings.push(m)).then((r) => {
        (r as LoadAllResult & { _warnings: string[] })._warnings = warnings;
        return r;
    });
}

describe('loadAll', () => {
    it('空目录:零装载零告警', async () => {
        const r = await load();
        expect(r.agents).toHaveLength(0);
        expect(r.flows).toHaveLength(0);
        expect(r.lorebooks).toHaveLength(0);
        expect(r.invalid).toHaveLength(0);
        expect(r.warnings).toHaveLength(0);
    });

    it('函数节点写 Agent 专属字段:工作流照常装载 + warning(不进 invalid)', async () => {
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'warn-flow.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default {
    name: 'warn-flow', title: 'T', description: 'D',
    nodes: { fn: { run: (i: { text: string }) => i.text, sessionMode: 'inherit' } },
    entry: 'fn', edges: {},
} satisfies FlowDefinition;
`,
        );
        const r = await load();
        expect(r.flows).toHaveLength(1); // 照常装载
        expect(r.invalid).toHaveLength(0);
        expect(r.warnings.join('\n')).toContain('函数节点忽略 sessionMode');
    });

    it('有效文件:agent/flow/lorebook 都装载,工作流级 lorebook 与函数节点合法', async () => {
        writeAgent(agentDir(false), 'alpha', AGENT('alpha'));
        writeAgent(agentDir(false), 'beta', AGENT('beta'));
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'pipe.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default {
    name: 'pipe', title: 'T', description: 'D',
    nodes: { start: { agent: 'alpha' }, parse: { run: (i: { text: string }) => i.text } },
    entry: 'start', edges: { start: 'parse', parse: 'done' },
    lorebook: { entries: [{ depth: 1, content: 'L' }] },
} satisfies FlowDefinition;
`,
        );
        mkdirSync(loreDir(false), { recursive: true });
        writeFileSync(
            join(loreDir(false), 'style.ts'),
            `import type { WorkspaceLorebook } from 'pi-agents';
export default { entries: (ctx: { agent: string }) => (ctx.agent === 'alpha' ? [{ target: 'system', slot: 0, content: 'R' }] : []) } satisfies WorkspaceLorebook;
`,
        );

        const r = await load();
        expect(r.warnings).toHaveLength(0);
        expect(r.invalid).toHaveLength(0);
        expect(r.agents.map((a) => a.def.name).sort()).toEqual(['alpha', 'beta']);
        expect(r.flows).toHaveLength(1);
        expect(r.flows[0]?.def.nodes.parse?.run).toBeTypeOf('function');
        expect(r.lorebooks).toHaveLength(1);
    });

    it('工作区覆盖全局同名:取工作区版本 + warning', async () => {
        writeAgent(agentDir(false), 'svc', AGENT('svc') /* global: 无 subagent */);
        writeAgent(
            agentDir(true),
            'svc',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'svc', title: 'T', description: 'D', systemPrompt: 'S', tools: ['read'] } satisfies AgentDefinition;
`,
        );

        const r = await load();
        expect(r.agents).toHaveLength(1);
        expect(r.agents[0]?.workspace).toBe(true);
        expect(r.agents[0]?.def.tools).toEqual(['read']);
        expect(r.warnings.join('\n')).toContain('工作区覆盖全局');
    });

    it('无效文件:进 invalid,其他文件不受影响', async () => {
        writeAgent(agentDir(false), 'good', AGENT('good'));
        writeAgent(
            agentDir(false),
            'bad',
            `export default { name: 'Bad Name', title: '', systemPrompt: '' };
`,
        );
        const r = await load();
        expect(r.agents.map((a) => a.def.name)).toEqual(['good']);
        expect(r.invalid).toHaveLength(1);
        expect(r.invalid[0]?.file).toContain('bad.ts');
        expect(r.invalid[0]?.reasons.length).toBeGreaterThan(0);
    });

    it('目录形式 index.ts:按目录名装载', async () => {
        const dir = join(agentDir(false), 'packaged');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.ts'), AGENT('packaged'));
        const r = await load();
        expect(r.agents.map((a) => a.def.name)).toEqual(['packaged']);
    });

    it('语法错误文件:首载判 invalid(jiti 报错进 reasons)', async () => {
        writeAgent(
            agentDir(false),
            'broken',
            `export default {{{;
`,
        );
        const r = await load();
        expect(r.agents).toHaveLength(0);
        expect(r.invalid).toHaveLength(1);
        expect(r.invalid[0]?.file).toContain('broken.ts');
    });

    it('重装失败保留旧定义(docs/40 §2.2):mtime 变更 + 坏内容 → warning + 保留旧 def', async () => {
        const p = writeAgent(agentDir(false), 'stable', AGENT('stable'));
        const first = await load();
        expect(first.agents).toHaveLength(1);

        // 破坏文件内容并推进 mtime
        writeFileSync(p, `export default {{{;`);
        const future = new Date(Date.now() + 5000);
        utimesSync(p, future, future);

        const warnings: string[] = [];
        const second = await loadAll(defaultRoots(cwd, root), (m) => warnings.push(m));
        expect(second.agents).toHaveLength(1); // 旧定义保留
        expect(second.agents[0]?.def.name).toBe('stable');
        expect(warnings.join('\n')).toContain('重装失败,保留旧定义');
    });

    it('工作流节点引用悬空 Agent → 工作流 invalid + warning', async () => {
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'ghost-flow.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default { name: 'ghost-flow', title: 'T', description: 'D',
    nodes: { a: { agent: 'ghost' } }, entry: 'a', edges: {} } satisfies FlowDefinition;
`,
        );
        const r = await load();
        expect(r.flows).toHaveLength(0);
        expect(r.invalid).toHaveLength(1);
        expect(r.invalid[0]?.reasons.join('\n')).toContain('ghost');
        expect(r.warnings.join('\n')).toContain('不存在');
    });

    it('subagents 悬空引用:条目忽略 + warning,Agent 本体保留', async () => {
        writeAgent(
            agentDir(false),
            'main',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'main', title: 'T', description: 'D', systemPrompt: 'S', subagents: ['nowhere', 'helper'] } satisfies AgentDefinition;
`,
        );
        writeAgent(agentDir(false), 'helper', AGENT('helper'));
        const r = await load();
        expect(r.agents).toHaveLength(2);
        const main = r.agents.find((a) => a.def.name === 'main');
        expect(main?.subagentRefs.map((x) => x.name)).toEqual(['helper']);
        expect(r.warnings.join('\n')).toContain('nowhere');
    });

    it('引用环(A→B→A):环上成员全部 invalid', async () => {
        writeAgent(
            agentDir(false),
            'a-loop',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'a-loop', title: 'T', description: 'D', systemPrompt: 'S', subagents: ['b-loop'] } satisfies AgentDefinition;
`,
        );
        writeAgent(
            agentDir(false),
            'b-loop',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'b-loop', title: 'T', description: 'D', systemPrompt: 'S', subagents: ['a-loop'] } satisfies AgentDefinition;
`,
        );
        const r = await load();
        expect(r.agents).toHaveLength(0);
        expect(r.invalid).toHaveLength(2);
        expect(r.warnings.join('\n')).toContain('引用环');
    });

    it('工作流自引用(subagent 指向自己所在流经节点)不误判;但 Agent subagent 指向引用它的工作流成环 → 拒绝', async () => {
        // flow: outer 引用 agent inner;agent inner 的 subagent 引用 outer → 环
        writeAgent(
            agentDir(false),
            'inner',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'inner', title: 'T', description: 'D', systemPrompt: 'S', subagents: ['outer'] } satisfies AgentDefinition;
`,
        );
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'outer.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default { name: 'outer', title: 'T', description: 'D',
    nodes: { n: { agent: 'inner' } }, entry: 'n', edges: {} } satisfies FlowDefinition;
`,
        );
        const r = await load();
        expect(r.agents).toHaveLength(0);
        expect(r.flows).toHaveLength(0);
        expect(r.invalid).toHaveLength(2);
        expect(r.warnings.join('\n')).toContain('引用环');
    });

    it('合法 subflow 引用(Agent → 工作流)不成环:全部保留', async () => {
        writeAgent(
            agentDir(false),
            'orchestrator',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'orchestrator', title: 'T', description: 'D', systemPrompt: 'S', subagents: ['pipeline'] } satisfies AgentDefinition;
`,
        );
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'pipeline.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default { name: 'pipeline', title: 'T', description: 'D',
    nodes: { n: { agent: 'worker' } }, entry: 'n', edges: {} } satisfies FlowDefinition;
`,
        );
        writeAgent(agentDir(false), 'worker', AGENT('worker'));
        const r = await load();
        expect(r.warnings.join('\n')).not.toContain('引用环');
        expect(r.invalid).toHaveLength(0);
        expect(r.agents.map((a) => a.def.name).sort()).toEqual(['orchestrator', 'worker']);
        expect(r.flows).toHaveLength(1);
    });

    it('同名 Agent 与工作流:subagent 引用同名时 Agent 优先(无环警告)', async () => {
        writeAgent(
            agentDir(false),
            'duo',
            `import type { AgentDefinition } from 'pi-agents';
export default { name: 'duo', title: 'T', description: 'D', systemPrompt: 'S', subagents: [{ name: 'target' }] } satisfies AgentDefinition;
`,
        );
        writeAgent(agentDir(false), 'target', AGENT('target'));
        mkdirSync(flowDir(false), { recursive: true });
        writeFileSync(
            join(flowDir(false), 'target.ts'),
            `import type { FlowDefinition } from 'pi-agents';
export default { name: 'target', title: 'T', description: 'D', nodes: { n: { agent: 'duo' } }, entry: 'n', edges: {} } satisfies FlowDefinition;
`,
        );
        const r = await load();
        const duo = r.agents.find((a) => a.def.name === 'duo');
        expect(duo?.subagentRefs.map((x) => x.name)).toEqual(['target']);
        expect(r.warnings.join('\n')).not.toContain('引用环');
    });
});

describe('homedir 默认参数', () => {
    it('defaultRoots 使用真实 homedir 时可构造(不触盘)', () => {
        const roots = defaultRoots('/tmp');
        expect(roots.homeDir).toBe(homedir());
        expect(roots.agentDirName).toBe('chlamydomonos-agents');
    });
});
