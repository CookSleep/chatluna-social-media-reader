import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fetchMedia, readLimited } from './utils/url.js';
import { describeCommentImages } from './comment-image.js';
const TABLE = 'chatluna_social_media_cache';
export class CacheService {
    ctx;
    cfg;
    warnedStorageUnavailable = false;
    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
    }
    async init() {
        this.ctx.model.extend(TABLE, {
            key: { type: 'string', length: 64 },
            createdAt: 'timestamp',
            expiresAt: 'timestamp',
            result: 'text',
            cached: 'text'
        }, { primary: 'key' });
        if (!this.cfg.cache.enabled)
            return;
        await this.cleanupExpired();
        this.ctx.interval(() => this.cleanupExpired(), 600_000);
    }
    createKey(req) {
        return crypto
            .createHash('sha1')
            .update(JSON.stringify([req, this.cfg.bilibili.maxDescLength, this.cfg.bilibili.describeCommentImages, this.cfg.commentImageService.model, this.cfg.commentImageService.prompt]))
            .digest('hex');
    }
    async get(key) {
        if (!this.cfg.cache.enabled)
            return null;
        const rows = await this.ctx.database.get(TABLE, { key });
        if (!rows.length)
            return null;
        const row = rows[0];
        if (Date.now() > row.expiresAt.getTime()) {
            this.debug('缓存过期，删除记录', { key });
            await this.ctx.database.remove(TABLE, { key });
            return null;
        }
        try {
            return this.decode(row);
        }
        catch {
            this.debug('缓存记录反序列化失败，删除记录', { key });
            await this.ctx.database.remove(TABLE, { key });
            return null;
        }
    }
    async set(key, result, mergeAudio) {
        const cached = {
            images: [],
            commentImages: [],
            videos: [],
            audios: [],
            mergedVideo: ''
        };
        if (this.cfg.cache.cacheMedia && this.hasStorageService()) {
            cached.images = await this.downloadMany(result.images, 'image');
            cached.commentImages = await this.downloadMany(extractBilibiliCommentImageUrls(result), 'comment-image');
            if (cached.commentImages.length) {
                const descs = await describeCommentImages(this.ctx, this.cfg, extractBilibiliCommentImages(result));
                cached.commentImages = cached.commentImages.map((item) => ({
                    ...item,
                    description: descs.get(item.source) || ''
                }));
            }
            if (mergeAudio && result.platform === 'bilibili' && result.videos[0] && result.audios[0]) {
                const merged = await this.mergeFromSources(result.videos[0], result.audios[0]);
                if (merged) {
                    cached.mergedVideo = merged;
                }
                else {
                    cached.videos = await this.downloadMany(result.videos, 'video');
                    cached.audios = await this.downloadMany(result.audios, 'audio');
                }
            }
            else {
                cached.videos = await this.downloadMany(result.videos, 'video');
                cached.audios = await this.downloadMany(result.audios, 'audio');
            }
        }
        else if (this.cfg.cache.cacheMedia && !this.warnedStorageUnavailable) {
            this.warnedStorageUnavailable = true;
            this.ctx.logger.debug('未启用 V2 文件存储，保留原始媒体链接。');
        }
        const now = Date.now();
        const compact = compactResult(result);
        const record = {
            key,
            createdAt: now,
            expiresAt: now + this.cfg.cache.ttlSeconds * 1000,
            result: compact,
            cached
        };
        this.cfg.signal?.throwIfAborted();
        if (!this.cfg.cache.cacheMedia || !this.hasStorageService() || this.isMediaCacheComplete(result, cached, mergeAudio)) {
            await this.ctx.database.upsert(TABLE, [this.encode(record)], ['key']);
        }
        return record;
    }
    async cleanupExpired() {
        this.debug('开始清理过期缓存');
        await this.ctx.database.remove(TABLE, {
            expiresAt: { $lt: new Date() }
        });
    }
    encode(record) {
        return {
            key: record.key,
            createdAt: new Date(record.createdAt),
            expiresAt: new Date(record.expiresAt),
            result: JSON.stringify(record.result),
            cached: JSON.stringify(record.cached)
        };
    }
    decode(row) {
        const parsedCached = JSON.parse(row.cached);
        return {
            key: row.key,
            createdAt: row.createdAt.getTime(),
            expiresAt: row.expiresAt.getTime(),
            result: JSON.parse(row.result),
            cached: {
                images: Array.isArray(parsedCached.images) ? parsedCached.images : [],
                commentImages: Array.isArray(parsedCached.commentImages) ? parsedCached.commentImages.map((item) => ({
                    ...item,
                    description: typeof item.description === 'string' ? item.description : ''
                })) : [],
                videos: Array.isArray(parsedCached.videos) ? parsedCached.videos : [],
                audios: Array.isArray(parsedCached.audios) ? parsedCached.audios : [],
                mergedVideo: typeof parsedCached.mergedVideo === 'string' ? parsedCached.mergedVideo : ''
            }
        };
    }
    async downloadMany(urls, kind) {
        const out = Array.from({ length: urls.length }, () => null);
        let index = 0;
        const concurrency = Math.min(this.cfg.mediaDownloadConcurrency, urls.length);
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (index < urls.length) {
                const current = index;
                index += 1;
                const url = urls[current];
                try {
                    const item = await this.download(url, `${kind}-${current + 1}`);
                    if (item)
                        out[current] = item;
                }
                catch (err) {
                    this.ctx.logger.warn(String(err));
                }
            }
        }));
        return out.filter((item) => item !== null);
    }
    async download(url, base) {
        if (!this.hasStorageService())
            return null;
        const payload = await this.fetchWithinLimit(url, `cache-${base}`);
        if (!payload)
            return null;
        if (base.startsWith('audio-') && !['audio/mpeg', 'audio/wav'].includes(payload.contentType)) {
            const mp3 = await this.convertAudio(payload.buffer);
            if (mp3) {
                payload.buffer = mp3;
                payload.contentType = 'audio/mpeg';
            }
        }
        const ext = payload.contentType === 'audio/mpeg' ? '.mp3' : guessExt(url, payload.contentType);
        const file = await this.ctx.chatluna_storage.createTempFile(payload.buffer, `${base}${ext}`, { expireHours: this.ttlHours(), mimeType: payload.contentType || 'application/octet-stream' });
        return {
            source: url,
            stored: 'storage://' + file.id,
            mimeType: payload.contentType.split(';')[0].trim().toLowerCase(),
            size: payload.buffer.length
        };
    }
    async fetchWithinLimit(url, tag = 'media') {
        const ac = new AbortController();
        const start = Date.now();
        const timer = setTimeout(() => ac.abort(), this.cfg.timeoutSeconds * 1000);
        try {
            const maxEncoded = this.cfg.cache.maxMediaMB * 1024 * 1024;
            const maxRaw = Math.floor((maxEncoded * 3) / 4);
            const res = await fetchMedia(url, {
                signal: this.cfg.signal ? AbortSignal.any([this.cfg.signal, ac.signal]) : ac.signal,
                headers: { referer: (isXhsMedia(url) ? 'https://www.xiaohongshu.com/' : 'https://www.bilibili.com/'),
                    'user-agent': this.cfg.xiaohongshu.userAgent }
            });
            if (!res.ok) {
                await res.body?.cancel();
                return null;
            }
            const buffer = await readLimited(res, maxRaw);
            this.debug('媒体下载成功并准备入库存储', {
                url,
                size: buffer.length
            });
            return {
                buffer,
                contentType: res.headers.get('content-type') || ''
            };
        }
        catch (err) {
            const host = (() => {
                try {
                    return new URL(url).host;
                }
                catch {
                    return '';
                }
            })();
            this.ctx.logger.warn(`媒体下载失败(${tag})：${err instanceof Error ? err.message : String(err)}`);
            this.debug('媒体下载失败详情', {
                tag,
                host,
                timeoutSeconds: this.cfg.timeoutSeconds,
                costMs: Date.now() - start,
                err: String(err),
                url
            });
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    ttlHours() {
        return Math.max(1, Math.ceil(this.cfg.cache.ttlSeconds / 3600));
    }
    async mergeFromSources(videoUrl, audioUrl) {
        if (!this.hasStorageService())
            return '';
        try {
            const video = await this.fetchWithinLimit(videoUrl, 'merge-video');
            if (!video)
                return '';
            const audio = await this.fetchWithinLimit(audioUrl, 'merge-audio');
            if (!audio)
                return '';
            const merged = await this.mergeMp4(video.buffer, audio.buffer);
            if (!merged)
                return '';
            const temp = await this.ctx.chatluna_storage.createTempFile(merged, 'merged.mp4', { expireHours: this.ttlHours(), mimeType: 'video/mp4' });
            return 'storage://' + temp.id;
        }
        catch (err) {
            this.ctx.logger.warn(`媒体合并失败：${err instanceof Error ? err.message : String(err)}`);
            this.debug('媒体合并失败详情', { videoUrl, audioUrl, err: String(err) });
            return '';
        }
    }
    hasStorageService() {
        return typeof this.ctx.chatluna_storage?.createTempFile === 'function';
    }
    isMediaCacheComplete(result, cached, mergeAudio) {
        const hasAllSources = (sources, items) => {
            if (!sources.length)
                return true;
            const got = new Set(items.map((item) => item.source));
            return sources.every((url) => got.has(url));
        };
        if (!hasAllSources(result.images, cached.images)) {
            return false;
        }
        const needMerged = Boolean(mergeAudio
            && result.platform === 'bilibili'
            && result.videos[0]
            && result.audios[0]);
        if (needMerged) {
            if (cached.mergedVideo) {
                return true;
            }
            return hasAllSources(result.videos, cached.videos)
                && hasAllSources(result.audios, cached.audios);
        }
        return hasAllSources(result.videos, cached.videos)
            && hasAllSources(result.audios, cached.audios);
    }
    async convertAudio(input) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatluna-smr-audio-'));
        const source = path.join(tmp, 'source.m4a');
        const output = path.join(tmp, 'audio.mp3');
        const maxBytes = Math.floor(this.cfg.cache.maxMediaMB * 1024 * 1024 * 0.75);
        try {
            await fs.writeFile(source, input);
            await promisify(execFile)('ffmpeg', [
                '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-i', source,
                '-vn', '-map', '0:a:0', '-codec:a', 'libmp3lame', '-b:a', '96k', '-fs', String(maxBytes), output
            ], { timeout: this.cfg.timeoutSeconds * 1000, signal: this.cfg.signal });
            const size = (await fs.stat(output)).size;
            if (size > 0 && size < maxBytes)
                return await fs.readFile(output);
        }
        catch {
            this.cfg.signal?.throwIfAborted();
        }
        finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    }
    async mergeMp4(video, audio) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatluna-smr-'));
        const videoFile = path.join(tmp, 'video.mp4');
        const audioFile = path.join(tmp, 'audio.m4a');
        const outFile = path.join(tmp, 'merged.mp4');
        try {
            await fs.writeFile(videoFile, video);
            await fs.writeFile(audioFile, audio);
            await promisify(execFile)('ffmpeg', [
                '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'mov', '-i', videoFile,
                '-protocol_whitelist', 'file', '-f', 'mov', '-i', audioFile, '-map', '0:v:0', '-map', '1:a:0',
                '-c:v', 'copy', '-c:a', 'aac', '-shortest', outFile
            ], { timeout: this.cfg.timeoutSeconds * 1000, signal: this.cfg.signal });
            if ((await fs.stat(outFile)).size * 4 / 3 > this.cfg.cache.maxMediaMB * 1024 * 1024)
                return null;
            return await fs.readFile(outFile);
        }
        catch {
            this.debug('FFmpeg 合并失败');
            return null;
        }
        finally {
            await fs.rm(tmp, { recursive: true, force: true });
        }
    }
    debug(message, payload) {
        if (!this.cfg.debug)
            return;
        if (payload == null) {
            this.ctx.logger.debug(message);
            return;
        }
        this.ctx.logger.debug(message, payload);
    }
}
function compactResult(result) {
    return {
        platform: result.platform,
        title: result.title,
        content: result.content,
        cover: result.cover,
        author: result.author,
        url: result.url,
        images: result.images,
        videos: result.videos,
        audios: result.audios,
        extra: result.extra
    };
}
function extractBilibiliCommentImages(result) {
    if (result.platform !== 'bilibili' || !result.extra || typeof result.extra !== 'object') {
        return [];
    }
    const extra = result.extra;
    const out = [];
    const pushImages = (entry) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const item = entry;
        const text = String(item.content || '');
        const images = item.images;
        if (!Array.isArray(images)) {
            return;
        }
        for (const image of images) {
            if (typeof image === 'string' && image) {
                out.push({ url: image, text });
            }
        }
    };
    pushImages(extra.pinnedComment);
    if (Array.isArray(extra.hotComments)) {
        for (const item of extra.hotComments) {
            pushImages(item);
        }
    }
    return [...new Map(out.map((item) => [item.url, item])).values()];
}
function extractBilibiliCommentImageUrls(result) {
    if (result.platform !== 'bilibili' || !result.extra || typeof result.extra !== 'object') {
        return [];
    }
    const extra = result.extra;
    const out = [];
    const pushImages = (entry) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const images = entry.images;
        if (!Array.isArray(images)) {
            return;
        }
        for (const image of images) {
            if (typeof image === 'string' && image) {
                out.push(image);
            }
        }
    };
    pushImages(extra.pinnedComment);
    if (Array.isArray(extra.hotComments)) {
        for (const item of extra.hotComments) {
            pushImages(item);
        }
    }
    return Array.from(new Set(out));
}
function guessExt(url, ct) {
    const pathname = (() => {
        try {
            return new URL(url).pathname;
        }
        catch {
            return '';
        }
    })();
    const fromPath = path.extname(pathname);
    if (fromPath)
        return fromPath;
    if (ct.includes('image/jpeg'))
        return '.jpg';
    if (ct.includes('image/png'))
        return '.png';
    if (ct.includes('image/webp'))
        return '.webp';
    if (ct.includes('video/mp4'))
        return '.mp4';
    if (ct.includes('audio/mp4'))
        return '.m4a';
    if (ct.includes('audio/mpeg'))
        return '.mp3';
    return '.bin';
}
function isXhsMedia(url) {
    return /(?:^|\.)(?:xhscdn|xiaohongshu)\.com$/i.test(new URL(url).hostname);
}
