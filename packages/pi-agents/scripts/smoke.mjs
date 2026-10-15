/**
 * 离线冒烟(docs/60 §4.2 M1 部分):装载 examples + 校验器自检,不发 LLM 请求。
 * 运行:npm run smoke(即 node scripts/smoke.mjs)
 *
 * 注:examples 是平铺的 examples/{agents,agent-flows,lorebooks} 布局,不经过
 * scanAll 的 .pi/ 目录拼接;完整「目录扫描 + 覆盖 + 环检测」路径由 vitest
 * 单测(test/loader.spec.ts)的 fixture 目录覆盖。本脚本验证:
 *   1) 真实默认根装载可用(空目录 = 零装载、零 invalid);
 *   2) 每个示例文件能被 jiti 装载且结构校验通过(import type 'pi-agents' 的
 *      alias 兜底即在此路径上被真实练习)。
 */
import { createJiti } from 'jiti';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { cache: false });

const { defaultRoots, loadAll } = await jiti.import(join(pkgRoot, 'src/extension/loader/load.ts'));
const { validateAgent, validateFlow, validateWorkspaceLorebook } = await jiti.import(
    join(pkgRoot, 'src/extension/loader/validate.ts'),
);

let failures = 0;
const check = (label, ok, detail = '') => {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
};

// 1) 真实默认根(~/.pi/agent/chlamydomonos-agents + <cwd>/.pi/chlamydomonos-agents)
const realResult = await loadAll(defaultRoots(process.cwd(), homedir()), (m) => console.log(`  warn: ${m}`));
console.log(
    `[smoke] 真实默认根: ${realResult.agents.length} agent(s), ${realResult.flows.length} flow(s), ` +
        `${realResult.lorebooks.length} lorebook(s), ${realResult.invalid.length} invalid, ${realResult.warnings.length} warning(s)`,
);
check('真实默认根装载无 invalid', realResult.invalid.length === 0, JSON.stringify(realResult.invalid));

// 2) examples 逐文件装载 + 校验(7 个示例必须全通过)
const kinds = [
    ['agents', validateAgent],
    ['agent-flows', validateFlow],
    ['lorebooks', validateWorkspaceLorebook],
];
let loaded = 0;
for (const [kind, validate] of kinds) {
    const dir = join(pkgRoot, 'examples', kind);
    let files = [];
    try {
        files = readdirSync(dir).filter((f) => /\.(ts|js)$/i.test(f));
    } catch {
        /* 目录不存在 → 跳过 */
    }
    for (const file of files) {
        const filePath = join(dir, file);
        try {
            const mod = await jiti.import(filePath);
            const out = validate(mod, filePath);
            const invalid = out !== null && typeof out === 'object' && Array.isArray(out.reasons);
            check(`examples/${kind}/${file}`, !invalid, invalid ? out.reasons.join('; ') : '');
            if (!invalid) loaded++;
        } catch (error) {
            check(`examples/${kind}/${file}`, false, error instanceof Error ? error.message : String(error));
        }
    }
}
check('examples 全部装载且校验通过(7 个)', loaded === 7, `期望 7,实际 ${loaded}`);

console.log(failures === 0 ? '\n[smoke] 全部通过 ✔' : `\n[smoke] ${failures} 项失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
