// 示例工作流:三节点带环 + 汇总终点(docs/20 §8 完整示例)
// 规划 → 实现 → 评审 → parseReview(函数节点解析 JSON)→ 通过则 wrap,否则带意见回实现(≤4 轮)。
// 要点(docs/50 §3.2/§3.4):评审员 fresh、实现者 inherit、总结者 fresh;LGTM 信号 + 缺省走向(解析失败 → 视为未通过回环由 maxIterations 兜底)。
import type { FlowDefinition } from '@chlamydomonos/pi-agents';

export default {
    name: 'dev-loop',
    title: '开发循环',
    description: '规划 → 实现 → 评审;通过则汇总,否则带意见回到实现(≤4 轮)',
    nodes: {
        plan: { agent: 'planner', sessionMode: 'inherit', label: '规划' },
        code: { agent: 'coder', sessionMode: 'inherit', label: '实现' },
        review: { agent: 'reviewer', sessionMode: 'fresh', label: '评审' },
        // 函数节点:从评审输出中抓取 JSON 解析为结构化数据,供 route 消费;解析失败 data=null
        parseReview: {
            run: (input) => {
                try {
                    return { text: input.text, data: JSON.parse(input.text.match(/\{[\s\S]*\}/)?.[0] ?? '{}') };
                } catch {
                    return { text: input.text, data: null };
                }
            },
        },
        wrap: { agent: 'notetaker', sessionMode: 'fresh', label: '总结' },
    },
    entry: 'plan',
    // 顶层默认 pass(所有边缺省时用):模板带轮次与评审意见文本;{{text}} = 直接上游(parseReview)输出
    pass: { mode: 'template', template: '上一节点输出(第 {{visit}} 轮):\n{{text}}' },
    edges: {
        plan: 'code',
        code: 'review',
        review: 'parseReview',
        parseReview: {
            // 路由看结构化信号优先,文本 LGTM 兜底;解析失败(text 亦无 LGTM)回 code,由 maxIterations 防失控
            route: (out) =>
                out.data !== null && (out.data as { pass?: boolean }).pass === true
                    ? 'wrap'
                    : out.text.includes('LGTM')
                      ? 'wrap'
                      : 'code',
            maxIterations: 4, // 约束的是目标节点 code
            // 静态展示候选(D24,仅展示):评审后或回 code、或去 wrap、或 done 汇出
            targets: ['code', 'wrap', 'done'],
        },
    },
    // 工作流级世界书:对全部节点子会话生效(与 Agent 级/工作区级合并,Agent 优先,10 §5.2)
    lorebook: {
        entries: [
            {
                depth: 1,
                content: '流程约束:规划只产任务清单不改代码;实现每轮必须跑测试;评审只评审不修码。',
                comment: 'dev-loop 全节点',
            },
        ],
    },
} satisfies FlowDefinition;
// wrap 无出边 = 终点;其最终文本 = dev-loop 的输出
