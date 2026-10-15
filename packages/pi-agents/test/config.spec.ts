/**
 * 两级 JSON 配置单测(docs/40 §11):
 *   新路径 全局 ~/.pi/agent/chlamydomonos-agents/config.json
 *          工作区 <cwd>/.pi/chlamydomonos-agents/config.json
 *   旧路径 pi-agents.json 作为最低优先级回退(+ 迁移告警)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearConfigCache, loadConfig } from '../src/extension/config.js';

let home: string; // fake homeDir
let cwd: string; // fake workspace

beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'pi-agents-cfg-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'pi-agents-cfg-cwd-'));
    clearConfigCache();
});
afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
}

const globalNew = () => join(home, '.pi', 'agent', 'chlamydomonos-agents', 'config.json');
const workspaceNew = () => join(cwd, '.pi', 'chlamydomonos-agents', 'config.json');
const globalLegacy = () => join(home, '.pi', 'agent', 'pi-agents.json');
const workspaceLegacy = () => join(cwd, '.pi', 'pi-agents.json');

/** 收集警告 */
function load(): { cfg: ReturnType<typeof loadConfig>; warnings: string[] } {
    const warnings: string[] = [];
    const cfg = loadConfig(cwd, (m) => warnings.push(m), home);
    return { cfg, warnings };
}

describe('loadConfig 路径', () => {
    it('无文件:默认值且零告警', () => {
        const { cfg, warnings } = load();
        expect(cfg.model).toBe('');
        expect(cfg.maxHops).toBe(64);
        expect(warnings).toHaveLength(0);
    });

    it('读取新工作区路径', () => {
        writeJson(workspaceNew(), { model: 'p/m' });
        expect(load().cfg.model).toBe('p/m');
    });

    it('读取新全局路径', () => {
        writeJson(globalNew(), { model: 'g/m' });
        expect(load().cfg.model).toBe('g/m');
    });

    it('工作区覆盖全局', () => {
        writeJson(globalNew(), { model: 'g/m', maxHops: 10 });
        writeJson(workspaceNew(), { model: 'w/m' });
        const { cfg } = load();
        expect(cfg.model).toBe('w/m');
        expect(cfg.maxHops).toBe(10);
    });

    it('新路径优先于旧路径(同作用域)', () => {
        writeJson(workspaceLegacy(), { model: 'legacy/m' });
        writeJson(workspaceNew(), { model: 'new/m' });
        expect(load().cfg.model).toBe('new/m'); // 新的更高优先级
    });

    it('旧路径仍可读(回退)+ 迁移告警', () => {
        writeJson(workspaceLegacy(), { model: 'legacy/m' });
        const { cfg, warnings } = load();
        expect(cfg.model).toBe('legacy/m');
        expect(warnings.join('\n')).toContain('已弃用配置');
        expect(warnings.join('\n')).toContain(workspaceNew()); // 提示目标路径
    });
});
