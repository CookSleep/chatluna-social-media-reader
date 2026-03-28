import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context, Time } from 'koishi'
import type {} from 'koishi-plugin-ffmpeg-path'
import { describeCommentImages } from './comment-image'
import { Config, name } from './config'
import { CachedMediaItem, CachedResult, ParseRequest, SocialParseResult } from './types'

interface SocialMediaCacheRow {
    key: string
    createdAt: Date
    expiresAt: Date
    result: string
    cached: string
}

declare module 'koishi' {
    interface Context {
        chatluna_storage?: {
            createTempFile(
                buffer: Buffer,
                filename: string,
                expireHours?: number
            ): Promise<{ url: string }>
        }
    }

    interface Tables {
        chatluna_social_media_cache: SocialMediaCacheRow
    }
}

const TABLE = 'chatluna_social_media_cache'

export class CacheService {
    private warnedStorageUnavailable = false

    constructor(
        private ctx: Context,
        private cfg: Config
    ) {}

    async init() {
        this.ctx.database.extend(
            TABLE,
            {
                key: { type: 'string', length: 64 },
                createdAt: 'timestamp',
                expiresAt: 'timestamp',
                result: 'text',
                cached: 'text'
            },
            { primary: 'key' }
        )

        if (!this.cfg.cache.enabled) return

        await this.cleanupExpired()
        this.ctx.setInterval(() => this.cleanupExpired(), Time.minute * 10)
    }

    createKey(req: ParseRequest) {
        return crypto
            .createHash('sha1')
            .update(JSON.stringify(req))
            .digest('hex')
    }

    async get(key: string) {
        if (!this.cfg.cache.enabled) return null

        const rows = await this.ctx.database.get(TABLE, { key })
        if (!rows.length) return null

        const row = rows[0]
        if (Date.now() > row.expiresAt.getTime()) {
            this.debug('缓存过期，删除记录', { key })
            await this.ctx.database.remove(TABLE, { key })
            return null
        }

        try {
            return this.decode(row)
        } catch {
            this.debug('缓存记录反序列化失败，删除记录', { key })
            await this.ctx.database.remove(TABLE, { key })
            return null
        }
    }

    async set(
        key: string,
        result: SocialParseResult,
        mergeAudio: boolean
    ) {
        const cached = {
            images: [] as CachedMediaItem[],
            commentImages: [] as CachedMediaItem[],
            videos: [] as CachedMediaItem[],
            audios: [] as CachedMediaItem[],
            mergedVideo: ''
        }

        if (this.cfg.cache.cacheMedia && this.hasStorageService()) {
            cached.images = await this.downloadMany(result.images, 'image')
            cached.commentImages = await this.downloadMany(
                extractBilibiliCommentImageUrls(result),
                'comment-image'
            )
            if (cached.commentImages.length) {
                const descs = await describeCommentImages(
                    this.ctx,
                    this.cfg,
                    extractBilibiliCommentImages(result)
                )
                cached.commentImages = cached.commentImages.map((item) => ({
                    ...item,
                    description: descs.get(item.source) || ''
                }))
            }

            if (mergeAudio && result.platform === 'bilibili' && result.videos[0] && result.audios[0]) {
                const merged = await this.mergeFromSources(
                    result.videos[0],
                    result.audios[0]
                )
                if (merged) {
                    cached.mergedVideo = merged
                } else {
                    cached.videos = await this.downloadMany(result.videos, 'video')
                    cached.audios = await this.downloadMany(result.audios, 'audio')
                }
            } else {
                cached.videos = await this.downloadMany(result.videos, 'video')
                cached.audios = await this.downloadMany(result.audios, 'audio')
            }

            if (!this.isMediaCacheComplete(result, cached, mergeAudio)) {
                throw new Error('媒体缓存不完整，已跳过写入缓存。')
            }
        } else if (this.cfg.cache.cacheMedia && !this.warnedStorageUnavailable) {
            this.warnedStorageUnavailable = true
            this.ctx
                .logger(name)
                .warn('未检测到 chatluna-storage-service，媒体将仅返回原始链接，不做存储缓存。')
            throw new Error('未检测到 chatluna-storage-service，媒体缓存失败。')
        } else if (this.cfg.cache.cacheMedia) {
            throw new Error('未检测到 chatluna-storage-service，媒体缓存失败。')
        }

        const now = Date.now()
        const compact = compactResult(result)
        const record: CachedResult = {
            key,
            createdAt: now,
            expiresAt: now + this.cfg.cache.ttlSeconds * 1000,
            result: compact,
            cached
        }

        await this.ctx.database.upsert(TABLE, [this.encode(record)], ['key'])
        return record
    }

    private async cleanupExpired() {
        this.debug('开始清理过期缓存')
        await this.ctx.database.remove(TABLE, {
            expiresAt: { $lt: new Date() }
        })
    }

    private encode(record: CachedResult): SocialMediaCacheRow {
        return {
            key: record.key,
            createdAt: new Date(record.createdAt),
            expiresAt: new Date(record.expiresAt),
            result: JSON.stringify(record.result),
            cached: JSON.stringify(record.cached)
        }
    }

    private decode(row: SocialMediaCacheRow): CachedResult {
        const parsedCached = JSON.parse(row.cached) as Partial<CachedResult['cached']>
        return {
            key: row.key,
            createdAt: row.createdAt.getTime(),
            expiresAt: row.expiresAt.getTime(),
            result: JSON.parse(row.result) as SocialParseResult,
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
        }
    }

    private async downloadMany(urls: string[], kind: string) {
        const out: CachedMediaItem[] = []
        for (let i = 0; i < urls.length; i++) {
            const url = urls[i]
            if (
                kind === 'image'
                && isXhsWebImage(url)
                && !url.includes('!nd_dft_wlteh_jpg_3')
            ) {
                continue
            }
            try {
                const item = await this.download(url, `${kind}-${i + 1}`)
                if (item) out.push(item)
            } catch (err) {
                this.ctx.logger(name).warn(String(err))
            }
        }
        return out
    }

    private async download(url: string, base: string) {
        if (!this.hasStorageService()) return null

        const payload = await this.fetchWithinLimit(url, `cache-${base}`)
        if (!payload) return null

        const ext = guessExt(url, payload.contentType)
        const file = await this.ctx.chatluna_storage.createTempFile(
            payload.buffer,
            `${base}${ext}`,
            this.ttlHours()
        )

        return {
            source: url,
            stored: file.url,
            size: payload.buffer.length
        }
    }

    private async fetchWithinLimit(url: string, tag = 'media') {
        const ac = new AbortController()
        const start = Date.now()
        const timer = setTimeout(
            () => ac.abort(),
            this.cfg.timeoutSeconds * 1000
        )

        try {
            const maxEncoded = this.cfg.cache.maxMediaMB * 1024 * 1024
            const maxRaw = Math.floor((maxEncoded * 3) / 4)
            const downloadFirst = isXhsWebImage(url)

            let probed = 0
            if (!downloadFirst) {
                try {
                    const head = await fetch(url, {
                        method: 'HEAD',
                        signal: ac.signal,
                        headers: {
                            referer: 'https://www.bilibili.com/',
                            'user-agent': this.cfg.xiaohongshu.userAgent
                        }
                    })
                    probed = Number(head.headers.get('content-length') || 0)
                } catch {
                    probed = 0
                }

                if (!Number.isFinite(probed) || probed <= 0) {
                    try {
                        const probe = await fetch(url, {
                            method: 'GET',
                            signal: ac.signal,
                            headers: {
                                referer: 'https://www.bilibili.com/',
                                'user-agent': this.cfg.xiaohongshu.userAgent,
                                range: 'bytes=0-0'
                            }
                        })
                        const contentRange = probe.headers.get('content-range') || ''
                        const total = contentRange.split('/').pop() || ''
                        probed = Number(total || 0)
                    } catch {
                        probed = 0
                    }
                }
            }

            if (probed > maxRaw) {
                this.debug('媒体下载已跳过（探测大小不合法或超限）', {
                    url,
                    probed,
                    maxRaw
                })
                return null
            }

            const res = await fetch(url, {
                signal: ac.signal,
                headers: {
                    referer: 'https://www.bilibili.com/',
                    'user-agent': this.cfg.xiaohongshu.userAgent
                }
            })

            if (!res.ok) return null

            const len = Number(res.headers.get('content-length') || 0)
            if (len > maxRaw) {
                this.debug('媒体下载已跳过（响应头大小超限）', {
                    url,
                    len,
                    maxRaw
                })
                return null
            }

            const buffer = Buffer.from(await res.arrayBuffer())
            if (buffer.length > maxRaw) {
                this.debug('媒体下载已跳过（实际大小超限）', {
                    url,
                    size: buffer.length,
                    maxRaw
                })
                return null
            }

            this.debug('媒体下载成功并准备入库存储', {
                url,
                size: buffer.length
            })

            return {
                buffer,
                contentType: res.headers.get('content-type') || ''
            }
        } catch (err) {
            const host = (() => {
                try {
                    return new URL(url).host
                } catch {
                    return ''
                }
            })()
            this.ctx.logger(name).warn(
                `媒体下载失败(${tag})：${err instanceof Error ? err.message : String(err)}`
            )
            this.debug('媒体下载失败详情', {
                tag,
                host,
                timeoutSeconds: this.cfg.timeoutSeconds,
                costMs: Date.now() - start,
                err: String(err),
                url
            })
            return null
        } finally {
            clearTimeout(timer)
        }
    }

    private ttlHours() {
        return Math.max(1, Math.ceil(this.cfg.cache.ttlSeconds / 3600))
    }

    private async mergeFromSources(videoUrl: string, audioUrl: string) {
        if (!this.hasStorageService()) return ''

        try {
            const video = await this.fetchWithinLimit(videoUrl, 'merge-video')
            if (!video) return ''

            const audio = await this.fetchWithinLimit(audioUrl, 'merge-audio')
            if (!audio) return ''

            const merged = await this.mergeMp4(video.buffer, audio.buffer)
            if (!merged) return ''

            const temp = await this.ctx.chatluna_storage.createTempFile(
                merged,
                'merged.mp4',
                this.ttlHours()
            )
            return temp.url
        } catch (err) {
            this.ctx.logger(name).warn(
                `媒体合并失败：${err instanceof Error ? err.message : String(err)}`
            )
            this.debug('媒体合并失败详情', { videoUrl, audioUrl, err: String(err) })
            return ''
        }
    }

    private hasStorageService() {
        return typeof this.ctx.chatluna_storage?.createTempFile === 'function'
    }

    private isMediaCacheComplete(
        result: SocialParseResult,
        cached: CachedResult['cached'],
        mergeAudio: boolean
    ) {
        const hasAllSources = (sources: string[], items: CachedMediaItem[]) => {
            if (!sources.length) return true
            const got = new Set(items.map((item) => item.source))
            return sources.every((url) => got.has(url))
        }

        if (!hasAllSources(result.images, cached.images)) {
            return false
        }

        const needMerged = Boolean(
            mergeAudio
            && result.platform === 'bilibili'
            && result.videos[0]
            && result.audios[0]
        )

        if (needMerged) {
            if (cached.mergedVideo) {
                return true
            }
            return hasAllSources(result.videos, cached.videos)
                && hasAllSources(result.audios, cached.audios)
        }

        return hasAllSources(result.videos, cached.videos)
            && hasAllSources(result.audios, cached.audios)
    }

    private async mergeMp4(video: Buffer, audio: Buffer) {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatluna-smr-'))
        const videoFile = path.join(tmp, 'video.mp4')
        const audioFile = path.join(tmp, 'audio.m4a')
        const outFile = path.join(tmp, 'merged.mp4')

        try {
            await fs.writeFile(videoFile, video)
            await fs.writeFile(audioFile, audio)

            await this.ctx.ffmpeg
                .builder()
                .input(videoFile)
                .input(audioFile)
                .outputOption('-c:v', 'copy', '-c:a', 'aac', '-shortest')
                .run('file', outFile)

            return await fs.readFile(outFile)
        } catch {
            this.debug('FFmpeg 合并失败')
            return null
        } finally {
            await fs.rm(tmp, { recursive: true, force: true })
        }
    }

    private debug(message: string, payload?: unknown) {
        if (!this.cfg.debug) return
        if (payload == null) {
            this.ctx.logger(name).debug(message)
            return
        }
        this.ctx.logger(name).debug(message, payload)
    }
}

function compactResult(result: SocialParseResult): SocialParseResult {
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
    }
}

function extractBilibiliCommentImages(result: SocialParseResult) {
    if (result.platform !== 'bilibili' || !result.extra || typeof result.extra !== 'object') {
        return [] as Array<{ url: string; text: string }>
    }

    const extra = result.extra as Record<string, unknown>
    const out: Array<{ url: string; text: string }> = []

    const pushImages = (entry: unknown) => {
        if (!entry || typeof entry !== 'object') {
            return
        }
        const item = entry as Record<string, unknown>
        const text = String(item.content || '')
        const images = item.images
        if (!Array.isArray(images)) {
            return
        }
        for (const image of images) {
            if (typeof image === 'string' && image) {
                out.push({ url: image, text })
            }
        }
    }

    pushImages(extra.pinnedComment)
    if (Array.isArray(extra.hotComments)) {
        for (const item of extra.hotComments) {
            pushImages(item)
        }
    }

    return [...new Map(out.map((item) => [item.url, item])).values()]
}

function extractBilibiliCommentImageUrls(result: SocialParseResult) {
    if (result.platform !== 'bilibili' || !result.extra || typeof result.extra !== 'object') {
        return [] as string[]
    }

    const extra = result.extra as Record<string, unknown>
    const out: string[] = []

    const pushImages = (entry: unknown) => {
        if (!entry || typeof entry !== 'object') {
            return
        }
        const images = (entry as Record<string, unknown>).images
        if (!Array.isArray(images)) {
            return
        }
        for (const image of images) {
            if (typeof image === 'string' && image) {
                out.push(image)
            }
        }
    }

    pushImages(extra.pinnedComment)
    if (Array.isArray(extra.hotComments)) {
        for (const item of extra.hotComments) {
            pushImages(item)
        }
    }

    return Array.from(new Set(out))
}

function guessExt(url: string, ct: string) {
    const pathname = (() => {
        try {
            return new URL(url).pathname
        } catch {
            return ''
        }
    })()

    const fromPath = path.extname(pathname)
    if (fromPath) return fromPath
    if (ct.includes('image/jpeg')) return '.jpg'
    if (ct.includes('image/png')) return '.png'
    if (ct.includes('image/webp')) return '.webp'
    if (ct.includes('video/mp4')) return '.mp4'
    if (ct.includes('audio/mp4')) return '.m4a'
    if (ct.includes('audio/mpeg')) return '.mp3'
    return '.bin'
}

function isXhsWebImage(url: string) {
    return url.includes('xhscdn.com') && url.includes('sns-webpic')
}
