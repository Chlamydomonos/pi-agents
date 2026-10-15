/**
 * M8 图片通道单元测试(docs/20 §9、docs/40 §4.1/§5.5)。
 *
 * 覆盖:collectWakeImages 上限过滤 / embedFinalImages 嵌图 / createFileHelpers
 * (readImage 读取+上限+mime、readText、list)/ runner 函数节点图片产出校验 /
 * pass 'forward' 转发 / 终点嵌图(RunFlowDeps.embedFinalImages)。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWakeImages, embedFinalImages, imageShapeError } from '../src/extension/shared/images.js';
import { createFileHelpers } from '../src/extension/files.js';
import { runFlow, FlowError } from '../src/extension/engine/runner.js';
import type { FlowDefinition, ImageContent, WakeContext } from '../src/extension/types.js';

const LIMITS = { maxWakeImages: 2, maxImageBytes: 16, maxNodeImages: 2 };
const TINY_PNG_B64 = 'aGk='; // "hi";base64Bytes = 3

function wake(input = '任务'): WakeContext {
    return { input, images: [], hostSessionId: 'h', wakeIndex: 1 };
}

/* ---------------- collectWakeImages(§9.2) ---------------- */

describe('collectWakeImages', () => {
    it('收集合法块并还原顺序;非 image/缺字段静默忽略', () => {
        const content = [
            { type: 'text', text: '看' },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'image' }, // 缺 data/mime → 忽略
            '裸字符串',
            { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' },
        ];
        const r = collectWakeImages(content, { maxWakeImages: 4, maxImageBytes: 1024, maxNodeImages: 8 });
        expect(r.images.map((i) => i.data)).toEqual(['AAAA', 'BBBB']);
        expect(r.droppedCount).toBe(0);
        expect(r.droppedBytes).toBe(0);
    });

    it('超单图上限 → droppedBytes;超唤醒上限 → droppedCount(丢尾)', () => {
        const big = { type: 'image', data: 'A'.repeat(100), mimeType: 'image/png' }; // ~75B > 16B
        const content = [
            big,
            { type: 'image', data: 'AA', mimeType: 'image/png' },
            big,
            { type: 'image', data: 'BB', mimeType: 'image/png' },
        ];
        const r = collectWakeImages(content, LIMITS);
        expect(r.images.map((i) => i.data)).toEqual(['AA', 'BB']); // 大图丢、后两张收满 max=2
        expect(r.droppedBytes).toBe(2);
        expect(r.droppedCount).toBe(0);
    });

    it('全超限 → images 空 + 计数', () => {
        const content = [{ type: 'image', data: 'A'.repeat(100), mimeType: 'image/png' }];
        const r = collectWakeImages(content, LIMITS);
        expect(r.images).toHaveLength(0);
        expect(r.droppedBytes).toBe(1);
    });
});

/* ---------------- embedFinalImages(§9.7) ---------------- */

describe('embedFinalImages', () => {
    it('有 src 的图追加 markdown 图行;无 src 跳过', () => {
        const r = embedFinalImages('结论', [
            { image: { type: 'image', data: 'x', mimeType: 'image/png' }, src: 'out/a.png' },
            { image: { type: 'image', data: 'y', mimeType: 'image/jpeg' } }, // 无 src → skip
        ]);
        expect(r.text).toBe('结论\n\n![工作流图片](out/a.png)');
        expect(r.attached).toBe(1);
        expect(r.skipped).toBe(1);
    });

    it('无图 = 原文本;空文本但有图 = 仅图行', () => {
        expect(embedFinalImages('文本', []).text).toBe('文本');
        const r = embedFinalImages('', [{ image: { type: 'image', data: 'x', mimeType: 'image/png' }, src: 'b.png' }]);
        expect(r.text).toBe('![工作流图片](b.png)');
        expect(r.attached).toBe(1);
    });

    it('路径含空格/中文/括号原样输出;data: URI 也会照写(渲染层 pi-web 拒绝 isSafeUrl 外的协议)', () => {
        const r = embedFinalImages('t', [
            { image: { type: 'image', data: 'x', mimeType: 'image/png' }, src: '输出 01/图(1).png' },
            { image: { type: 'image', data: 'y', mimeType: 'image/png' }, src: 'data:image/png;base64,AAAA' },
        ]);
        expect(r.text).toContain('![工作流图片](输出 01/图(1).png)');
        expect(r.text).toContain('![工作流图片](data:image/png;base64,AAAA)');
        expect(r.attached).toBe(2);
    });
});

/* ---------------- imageShapeError(§9.6) ---------------- */

describe('imageShapeError', () => {
    it('合法 ImageContent/null;非数组/缺字段/空 mime 报错', () => {
        expect(imageShapeError([{ type: 'image', data: 'AA', mimeType: 'image/png' }])).toBeNull();
        expect(imageShapeError('x')).toContain('数组');
        expect(imageShapeError([{ type: 'image', data: 1, mimeType: 'image/png' }])).toContain('data');
        expect(imageShapeError([{ type: 'image', data: 'AA', mimeType: '' }])).toContain('mimeType');
    });
});

/* ---------------- createFileHelpers(§9.5) ---------------- */

describe('createFileHelpers', () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'piagents-m8-'));
        mkdirSync(join(dir, 'out'));
        // 1x1 透明 PNG(89 50 4E 47 魔数;嗅探按扩展名,内容任意)
        writeFileSync(join(dir, 'out', 'a.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
        writeFileSync(join(dir, 'note.txt'), '你好\n第二行');
        writeFileSync(join(dir, 'out', 'big.png'), Buffer.alloc(LIMITS.maxImageBytes + 1, 7));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('readImage:读取+base64+src 记录', async () => {
        const files = createFileHelpers(() => dir, { ...LIMITS, maxImageBytes: 1024 * 1024 });
        const img = await files.readImage('out/a.png');
        expect(img.image.mimeType).toBe('image/png');
        expect(img.src).toBe('out/a.png');
        expect(typeof img.image.data).toBe('string');
        expect(img.image.data.length).toBeGreaterThan(0);
    });

    it('readImage:超上限抛错(含路径);不支持 mime 抛错;逃逸抛错', async () => {
        const files = createFileHelpers(() => dir, LIMITS);
        await expect(files.readImage('out/big.png')).rejects.toThrow('单图上限');
        await expect(files.readImage('out/a.txt')).rejects.toThrow('不支持的图片格式');
        await expect(files.readImage('../secret.png')).rejects.toThrow();
    });

    it('readText:读全文;超 1MiB 抛错', async () => {
        const files = createFileHelpers(() => dir, LIMITS);
        expect(await files.readText('note.txt')).toBe('你好\n第二行');
        writeFileSync(join(dir, 'huge.txt'), Buffer.alloc(1024 * 1024 + 1, 1));
        await expect(files.readText('huge.txt')).rejects.toThrow('1MiB');
    });

    it('list:目录项相对路径(目录带 /);不存在 → []', async () => {
        const files = createFileHelpers(() => dir, LIMITS);
        const items = await files.list('out');
        expect(items).toEqual(['out/a.png', 'out/big.png']);
        expect(await files.list('missing-dir')).toEqual([]);
    });
});

/* ---------------- runner 集成(§9.3/9.4/9.6/9.7) ---------------- */

function agentFlow(partial: Partial<FlowDefinition>): FlowDefinition {
    return {
        name: 'f',
        title: 'T',
        description: 'D',
        nodes: { a: { agent: 'x' }, b: { agent: 'y' } },
        entry: 'a',
        edges: { a: 'b' },
        ...partial,
    } as FlowDefinition;
}

const fakeExec =
    (script: Record<string, (input: string, images: ImageContent[]) => string>) =>
    async (agentName: string, input: string, _spec: unknown, ctx: { images: ImageContent[] }) => ({
        text: script[agentName]?.(input, ctx.images) ?? `E(${agentName})`,
        stats: {
            durationMs: 1,
            llmRequests: 1,
            toolCalls: 0,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
    });

describe('runFlow 图片通道', () => {
    it('入口节点收到 wake.images;pass forward 把上游图转给下游;终点嵌图', async () => {
        const img: ImageContent = { type: 'image', data: 'QQ==', mimeType: 'image/png' };
        const seen: Record<string, ImageContent[]> = {};
        const flow = agentFlow({
            nodes: { a: { agent: 'x' }, b: { agent: 'y' } },
            edges: { a: { route: () => 'b', pass: { mode: 'text', images: 'forward' } } },
        });
        const r = await runFlow(
            flow,
            { ...wake(), images: [img] },
            {
                executeAgentNode: async (agent, _input, _spec, ctx) => {
                    seen[agent] = ctx.images;
                    return {
                        text: `${agent}完成`,
                        // a 产无 src 的图(forward 语义:NodeImage → .image 转发);y 产带 src 图(终点嵌图)
                        images:
                            agent === 'x'
                                ? [{ image: img }]
                                : agent === 'y'
                                  ? [{ image: img, src: 'out/y.png' }]
                                  : undefined,
                        stats: {
                            durationMs: 1,
                            llmRequests: 1,
                            toolCalls: 0,
                            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        },
                    };
                },
            },
        );
        // 入口带图、下游 forward 收图
        expect(seen.x).toEqual([img]);
        expect(seen.y).toEqual([img]);
        // 终点 y 有 src 图 → 嵌图 markdown;images 字段回传
        expect(r.text).toBe('y完成\n\n![工作流图片](out/y.png)');
        expect(r.images).toEqual([{ image: img, src: 'out/y.png' }]);
        expect(r.embed).toEqual({ attached: 1, skipped: 0 });
    });

    it('pass 非 forward → 下游空图;embedFinalImages off → 不嵌', async () => {
        const img: ImageContent = { type: 'image', data: 'QQ==', mimeType: 'image/png' };
        const seen: Record<string, ImageContent[]> = {};
        const r = await runFlow(
            agentFlow({}),
            { ...wake(), images: [img] },
            {
                executeAgentNode: async (agent, _input, _spec, ctx) => {
                    seen[agent] = ctx.images;
                    return {
                        text: `${agent}ok`,
                        ...(agent === 'y' ? { images: [{ image: img, src: 'b.png' }] } : {}),
                        stats: {
                            durationMs: 1,
                            llmRequests: 1,
                            toolCalls: 0,
                            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        },
                    };
                },
                embedFinalImages: 'off',
            },
        );
        expect(seen.y).toEqual([]); // text pass 无 images:'forward' → 空
        expect(r.text).toBe('yok'); // off → 原文本
        expect(r.images).toEqual([{ image: img, src: 'b.png' }]);
        expect(r.embed).toBeUndefined();
    });

    it('route done / maxIterations 终点同样嵌图', async () => {
        const img: ImageContent = { type: 'image', data: 'QQ==', mimeType: 'image/png' };
        const flow = agentFlow({
            edges: { a: { route: () => 'done', maxIterations: 3 } },
        });
        const r = await runFlow(flow, wake(), {
            executeAgentNode: async () => ({
                text: '完',
                images: [{ image: img, src: 'd.png' }],
                stats: {
                    durationMs: 1,
                    llmRequests: 1,
                    toolCalls: 0,
                    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
            }),
        });
        expect(r.text).toBe('完\n\n![工作流图片](d.png)');
    });

    it('函数节点 images 产出:合法 → NodeOutput.images + 终点嵌图;超上限/坏形 → FlowError', async () => {
        const img: ImageContent = { type: 'image', data: TINY_PNG_B64, mimeType: 'image/png' };
        const flow = agentFlow({
            nodes: { a: { run: () => ({ text: '做了', images: [img] }) }, b: { agent: 'x' } },
        });
        const r = await runFlow(flow, wake(), { executeAgentNode: fakeExec({ x: (i) => i }) });
        expect(r.text).toBe('做了'); // a 函数节点产出文本经 pass 传给 b;b 回显为终
        expect(r.images).toBeUndefined();

        const bad = agentFlow({ nodes: { a: { run: () => ({ text: 'x', images: [{ type: 'image' }] }) } }, edges: {} });
        await expect(runFlow(bad, wake(), { executeAgentNode: fakeExec({}) })).rejects.toThrow(FlowError);

        const tooMany = agentFlow({
            nodes: { a: { run: () => ({ text: 'x', images: [img, img, img] }) } }, // maxNodeImages=2
            edges: {},
        });
        await expect(
            runFlow(tooMany, wake(), {
                executeAgentNode: fakeExec({ x: (i) => i }),
                imageLimits: LIMITS, // maxNodeImages=2
            }),
        ).rejects.toThrow('超过上限');
    });

    it('函数节点缺 fileHelpers → ctx.files.readImage 抛错包成 FlowError', async () => {
        const flow = agentFlow({
            nodes: {
                a: {
                    run: async (_i, ctx) => {
                        await ctx.files.readImage('x.png');
                        return 'ok';
                    },
                },
            },
            edges: {},
        });
        await expect(runFlow(flow, wake(), { executeAgentNode: fakeExec({}) })).rejects.toThrow('files 助手未启用');
    });
});
