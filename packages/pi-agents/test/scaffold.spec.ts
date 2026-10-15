/**
 * /agent-init 脚手架单测(docs/50 §1):目录 / tsconfig / 类型定义 shim 的生成与幂等。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    AGENT_SUBDIRS,
    TS_CONFIG_NAME,
    TYPES_SHIM_NAME,
    renderTsconfig,
    renderTypesShim,
    scaffoldAgentsDir,
} from '../src/extension/scaffold.js';

let base: string;
/** 假装本包 types.ts 的位置(不触盘,仅用于相对路径渲染) */
const TYPES = '/repo/packages/pi-agents/src/extension/types.ts';

beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'pi-agents-scaffold-'));
});
afterEach(() => {
    rmSync(base, { recursive: true, force: true });
});

describe('scaffoldAgentsDir', () => {
    it('建立三个子目录 + tsconfig + shim', () => {
        const r = scaffoldAgentsDir({ baseDir: base, typesPath: TYPES });
        for (const sub of AGENT_SUBDIRS) expect(existsSync(join(base, sub))).toBe(true);
        expect(existsSync(join(base, TS_CONFIG_NAME))).toBe(true);
        expect(existsSync(join(base, TYPES_SHIM_NAME))).toBe(true);
        expect([...r.created].sort()).toEqual([TS_CONFIG_NAME, TYPES_SHIM_NAME].sort());
        expect(r.skipped).toHaveLength(0);
    });

    it('幂等:内容一致时不重写', () => {
        scaffoldAgentsDir({ baseDir: base, typesPath: TYPES });
        const r2 = scaffoldAgentsDir({ baseDir: base, typesPath: TYPES });
        expect(r2.created).toHaveLength(0);
        expect([...r2.skipped].sort()).toEqual([TS_CONFIG_NAME, TYPES_SHIM_NAME].sort());
    });

    it('尊重用户已有 tsconfig(不覆盖)', () => {
        writeFileSync(join(base, TS_CONFIG_NAME), '{"compilerOptions":{}}\n');
        const r = scaffoldAgentsDir({ baseDir: base, typesPath: TYPES });
        expect(readFileSync(join(base, TS_CONFIG_NAME), 'utf8')).toBe('{"compilerOptions":{}}\n');
        expect(r.skipped).toContain(TS_CONFIG_NAME);
    });

    it('tsconfig 把两个包名映射到 shim,include 覆盖三个子目录', () => {
        const cfg = JSON.parse(renderTsconfig()) as {
            compilerOptions: { paths: Record<string, string[]> };
            include: string[];
        };
        expect(cfg.compilerOptions.paths['@chlamydomonos/pi-agents']).toEqual([`./${TYPES_SHIM_NAME}`]);
        expect(cfg.compilerOptions.paths['pi-agents']).toEqual([`./${TYPES_SHIM_NAME}`]);
        expect(cfg.include).toEqual(
            expect.arrayContaining(['agents/**/*.ts', 'agent-flows/**/*.ts', 'lorebooks/**/*.ts', TYPES_SHIM_NAME]),
        );
    });

    it('shim 以相对路径再导出 types.ts(去扩展名)', () => {
        const expected = `export * from '${relative(base, TYPES).replace(/\\/g, '/').replace(/\.ts$/, '')}';`;
        const line = renderTypesShim(TYPES, base)
            .split('\n')
            .find((l) => l.startsWith('export * from'));
        expect(line).toBe(expected);
    });

    it('types.ts 路径变化 → 重写 shim(命令托管)', () => {
        scaffoldAgentsDir({ baseDir: base, typesPath: TYPES });
        const r = scaffoldAgentsDir({ baseDir: base, typesPath: '/other/place/types.ts' });
        expect(r.created).toContain(TYPES_SHIM_NAME);
        expect(r.skipped).toContain(TS_CONFIG_NAME); // tsconfig 不受影响
    });
});
