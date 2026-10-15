/**
 * 引擎模块出口:M2 假执行器层的完整 API(runner/pass/context)。
 */

export { FlowError, runFlow, type NodeExecutor, type RunFlowDeps, type RunFlowResult } from './runner.js';
export { applyPass, renderTemplate, resolvePass, type PassOutcome } from './pass.js';
export { createRunState, routeContext, type RunState } from './context.js';
