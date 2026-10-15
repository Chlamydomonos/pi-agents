/**
 * 作者模块说明符 alias 测试(docs/60 §2):
 *   - 主名 `@chlamydomonos/pi-agents`(包名)
 *   - 旧名 `pi-agents`(兼容别名)
 * 两者都应被 jiti alias 解析到本包 types.ts,即使未安装本包也能类型擦除通过。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearModuleCache, defaultRoots, loadAll } from '../src/extension/loader/load.js';

let root: string; // fake homeDir
let cwd: string; // fake workspace

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-agents-alias-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'pi-agents-alias-cwd-'));
    clearModuleCache();
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
});

/** 在工作区 agents/ 写一个 import 指定模块说明符的 Agent */
function writeAgent(name: string, specifier: string): void {
    const dir = join(cwd, '.pi', 'chlamydomonos-agents', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
        join(dir, `${name}.ts`),
        `import type { AgentDefinition } from '${specifier}';\n` +
            `export default { name: '${name}', title: 'T', description: 'D', systemPrompt: 'S' } satisfies AgentDefinition;\n`,
    );
}

describe('作者模块说明符 alias', () => {
    it('主名 @chlamydomonos/pi-agents 可被 jiti 解析(未安装本包)', async () => {
        writeAgent('scoped', '@chlamydomonos/pi-agents');
        const r = await loadAll(defaultRoots(cwd, root), () => {});
        expect(r.invalid).toHaveLength(0);
        expect(r.agents.map((a) => a.def.name)).toEqual(['scoped']);
    });

    it('旧名 pi-agents 仍兼容', async () => {
        writeAgent('legacy', 'pi-agents');
        const r = await loadAll(defaultRoots(cwd, root), () => {});
        expect(r.invalid).toHaveLength(0);
        expect(r.agents.map((a) => a.def.name)).toEqual(['legacy']);
    });
});
