// 示例工作流:单节点(docs/50 §1.3 最小例子)
// 与 notetaker 的「持久对话」:每次唤醒都执行 main,sessionMode inherit 使多轮记忆生效。
// /model 选 pi-workflows/notes 后直接对话即可。
import type { FlowDefinition } from '@chlamydomonos/pi-agents';

export default {
    name: 'notes',
    title: '纪要',
    description: '与纪要员对话:每句话被整理为结构化纪要',
    nodes: { main: { agent: 'notetaker', sessionMode: 'inherit' } },
    entry: 'main',
    edges: {}, // 无出边 = 执行 main 后即终点
} satisfies FlowDefinition;
