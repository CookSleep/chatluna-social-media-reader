import { StructuredTool } from '@langchain/core/tools'
import { Context, h } from 'koishi'
import type { ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { z } from 'zod'
import { CacheService } from './cache'
import { extractCardItems, formatCardText } from './card'
import { Config, inject, name } from './config'
import { parseBilibili } from './parsers/bilibili'
import { parseXiaohongshu } from './parsers/xiaohongshu'
import { CachedResult } from './types'
import { ParseRequest } from './types'
import { detectPlatform, normalizeInputUrl } from './utils/url'

const schema = z.object({
    url: z.string().describe('需要读取的哔哩哔哩或小红书链接。')
})

class SocialReaderTool extends StructuredTool {
    name: string
    description: string
    schema = schema

    constructor(
        private ctx: Context,
        private cfg: Config,
        private cache: CacheService
    ) {
        super({})
        this.name = (cfg.tool.name || 'read_social_media').trim()
        this.description =
            (cfg.tool.description || '').trim()
            || '读取哔哩哔哩或小红书链接，返回结构化信息与资源链接。'
    }

    async _call(
        input: z.infer<typeof schema>,
        _runManager: unknown,
        _runnable: ChatLunaToolRunnable
    ) {
        const debug = (message: string, payload?: unknown) => {
            if (!this.cfg.debug) return
            if (payload == null) {
                this.ctx.logger(name).debug(message)
                return
            }
            this.ctx.logger(name).debug(message, payload)
        }

        const req: ParseRequest = {
            url: input.url,
            bilibiliVideoQuality: this.cfg.bilibili.videoQuality,
            bilibiliAudioQuality: this.cfg.bilibili.audioQuality,
            bilibiliMergeAudio: this.cfg.bilibili.mergeAudio,
            xiaohongshuMaxImages: this.cfg.xiaohongshu.maxImages,
            cacheMedia: this.cfg.cache.cacheMedia,
            maxMediaMB: this.cfg.cache.maxMediaMB
        }
        debug('收到工具请求', req)

        const raw = normalizeInputUrl(req.url)
        if (!raw) {
            return '输入中没有可识别的链接。'
        }
        debug('归一化链接', raw)

        const platform = detectPlatform(raw)
        if (!platform) {
            return '当前仅支持小红书与哔哩哔哩链接。'
        }
        debug('识别平台', platform)

        if (platform === 'bilibili') {
            req.url = await toCanonicalBilibiliRequestUrl(
                this.ctx,
                raw,
                this.cfg.timeoutSeconds
            )
        } else if (platform === 'xiaohongshu') {
            req.url = toCanonicalXiaohongshuUrl(raw)
        }

        const key = this.cache.createKey(req)
        debug('缓存键', key)
        if (this.cfg.cache.enabled) {
            const hit = await this.cache.get(key)
            if (hit) {
                debug('缓存命中', key)
                return JSON.stringify(
                    formatOutput(
                        hit,
                        true,
                        this.cfg.cache.enabled && this.cfg.cache.cacheMedia,
                        this.cfg.debug
                    ),
                    null,
                    2
                )
            }
            debug('缓存未命中', key)
        }

        try {
            const result =
                platform === 'xiaohongshu'
                    ? await parseXiaohongshu(this.ctx, req.url, this.cfg)
                    : await parseBilibili(req.url, this.cfg, req, (msg, extra) => debug(msg, extra))

            const saved = this.cfg.cache.enabled
                ? await this.cache.set(
                    key,
                    result,
                    platform === 'bilibili' && this.cfg.bilibili.mergeAudio
                )
                : createTransientResult(key, result)

            debug('解析完成', {
                platform,
                images: result.images.length,
                videos: result.videos.length,
                audios: result.audios.length
            })

            return JSON.stringify(
                formatOutput(
                    saved,
                    false,
                    this.cfg.cache.enabled && this.cfg.cache.cacheMedia,
                    this.cfg.debug
                ),
                null,
                2
            )
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            this.ctx.logger(name).error(msg)
            debug('解析异常详情', err)
            return `解析失败：${msg}`
        }
    }
}

export function apply(ctx: Context, cfg: Config) {
    const cache = new CacheService(ctx, cfg)

    ctx.middleware(async (session, next) => {
        const elements = session.elements ?? []
        const cards = await Promise.all(
            extractCardItems(session, elements).map((item) =>
                normalizeCardItem(ctx, item, cfg.timeoutSeconds)
            )
        )
        if (cards.length) {
            for (const item of cards) {
                elements.push(h.text(formatCardText(item)))
            }
            session.elements = elements
        }
        return next()
    }, true)

    ctx.on('ready', async () => {
        await cache.init()
        if (!cfg.tool.enabled) {
            return
        }

        const toolName = (cfg.tool.name || 'read_social_media').trim() || 'read_social_media'
        ctx.effect(() => ctx.chatluna.platform.registerTool(toolName, {
            selector() {
                return true
            },
            createTool() {
                return new SocialReaderTool(ctx, cfg, cache)
            }
        }))
    })
}

function formatOutput(
    data: CachedResult,
    fromCache: boolean,
    preferStoredLink: boolean,
    includeVerbose: boolean
) {
    const storedImages = data.cached.images.map((item) => item.stored)
    const storedVideos = data.cached.videos.map((item) => item.stored)
    const storedAudios = data.cached.audios.map((item) => item.stored)

    const images =
        preferStoredLink && storedImages.length
            ? storedImages
            : data.result.images
    const videos =
        preferStoredLink && storedVideos.length
            ? storedVideos
            : data.result.videos
    const audios =
        preferStoredLink && storedAudios.length
            ? storedAudios
            : data.result.audios

    const pickOne = (items: string[]) => (items.length ? items[0] : '')
    const pickFirst = <T>(items: T[]) => (items.length ? items[0] : null)

    const mergedVideo =
        preferStoredLink && data.cached.mergedVideo
            ? data.cached.mergedVideo
            : ''

    const resources: Record<string, string | string[]> = {}

    if (data.result.platform === 'xiaohongshu') {
        const video = pickOne(videos)
        if (video) {
            resources.video = video
        } else {
            if (images.length) {
                resources.images = images
            }
        }
    } else {
        const cover = pickOne(images)
        if (cover) {
            resources.cover = cover
        }
        if (mergedVideo) {
            resources.mergedVideo = mergedVideo
        } else {
            const video = pickOne(videos)
            const audio = pickOne(audios)
            if (video) resources.video = video
            if (audio) resources.audio = audio
        }
    }

    const output: Record<string, unknown> = {
        platform: data.result.platform,
        title: data.result.title,
        author: data.result.author,
        content: data.result.content,
        url: data.result.url
    }

    if (Object.keys(resources).length) {
        output.resources = resources
    }

    if (!includeVerbose) {
        return output
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
                videos: pickFirst(data.cached.videos),
                audios: pickFirst(data.cached.audios),
                mergedVideo: data.cached.mergedVideo || ''
            }
        }
    }
}

function createTransientResult(
    key: string,
    result: CachedResult['result']
): CachedResult {
    const now = Date.now()
    return {
        key,
        createdAt: now,
        expiresAt: now,
        result,
        cached: {
            images: [],
            videos: [],
            audios: [],
            mergedVideo: ''
        }
    }
}

export * from './config'

function toCanonicalBilibiliUrl(input: string) {
    const bv = input.match(/BV[0-9a-zA-Z]{10}/i)?.[0]
    const av = input.match(/(?:^|[^a-zA-Z0-9])av(\d+)/i)?.[1]
    let p = 1

    try {
        const url = new URL(input)
        const qp = Number(url.searchParams.get('p') || 1)
        if (Number.isInteger(qp) && qp > 0) {
            p = qp
        }
    } catch {
        // ignore
    }

    if (bv) {
        const id = bv.toUpperCase().startsWith('BV') ? `BV${bv.slice(2)}` : bv
        return p > 1
            ? `https://www.bilibili.com/video/${id}?p=${p}`
            : `https://www.bilibili.com/video/${id}`
    }

    if (av) {
        return p > 1
            ? `https://www.bilibili.com/video/av${av}?p=${p}`
            : `https://www.bilibili.com/video/av${av}`
    }

    return input
}

async function toCanonicalBilibiliRequestUrl(
    ctx: Context,
    input: string,
    timeoutSeconds: number
) {
    let url = input
    try {
        const host = new URL(input).hostname.toLowerCase()
        if (
            host.includes('b23.tv')
            || host.includes('bili22.cn')
            || host.includes('bili23.cn')
            || host.includes('bili33.cn')
            || host.includes('bili2233.cn')
        ) {
            const res = await ctx.http(input, {
                method: 'GET',
                timeout: timeoutSeconds * 1000,
                redirect: 'follow'
            })
            url = res.url || input
        }
    } catch {
        url = input
    }
    return toCanonicalBilibiliUrl(url)
}

async function normalizeCardItem(
    ctx: Context,
    item: { platform: 'bilibili' | 'xiaohongshu'; title: string; url: string },
    timeoutSeconds: number
) {
    if (item.platform === 'xiaohongshu') {
        return {
            ...item,
            url: toCanonicalXiaohongshuUrl(item.url)
        }
    }

    let resolved = item.url
    try {
        const host = new URL(item.url).hostname.toLowerCase()
        if (
            host.includes('b23.tv')
            || host.includes('bili22.cn')
            || host.includes('bili23.cn')
            || host.includes('bili33.cn')
            || host.includes('bili2233.cn')
        ) {
            const res = await ctx.http(item.url, {
                method: 'GET',
                timeout: timeoutSeconds * 1000,
                redirect: 'follow'
            })
            resolved = res.url || item.url
        }
    } catch {
        resolved = item.url
    }

    return {
        ...item,
        url: toCanonicalBilibiliUrl(resolved)
    }
}

function toCanonicalXiaohongshuUrl(input: string) {
    try {
        const url = new URL(input)
        const m = url.pathname.match(/\/(?:discovery\/item|explore)\/([0-9a-zA-Z]+)/)
        if (!m?.[1]) {
            return input
        }

        const token = url.searchParams.get('xsec_token') || ''
        const canonical = new URL(`https://www.xiaohongshu.com/discovery/item/${m[1]}`)
        if (token) {
            canonical.searchParams.set('xsec_token', token)
            canonical.searchParams.set('xsec_source', 'pc_user')
        }
        return canonical.toString()
    } catch {
        return input
    }
}
