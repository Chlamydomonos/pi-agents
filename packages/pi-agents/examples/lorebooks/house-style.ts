// 示例工作区级世界书(docs/10 §5 三级来源之「工作区级」;docs/50 §4.4)
// 放在 <工作区>/.pi/chlamydomonos-agents/lorebooks/ 下,自动对**全部**子会话生效;
// 没有所属 Agent,用 ctx.agent 自己做筛选(本例:只给 coder*/reviewer* 注入仓库规范)。
// target:"system" + slot:0 → 插进每个相关 Agent 系统提示词列表最前面(10 §5.1),
// 稳定规范进 system 有 provider 前缀缓存优势;每请求重算、不持久化。
import type { WorkspaceLorebook } from '@chlamydomonos/pi-agents';

export default {
    entries: (ctx) =>
        ctx.agent.startsWith('coder') || ctx.agent.startsWith('reviewer')
            ? [
                  {
                      target: 'system',
                      slot: 0, // 插在 systemPrompt 列表第 0 项之前 = 整个列表之前
                      content: '本仓库规范:缩进 4 空格;错误必须带上下文前缀;禁止新增依赖而不说明理由。',
                      comment: '仓库硬性规范(工作区级)',
                  },
              ]
            : [],
} satisfies WorkspaceLorebook;
