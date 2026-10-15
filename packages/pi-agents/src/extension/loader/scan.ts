/**
 * 目录扫描与覆盖(docs/40 §2.1):
 *   两级目录并集:全局 ~/.pi/agent/chlamydomonos-agents/{agents,agent-flows,lorebooks}
 *              + 工作区 <cwd>/.pi/chlamydomonos-agents/{agents,agent-flows,lorebooks}
 *   .ts/.js 单文件,或含 index.ts/index.js 的目录(一层);先全局后工作区,后装载者同名覆盖。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Kind = 'agents' | 'agent-flows' | 'lorebooks';

export interface ScanEntry {
    /** 装载入口文件(单文件自身,或目录内 index.ts/index.js) */
    filePath: string;
    kind: Kind;
    /** 全局 = false,工作区 = true(同名覆盖全局) */
    workspace: boolean;
    /** 判重键:Agent/Flow = 相对 kinds 目录的来源名(文件名去扩展或目录名);lorebook = 相对路径 */
    sourceName: string;
}

const ENTRY_FILE = /\.(ts|js)$/i;
const INDEX_RE = /^index\.(ts|js)$/i;

function scanKindDir(dir: string, kind: Kind, workspace: boolean): ScanEntry[] {
    let entries: import('node:fs').Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return []; // 目录不存在 → 空
    }
    const out: ScanEntry[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = join(dir, e.name);
        if (e.isFile() && ENTRY_FILE.test(e.name)) {
            out.push({ filePath: full, kind, workspace, sourceName: e.name.replace(/\.(ts|js)$/i, '') });
        } else if (e.isDirectory()) {
            // 目录形式:必须直接含 index.ts/index.js(一层,不递归其他深度)
            const indexTs = join(full, 'index.ts');
            const indexJs = join(full, 'index.js');
            const index = existsSync(indexTs) ? indexTs : existsSync(indexJs) ? indexJs : null;
            if (index !== null) {
                out.push({ filePath: index, kind, workspace, sourceName: e.name });
            }
        }
    }
    return out;
}

export interface ScanRoots {
    homeDir: string;
    cwd: string;
    /** 目录名(docs/00 §4):chlamydomonos-agents */
    agentDirName: string;
}

export function defaultScanRoots(cwd: string, homeDir: string = homedir()): ScanRoots {
    return { homeDir, cwd, agentDirName: 'chlamydomonos-agents' };
}

function kindDir(root: ScanRoots, kind: Kind, workspace: boolean): string {
    const base = workspace
        ? join(root.cwd, '.pi', root.agentDirName)
        : join(root.homeDir, '.pi', 'agent', root.agentDirName);
    return join(base, kind);
}

/**
 * 全量扫描。返回按装载顺序排列的条目(先全局后工作区,kind 顺序 agents → agent-flows → lorebooks)。
 * 覆盖判定交给调用方(按 kind + sourceName 去重,后装载者胜)。
 */
export function scanAll(root: ScanRoots): ScanEntry[] {
    const kinds: Kind[] = ['agents', 'agent-flows', 'lorebooks'];
    const out: ScanEntry[] = [];
    for (const workspace of [false, true]) {
        for (const kind of kinds) {
            out.push(...scanKindDir(kindDir(root, kind, workspace), kind, workspace));
        }
    }
    return out;
}

/** mtime(装载缓存用);文件不存在返回 0 */
export function statMtimeMs(filePath: string): number {
    try {
        return statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}
