import { Schema } from '@chatluna/schema';
import { defineTool } from '@chatluna/tool';
import { ChatMessage } from '@chatluna/message';
import { registerCards } from './card.js';
import { CacheService } from './cache.js';
import { describeCommentImages, toMarkdownImage } from './comment-image.js';
import { parseBilibili } from './parsers/bilibili.js';
import { parseXiaohongshu } from './parsers/xiaohongshu.js';
import { detectPlatform, isMediaUrl, normalizeInputUrl } from './utils/url.js';
export * from './config.js';
async function readPost(ctx, cfg, input) {
    const url = normalizeInputUrl(input);
    const platform = detectPlatform(url);
    if (!platform || !cfg[platform].enabled)
        throw new Error('链接不受支持或该平台已停用。');
    const cache = new CacheService(ctx, cfg);
    const req = { url, bilibiliVideoQuality: cfg.bilibili.videoQuality, bilibiliAudioQuality: cfg.bilibili.audioQuality,
        bilibiliMergeAudio: cfg.bilibili.mergeAudio, bilibiliParseComments: cfg.bilibili.parseComments,
        bilibiliCommentsCount: cfg.bilibili.commentsCount, xiaohongshuMaxImages: cfg.xiaohongshu.maxImages,
        cacheMedia: cfg.cache.cacheMedia, maxMediaMB: cfg.cache.maxMediaMB };
    const key = cache.createKey(req);
    cfg.signal?.throwIfAborted();
    const hit = await cache.get(key);
    let data = hit;
    if (!data) {
        const result = platform === 'bilibili' ? await parseBilibili(url, cfg, req) : await parseXiaohongshu(url, cfg);
        cfg.signal?.throwIfAborted();
        data = createTransientResult(key, result);
        if (cfg.cache.enabled) {
            try {
                data = await cache.set(key, result, cfg.bilibili.mergeAudio);
            }
            catch {
                cfg.signal?.throwIfAborted();
                ctx.logger.warn('缓存写入失败，保留原始解析结果。');
            }
        }
    }
    const output = await formatOutput(data, !!hit, cfg.cache.cacheMedia, cfg.debug, ctx, cfg);
    const media = [];
    const seen = new Set();
    function attach(url, mediaType) {
        if (seen.has(url) || !url || !(url.startsWith('storage://') || isMediaUrl(url)))
            return;
        seen.add(url);
        media.push({ type: 'file', mediaType, data: url.startsWith('storage://')
                ? { type: 'reference', reference: url } : { type: 'url', url } });
    }
    function attachSources(urls, cached, kind) {
        for (const url of urls) {
            const item = cached.find(entry => entry.source === url);
            if (cfg.cache.enabled && cfg.cache.cacheMedia && ctx.get('chatluna_storage') && !item)
                continue;
            const mediaType = item?.mimeType || mediaTypeFromUrl(url);
            if (mediaType?.startsWith(kind + '/'))
                attach(item?.stored || url, mediaType);
        }
    }
    attachSources(data.result.images, data.cached.images, 'image');
    if (data.cached.mergedVideo)
        attach(data.cached.mergedVideo, 'video/mp4');
    else {
        attachSources(data.result.videos, data.cached.videos, 'video');
        for (const item of data.cached.audios) {
            if (item.mimeType === 'audio/mpeg' || item.mimeType === 'audio/wav')
                attach(item.stored, item.mimeType);
        }
    }
    cfg.signal?.throwIfAborted();
    return { output, media };
}
export async function apply(ctx, cfg) {
    registerCards(ctx, cfg);
    if (!cfg.tool.enabled)
        return;
    await new CacheService(ctx, cfg).init();
    ctx.tools.define(defineTool({
        name: cfg.tool.name, description: cfg.tool.description,
        args: Schema.object({ url: Schema.string().required().description('小红书笔记或哔哩哔哩视频链接，支持分享短链。') }),
        traits: { effect: 'read', parallel: true },
        async run({ url }, call) {
            const { output, media } = await readPost(ctx, { ...cfg, signal: call.signal }, url);
            if (media.length)
                call.note(ChatMessage.notice('social-media-reader', media));
            return output;
        }
    }));
}
async function formatOutput(data, fromCache, preferStoredLink, includeVerbose, ctx, cfg) {
    const commentImageMap = new Map(data.cached.commentImages.map(item => [item.source, item.stored]));
    const links = (sources, cached) => sources.map(url => preferStoredLink ? cached.find(item => item.source === url)?.stored || url : url);
    const images = links(data.result.images, data.cached.images);
    const videos = links(data.result.videos, data.cached.videos);
    const audios = links(data.result.audios, data.cached.audios);
    const pickOne = (items) => (items.length ? items[0] : '');
    const pickFirst = (items) => (items.length ? items[0] : null);
    const mergedVideo = preferStoredLink && data.cached.mergedVideo
        ? data.cached.mergedVideo
        : '';
    const cover = pickOne(images) || data.result.cover || '';
    const primaryVideo = pickOne(videos);
    const primaryAudio = pickOne(audios);
    const output = {
        url: data.result.url,
        platform: data.result.platform
    };
    if (cover) {
        output.cover = cover;
    }
    output.title = data.result.title;
    if (data.result.author) {
        output.author = data.result.author;
    }
    if (data.result.platform === 'bilibili') {
        const extra = data.result.extra;
        const description = data.result.content || '';
        const durationSec = Number(extra?.['durationSec'] || 0);
        const engagement = extra && typeof extra['engagement'] === 'object'
            ? extra['engagement']
            : undefined;
        const hotComments = extra && Array.isArray(extra['hotComments'])
            ? extra['hotComments']
            : undefined;
        const pinnedComment = extra && typeof extra['pinnedComment'] === 'object'
            ? extra['pinnedComment']
            : undefined;
        const tagsRaw = extra && Array.isArray(extra['tags'])
            ? extra['tags']
            : [];
        output.description = description;
        const tags = tagsRaw
            .map((item) => {
            if (!item || typeof item !== 'object') {
                return null;
            }
            const row = item;
            const name = String(row.name || '').trim();
            if (!name) {
                return null;
            }
            return name;
        })
            .filter((item) => item !== null);
        if (tags.length) {
            output.tags = tags;
        }
        const descs = new Map(data.cached.commentImages
            .filter((item) => item.description)
            .map((item) => [item.stored, item.description]));
        const miss = [pinnedComment, ...(hotComments || [])]
            .filter((item) => !!item && typeof item === 'object')
            .flatMap((item) => {
            const text = String(item.content || '');
            const images = (Array.isArray(item.images)
                ? item.images.filter((it) => typeof it === 'string' && it.length > 0)
                : [])
                .map((url) => preferStoredLink ? (commentImageMap.get(url) || url) : url)
                .filter((url) => !descs.has(url));
            return images.map((url) => ({ url, text }));
        });
        if (miss.length) {
            const extra = await describeCommentImages(ctx, cfg, miss);
            for (const [url, text] of extra) {
                descs.set(url, text);
            }
        }
        const normalizeComment = (value) => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            const item = value;
            const text = String(item.content || '');
            const likes = Number(item.likes || 0);
            const replies = Number(item.replies || 0);
            const images = (Array.isArray(item.images)
                ? item.images.filter((it) => typeof it === 'string' && it.length > 0)
                : [])
                .map((url) => preferStoredLink ? (commentImageMap.get(url) || url) : url)
                .map((url) => toMarkdownImage(descs.get(url) || '', url));
            if (!text && !images.length) {
                return null;
            }
            return {
                content: text || '[图片评论]',
                likes,
                replies,
                ...(images.length ? { images } : {})
            };
        };
        const normalizedPinnedComment = normalizeComment(pinnedComment);
        const normalizedHotComments = hotComments
            ? hotComments
                .map((item) => normalizeComment(item))
                .filter((item) => item !== null)
            : [];
        if (mergedVideo) {
            output.video = mergedVideo;
        }
        else if (primaryVideo || primaryAudio) {
            output.videoResources = {
                ...(primaryVideo ? { video: primaryVideo } : {}),
                ...(primaryAudio ? { audio: primaryAudio } : {})
            };
        }
        output.duration = formatDuration(durationSec);
        if (engagement) {
            output.engagement = engagement;
        }
        if (normalizedPinnedComment) {
            output.pinnedComment = normalizedPinnedComment;
        }
        if (normalizedHotComments.length) {
            output.hotComments = normalizedHotComments;
        }
    }
    else {
        output.content = data.result.content;
        if (primaryVideo) {
            output.video = primaryVideo;
        }
        else if (images.length) {
            output.resources = { images };
        }
    }
    if (!includeVerbose) {
        return output;
    }
    return {
        ...output,
        debug: {
            fromCache,
            createdAt: new Date(data.createdAt).toISOString(),
            expiresAt: new Date(data.expiresAt).toISOString(),
            resourceCount: {
                images: images.length,
                videos: videos.length,
                audios: audios.length
            },
            cachedResources: {
                images: pickFirst(data.cached.images),
                commentImages: pickFirst(data.cached.commentImages),
                videos: pickFirst(data.cached.videos),
                audios: pickFirst(data.cached.audios),
                mergedVideo: data.cached.mergedVideo || ''
            }
        }
    };
}
function mediaTypeFromUrl(url) {
    if (!isMediaUrl(url))
        return;
    const extension = new URL(url).pathname.match(/\.(jpg|jpeg|png|webp|gif|avif|mp4)$/i)?.[1].toLowerCase();
    if (extension === 'mp4')
        return 'video/mp4';
    if (extension)
        return 'image/' + (extension === 'jpg' ? 'jpeg' : extension);
}
function formatDuration(totalSeconds) {
    const sec = Number.isFinite(totalSeconds) && totalSeconds > 0
        ? Math.floor(totalSeconds)
        : 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function createTransientResult(key, result) {
    const now = Date.now();
    return {
        key,
        createdAt: now,
        expiresAt: now,
        result,
        cached: {
            images: [],
            commentImages: [],
            videos: [],
            audios: [],
            mergedVideo: ''
        }
    };
}
