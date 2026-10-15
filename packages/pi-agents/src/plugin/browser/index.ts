/**
 * pi-agents 浏览器插件(browser v4,docs/70 §2):workspace panel = 目录 + 运行图。
 * pi-web 仅类型依赖(构建期擦除);lit 打进 bundle。
 */
import type {
    PluginActivationContext,
    PluginActivationResult,
    WorkspacePanelContext,
} from '@jmfederico/pi-web/plugin-api';
import { PiAgentsPanelElement, attachPanel } from './panel.js';

const PANEL_ID = 'agents' as const;

export const agentsBrowserPlugin = {
    apiVersion: 4 as const,
    name: 'Pi Agents',

    activate(context: PluginActivationContext): PluginActivationResult {
        return {
            contributions: {
                workspacePanels: [
                    {
                        id: PANEL_ID,
                        title: 'Agents',
                        icon: context.svg`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M7.8 7.8L10.5 16M16.2 7.8L13.5 16M8.5 6h7"/></svg>`,
                        render: (panelContext: WorkspacePanelContext) =>
                            context.html`<pi-agents-panel .panelCtx=${panelContext}></pi-agents-panel>`,
                        // 宿主状态变化(会话切换/agent-activity)→ 通知面板重查 selectedSession
                        // (panelCtx 引用可能稳定,靠属性变化检测会话切换不可靠;70 §7)
                        onInvalidate: () => attachPanel.current?.onHostInvalidate(),
                    },
                ],
            },
            start() {
                /* 面板经本插件服务端 peer 通信,无额外 capability */
            },
            dispose() {
                attachPanel.set(null);
            },
        };
    },
};

export default agentsBrowserPlugin;

// 自定义元素注册(lit;bundle 内只执行一次)
if (!customElements.get('pi-agents-panel')) {
    customElements.define('pi-agents-panel', PiAgentsPanelElement);
}
