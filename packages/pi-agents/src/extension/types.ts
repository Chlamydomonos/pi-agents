/**
 * pi-agents 作者契约类型(docs/10、docs/20)。
 *
 * 作者文件里 `import type { AgentDefinition } from '@chlamydomonos/pi-agents'`
 * 只做类型擦除,
 * 不产生运行时依赖;包 exports 指向本文件(纯类型)。运行时如需模块别名,
 * 装载器以 jiti alias 提供(docs/60 §2;旧名 `pi-agents` 仍兼容)。
 */

/* ------------------------------------------------------------------ */
/*  世界书(docs/10 §5,D8/D9/D10/D20)                                  */
/* ------------------------------------------------------------------ */

export type LorebookTarget = 'depth' | 'system';

export interface LorebookEntry {
    /** 注入目标:depth = 对话记录按深度插入(缺省);system = 系统提示词槽位插入 */
    target?: LorebookTarget;
    /** 深度:0 = 插在最新一条消息之前,1 = 再往前一条;越界则插到最前。仅 target:"depth" 需要给出;system 条目省略 */
    depth?: number;
    /** depth 条目:同深度排序键;system 条目:槽内排序键。小者在前;缺省按声明顺序 */
    order?: number;
    /** system 条目:插入 systemPrompt 列表第 slot 项之后(0 = 整个列表之前;缺省 = 列表末尾) */
    slot?: number;
    /** 注入内容 */
    content: string;
    /** depth 条目呈现角色;缺省 "user";system 条目无效 */
    role?: 'user' | 'assistant';
    /** 稳定标识(持久化判重/跨级去重);缺省 = content 的 sha1 前 12 位 */
    id?: string;
    /** 作者备注,不注入 */
    comment?: string;
}

/**
 * 世界书上下文。`messages` 的元素类型由 pi 宿主提供;作者侧视为不透明只读数组,
 * 因此这里用最小结构化约束(避免让纯类型文件依赖 pi 包)。
 */
export interface LorebookMessageLike {
    role: string;
    content: unknown;
    [key: string]: unknown;
}

/** 工作流运行上下文(docs/20 §6);作者侧投影,message 字段不展开 */
export interface FlowRunContext {
    flow: { name: string; title: string; meta: unknown };
    currentNode: string;
    /** 当前节点本次唤醒内的执行序号(从 1 起) */
    visit: number;
    wake: WakeContext;
    /** 已完成节点的输出轨迹(按执行顺序) */
    trail: Array<{ node: string; visit: number; text: string; data?: unknown }>;
    /** 便签桶(只读视图;修改走 route/transform/run 的 ctx) */
    scratch: Record<string, unknown>;
}

export interface LorebookContext {
    /** 触发本次注入的 Agent name(工作区级世界书用它筛选) */
    agent: string;
    /** 本次发给子会话的完整请求消息列表(注入前;只读) */
    messages: LorebookMessageLike[];
    /** 工作流运行上下文(工作流节点/subflow 内;独立 subagent 运行时为 null) */
    flow: FlowRunContext | null;
    /** Agent 定义 extra */
    extra: unknown;
    /** 子会话内第几次 LLM 请求(从 1 起) */
    requestIndex: number;
}

export interface LorebookSpec {
    /** 仅 depth 条目:是否持久化进子会话记录;缺省 false。system 条目恒动态重算 */
    persistent?: boolean;
    /** 静态条目:每次请求无条件评估(仍会经过 trigger 过滤) */
    entries?: LorebookEntry[] | ((ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>);
    /** 触发函数:返回本轮实际生效的条目;与 entries 的并集去重后注入 */
    trigger?: (ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>;
}

/* ------------------------------------------------------------------ */
/*  Agent 定义(docs/10 §2)                                             */
/* ------------------------------------------------------------------ */

export interface SubagentSpec {
    /** 引用的 Agent name 或工作流 name(同名冲突 → 装载 warning,Agent 优先) */
    name: string;
    /** 覆盖显示名 */
    title?: string;
    /** 附加指令,拼在该 subagent 子会话 systemPrompt 之后(仅 Agent 引用有效) */
    appendSystemPrompt?: string;
    /** 会话语义;仅 Agent 引用有效(工作流引用忽略);缺省取全局配置 subagentSession,再缺省 stateless(D7) */
    session?: 'stateless' | 'inherit';
}

export interface AgentDefinition {
    /** 全局唯一标识;[a-z][a-z0-9-]{0,63} */
    name: string;
    /** 显示名 */
    title: string;
    /** 一句话说明 */
    description: string;
    /** 系统提示词基座;字符串视为单元素列表;世界书 system 条目按槽位插入(10 §5.1) */
    systemPrompt: string | string[];
    /** 子会话物理模型,"provider/id" 格式;缺省走解析链(节点 > Agent > 配置 > pi 默认) */
    model?: string;
    /** 思考级别覆盖;解析链同上 */
    thinkingLevel?: ThinkingLevel;
    /** 工具白名单;缺省 = 无任何工具 */
    tools?: string[];
    /** 可调用的子代理(Agent 或工作流) */
    subagents?: (string | SubagentSpec)[];
    /** Agent 级世界书 */
    lorebook?: LorebookSpec;
    /** 作者自定义数据,透传到各回调 ctx.extra */
    extra?: unknown;
}

/* ------------------------------------------------------------------ */
/*  工作流定义(docs/20 §2)                                             */
/* ------------------------------------------------------------------ */

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** 节点执行统计(docs/20 §3.2 NodeRunStats) */
export interface NodeRunStats {
    durationMs: number;
    llmRequests: number;
    toolCalls: number;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** 节点输出(route/transform 的 out) */
export interface NodeOutput {
    /** 最终文本(Agent 节点 = 最终 assistant 文本;函数节点 = run 返回的 text) */
    text: string;
    /** Agent 节点最终 assistant 消息(不透明;函数节点为 undefined) */
    message?: unknown;
    /** 结构化产出(Agent 节点 = pass.transform 返回值;函数节点 = run 返回的 data) */
    data?: unknown;
    /** 本节点产出的图片(D21,docs/20 §9.1;Agent 节点恒空,函数节点 run 返回 images) */
    images?: NodeImage[];
    stats: NodeRunStats;
}

/** 图片块(结构与 pi-ai ImageContent 一致;纯类型文件不依赖宿主包,docs/20 §9.1) */
export interface ImageContent {
    type: 'image';
    /** base64 */
    data: string;
    mimeType: string;
}

/** 节点图片:块 + 来源工作区相对路径(readImage 自动记录;嵌图用它生成 markdown,docs/20 §9.1) */
export interface NodeImage {
    image: ImageContent;
    src?: string;
}

export interface WakeContext {
    /** 宿主本次唤醒的用户输入(纯文本;图片位置为 "[图片 xN]" 占位,真实图片在 images) */
    input: string;
    /** 宿主本次唤醒附带的图片块(D21;按上限过滤后;无附件 = [],docs/20 §9.3) */
    images: ImageContent[];
    /** 宿主 session id(会话池键) */
    hostSessionId: string;
    /** 本宿主 session 内第几次唤醒(从 1 起) */
    wakeIndex: number;
    /** 上一次唤醒的工作流最终输出 */
    lastOutput?: string;
}

export interface RouteContext {
    /** 该节点本轮是第几次被执行(该唤醒内,从 1 起) */
    visit: number;
    wake: WakeContext;
    /** 跨节点/跨轮共享便签桶(仅本次唤醒存活) */
    scratch: Record<string, unknown>;
    /** 工作流 meta 与节点 meta(flow.extra) */
    extra: unknown;
}

export type RouteFn = (out: NodeOutput, ctx: RouteContext) => string | Promise<string>;

/** 静态边目标或条件边对象(docs/20 §3.1/§5.1:pass 归属边,边级覆盖顶层) */
export type EdgeSpec =
    | string
    | {
          route: RouteFn;
          /** 该边限次:目标节点本次唤醒内被执行次数超 N → 温和结束(docs/20 §3.3) */
          maxIterations?: number;
          /** 该边的传递规则,覆盖工作流顶层 pass(docs/20 §5.1) */
          pass?: PassSpec | PassResolver;
          /**
           * 条件边静态展示候选(D24,仅展示):路由可能到达的节点键;
           * 装载校验成员合法性(pi-web 运行图画虚线候选),不影响执行。
           */
          targets?: string[];
      };

export interface FuncNodeInput {
    /** 上游交给本节点的内容(pass 加工后;入口节点 = initialInput 结果) */
    text: string;
    /** 上游结构化数据(pass.transform 的 data 通道;无则 undefined) */
    data?: unknown;
}

/** 工作区文件助手(函数节点 ctx.files,docs/20 §9.5;路径禁逃逸工作区,超限抛错) */
export interface FuncFileHelpers {
    /** 读图片为 ImageContent(mime 嗅探 png/jpeg/gif/webp;超 maxImageBytes 抛错;自动携带 src) */
    readImage(relPath: string): Promise<NodeImage>;
    /** 读文本文件(UTF-8;超过 1MiB 抛错) */
    readText(relPath: string): Promise<string>;
    /** 列目录(工作区相对路径;返回相对路径列表,目录不存在返回 []) */
    list(relDir: string): Promise<string[]>;
}

/**
 * 宿主会话消息的只读投影(docs/20 §2.2 ctx.host.messages)。
 * 形状同构 pi-ai 消息(纯类型文件不依赖宿主包,字段声明保持最小):
 * system 消息不进入投影;role 已知为 'user' | 'assistant' | 'toolResult';
 * content 为字符串或内容块数组(pi-ai 形态;按 type 窄化)。
 */
export type HostRole = 'user' | 'assistant' | 'toolResult';

/** 文本块(同构 pi-ai TextContent) */
export interface HostTextBlock {
    type: 'text';
    text: string;
}

/** 思维链块(同构 pi-ai ThinkingContent) */
export interface HostThinkingBlock {
    type: 'thinking';
    thinking: string;
}

/** 图片块(同构 pi-ai ImageContent;与本文件 ImageContent 一致) */
export interface HostImageBlock {
    type: 'image';
    /** base64 */
    data: string;
    mimeType: string;
}

/** 工具调用块(同构 pi-ai ToolCall;arguments 收窄为 Record) */
export interface HostToolCallBlock {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

/** 宿主消息内容块联合(按 type 窄化) */
export type HostContentBlock = HostTextBlock | HostThinkingBlock | HostImageBlock | HostToolCallBlock;

export interface HostMessageLike {
    role: HostRole;
    /** 字符串或内容块数组(pi-ai 形态);toolResult 恒为数组(TextContent | ImageContent) */
    content: string | HostContentBlock[];
}

/** 宿主会话只读视图(函数节点 ctx.host,docs/20 §2.2) */
export interface HostSessionView {
    /** 宿主 session id(= wake.hostSessionId) */
    sessionId: string;
    /** 本次唤醒序号(= wake.wakeIndex,从 1 起) */
    wakeIndex: number;
    /** 本次唤醒输入(= wake.input) */
    lastInput: string;
    /** 上一次唤醒的工作流最终输出(首唤醒无则 undefined) */
    lastOutput?: string;
    /**
     * 宿主会话完整消息列表(时间序,含本唤醒前的全部历史;**不含本次尚未落盘的引擎输出**;
     * 只读,修改无效也不抛错)。
     */
    messages: readonly HostMessageLike[];
}

export interface FuncNodeContext {
    /** 本节点本次唤醒内第几次执行(从 1 起) */
    visit: number;
    wake: WakeContext;
    /** 与 route/transform 共享的便签桶 */
    scratch: Record<string, unknown>;
    /** 节点所在 flow 的 meta */
    extra: unknown;
    /** 工作区文件助手(M8,docs/20 §9.5;图片进入流的主要入口) */
    files: FuncFileHelpers;
    /** 宿主会话只读视图(完整对话列表;docs/20 §2.2;仅引擎真实链路提供,测试/子流可缺省) */
    host: HostSessionView;
}

/** 函数节点返回:string = 最终文本;对象可带结构化 data 与图片(D21,docs/20 §9.1) */
export type FuncNodeResult = string | { text: string; data?: unknown; images?: unknown[] };

export interface NodeSpec {
    /** Agent 节点:引用的 Agent name(与 run 二选一) */
    agent?: string;
    /** 函数节点:纯 TS 处理函数(与 agent 二选一) */
    run?: (input: FuncNodeInput, ctx: FuncNodeContext) => FuncNodeResult | Promise<FuncNodeResult>;
    /** 本节点会话模式;缺省 fresh(D11);仅 Agent 节点有效 */
    sessionMode?: 'fresh' | 'inherit';
    /** 本节点模型覆盖;仅 Agent 节点有效 */
    model?: string;
    /** 本节点思考级别覆盖;仅 Agent 节点有效 */
    thinkingLevel?: ThinkingLevel;
    /** 覆盖/追加系统提示词(仅本节点身份);仅 Agent 节点有效 */
    appendSystemPrompt?: string;
    /** 节点标签;缺省 = 节点名 */
    label?: string;
    /**
     * 节点输出是否可见(仅 Agent 节点有效;缺省 true,docs/30 §3.1)。
     * true:输出先按 text 流式;若该节点非工作流终点,落定收口时纠偏为 thinking。
     * false:全部输出始终映射为 thinking;若该节点为工作流终点,直到输出彻底结束
     * 才一次性产生最终文本(不流式)。
     */
    outputVisible?: boolean;
}

export type PassTransform = (
    out: NodeOutput,
    ctx: { to: string; visit: number; wake: WakeContext; scratch: Record<string, unknown>; extra: unknown },
) =>
    | string
    | { userMessage?: string; data?: unknown; images?: ImageContent[] }
    | Promise<string | { userMessage?: string; data?: unknown; images?: ImageContent[] }>;

export type PassSpec =
    | { mode: 'text' }
    | { mode: 'none' }
    | { mode: 'template'; template: string }
    | { mode: 'custom'; transform: PassTransform }
    /** 文本照旧 + 附带转发上游产出图片到下游 prompt(docs/20 §9.4;其余 mode 不转发) */
    | { mode: 'text'; images: 'forward' };

/** pass 解析器:按 (下游节点, 下游 visit) 动态给 PassSpec */
export type PassResolver = (to: string, visit: number) => PassSpec | undefined;

export interface FlowDefinition {
    /** 虚拟模型 id 用它:pi-workflows/<name>;[a-z][a-z0-9-]{0,63} */
    name: string;
    /** /model 列表显示名 */
    title: string;
    /** 一句话说明 */
    description: string;
    /** ≥1 个节点;键 = 节点名(工作流内唯一,[A-Za-z][A-Za-z0-9_-]{0,63};允许大写驼峰如 parseReview) */
    nodes: Record<string, NodeSpec>;
    /** 入口节点名,必须存在于 nodes */
    entry: string;
    /** 每个节点的出边声明(终点节点可缺省键) */
    edges: Record<string, EdgeSpec>;
    /** 顶层默认 pass(边级 pass 覆盖) */
    pass?: PassSpec | PassResolver;
    /** 工作流级世界书(10 §5.2 三级合并) */
    lorebook?: LorebookSpec;
    /** 入口节点输入加工;缺省 = 宿主本次唤醒的用户输入文本 */
    initialInput?: (wake: WakeContext) => string | Promise<string>;
    /** 作者自定义数据,透传 ctx.extra */
    meta?: unknown;
}

/* ------------------------------------------------------------------ */
/*  工作区级世界书(docs/10 §5,lorebooks/*.ts)                          */
/* ------------------------------------------------------------------ */

export interface WorkspaceLorebook {
    /** 静态条目(可按 ctx.agent 筛选) */
    entries?: LorebookEntry[] | ((ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>);
    /** 触发函数;与 entries 并集去重后注入 */
    trigger?: (ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>;
}

/* ------------------------------------------------------------------ */
/*  名称规则(装载器共用)                                               */
/* ------------------------------------------------------------------ */

export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
