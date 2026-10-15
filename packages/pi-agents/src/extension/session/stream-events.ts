/**
 * 子会话事件透传包(docs/30 §3/§3.2/§3.3)。
 *
 * run-node 的 subscribe 回调把子会话原始事件压缩成少量「透传包」,
 * stream 层按规则映射为虚拟模型流事件:
 *   - thinking delta → thinking_delta(带来源前缀【label #visit > …】);
 *   - 中间节点 text delta → thinking_delta(§3.1);
 *   - 终点节点 text delta → text_delta(M4 预估:首个 Agent 节点;结果回补纠偏);
 *   - 工具调用 → 占位 agents_tool 透传包(§4,D14);
 *   - 工具结果 → thinking 摘要行 ✓/✗(§3.3)。
 *
 * 前缀在进入新「来源」时插入一次(§3.2),不逐 delta 重复;
 * sourceKey = 节点身份,sourceLabel = 【…】内文本。
 */

import type { JsonObject } from '@earendil-works/pi-ai';

/** 单个透传包 */
export type NodeEvent =
    /** 进入新节点:stream 层据此换前缀;fnNode = 函数节点(runner 已自行发状态行,透传层忽略) */
    | { kind: 'node-start'; nodeKey: string; label: string; visit: number; isAgent: boolean }
    /** 子会话内逐字思考流(已带换行语义的原文增量) */
    | { kind: 'thinking-delta'; sourceKey: string; sourceLabel: string; delta: string }
    /** 子会话内逐字文本流(中间节点 → thinking;终点节点 → text,由 isTerminal 标注) */
    | {
          kind: 'text-delta';
          sourceKey: string;
          sourceLabel: string;
          delta: string;
          isTerminal: boolean;
          /** 本节点 outputVisible 配置(缺省 true;segmenter 据此分流 text/thinking) */
          outputVisible?: boolean;
          /** 所属节点键(收口纠偏时与终点节点比对用) */
          nodeKey?: string;
      }
    /** 子会话真实工具调用 → 占位 agents_tool 调用(§4) */
    | { kind: 'tool-call'; sourceKey: string; sourceLabel: string; toolCall: PlaceholderToolCall }
    /** 子会话 ask_user 调用 → 宿主真实 ask_user 调用(宿主执行 pi-web 本体,浏览器弹表单) */
    | { kind: 'ask-user'; sourceKey: string; sourceLabel: string; ask: AskUserPayload }
    /** 子会话工具结果摘要行(§3.3;不含在 thinking 块内的场合由 stream 层决定) */
    | { kind: 'tool-result'; sourceKey: string; sourceLabel: string; line: string }
    /** 节点最终文本就绪(结果回补:首个 Agent 节点曾按终点流式,若非工作流终点需纠偏) */
    | { kind: 'node-text'; nodeKey: string; text: string; isFlowTerminal: boolean };

/** 占位工具调用参数(docs/30 §4.2:真实名+参数内嵌 agents_tool arguments) */
export interface PlaceholderToolCall {
    /** 执行该工具的节点标注(agents_tool.agent) */
    agent: string;
    /** 真实工具名(agents_tool.tool) */
    tool: string;
    /** 真实调用参数(agents_tool.arguments;超大截断,§4.3) */
    arguments: JsonObject;
    /** 参数是否被截断(§4.3;>32KiB) */
    truncated: boolean;
}

/** 占位工具固定名(docs/30 §4.2:惰性固定集) */
export const PLACEHOLDER_TOOL_NAME = 'agents_tool';

/**
 * ask_user 真实透传工具名:pi-web 在宿主 session 注册的提问工具。
 * 子会话内的同名桥接工具(见 run-node)只把参数原样上抛;真实执行发生在
 * 宿主 agent loop——宿主把该调用写进宿主 transcript 并执行 pi-web 本体,
 * 浏览器才能渲染提问表单(pi-web 按 transcript 里 toolName==='ask_user' 的
 * toolResult details.ask 渲染/回查)。因此这类调用不发占位 agents_tool。
 */
export const ASK_USER_TOOL_NAME = 'ask_user';

/** ask_user 单个选项(与 pi-web AskUserOptionParams 对齐;形状校验在桥接工具参数 schema) */
export interface AskUserOptionPayload {
    value: string;
    label: string;
    detail?: string;
}

/** ask_user 单个问题(与 pi-web AskUserQuestionParams 对齐) */
export interface AskUserQuestionPayload {
    id: string;
    question: string;
    detail?: string;
    options?: AskUserOptionPayload[];
    multiple?: boolean;
}

/** ask_user 调用载荷(questions 原样上抛;形状由桥接工具 schema 保证) */
export interface AskUserPayload {
    questions: AskUserQuestionPayload[];
}

/** pi-web ask_user 成功结果文案(与 askUserTool.postedText 同义;宿主执行时以 pi-web 本体为准) */
export const ASK_USER_POSTED_TEXT =
    '问题已提交给用户;回答将作为后续消息送达(可能包含未回答的题)。不要重复提交这些问题。';

/** 占位工具返回固定文案(docs/30 §4.1) */
export const PLACEHOLDER_RESULT_TEXT = '该工具已在工作流内部真实执行完毕;此结果仅为占位,无需处理。';

/** 参数序列化上限:超过即截断为 {truncated,bytes,preview}(docs/30 §4.3) */
export const TOOL_ARGS_LIMIT = 32 * 1024;

/** 截断预览长度(§4.3 preview) */
const PREVIEW_CHARS = 400;

/**
 * 真实工具调用 → 占位 agents_tool 参数(§4.2/§4.3)。
 * 序列化 > 32KiB → {truncated:true, bytes, preview}。
 */
export function wrapToolArguments(tool: string, rawArgs: unknown, agentLabel: string): PlaceholderToolCall {
    let json: JsonObject;
    try {
        json = (rawArgs ?? {}) as JsonObject;
    } catch {
        json = {};
    }
    let text: string;
    try {
        text = JSON.stringify(json) ?? '';
    } catch {
        text = '';
    }
    if (text.length > TOOL_ARGS_LIMIT) {
        return {
            agent: agentLabel,
            tool,
            arguments: {
                truncated: true,
                bytes: text.length,
                preview: text.slice(0, PREVIEW_CHARS),
            },
            truncated: true,
        };
    }
    return { agent: agentLabel, tool, arguments: json, truncated: false };
}

/**
 * 来源前缀(docs/30 §3.2):「【label #visit】」;层级用「 > 」连接由调用方拼 label。
 * prefixes 关闭(全局配置 streamPrefixes:false)→ 返回空串。
 */
export function sourcePrefix(label: string, visit: number, prefixes: boolean): string {
    if (!prefixes) return '';
    return `【${label} #${visit}】`;
}

/** 工具结果摘要行(docs/30 §3.3):成功 ✓ / 失败 ✗ */
export function toolResultLine(tool: string, ok: boolean, detail: string): string {
    return ok ? `✓ ${tool} (${detail})` : `✗ ${tool}: ${detail}`;
}
