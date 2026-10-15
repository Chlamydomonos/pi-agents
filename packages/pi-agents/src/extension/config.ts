/**
 * 两级 JSON 配置(docs/40 §11):
 *   全局   ~/.pi/agent/chlamydomonos-agents/config.json
 *   工作区 <cwd>/.pi/chlamydomonos-agents/config.json
 * 浅合并,工作区覆盖;未知/非法键 warn+跳过;两层各自 mtime 缓存。
 *
 * 旧路径(全局 ~/.pi/agent/pi-agents.json、工作区 <cwd>/.pi/pi-agents.json)
 * 已弃用:作为最低优先级回退继续读取(避免升级后静默丢配置 → 模型漂移),
 * 同时发一次性 warning 提示迁移到新路径。
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type HistoryFootprint = 'full' | 'compact';

/** 图片通道上限(docs/20 §9.2,40 §11;0 = 关闭对应通道) */
export interface ImagesConfig {
    /** 宿主唤醒附图上限,超出丢弃尾图 */
    maxWakeImages: number;
    /** 单图字节上限;超出丢弃(唤醒图)/抛错(函数节点读图) */
    maxImageBytes: number;
    /** 单节点产出上限;超出 → 工作流 error */
    maxNodeImages: number;
    /** 终点嵌图:markdown | off(docs/20 §9.7) */
    embedFinalImages: 'markdown' | 'off';
}

export interface PiAgentsConfig {
    /** 模型解析链第 3 级(节点 > Agent > 此处 > pi 默认);空 = 跳过本级 */
    model: string;
    /** 同链;空 = medium */
    thinkingLevel: string;
    /** spawn_* 缺省会话语义(D7) */
    subagentSession: 'stateless' | 'inherit';
    /** thinking 前缀标注(docs/30 §3.2) */
    streamPrefixes: boolean;
    /** 宿主上下文占用(docs/40 §10) */
    historyFootprint: HistoryFootprint;
    /** 单唤醒总跳数硬上限(docs/40 §4.3) */
    maxHops: number;
    /** 记账与 appendEntry 开关 */
    usage: boolean;
    /** 图片通道(M8) */
    images: ImagesConfig;
    /**
     * 宿主标题生成请求专用模型(provider/id 形式;空 = 跟随会话模型)。
     * 背景:pi-web 用会话模型生成会话标题——虚拟工作流模型会被误触发完整运行一遍;
     * 配置后标题请求改走该真实模型,不再唤醒工作流。
     */
    titleModel: string;
}

export const DEFAULT_CONFIG: PiAgentsConfig = {
    model: '',
    thinkingLevel: '',
    subagentSession: 'stateless',
    streamPrefixes: true,
    historyFootprint: 'full',
    maxHops: 64,
    usage: true,
    titleModel: '',
    images: {
        maxWakeImages: 4,
        maxImageBytes: 2 * 1024 * 1024,
        maxNodeImages: 8,
        embedFinalImages: 'markdown',
    },
};

export type Warn = (message: string) => void;

/** Cached raw JSON per file path. `value: null` = missing/bad file(cached)。 */
interface CacheEntry {
    mtimeMs: number;
    value: unknown | null;
}

const cache = new Map<string, CacheEntry>();

function readJsonFile(path: string, warn: Warn): unknown | null {
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(path).mtimeMs;
    } catch {
        return null; // 缺文件不算错
    }
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    let value: unknown | null = null;
    try {
        value = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        warn(`配置解析失败 (${path}): ${error instanceof Error ? error.message : String(error)}`);
        value = null;
    }
    cache.set(path, { mtimeMs, value });
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, key: string, warn: Warn): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim() === '') {
        warn(`配置键 ${key} 无效(${JSON.stringify(value)}),已忽略`);
        return undefined;
    }
    return value;
}

function asPositiveInt(value: unknown, key: string, warn: Warn, min: number, max: number): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        warn(`配置键 ${key} 无效(${JSON.stringify(value)}),已忽略`);
        return undefined;
    }
    return value;
}

function asBool(value: unknown, key: string, warn: Warn): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') {
        warn(`配置键 ${key} 必须是布尔,已忽略`);
        return undefined;
    }
    return value;
}

/** 已发过弃用告警的旧路径(每进程每路径一次,避免刷屏) */
const legacyWarned = new Set<string>();

/** 旧路径存在 → 每路径一次性告警,提示迁移(读取照旧,作为最低优先级回退)。 */
function warnLegacy(legacyPath: string, newPath: string, warn: Warn): void {
    if (legacyWarned.has(legacyPath)) return;
    try {
        statSync(legacyPath);
    } catch {
        return; // 不存在 → 无告警
    }
    legacyWarned.add(legacyPath);
    warn(`检测到已弃用配置 ${legacyPath};请移动到 ${newPath}(旧路径仍可读,但将被移除)`);
}

/**
 * 读取并合并两级配置。所有路径都缺文件 → 默认值(不告警)。
 * 解析失败 → warning + 默认值(错误不致命,pi 惯例);每次调用都做 mtime 缓存检查。
 */
export function loadConfig(cwd: string, warn: Warn, homeDir: string = homedir()): PiAgentsConfig {
    const globalFile = join(homeDir, '.pi', 'agent', 'chlamydomonos-agents', 'config.json');
    const workspaceFile = join(cwd, '.pi', 'chlamydomonos-agents', 'config.json');
    // 弃用回退:优先级低于同作用域的新路径
    const globalLegacy = join(homeDir, '.pi', 'agent', 'pi-agents.json');
    const workspaceLegacy = join(cwd, '.pi', 'pi-agents.json');
    warnLegacy(globalLegacy, globalFile, warn);
    warnLegacy(workspaceLegacy, workspaceFile, warn);

    // 优先级从低到高:全局旧 < 全局新 < 工作区旧 < 工作区新
    let merged: Record<string, unknown> = {};
    for (const file of [globalLegacy, globalFile, workspaceLegacy, workspaceFile]) {
        const raw = readJsonFile(file, warn);
        if (raw === null) continue;
        if (!isRecord(raw)) {
            warn(`配置文件必须是对象 (${file}),已忽略`);
            continue;
        }
        merged = { ...merged, ...raw };
    }

    const cfg: PiAgentsConfig = { ...DEFAULT_CONFIG };

    const model = asString(merged.model, 'model', warn);
    if (model !== undefined) cfg.model = model;

    const thinkingLevel = asString(merged.thinkingLevel, 'thinkingLevel', warn);
    if (thinkingLevel !== undefined) {
        if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinkingLevel)) {
            warn(`配置键 thinkingLevel 无效(${thinkingLevel}),已忽略`);
        } else {
            cfg.thinkingLevel = thinkingLevel;
        }
    }

    const subagentSession = asString(merged.subagentSession, 'subagentSession', warn);
    if (subagentSession !== undefined) {
        if (subagentSession !== 'stateless' && subagentSession !== 'inherit') {
            warn(`配置键 subagentSession 无效(${subagentSession}),已忽略`);
        } else {
            cfg.subagentSession = subagentSession;
        }
    }

    const streamPrefixes = asBool(merged.streamPrefixes, 'streamPrefixes', warn);
    if (streamPrefixes !== undefined) cfg.streamPrefixes = streamPrefixes;

    const titleModel = asString(merged.titleModel, 'titleModel', warn);
    if (titleModel !== undefined) {
        if (!titleModel.includes('/') || titleModel.startsWith('/') || titleModel.endsWith('/')) {
            warn(`配置键 titleModel 无效(需 provider/id 形式):${titleModel},已忽略`);
        } else {
            cfg.titleModel = titleModel;
        }
    }

    const historyFootprint = asString(merged.historyFootprint, 'historyFootprint', warn);
    if (historyFootprint !== undefined) {
        if (historyFootprint !== 'full' && historyFootprint !== 'compact') {
            warn(`配置键 historyFootprint 无效(${historyFootprint}),已忽略`);
        } else {
            cfg.historyFootprint = historyFootprint;
        }
    }

    const maxHops = asPositiveInt(merged.maxHops, 'maxHops', warn, 1, 10_000);
    if (maxHops !== undefined) cfg.maxHops = maxHops;

    const usage = asBool(merged.usage, 'usage', warn);
    if (usage !== undefined) cfg.usage = usage;

    // images 配置组(docs/40 §11):浅合并进默认组;非对象整体忽略(保留默认)
    const rawImages = merged.images;
    if (rawImages !== undefined) {
        if (!isRecord(rawImages)) {
            warn('配置键 images 无效(必须是对象),已忽略');
        } else {
            const maxWakeImages = asPositiveInt(rawImages.maxWakeImages, 'images.maxWakeImages', warn, 0, 100);
            if (maxWakeImages !== undefined) cfg.images.maxWakeImages = maxWakeImages;
            const maxImageBytes = asPositiveInt(rawImages.maxImageBytes, 'images.maxImageBytes', warn, 0, 1024 ** 3);
            if (maxImageBytes !== undefined) cfg.images.maxImageBytes = maxImageBytes;
            const maxNodeImages = asPositiveInt(rawImages.maxNodeImages, 'images.maxNodeImages', warn, 0, 100);
            if (maxNodeImages !== undefined) cfg.images.maxNodeImages = maxNodeImages;
            const embedFinalImages = rawImages.embedFinalImages;
            if (embedFinalImages !== undefined) {
                if (embedFinalImages !== 'markdown' && embedFinalImages !== 'off') {
                    warn(`配置键 images.embedFinalImages 无效(${JSON.stringify(embedFinalImages)}),已忽略`);
                } else {
                    cfg.images.embedFinalImages = embedFinalImages;
                }
            }
        }
    }

    return cfg;
}

/** 测试用:清空 mtime 缓存 */
export function clearConfigCache(): void {
    cache.clear();
}
