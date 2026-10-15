/**
 * 作者目录脚手架(docs/50 §1、docs/60 §2),由 Pi 命令 `/agent-init` 调用:
 *   1. 建立 `<base>/chlamydomonos-agents/{agents,agent-flows,lorebooks}/`;
 *   2. 生成 `tsconfig.json`(把该目录当作独立 TS 工程,含 paths 映射);
 *   3. 生成 `pi-agents.d.ts`(把作者契约包名 `@chlamydomonos/pi-agents` 指向本包
 *      types.ts)——这样即使没有 npm 安装本包,编辑器也能给出补全与类型检查。
 *
 * 运行时装载不依赖这些文件(jiti 有自己的 alias,见 loader/load.ts);
 * 它们纯粹服务于「编写期 DX」,可重复运行,幂等。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 目录契约(docs/00 §4):chlamydomonos-agents 下的三个子目录 */
export const AGENT_SUBDIRS = ['agents', 'agent-flows', 'lorebooks'] as const;
export const TS_CONFIG_NAME = 'tsconfig.json';
export const TYPES_SHIM_NAME = 'pi-agents.d.ts';

export interface ScaffoldOptions {
    /** 目标 `chlamydomonos-agents` 目录的绝对路径 */
    baseDir: string;
    /** 本包作者契约 types.ts 的绝对路径(与 jiti alias 同源) */
    typesPath: string;
}

export interface ScaffoldResult {
    baseDir: string;
    /** 本次新写/改写的文件(相对 baseDir) */
    created: string[];
    /** 已存在且无需变更因而跳过的文件(相对 baseDir) */
    skipped: string[];
}

/** 生成的 tsconfig.json 内容(独立工程 + 包名 paths 映射) */
export function renderTsconfig(): string {
    const cfg = {
        compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022'],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            verbatimModuleSyntax: true,
            isolatedModules: true,
            forceConsistentCasingInFileNames: true,
            // 不设 baseUrl(TS 6 已弃用);paths 相对本 tsconfig 解析
            paths: {
                '@chlamydomonos/pi-agents': [`./${TYPES_SHIM_NAME}`],
                // 旧包名兼容(仍可用,但建议迁移到上面的作用域名)
                'pi-agents': [`./${TYPES_SHIM_NAME}`],
            },
        },
        include: ['agents/**/*.ts', 'agent-flows/**/*.ts', 'lorebooks/**/*.ts', TYPES_SHIM_NAME],
    };
    return `${JSON.stringify(cfg, null, 4)}\n`;
}

/** 生成的 pi-agents.d.ts 内容:把包名再导出到本包 types.ts(相对路径,便于随仓库移动) */
export function renderTypesShim(typesPath: string, shimDir: string): string {
    const rel = relative(shimDir, typesPath)
        .replace(/\\/g, '/') // Windows 分隔符 → POSIX(tsconfig 里始终用 /)
        .replace(/\.ts$/, '');
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    return [
        '// 自动生成 by pi-agents /agent-init —— 请勿手改(重新生成:/agent-init)。',
        '// 作用:把作者契约包名指向本包 types.ts,使编辑器在未安装本包时也能给出类型提示。',
        `export * from '${spec}';`,
        '',
    ].join('\n');
}

/** 幂等建立目录 + 生成 tsconfig/shim。已存在且内容一致的文件不重复写。 */
export function scaffoldAgentsDir(opts: ScaffoldOptions): ScaffoldResult {
    const { baseDir } = opts;
    mkdirSync(baseDir, { recursive: true });
    for (const sub of AGENT_SUBDIRS) mkdirSync(join(baseDir, sub), { recursive: true });

    const created: string[] = [];
    const skipped: string[] = [];

    const writeIfChanged = (name: string, content: string): void => {
        const path = join(baseDir, name);
        if (existsSync(path) && readFileSync(path, 'utf8') === content) {
            skipped.push(name);
            return;
        }
        writeFileSync(path, content);
        created.push(name);
    };

    // tsconfig:尊重用户已有内容(只补不覆盖);缺失才生成
    const tsconfigPath = join(baseDir, TS_CONFIG_NAME);
    if (existsSync(tsconfigPath)) skipped.push(TS_CONFIG_NAME);
    else {
        writeFileSync(tsconfigPath, renderTsconfig());
        created.push(TS_CONFIG_NAME);
    }

    // shim:命令托管,内容随本包类型路径变化 → 每次校验,变了才写
    writeIfChanged(TYPES_SHIM_NAME, renderTypesShim(opts.typesPath, baseDir));

    return { baseDir, created, skipped };
}
