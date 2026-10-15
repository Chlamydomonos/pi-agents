# 10 — Agent 定义与 Subagent

> 本篇定义 Agent 定义文件的完整契约:模块结构、字段、三级世界书(Agent/工作流/工作区)与系统提示词构成、Subagent 引用;会话生命周期模式属工作流节点(§7)。
> 前置阅读:00-总览(D3/D6/D7/D8/D9/D10/D11)。装载与错误处理见 40 §2。

## 1. 位置与命名(D2/D3)

```
chlamydomonos-agents/
├── agents/
│   ├── reviewer.ts             # 单文件 Agent
│   └── coder/
│       ├── index.ts            # 目录形式 Agent:入口 index.ts
│       └── prompts.ts          # 允许被相对 import 的辅助模块
└── lorebooks/
    └── house-style.ts          # 工作区级世界书(自动对全部子会话生效,见 §5)
```

- 全局:`~/.pi/agent/chlamydomonos-agents/`(agents/ 与 lorebooks/);工作区:`<工作区>/.pi/chlamydomonos-agents/`;工作区同名覆盖全局(Agent 以导出 `name` 判重,不以文件名;世界书以文件相对路径判重)。
- jiti 直载 TS;允许 `import`(npm 依赖、相对模块、类型导入)。**没有** import 禁令(与 pi-comfyui 生成器不同——Agent 定义逻辑复杂,自包含不现实;信任模型 = 与 pi 扩展同进程同权限,用户可信代码)。
- 装载时机:`session_start`(startup/reload)全量扫描;每次实际使用前按 mtime 校验缓存(见 40 §2)。修改后 `/reload` 或下次使用自动生效。

## 2. 模块契约

最小骨架:

```ts
// reviewer.ts
import type { AgentDefinition } from '@chlamydomonos/pi-agents'; // 仅类型;运行时由扩展提供

export default {
    name: 'reviewer',
    title: '代码评审员',
    description: '评审当前工作区改动的代码,输出问题清单与修改建议',

    // 系统提示词:字符串或字符串列表(列表 \n\n 连接;实际提示词 = 列表 + 世界书 system 条目按槽位插入,§5.1)
    systemPrompt: ['你是资深代码评审员。逐文件审查,只报告真实问题。', '输出格式:按严重度分组的 Markdown 清单。'],

    tools: ['read', 'grep', 'ls'], // 工具白名单(见 §4)
    subagents: [], // 可调用的子代理(见 §6)

    // 世界书注入(可选,见 §5)
    lorebook: {
        persistent: false,
        entries: (ctx) => [{ depth: 1, content: `当前评审标准版本:v3\n输出格式:按严重度分组` }],
    },

    // 可选:本 Agent 默认物理模型(可被工作流节点覆盖,见 §3.1)
    model: 'anthropic/claude-sonnet-4-5',
} satisfies AgentDefinition;
```

### 2.1 字段总表

| 字段           | 类型                       | 必需 | 说明                                                                                                                                    |
| -------------- | -------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | string                     | 是   | 全局唯一标识;`[a-z][a-z0-9-]{0,63}`;引用(subagents、工作流节点)都用它                                                                   |
| `title`        | string                     | 是   | 显示名(`/agent-usage` 报表、错误信息)                                                                                                   |
| `description`  | string                     | 是   | 一句话说明(工作流作者与 `/agent-usage` 展示)                                                                                            |
| `systemPrompt` | string \| string[]         | 是   | 子会话系统提示词基座;字符串视为单元素列表,列表 \n\n 连接;**整段替换** pi 默认 system prompt(D10);世界书 system 条目按槽位插入其中(§5.1) |
| `model`        | string                     | 否   | 该 Agent 子会话物理模型,`"provider/id"` 格式;缺省 = 回退解析链(§3.1)。仅物理模型,不可指向工作流虚拟模型                                 |
| `tools`        | string[]                   | 否   | 工具白名单;缺省 = 无任何工具(纯文本推理)。内置工具名(read/bash/edit/write/grep/find/ls)与扩展注册的工具名均可                           |
| `subagents`    | (string \| SubagentSpec)[] | 否   | 可调用的子代理;字符串 = 名字引用,对象 = 带覆盖(§6)                                                                                      |
| `lorebook`     | LorebookSpec               | 否   | Agent 级世界书(§5;另有工作流级/工作区级,三级自动合并)                                                                                   |
| `extra`        | unknown                    | 否   | 作者自定义数据,运行时原样透传到各回调的 ctx.def.extra,便于复杂 Agent 自带配置                                                           |

### 2.2 校验规则

装载器校验(不过 → 跳过该文件,warning 带文件路径与原因):

- default 导出为对象;`name`/`title`/`description` 为非空字符串,name 匹配模式;`systemPrompt` 为非空字符串**或非空字符串数组**(数组每项均为非空字符串)。
- `tools` 每项为字符串(装载期**不**校验工具是否真实存在——工具集随宿主会话变化;运行期按可用集取交集,见 §4)。
- `subagents` 每项为字符串或对象(对象须含 `name`);引用名字在**全量装载完成后**做一次引用检查(悬空引用 → warning,该 subagent 条目忽略)。
- `lorebook.entries`、`lorebook.trigger` 为函数;`persistent` 为布尔;条目 `target` ∈ {"depth","system"}(缺省 depth)、`slot` 为非负整数;depth 条目必须给 `depth` 数值,system 条目的 `depth`/`role` 无效。
- `model` 为 `"provider/id"` 形式字符串(装载期不校验存在性——模型目录随凭据变化;运行期解析失败见 10 §3.1)。
- 循环引用检查:subagent **引用图**(Agent→subagent 边 + 工作流节点→Agent 边 + subagent→工作流 边,见 §6.1)不允许成环;装载期 DFS 检测,环上成员全部判无效(合并见 40 §2.3)。**注**:工作流图允许环,但引用图不允许——subagent 是树状委派。

## 3. 子会话形态(实现契约)

每个 Agent 运行在一个由扩展创建的子会话中(SDK `createAgentSession`),关键配置:

| 配置              | 值                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `sessionManager`  | `SessionManager.inMemory(cwd)`(fresh);inherit 复用上一轮的 manager(40 §3)                             |
| `settingsManager` | `SettingsManager.inMemory({...})`:关闭 compaction 之外的干扰项;不携带宿主模型选择(模型走 §3.1 解析链) |
| model             | 按 §3.1 解析链确定的物理模型                                                                          |
| systemPrompt      | resourceLoader 每请求计算:systemPrompt 列表 + 三级世界书 system 条目按槽位插入(§5.1)                  |
| tools             | `tools` 白名单 ∩ 宿主可用工具 + 本 Agent 的 subagent 工具(spawn\_\*,§6)+ 世界书无需工具               |
| extensions        | inline extensions:世界书注入器(§5)+ 透传监听器(30 §3)                                                 |

- 子会话对宿主完全不可见(不出现在 `/session` 列表;不落盘,除非 lorebook.persistent 开启的条目走 custom_message 落在**子会话**自己的 in-memory 记录中)。
- 子会话中 Agent 的工具调用与工具结果都进入子会话自身上下文(Agent 自主多轮);这些内容**不**进宿主上下文。

### 3.1 模型与思考级别解析链

子会话的物理模型按以下优先级取第一个非空者:

1. **工作流节点**(NodeSpec.model,20 §2.2,仅工作流节点身份时)
2. **Agent 定义**(AgentDefinition.model)
3. **全局配置**(40 §11 的 `model`)
4. pi 全局默认模型(settings 默认)

`thinkingLevel` 同链路(节点 > Agent > 配置 > medium)。解析在节点执行前完成;`provider/id` 无法在模型目录中找到 → 工作流节点判运行期错误(error 流,提示检查拼写/凭据),subagent 调用返回 isError。

### 3.2 子会话其余约定

子会话对宿主完全不可见(不出现在 `/session` 列表;不落盘,除非 lorebook.persistent 开启的条目走 custom_message 落在**子会话**自己的 in-memory 记录中)。子会话中 Agent 的工具调用与工具结果都进入子会话自身上下文(Agent 自主多轮);这些内容**不**进宿主上下文。

## 4. 工具白名单

- `tools: ["read", "grep"]` 语义 = 该 Agent 的子会话中**只**激活这些工具(白名单,非黑名单)。
- 与宿主可用工具取交集:白名单里的名字在宿主会话中不存在时,静默忽略(避免"别的机器没装某扩展"导致 Agent 整体不可用),但 `/agent-usage -v` 与装载 warning 中列出。
- 内置工具用 pi 原名(`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`);扩展工具用注册名(如 `comfyui_generate`)。**不**支持通配符——显式列出,避免宿主工具集漂移引入意外工具。
- bash 等危险工具不受额外限制(信任模型同扩展;需要限制时作者自己不放进白名单)。

## 5. 世界书注入(D8/D9/D10/D20)

参照 SillyTavern 世界书的"按深度插入对话",但**触发规则完全交给用户函数**;并扩展为**三级来源 + 双注入目标**(D20):

- **三级来源**(自动合并,见 §5.2 合并规则):Agent 级(本篇 `lorebook` 字段)、工作流级(FlowDefinition.lorebook,20 §2.1)、工作区级(`chlamydomonos-agents/lorebooks/*.ts`,对所有子会话自动生效,作者用 `ctx.agent` 筛选)。
- **双注入目标**:条目自声明 `target`——`"depth"`(按深度插入对话记录,原有行为)或 `"system"`(拼进系统提示词,可带 `slot` 精确插位,见 §5.1)。

```ts
interface LorebookSpec {
    /** 仅对 target:"depth" 条目有意义:是否持久化进子会话记录;缺省 false(每次请求动态重算)。system 条目恒为动态重算 */
    persistent?: boolean;
    /** 静态条目:每次请求无条件评估(仍会经过 trigger 过滤) */
    entries?: LorebookEntry[] | ((ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>);
    /** 触发函数:返回本轮实际生效的条目;与 entries 的并集去重后注入 */
    trigger?: (ctx: LorebookContext) => LorebookEntry[] | Promise<LorebookEntry[]>;
}

interface LorebookEntry {
    /** 注入目标:depth = 对话记录按深度插入(缺省);system = 系统提示词槽位插入 */
    target?: 'depth' | 'system';
    /** 深度:0 = 插在最新一条消息之前,1 = 再往前一条,以此类推;越界则插到最前。仅 target:"depth" 有效(必填) */
    depth: number;
    /** 同深度多条的排序键,小者在前;缺省按声明顺序(depth 条目)/ 槽位内排序键(system 条目) */
    order?: number;
    /** system 条目专用:插入 systemPrompt 列表第 slot 项之后(0 = 整个列表之前;缺省 = 列表末尾,即追加);同槽位按 order 排序,§5.1 */
    slot?: number;
    /** 注入内容 */
    content: string;
    /** depth 条目注入消息的呈现角色;缺省 "user";system 条目无效 */
    role?: 'user' | 'assistant';
    /** 作者备注,不注入,仅调试展示 */
    comment?: string;
}

interface LorebookContext {
    /** **触发本次注入的 Agent name**(subagent 链上为当前实际运行的 Agent;工作区级世界书用它做筛选) */
    agent: string;
    /** 本次发给子会话的完整请求消息列表(注入前) */
    messages: AgentMessage[];
    /** 工作流运行上下文(工作流节点身份或 subflow 唤醒内;独立 subagent 运行时为 null),见 20 §运行上下文 */
    flow: FlowRunContext | null;
    /** Agent 定义 extra */
    extra: unknown;
    /** 子会话轮次计数(本 session 内第几次 LLM 请求,从 1 起) */
    requestIndex: number;
}
```

### 5.1 系统提示词构成(target:"system" 与槽位)

子会话系统提示词不再是静态字符串,而是**每次 LLM 请求前动态组装**:

```
base = systemPrompt 为 string ? [systemPrompt] : systemPrompt      // 基座列表
segs = base.map(s => ({ slot: Infinity, order: i, text: s }))       // 基座项视为"追加"到各自原位置
        … 换算:base[i] 固定在第 i 槽末尾
entry 条目(target:"system"):slot 缺省 = 跟随列表末尾;slot:n = 插入列表第 n 项之后
最终 = 按槽位序排列;同槽位内:条目按 order 升序,基座项排在同槽位条目之后
拼接:各段以 "\n\n" 连接
```

- 例:`systemPrompt: ["角色设定", "输出格式"]` + 条目 `{target:"system", slot:0, content:"补充约束"}` → `角色设定\n\n补充约束\n\n输出格式`。
- `slot` 为非负整数,超过基座长度 = 追加到末尾(不报错);同槽多条按 order 排,order 相同按三级来源优先序(Agent > 工作流 > 工作区)与声明序。
- 组装发生在 resourceLoader.getSystemPrompt(每请求);system 条目**每请求重算**、不持久化——`persistent` 对它们无意义。
- system 条目同样经过该来源的 trigger 过滤与去重;抛错语义与 depth 条目一致(该来源本轮跳过,不中断)。

### 5.2 三级合并规则

- 每个子会话注入时,同时评估三级:Agent 级(定义文件)、工作流级(节点所在 flow;仅工作流节点与 subflow 唤醒内,subagent 身份为 null 层)、工作区级(全部 lorebooks/\*.ts 中通过 `ctx.agent` 筛选者)。
- **评估相互独立**:每级各自跑 entries+trigger;某级抛错 → 该级本轮跳过 + warning,不影响其他级。
- **id 去重**:entry 稳定 id(`LorebookEntry.id?`,缺省 = `content` 的 sha1 前 12 位)跨级重复 → 高优先级层胜出(Agent > 工作流 > 工作区),低层级该条目本轮不注入,`/agent-usage -v` 列出被遮蔽条目。
- depth/system 两类条目分别合并:depth 条目合入同一插入操作(§5.3);system 条目按 §5.1 槽位合入。

### 5.3 depth 注入机制(实现)

- 非持久化(默认):inline extension 挂子会话 `context` 事件,每次 LLM 请求前重算,把选中条目按 depth/order 插入 `messages`(转成对应 role 的 user/assistant 文本消息),返回替换后的列表。session 存储不含注入消息,pi 原生记录不被污染。
- 持久化(`persistent: true`,仅 depth 条目):每条**首次生效**的条目经 `pi.sendMessage` 以 custom_message 写入子会话(pi 的 convertToLlm 会把它转为 user 消息进上下文),之后自然留在历史里;trigger 不再重复注入同一 entry(以 entry 稳定 id 判重)。
    - 因此持久化模式下 entry 需要稳定标识:`LorebookEntry.id?: string`(缺省 = `content` 的 sha1 前 12 位)。
    - ⚠️ 子会话是 in-memory 的,进程退出即失;持久化只保证"同一子会话生命周期内不重复注入",不保证跨进程存续(与 D9 语义一致)。

**语义约束**:

- depth 以**注入前的消息列表**从末尾计数;插入操作按 order 稳定排序后一次完成(先深后浅插入不会互相错位)。
- 注入发生在子会话的**每次** LLM 请求前(多轮工具调用中的每次都重算)——非持久化模式下 trigger 可以根据 `requestIndex` 决定只在首轮注入。
- trigger/entries 抛错:该级该次请求按"无注入"继续,warning 记日志(**不**中断 Agent 运行)。
- 工作区级世界书文件契约与 Agent 文件一致(jiti、default 导出、mtime 缓存);装载失败 → 该文件跳过 + warning。

## 6. Subagent(D6/D7)

Agent 定义中的 `subagents` 列表决定它能调用哪些子代理。**被引用对象可以是 Agent,也可以是工作流**(工作流引用见 §6.1)。装载后,扩展为该 Agent 的子会话注册若干 `spawn_*` 工具:

```ts
// 为 subagents: ["coder", { name: "reviewer", title: "快速评审" }, { name: "dev-loop" }](dev-loop 为工作流名)生成:
{
    name: "spawn_coder" | "spawn_reviewer" | "spawn_dev-loop",
    label: "调用子代理 <title或name>",
    description: "启动子代理 <被引用对象的 description 文本>,传给它一段任务描述,阻塞直到完成,返回它的最终输出文本。",
    parameters: Type.Object({
        task: Type.String({ description: "交给子代理的任务描述(它会以此为用户消息开始工作)" }),
        context: Type.Optional(Type.String({ description: "补充上下文/约束,拼在 task 之后的第二段" })),
    }),
    execute: async (…) => { /* §6.2 */ },
}
```

- 工具名固定 `spawn_<被引用name>`;`description` 由被引用 Agent/工作流的 `title`/`description` 组合(调用方模型靠它决定何时用)。
- **参数刻意最小化**(只有 task/context):subagent 的能力由其定义文件决定,不由调用方临时捏造(工具白名单、世界书都按定义来)。需要给子代理材料时,写进 task/context 文本。

### 6.1 SubagentSpec

```ts
interface SubagentSpec {
    name: string; // 引用的 Agent name 或工作流 name(同名冲突 → 装载 warning,Agent 优先)
    /** 覆盖显示名(同一被引用对象在不同父 Agent 下可有不同称呼) */
    title?: string;
    /** 附加指令,拼在该 subagent 子会话 systemPrompt 之后(一次性的定制;仅 Agent 引用有效) */
    appendSystemPrompt?: string;
    /** 会话语义;缺省取全局配置 subagentSession,再缺省 "stateless"(D7)。仅 Agent 引用;工作流引用忽略 */
    session?: 'stateless' | 'inherit';
}
```

**Agent 引用**(name 指向 Agent):

- `session: "inherit"` 语义:同一**父 Agent 子会话**生命周期内,同名 spawn\_\* 的多次调用复用同一 subagent 子会话(task 作为新 user 消息追加);父 Agent 子会话结束(工作流节点完成 / fresh 模式被丢弃)时一并清理。
- subagent 自身定义里的 `subagents` 列表同样生效(**递归委派**)。深度无硬限制,但每层都受宿主 Esc 中断级联控制(D16)。

**工作流引用**(name 指向工作流 name):

- spawn 后**一次完整唤醒**:task(+context)作为该工作流入口节点的输入;工作流跑到终点,终点文本即工具返回值。
- 子会话配置完全由工作流节点自己声明(sessionMode/model/世界书);SubagentSpec 的 appendSystemPrompt/session 不适用(写了忽略 + warning)。
- **引用图无环**:Agent→subagent 边 + 工作流节点→Agent 边 + subagent→工作流 边构成的引用图在装载期 DFS 查环;发现环 → 环上成员全部判无效(每个环成员一条 warning);**自引用**(工作流引用自己)同样拒绝。
- agentPath 记账键延伸:工作流引用在链上记作 `subflow:<flowName>`(40 §6,如 `flow:outer#规划 > subflow:dev-loop#实现`)。

### 6.2 spawn\_\* 工具执行流程

1. 校验:被引用对象当前装载有效(失效 → isError,提示重载)。
2. **Agent 引用**:按 §6.1 session 语义取(新)子会话;inherit 时已存在则复用。**工作流引用**:发起一次性的工作流唤醒(与该工作流被选为虚拟模型时同一套引擎/池;“宿主”即发起 spawn 的子会话);task(+context)为入口输入。
3. 输入:user 消息 = `task` + (context ? "\n\n" + context : "");世界书照常评估(flow 上下文:Agent 引用为 null,工作流引用为该次唤醒的 FlowRunContext;工作流级世界书同样生效,工作区级按 ctx.agent 筛选)。
4. 运行:阻塞至子代理/子工作流结束(pi `session.prompt(task)` / 引擎 run);期间内部文本/思考/工具调用照常透传到宿主流(30 §3,携带 `agentPath` 标明层级)。
5. 返回:`content` = 最终文本(Agent 引用 = 最后一条 assistant 文本;工作流引用 = 终点文本);`details` = `{ agent|flow, usage, durationMs }`(usage 进记账,§6.3);内部报错 → isError,content 为错误摘要。

### 6.3 usage 记账(D15)

- 每个子会话(session.subscribe 监听 message_end)的 usage 增量 → 记账器按 `(hostSessionId, agentPath)` 累计;`agentPath` 形如 `flow:review-loop#coder > sub:reviewer`(工作流节点 > 子代理链)。
- 记账数据经 `pi.appendEntry("pi-agents:usage", …)` 持久化到宿主 session(非模型上下文);`/agent-usage` 汇总展示(40 §7)。
- 虚拟模型消息本身的 usage/cost 恒 0(D15),防止宿主统计重复计费。

## 7. 会话模式归属(设计说明)

子会话的生命周期模式(fresh/inherit)是**工作流节点属性**(NodeSpec.sessionMode,20 §2.2),不在 Agent 定义中——同一个 Agent(如 reviewer)在评审循环里每轮要从零看代码(fresh),在长程开发流里可能需要记住上次意见(inherit),由**使用场景**决定而非 Agent 本身。

- Agent 定义作为模板,不含任何会话生命周期信息;subagent 身份的会话语义由调用方 SubagentSpec.session 决定(§6.1)。
- 语义细则(fresh/inherit/重入/清理)统一见 40 §3。

## 8. 示例:带递归子代理的 Agent

```ts
// planner.ts
import type { AgentDefinition } from '@chlamydomonos/pi-agents';

export default {
    name: 'planner',
    title: '规划者',
    description: '把需求拆解为任务清单,可派发 coder/reviewer 子代理执行',
    systemPrompt: `你是规划者。维护一份任务清单,逐项派发给子代理,汇总结果。
每次回复结尾用一行 "NEXT: <任务描述或 DONE>" 说明下一步。`,
    tools: ['read', 'ls'],
    subagents: [
        'coder',
        { name: 'reviewer', appendSystemPrompt: '只关注正确性,不管风格。' },
        // 工作流引用:name 指向 agent-flows 里的 dev-loop(10 §6.1)
        { name: 'dev-loop', title: '跑一遍完整开发循环' },
    ],
    lorebook: {
        persistent: false,
        trigger: (ctx) => {
            // 触发规则完全自定义:这里示例"首轮注入项目结构说明,后续每 5 轮提醒格式"
            if (ctx.requestIndex === 1) {
                return [{ depth: 0, content: '项目结构:<此处由你的函数读取文件系统生成>' }];
            }
            if (ctx.requestIndex % 5 === 0) {
                return [{ depth: 0, content: '提醒:回复结尾必须有 NEXT: 行。' }];
            }
            return [];
        },
    },
} satisfies AgentDefinition;
```
