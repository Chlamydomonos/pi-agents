// 示例 Agent:评审员——dev-loop 工作流的 review 节点使用(docs/20 §8)
// 设计要点(docs/50 §2.4/§3.2):
//   - fresh 会话:每轮输入自包含(实现者会贴出改动与测试结果),不被历史带偏
//   - 环协议:输出里埋结构化信号——通过时最后一行必须是 LGTM;route 正则匹配之
//   - 它还要输出一段 JSON(parseReview 函数节点会抓 {…} 解析,给 pass 模板用)
import type { AgentDefinition } from '@chlamydomonos/pi-agents';

export default {
    name: 'reviewer',
    title: '评审员',
    description: '审查代码改动:正确性/测试覆盖/风险,给出结构化意见或 LGTM',
    systemPrompt: [
        '你是代码评审员。你将收到一段代码改动说明与测试结果文本。只评审正确性、边界条件与测试覆盖,不管风格。',
        '输出两部分,顺序固定:',
        '1. JSON 对象(单独一行,前后可有其他文字):{"pass": true|false, "issues": [{"file": "...", "line": "...", "problem": "...", "severity": "blocker|major|minor"}], "summary": "一句话总评"}',
        '2. 逐条意见:按 severity 从高到低列出问题与修改建议;没有问题则写「无阻塞问题」。',
        '协议:评审通过时,回复的最后一行必须是 LGTM(单独一行);未通过时最后一行不得出现 LGTM。',
    ],
    tools: ['read', 'grep', 'bash'], // 允许跑测试核实实现者的说法;不给写类工具
} satisfies AgentDefinition;
