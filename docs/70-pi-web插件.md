# 70 — pi-web 插件(智能体/工作流面板与运行图)

> 本篇定义 `pi-agents` 包内 pi-web 插件的完整契约:包声明、浏览器面板(browser v4)、服务端插件(server v3)、wire 协议、运行图渲染、安装与刷新。
> 数据流模式与 `pi-comfyui` 30 号文档同款(已验证),差异:本插件**无产物画廊**,核心是**目录 + 实时运行图**。
> 宿主契约来源:pi-web `src/plugin-api.ts`(browser v4)/ `src/server-plugin-api.ts`(server v3)/ captains-log 参考实现;渲染行为已核实 `src/client/src/formatting/markdownImages.ts` 等源码(2026-10-13)。
> 前置阅读:00(D1/D21-D24)、40 §13(事件发射)。

## 1. 包声明与构建

```jsonc
// packages/pi-agents/package.json(与 pi 扩展同包,D1)
{
    "pi": { "extensions": ["./src/extension/index.ts"] },
    "piWeb": {
        "plugins": [
            {
                "id": "pi-agents",
                "module": "./dist/plugin/browser/index.js", // 浏览器入口 v4
                "serverModule": "./dist/plugin/server/index.js", // 服务端入口 v3
                "browserRoot": "./dist/plugin/browser", // 浏览器静态资源根
                "machineSpecific": true, // 目录与运行状态依赖该机器上的扩展进程,按机器区分
                "defaultEnabled": true,
            },
        ],
    },
}
```

- **浏览器/服务端必须构建**(宿主不编译插件源码):esbuild 打包 `src/plugin/browser/index.ts` → `dist/plugin/browser/`(含 lit 运行时)、`src/plugin/server/index.ts` → `dist/plugin/server/index.js`。与扩展本体(jiti 免构建)并存:扩展源码直载,插件走 dist。构建命令与 watch 见 60 §3。
- 包体积上限 16MiB/4096 文件(宿主约束):只打包运行时必要物,lit 打进 bundle,不放 source map 进 browserRoot。
- 浏览器与服务端**必须成对**(peer 必须提供 request 或 openChannel 之一)。

## 2. 浏览器插件(browser v4)

```ts
import type { PiWebPlugin, WorkspacePanelContext } from '@jmfederico/pi-web/plugin-api';
import { html } from 'lit';

const plugin: PiWebPlugin = {
    apiVersion: 4,
    name: 'Pi Agents',
    activate(ctx /* {apiVersion, pluginId, html, svg, signal, lifetimeSignal, selection?} */) {
        return {
            contributions: {
                workspacePanels: [
                    {
                        id: 'agents', // 面板限定 ID:"pi-agents:agents"
                        title: 'Agents',
                        icon: ctx.svg`<svg …>…</svg>`,
                        render: (context: WorkspacePanelContext) =>
                            html`<pi-agents-panel .ctx=${context}></pi-agents-panel>`,
                    },
                ],
            },
        };
    },
};
export default plugin;
```

- **仅 workspace panel**(D24 拍板):需要选中工作区(目录按工作区扫描、运行图按会话);无会话时面板显示引导文案。
- 渲染模式遵循宿主约定:`render` 是同步 Lit 模板;异步数据(panel 内部状态)由组件管理;一切订阅/定时器挂传入 `signal`,`disconnectedCallback` 退订。

### 2.1 面板布局(pi-agents-panel,Lit)

```
┌ Agents ────────────────────────────────────────────────┐
│ [目录区]                                               │
│  ▾ 工作流(2)                                           │
│    ● dev-loop — 开发循环     [全局]   ⚠1               │
│    ● notes — 纪要            [工作区]                   │
│  ▾ 智能体(4)                                           │
│    ○ planner — 规划者        [全局]                     │
│    ○ coder — 编码者          [全局]                     │
│    …                                                   │
│ [运行图区](选中会话存在唤醒时)                          │
│  <svg 运行图:节点/边/高亮/徽章>                        │
│  唤醒 #3 · 运行中 · 当前:实现(#2)                      │
└────────────────────────────────────────────────────────┘
```

**目录区**(简易展示,Q6 拍板):

- 两组折叠列表:**工作流** / **智能体**。每项:●/○(工作流/Agent)、name(等宽字体)、title、来源徽章(`全局`/`工作区`)。
- 装载警告计数徽章(⚠N):点开显示 warning 文本列表(来自 catalog 帧)。
- 无点击跳转、不展示 tools/lorebook/model 细节(简易展示,后续按需扩展)。
- 空目录:引导文案「在 `.pi/chlamydomonos-agents/` 创建 Agent 与工作流(见文档 50)」。

**运行图区**(核心;Q5 拍板**只做实时**,无历史快照):

- 数据 = 当前选中会话的**进行中或最近一次唤醒**(wake-start 起,wake-end 后保持显示直到下次唤醒覆盖;不做历史回看)。
- 无唤醒:显示工作流选中提示(「选一个工作流模型并对话后此处显示运行图」),或目录里点工作流名 → 显示其**静态定义图**(同款渲染,无动态状态;仅当该工作流 catalog 可用)。

### 2.2 运行图规格

- **图源**:静态结构来自 catalog 帧(节点列表/entry/静态边/条件边 targets);动态状态来自 wake/node/edge/spawn 帧(40 §13)。
- **布局**:**@dagrejs/dagre 自动分层**(rankdir=LR,执行流从左到右,分支图自然二维展开;引入第三方布局库,替代旧手写分层),SVG 渲染。长链(每层 1 节点,整体退化为一条水平线)超过 `MAX_PER_ROW=4` 时**蛇形换行**成多行(偶数行左→右、奇数行右→左),避免单链图被拉得极宽。环(targets/route 回边)由 dagre 原生支持 + 渲染层曲线回边(目标在上方/左侧时绕行)。
- **代码结构**(浏览器端 4 文件,替代旧单文件 panel.ts):
    - `graph-layout.ts`:dagre 布局 + 长链换行 + 子图拼合(`layoutFlow`/`composeLayouts`);
    - `graph-render.ts`:SVG 渲染纯函数(边/节点/子图组/连接虚线);
    - `panel-css.ts`:面板样式;
    - `panel.ts`:元素/帧重放/目录/spawn 子图拼接。
- **节点框**:圆角矩形;`节点名`(label 缺省节点名)+ 来源 Agent 名小字;Agent 节点实线框、函数节点虚线框。入口节点加 ▶ 标记。
- **边**:静态边实线箭头;条件边画 **targets 候选虚线**(无 targets 声明 → 画到框右侧的通用 `?` 路由标记);`done` 目标画向图外的 ⏹ 端点。
- **动态状态**(按 wake 帧序重放渲染):
    - 当前节点:高亮描边 + 进度点(运行中脉动动画);函数节点运行中同样高亮。
    - 已完成节点:visit 计数徽章(`×2`/`×3`,环回可见);终点状态色:绿(完成)/红(失败)/橙(中断)。
    - **edge 帧**:点亮实际走过的边(实线加粗),未走候补虚线保持淡色。
    - **maxIterations 触发**:对应节点框角标 `max`,thinking 之外的视觉提示。
    - **子智能体/子工作流徽章**:节点框下方挂徽章行——每次 `spawn-start` 在 parentPath 对应节点下追加徽章:`sub:<name>`(Agent 引用)/ `subflow:<name>`(工作流引用);`spawn-end` 后按状态着色(运行中蓝脉动/完成绿/失败红/中断橙)。
    - **子图拼接**(核心升级):spawn 发生时,被引用对象**实际展开进图**——`subflow` 引用取 catalog 同名 flow 的完整布局拼接为主图旁的子图组(虚线组框 + `subflow:<title>` 组标题);`sub` 引用(Agent 无图)画**单节点迷你图**同框展示。父节点右缘 → 子图组左缘画**连接虚线**;子图组纵向堆叠在主图右侧。spawn 结束后子图保留(轨迹回看);新 wake-start 重置。
- **唤醒切换**:新 wake-start 帧清空重置;面板顶部状态行:`唤醒 #N · <状态> · 当前:<节点>`。
- **性能**:帧驱动增量更新(Lit 响应式),不做动画重排;channel 断线重连后以 `wake-start`(若仍进行中)+ 服务端快照帧重建(§4.4)。

### 2.3 浏览器渲染注意

- 帧文本(inputPreview/textPreview/警告)一律 `textContent`/Lit 默认转义,不做 HTML 注入(宿主信任边界:插件自己校验/转义帧数据)。
- channel 关闭/abort signal 触发时正确清理;`context.host.requestRender()` 用于帧到达后的重渲。
- SVG 图在面板宽度内横向滚动(超大图不缩放到不可读)。

## 3. 服务端插件(server v3)

```ts
import { PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY } from '@jmfederico/pi-web/server-plugin-api';
import type { PiWebServerPlugin, ServerPluginActivationContext } from '@jmfederico/pi-web/server-plugin-api';

const plugin: PiWebServerPlugin = {
    apiVersion: 3,
    name: 'Pi Agents',
    requires: [PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY],
    activate(host /* {pluginId, packageRoot, dataDirectory, logger, settings, signal, lifetimeSignal} */) {
        // …
        return {
            start({ capabilities }) {
                events = capabilities.resolve(PI_WEB_HOST_PI_SESSION_EVENTS_CAPABILITY);
            },
            peer: { request, openChannel },
            async dispose() {
                /* 关闭全部连接与订阅(幂等) */
            },
            health() {
                return { status: 'healthy' };
            },
        };
    },
};
export default plugin;
```

要点(照抄 captains-log/pi-comfyui 已验证模式):

- `host.dataDirectory`:宿主创建的持久目录,格式本插件自理;`lifetimeSignal` 挂全部监听;peer 回调的 `signal` 只属本次调用。
- `send` 同步克隆 + 有界:超限 throw 关 channel → try/catch 后摘除该订阅者。
- **服务端不读工作区目录、不做装载**——扩展是唯一真相(D23);服务端只做桥接/扇出/快照。

### 3.1 会话桥接

- `pi.events` 按会话 scope:一次 `connect({projectId, workspaceId, sessionId})` 只覆盖一个会话;会话切换 → 重连 + 重新 `on("pi-agents", handler)`(先订阅后收帧铁律,同 pi-comfyui 30 §3.1)。
- 扩展在 `session_start` 完成订阅(同事件名 `"pi-agents"`);无扩展的会话 = channel 打开但无帧,浏览器以 catalog 请求失败识别并提示「本工作区未启用 pi-agents 扩展」。

### 3.2 快照与扇出(服务端唯一有状态的职责)

- 服务端为每个 `(project, workspace, session)` 维护**最新状态快照**:catalog(最近一帧)+ 进行中唤醒的已收帧缓冲(≤256 帧,环形)。
- `openChannel` 打开即发 `{kind:'snapshot', catalog, active?}`(§4.3)作为初始状态——浏览器断线重连、daemon 重启后浏览器 reload,都能从快照恢复,而**不必等扩展重发**(扩展只发增量)。
- 进行中唤醒期间:每收到扩展帧 → 更新快照 + 扇出全部订阅者;唤醒结束(wake-end)→ 快照保留为"最近一次"(浏览器后续 openChannel 仍能看到),直至该会话新唤醒覆盖。
- **不做**磁盘持久化历史(Q5 拍板只做实时):快照仅内存;daemon 重启丢失最近唤醒图(可接受,目录区由扩展 catalog 重新填充)。

### 3.3 peer.request 操作

| operation          | input | 返回                                  | 说明                                  |
| ------------------ | ----- | ------------------------------------- | ------------------------------------- |
| `snapshot`         | `{}`  | `{ catalog?, active? }`(同快照帧载荷) | 面板挂载打底(与 openChannel 首发等价) |
| `refresh-catalog`  | `{}`  | `{ ok }`                              | 转发 cmd 给扩展,扩展重发 catalog 帧   |
| `extension-status` | `{}`  | `{ connected: boolean }`              | 该会话 events 订阅是否活着(诊断用)    |

### 3.4 持久化边界

- 仅一处:`dataDirectory/last-snapshot/<workspaceHash>.json`(可选优化,daemon 重启后保留"最近一次"图;**第一期不做**,内存快照即达需求)。
- 其余(目录/运行状态)全部实时来自扩展,无宿主文件读写。

## 4. Wire 协议(`src/shared/protocol.ts`,唯一真相)

频道名:`"pi-agents"`(常量 `AGENTS_CHANNEL`)。**帧内禁止图片数据**;preview 字段 ≤200 字;全部纯 JSON。

### 4.1 扩展 → 服务端(pi.events.emit,无回放)

```ts
type NodeKind = 'agent' | 'fn';

type CatalogAgent = { name: string; title: string; description: string; source: 'global' | 'workspace' };
type CatalogFlow = {
    name: string;
    title: string;
    description: string;
    source: 'global' | 'workspace';
    entry: string;
    nodes: { key: string; label?: string; kind: NodeKind; agent?: string }[]; // kind:fn 的 agent 缺省
    edges: { from: string; to: string | 'done'; via: 'static' | 'route'; targets?: string[] }[];
};

type AgentFrame =
    | { kind: 'catalog'; agents: CatalogAgent[]; flows: CatalogFlow[]; warnings: string[] }
    | { kind: 'wake-start'; hostSessionId: string; wake: number; flow: string; inputPreview: string }
    | { kind: 'node-enter'; wake: number; node: string; visit: number; nodeKind: NodeKind }
    | {
          kind: 'node-exit';
          wake: number;
          node: string;
          visit: number;
          status: 'ok' | 'error';
          durationMs: number;
          textPreview?: string;
      }
    | { kind: 'edge'; wake: number; from: string; to: string | 'done'; via: 'static' | 'route' | 'maxIterations' }
    | { kind: 'spawn-start'; wake: number; parentPath: string; refKind: 'sub' | 'subflow'; name: string; label: string }
    | {
          kind: 'spawn-end';
          wake: number;
          parentPath: string;
          name: string;
          status: 'ok' | 'error' | 'aborted';
          durationMs: number;
      }
    | { kind: 'wake-end'; wake: number; status: 'completed' | 'failed' | 'aborted'; terminalPreview?: string };
```

- `parentPath` = usage 的 agentPath 链(40 §6):`flow:<flow>#<label>[ > sub:<name> | > subflow:<name>#<label>]*`;浏览器按 `>` 分段把徽章挂到对应节点框(parentPath 第一段定位节点)。
- `catalog.edges.targets` 直接来自 EdgeSpec.targets(D24);无 targets 的条件边省略字段。
- `wake` = wakeIndex(宿主 session 内序号);hostSessionId 供服务端路由,浏览器不需要。

### 4.2 浏览器 → 服务端(channel receive)

```ts
type BrowserFrame = { kind: 'cmd'; action: 'refresh-catalog' };
```

### 4.3 服务端 → 浏览器(channel send)

```ts
type ServerFrame =
    | AgentFrame // 原样转发
    | {
          kind: 'snapshot';
          catalog?: { agents: CatalogAgent[]; flows: CatalogFlow[]; warnings: string[] };
          active?: {
              wake: number;
              flow: string;
              status: 'running' | 'completed' | 'failed' | 'aborted';
              frames: AgentFrame[];
          }; // 唤醒帧缓冲按序重放
      }
    | { kind: 'error'; message: string };
```

### 4.4 时序

```mermaid
sequenceDiagram
    participant B as 浏览器面板
    participant S as 服务端插件(sessiond)
    participant E as pi 扩展(会话内)

    B->>S: openChannel + request snapshot
    S-->>B: snapshot{catalog, active?}
    Note over E: /model 选 pi-workflows/xxx 后对话
    E-->>S: emit wake-start
    S-->>B: 转发(面板重置运行图)
    E-->>S: emit node-enter/edge/node-exit/spawn-* …
    S-->>B: 逐帧扇出(高亮/徽章/计数)
    E-->>S: emit wake-end
    S-->>B: 终帧(状态行落定;快照保留为最近一次)
    B->>S: cmd refresh-catalog(可选,目录刷新)
    S->>E: emit cmd
    E-->>S: emit catalog(重发)
    S-->>B: catalog 帧(目录区更新)
```

### 4.5 错误与恢复

| 场景              | 行为                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| 会话 daemon 重启  | 服务端重新 activate,内存快照丢失;浏览器 reload → openChannel → 等扩展 session_start 重发 catalog(扩展随宿主重启) |
| 扩展 /reload      | catalog 重发纠正;进行中唤醒的帧序号从新 wake 重新计;浏览器对新 wake-start 重置图                                 |
| channel 断开      | 浏览器重开;快照打底,无帧丢失感(进行中唤醒以快照 frames 重放)                                                     |
| 扩展未装/未启用   | `snapshot` 超时/extension-status=false → 面板提示;不做目录猜测                                                   |
| 帧超限(send 抛错) | 摘除该订阅者,logger.warn;其他订阅者不受影响                                                                      |
| 插件禁用          | 面板消失;扩展照常工作(独立安装)                                                                                  |

## 5. 目录与运行图的数据一致性

- 目录区**只信 catalog 帧**:扩展装载是唯一真相(覆盖规则/无效文件/警告都在装载期决定,40 §2);服务端与浏览器不做二次推断。
- 运行图节点/边**以 catalog 的静态结构为底版**,帧只提供"走到哪/徽章"——catalog 未含的工作流(wake 帧 flow 名不在 catalog)→ 面板提示「工作流定义已变更,/reload 后恢复」并仅显示状态行。
- 来源徽章按 catalog 的 `source` 显示;同名覆盖(工作区胜)时目录只出现一条,以胜者为准(装载期已合并)。

## 6. 安装与刷新

```fish
# 开发态:symlink 包进 pi-web 插件目录(必须含构建产物 dist/plugin/)
mkdir -p ~/.pi-web/plugins
ln -s <repo>/packages/pi-agents ~/.pi-web/plugins/pi-agents
# 若 PI_WEB_DATA_DIR 已设置 → 用 $PI_WEB_DATA_DIR/plugins

# 改动后的生效路径(宿主规则):
#   只改浏览器代码 → 重载浏览器页面
#   改了服务端代码/包声明 → 重启该机器 session daemon,再重载浏览器
systemctl --user restart pi-web-sessiond
```

- 扩展部分(装载/引擎)变更仍走 pi 的 `/reload`(独立于插件刷新)。
- 双机拓扑注意(用户环境):浏览器在笔记本、sessiond 在远程 → symlink 装在**远程机器**的 `$PI_WEB_DATA_DIR/plugins`,浏览器访问面板经 gateway;`machineSpecific: true` 使目录/运行图指向远程机器的扩展进程。

## 7. 验收清单(实现期)

```
[ ] 装载后 catalog 帧:agents/flows 与 /model 列表一致;来源徽章正确;警告计数与装载 warning 一致
[ ] 面板目录区:折叠/展开、名称 title 展示;空目录引导文案
[ ] 静态图:dev-loop 示例(含条件边 targets)节点/边/入口/done 端点绘制正确;无 targets 条件边显示 ? 标记
[ ] 运行图:唤醒中当前节点高亮;edge 点亮;环回 visit 徽章 ×N;maxIterations 角标
[ ] spawn 徽章:Agent 引用 sub:x、工作流引用 subflow:y,挂父节点下;状态着色;点击见 task 摘要
[ ] 唤醒结束:状态行/终点着色;新唤醒重置;断线重连后快照恢复(进行中唤醒图不丢)
[ ] 会话切换:图随 selectedSession 变化;无唤醒会话显示占位
[ ] 未装扩展工作区:面板提示,无报错
[ ] 嵌图联动:嵌图工作流(pi-comfyui 链路)在聊天中图片可见(20 §9.7;本插件不负责图,仅端到端联测)
[ ] 帧无图片数据;preview ≤200 字(协议断言进单测)
```

## 8. 与 pi-comfyui 插件的复用与差异

| 项           | pi-comfyui(30 号)            | 本插件                                |
| ------------ | ---------------------------- | ------------------------------------- |
| 面板定位     | 任务卡片/进度/预览/画廊      | 目录 + 运行图                         |
| 数据真相     | 扩展(任务状态)               | 扩展(装载目录 + 引擎轨迹)             |
| 服务端持久化 | jobs JSONL 历史              | 无(内存快照;Q5 只做实时)              |
| 帧方向       | 扩展→服务端→浏览器单向 + cmd | 同构;多一类 snapshot 初始帧           |
| 图片         | preview 基64 帧走 wire       | **禁止**(嵌图走聊天 markdown,20 §9.7) |
| 频道名       | `"pi-comfyui"`               | `"pi-agents"`                         |
