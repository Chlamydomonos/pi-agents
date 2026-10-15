/**
 * 图片通道纯函数(docs/20 §9,40 §5.5,M8)。
 *
 * ImageContent = { type:'image', data: base64, mimeType } — pi-ai 类型;
 * 这里不 import pi-ai(纯类型结构,作者契约 types.ts 同样零依赖)。
 *
 * 职责:
 *   - 唤醒图片收集过滤(上限:maxWakeImages/maxImageBytes,超限丢+计数,§9.2)
 *   - 函数节点产出校验(maxNodeImages → FlowError 由 runner 抛,这里只判定)
 *   - ctx.files 路径安全(禁 .. 逃逸工作区)与 mime 嗅探(png/jpeg/gif/webp)
 *   - 终点嵌图 markdown 行(20 §9.7:src 有 → 行;无 → 跳过,由调用方提示)
 *
 * 所有函数纯同步、零 IO;bytes 判定用 base64 解码前长度近似
 * (decoded ≈ base64Len * 3 / 4,足够上限判定;真实解码在 readImage 落 IO 时)。
 */

/** pi-ai ImageContent 的最小结构约束(兼容宿主类型,避免纯模块依赖) */
export interface ImageContentLike {
    type: 'image';
    data: string;
    mimeType: string;
}

/** 带 src 的节点图片(引擎内部形态,docs/20 §9.1 NodeImage) */
export interface NodeImage {
    image: ImageContentLike;
    /** 来源工作区相对路径(ctx.files.readImage 自动记录;嵌图用) */
    src?: string;
}

/** 图片上限(来自 config.images,docs/40 §11) */
export interface ImageLimits {
    maxWakeImages: number;
    maxImageBytes: number;
    maxNodeImages: number;
}

/** base64 估算解码字节数(近似;padding 不细究,上限判定足够) */
export function base64Bytes(b64: string): number {
    return Math.floor((b64.length * 3) / 4);
}

export interface CollectImagesResult {
    images: ImageContentLike[];
    /** 因超 wake 上限被丢弃的张数 */
    droppedCount: number;
    /** 因超单图上限被丢弃的张数 */
    droppedBytes: number;
}

/**
 * 唤醒图片收集过滤(40 §4.1/§5.5):按顺序收集合法图片块,
 * 超 maxImageBytes 丢单图(droppedBytes++),收集数到 maxWakeImages 后丢余下(droppedCount++)。
 * 非 image 块/形状不合法 → 静默忽略(宿主数据,不视为作者错误)。
 */
export function collectWakeImages(content: unknown, limits: ImageLimits): CollectImagesResult {
    const out: CollectImagesResult = { images: [], droppedCount: 0, droppedBytes: 0 };
    if (!Array.isArray(content)) return out;
    for (const block of content) {
        const b = block as { type?: unknown; data?: unknown; mimeType?: unknown };
        if (b?.type !== 'image' || typeof b.data !== 'string' || typeof b.mimeType !== 'string') continue;
        if (base64Bytes(b.data) > limits.maxImageBytes) {
            out.droppedBytes++;
            continue;
        }
        if (out.images.length >= limits.maxWakeImages) {
            out.droppedCount++;
            continue;
        }
        out.images.push({ type: 'image', data: b.data, mimeType: b.mimeType });
    }
    return out;
}

/** 图片块形状校验(函数节点产出/transform 显式构造用,20 §9.2)。返回错误消息或 null。 */
export function imageShapeError(value: unknown): string | null {
    if (!Array.isArray(value)) return 'images 必须是数组';
    for (let i = 0; i < value.length; i++) {
        const b = value[i] as { type?: unknown; data?: unknown; mimeType?: unknown };
        if (b === null || typeof b !== 'object' || b.type !== 'image') {
            return `images[${i}] 必须是 { type:'image', data, mimeType }`;
        }
        if (typeof b.data !== 'string' || b.data.length === 0) return `images[${i}].data 必须是非空 base64 字符串`;
        if (typeof b.mimeType !== 'string' || !b.mimeType) return `images[${i}].mimeType 必须是非空字符串`;
    }
    return null;
}

/* ------------------------------------------------------------------ */
/*  ctx.files 路径安全与 mime 嗅探(docs/20 §9.5)                        */
/* ------------------------------------------------------------------ */

/** mime 嗅探(按扩展名;不在表内 → 抛错,40 §5.5「mime 嗅探:png/jpeg/gif/webp」) */
export function sniffImageMime(relPath: string): string {
    const lower = relPath.toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    throw new Error(`不支持的图片格式(仅 png/jpeg/gif/webp):${relPath}`);
}

/**
 * 工作区内相对路径解析:返回规范化的工作区相对路径;`..` 逃逸/绝对路径 → 抛错。
 * 以 posix 分隔符比较(工作区路径约定);保留子目录与中文名。
 */
export function resolveWorkspacePath(cwd: string, relPath: string): { abs: string; rel: string } {
    if (typeof relPath !== 'string' || relPath.trim() === '') throw new Error('路径必须是非空字符串');
    const norm = relPath.replace(/\\/g, '/');
    const segments: string[] = [];
    for (const seg of norm.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (segments.length === 0) throw new Error(`路径逃逸工作区:${relPath}`);
            segments.pop();
            continue;
        }
        segments.push(seg);
    }
    if (segments.length === 0) throw new Error(`路径为空:${relPath}`);
    const rel = segments.join('/');
    return { abs: `${cwd.replace(/\/+$/, '')}/${rel}`, rel };
}

/* ------------------------------------------------------------------ */
/*  终点嵌图(docs/20 §9.7,40 §5.5 embedFinalImages)                     */
/* ------------------------------------------------------------------ */

/** 单张图 → markdown 行;无 src → null(调用方计数并 thinking 提示) */
export function embedImageLine(img: NodeImage): string | null {
    if (!img.src) return null;
    return `![工作流图片](${img.src})`;
}

/**
 * 终点嵌图(docs/40 §5.5):
 *   finalText = text + "\n\n" + 有 src 的图行("\n\n" 连接);无可用图 → 原文。
 * 返回 { text, attached, skipped } 供 thinking 行与面板统计。
 */
export function embedFinalImages(
    text: string,
    images: NodeImage[] | undefined,
): { text: string; attached: number; skipped: number } {
    if (!images || images.length === 0) return { text, attached: 0, skipped: 0 };
    const lines: string[] = [];
    let skipped = 0;
    for (const img of images) {
        const line = embedImageLine(img);
        if (line === null) skipped++;
        else lines.push(line);
    }
    if (lines.length === 0) return { text, attached: 0, skipped };
    const joined = lines.join('\n\n');
    return { text: text.trim().length > 0 ? `${text}\n\n${joined}` : joined, attached: lines.length, skipped };
}
