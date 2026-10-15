/**
 * 传递规则(pass)执行(docs/20 §5)。
 *
 * 职责:按边/顶层声明把上游 NodeOutput 加工为下游的用户消息。
 * 不做裁剪(文档明确);transform/template 抛错原样上抛,由 runner 转 error 流。
 */

import type { FlowDefinition, ImageContent, NodeOutput, PassResolver, PassSpec, WakeContext } from '../types.js';

export interface PassOutcome {
    /** 下游节点的用户消息(userMessage 为空 = 不发新消息,仅投喂数据) */
    userMessage: string;
    /** transform 返回的结构化数据;记录进**上游节点**本次执行后的 NodeOutput.data(docs/20 §5.1) */
    data?: unknown;
    /** 下游 prompt 的图片参数(docs/20 §9.4:forward = 上游 images;transform.images = 显式集;缺省空) */
    images?: ImageContent[];
}

/** 解析某条边实际生效的 PassSpec:边级覆盖顶层(docs/20 §5.1) */
export function resolvePass(
    flow: FlowDefinition,
    target: string,
    visit: number,
    edgePass: PassSpec | PassResolver | undefined,
): PassSpec {
    void target;
    void visit;
    if (edgePass) {
        if (typeof edgePass === 'function') return edgePass(target, visit) ?? { mode: 'text' };
        return edgePass;
    }
    const top = flow.pass;
    if (!top) return { mode: 'text' };
    if (typeof top === 'function') return top(target, visit) ?? { mode: 'text' };
    return top;
}

/**
 * 应用 pass:把上游输出加工成下游输入。
 * - text:上游最终文本原样
 * - text + images:'forward':文本照旧 + 上游 images 原样转发(docs/20 §9.4)
 * - none:提示语「继续你的任务」
 * - template:插值 {{text}} / {{visit}} / {{data.<path>}};{{{{ 转义原样
 * - custom:transform 返回 string 或 { userMessage?, data?, images? };
 *   userMessage 空 = 不发新消息;images = 显式转发集(缺省不转发)
 */
export async function applyPass(
    spec: PassSpec,
    output: NodeOutput,
    ctx: { to: string; visit: number; wake: WakeContext; scratch: Record<string, unknown>; extra: unknown },
): Promise<PassOutcome> {
    switch (spec.mode) {
        case 'text':
            return 'images' in spec && spec.images === 'forward'
                ? { userMessage: output.text, images: (output.images ?? []).map((n) => n.image) }
                : { userMessage: output.text };
        case 'none':
            return { userMessage: '继续你的任务' };
        case 'template':
            return { userMessage: renderTemplate(spec.template, output, ctx) };
        case 'custom': {
            const r = await spec.transform(output, ctx);
            if (typeof r === 'string') return { userMessage: r };
            return {
                userMessage: r.userMessage ?? '',
                ...(r.data !== undefined ? { data: r.data } : {}),
                ...(r.images !== undefined ? { images: r.images } : {}),
            };
        }
    }
}

/** 模板插值(docs/20 §5.2)。未闭合 `{{` 视为普通文本;`{{{{x}}` → `{{x}}`。 */
export function renderTemplate(template: string, output: NodeOutput, ctx: { to: string; visit: number }): string {
    return template.replace(/\{\{(\{\{[^]*?\}\}|[^]*?)\}\}/g, (_m, inner: string) => {
        if (inner.startsWith('{{') && inner.endsWith('}}')) {
            return `{{${inner.slice(2, -2)}}}`; // {{{{x}} → {{x}}
        }
        const key = inner.trim();
        if (key === 'text') return output.text;
        if (key === 'visit') return String(ctx.visit);
        if (key.startsWith('data.')) return lookupPath(output.data, key.slice(5));
        return ''; // 未知变量 → 空串
    });
}

/** JSON 路径取值:a.b.c;数组下标用数字段。路径不存在 → 空串(docs/20 §5.2)。 */
function lookupPath(data: unknown, path: string): string {
    if (data === undefined || data === null) return '';
    let cur: unknown = data;
    for (const segRaw of path.split('.')) {
        const seg = segRaw.trim();
        if (cur === null || cur === undefined) return '';
        if (Array.isArray(cur)) {
            const idx = Number(seg);
            if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return '';
            cur = cur[idx];
            continue;
        }
        if (typeof cur !== 'object') return '';
        cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === undefined || cur === null) return '';
    if (typeof cur === 'string') return cur;
    if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
    return JSON.stringify(cur); // 对象/数组 → JSON 文本
}
