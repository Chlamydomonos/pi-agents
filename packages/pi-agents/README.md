# @chlamydomonos/pi-agents

Pi Coding Agent 扩展:用 TypeScript 文件定义 Agent 与工作流,工作流经虚拟模型端点(`/model` 中的 `pi-workflows/<name>`)驱动多智能体执行。

- 设计文档:`../../docs/`(00-总览 … 60-安装与开发)
- 运行时免构建(pi 经 jiti 直载 TS);`npm run typecheck` 保证类型正确

## 安装(开发态)

```fish
npm i
# pi settings.json 的 packages 里加本包路径,或:
pi --extension ./src/extension/index.ts
```

## 目录契约(用户文件)

在 pi 里执行 `/agent-init`(全局加 `--global`)即可生成下列结构,并附带 `tsconfig.json` + `pi-agents.d.ts` 类型 shim —— **无需安装本包**即可在编辑器获得完整类型提示。

```
~/.pi/agent/chlamydomonos-agents/          # 全局
├── config.json                            # 两级配置(model 等;工作区覆盖全局)
├── tsconfig.json                          # 编辑期类型检查(noEmit)
├── pi-agents.d.ts                         # export * from …/src/extension/types
├── agents/…                               # Agent 定义(*.ts 或 目录/index.ts)
├── agent-flows/…                          # 工作流定义
└── lorebooks/…                            # 工作区级世界书(自动生效)
<工作区>/.pi/chlamydomonos-agents/          # 工作区(同名覆盖全局)
```

作者文件里 `import type { AgentDefinition } from '@chlamydomonos/pi-agents'`。

## 脚本

| 命令                | 作用                                |
| ------------------- | ----------------------------------- |
| `npm run typecheck` | tsc --noEmit                        |
| `npm test`          | vitest 单元/冒烟(不发真实 LLM 请求) |
| `npm run smoke`     | 离线冒烟(装载示例 + 打表)           |
