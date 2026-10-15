// 示例 Agent:规划者——dev-loop 工作流的 plan 节点,也是「多专家编排」样例(docs/10 §8)
// 设计要点:
//   - inherit 会话:跨轮维护任务清单(docs/50 §2.4 表:规划者需要记住"说到哪了")
//   - subagents 三种形态各演示一次:字符串引用、对象覆盖、工作流引用(10 §6.1)
//   - Agent 级世界书:trigger 演示「首轮注入 + 每 5 轮提醒」(depth 条目,requestIndex)
import type { AgentDefinition } from '@chlamydomonos/pi-agents';

export default {
    name: 'planner',
    title: '规划者',
    description: '把需求拆解为任务清单,可派发 coder/reviewer 子代理或整段 dev-loop 工作流',
    systemPrompt: `你是规划者。把用户需求拆成带验收标准的小任务,逐项派发给子代理,并汇总结果。
维护任务清单(编号/状态/验收标准)。每次回复结尾用一行 "NEXT: <任务描述或 DONE>" 说明下一步。`,
    tools: ['read', 'ls', 'grep'],
    subagents: [
        'coder', // 字符串引用
        { name: 'reviewer', appendSystemPrompt: '只关注正确性,不管风格。' }, // 对象覆盖
        { name: 'dev-loop', title: '跑一遍完整开发循环' }, // 工作流引用(subflow 唤醒)
    ],
    lorebook: {
        persistent: false,
        trigger: (ctx) => {
            // 首轮注入项目结构说明;此后每 5 轮提醒输出格式(10 §5.3:非持久化,每请求重算)
            if (ctx.requestIndex === 1) {
                return [
                    {
                        depth: 0,
                        content: '项目结构:<此处由你的函数读取文件系统生成,例如 ls + 关键 README 摘要>',
                        comment: '首轮上下文',
                    },
                ];
            }
            if (ctx.requestIndex % 5 === 0) {
                return [{ depth: 0, content: '提醒:回复结尾必须有 NEXT: 行。', comment: '格式提醒' }];
            }
            return [];
        },
    },
} satisfies AgentDefinition;
