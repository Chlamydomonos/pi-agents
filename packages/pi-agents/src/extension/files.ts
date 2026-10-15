/**
 * 函数节点 ctx.files 工作区文件助手(docs/20 §9.5,M8)。
 *
 * - 路径安全:resolveWorkspacePath(禁 .. 逃逸);readImage 记录 src 相对路径(嵌图用)
 * - 上限:readImage 超 maxImageBytes 抛错;readText 超 1MiB 抛错
 * - mime 嗅探:png/jpeg/gif/webp 之外抛错
 * - list 返回工作区相对路径(目录不存在返回 [],不抛——comfyui-output 尚未生成的常态)
 *
 * 纯 Node fs;工厂按当前 cwd 构造(节点执行时调用,读到的文件即时生效)。
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FuncFileHelpers, NodeImage } from './types.js';
import { base64Bytes, resolveWorkspacePath, sniffImageMime, type ImageLimits } from './shared/images.js';

const TEXT_LIMIT = 1024 * 1024; // readText 上限(docs/20 §2.2)

export function createFileHelpers(getCwd: () => string, limits: ImageLimits): FuncFileHelpers {
    return {
        async readImage(relPath: string): Promise<NodeImage> {
            const { abs, rel } = resolveWorkspacePath(getCwd(), relPath);
            sniffImageMime(rel); // 扩展名不支持 → 抛错(读文件前)
            let buf: Buffer;
            try {
                buf = await readFile(abs);
            } catch (error) {
                throw new Error(`读取图片失败(${rel}): ${error instanceof Error ? error.message : String(error)}`);
            }
            if (buf.byteLength > limits.maxImageBytes) {
                throw new Error(
                    `图片超过单图上限(${Math.floor(limits.maxImageBytes / 1024)}KiB):${rel}(${Math.floor(buf.byteLength / 1024)}KiB)`,
                );
            }
            return { image: { type: 'image', data: buf.toString('base64'), mimeType: sniffImageMime(rel) }, src: rel };
        },

        async readText(relPath: string): Promise<string> {
            const { abs, rel } = resolveWorkspacePath(getCwd(), relPath);
            let buf: Buffer;
            try {
                buf = await readFile(abs);
            } catch (error) {
                throw new Error(`读取文件失败(${rel}): ${error instanceof Error ? error.message : String(error)}`);
            }
            if (buf.byteLength > TEXT_LIMIT) {
                throw new Error(`文件超过 1MiB 上限:${rel}(${Math.floor(buf.byteLength / 1024)}KiB)`);
            }
            return buf.toString('utf8');
        },

        async list(relDir: string): Promise<string[]> {
            const { abs, rel } = resolveWorkspacePath(getCwd(), relDir);
            let st;
            try {
                st = await stat(abs);
            } catch {
                return []; // 目录不存在 = 空列表(docs/20 §9.5)
            }
            if (!st.isDirectory()) {
                throw new Error(`不是目录:${rel}`);
            }
            const names = await readdir(abs, { withFileTypes: true });
            // 相对路径列表;目录项带尾部 /(作者可拼子路径);按名称排序稳定输出
            return names
                .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
                .sort((a, b) => a.localeCompare(b))
                .map((name) => join(rel, name).replace(/\\/g, '/'));
        },
    };
}

/** 唤醒入口图片给入口 Agent 节点的 prompt images(20 §9.3);上限已由收集保证 */
export { base64Bytes };
