/**
 * 面板样式(docs/70 §2.1/2.2):从 panel.ts 拆出。
 */
import { css } from 'lit';

export const panelStyles = css`
    :host {
        display: block;
        font-size: 13px;
        color: var(--vscode-foreground, var(--sl-color-neutral-700, #ddd));
        padding: 8px 12px 24px;
    }
    h3 {
        font-size: 13px;
        font-weight: 600;
        margin: 18px 0 8px;
        display: flex;
        align-items: center;
        gap: 8px;
    }
    h3:first-child {
        margin-top: 4px;
    }
    .muted {
        color: var(--vscode-descriptionForeground, #888);
    }
    .group {
        margin-bottom: 4px;
    }
    .group-title {
        cursor: pointer;
        user-select: none;
        padding: 2px 4px;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .group-title:hover {
        background: rgba(128, 128, 128, 0.12);
    }
    .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 2px 6px 2px 18px;
        border-radius: 6px;
        min-width: 0;
    }
    .row:hover {
        background: rgba(128, 128, 128, 0.1);
    }
    .row .name {
        font-family: var(--vscode-editor-font-family, monospace);
    }
    .row .title {
        color: var(--vscode-descriptionForeground, #999);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .row .grow {
        flex: 1;
        min-width: 0;
    }
    .badge {
        font-size: 11px;
        padding: 0 6px;
        border-radius: 8px;
        border: 1px solid rgba(128, 128, 128, 0.4);
        color: var(--vscode-descriptionForeground, #999);
        flex: none;
    }
    .warn-badge {
        cursor: pointer;
        color: var(--pi-agents-abort, #e0a030);
        border-color: currentColor;
    }
    .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        border: 1.5px solid var(--vscode-descriptionForeground, #888);
        flex: none;
    }
    .dot.flow {
        border-radius: 2px;
    }
    .dot.selected {
        background: var(--vscode-descriptionForeground, #888);
    }
    button {
        font: inherit;
        font-size: 12px;
        color: inherit;
        background: transparent;
        border: 1px solid rgba(128, 128, 128, 0.4);
        border-radius: 6px;
        padding: 2px 10px;
        cursor: pointer;
    }
    button:hover {
        background: rgba(128, 128, 128, 0.15);
    }
    .status-line {
        display: flex;
        gap: 8px;
        align-items: center;
        margin: 6px 0;
    }
    .graph-scroll {
        overflow: auto;
        max-height: 70vh;
        padding-bottom: 6px;
    }
    svg {
        display: block;
    }
    .node-rect {
        fill: rgba(128, 128, 128, 0.08);
        stroke: rgba(128, 128, 128, 0.55);
        stroke-width: 1.4;
    }
    .node-rect.fn {
        stroke-dasharray: 5 3;
    }
    .node-rect.current {
        stroke: var(--pi-agents-running, #4a9eff);
        stroke-width: 2.2;
    }
    .node-rect.ok {
        stroke: var(--pi-agents-ok, #4caf7d);
    }
    .node-rect.error {
        stroke: var(--pi-agents-error, #e05c5c);
    }
    .node-label {
        fill: currentColor;
        font-size: 12px;
    }
    .node-agent {
        fill: var(--vscode-descriptionForeground, #999);
        font-size: 10px;
    }
    .edge {
        stroke: rgba(128, 128, 128, 0.45);
        stroke-width: 1.3;
        fill: none;
    }
    .edge.dashed {
        stroke-dasharray: 4 3;
    }
    .edge.walked {
        stroke: var(--pi-agents-running, #4a9eff);
        stroke-width: 2.2;
    }
    .edge-head {
        fill: rgba(128, 128, 128, 0.55);
    }
    .entry-mark {
        fill: var(--vscode-descriptionForeground, #999);
        font-size: 11px;
    }
    .visit-badge {
        fill: var(--vscode-descriptionForeground, #bbb);
        font-size: 10px;
    }
    .spawn-badge {
        font-size: 10px;
    }
    .max-badge {
        fill: var(--pi-agents-abort, #e0a030);
        font-size: 10px;
        font-weight: 600;
    }
    .banner {
        padding: 8px 10px;
        border-radius: 6px;
        background: rgba(128, 128, 128, 0.12);
        margin: 6px 0;
    }
    .subgraph-frame {
        fill: rgba(128, 128, 128, 0.04);
        stroke: rgba(128, 128, 128, 0.35);
        stroke-width: 1;
        stroke-dasharray: 6 4;
    }
    .subgraph-title {
        fill: var(--vscode-descriptionForeground, #999);
        font-size: 11px;
        font-weight: 600;
    }
    .sublink {
        stroke: rgba(128, 128, 128, 0.4);
        stroke-width: 1.2;
        stroke-dasharray: 5 4;
        fill: none;
    }
    .pulse {
        animation: pulse 1.2s ease-in-out infinite;
    }
    @keyframes pulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.45;
        }
    }
`;
