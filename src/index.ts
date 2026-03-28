import { StructuredTool } from '@langchain/core/tools'
import { Context, h } from 'koishi'
import type { ChatLunaToolMeta, ChatLunaToolRunnable } from 'koishi-plugin-chatluna/llm-core/platform/types'
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
            bilibiliParseComments: this.cfg.bilibili.parseComments,
            bilibiliCommentsCount: this.cfg.bilibili.commentsCount,
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

        let hasReadFilesTool = false
        try {
            const toolMask = _runnable?.configurable?.toolMask
            if (toolMask) {
                hasReadFilesTool = this.ctx.chatluna.platform.getFilteredTools(toolMask).includes('read_files')
            } else {
                hasReadFilesTool = this.ctx.chatluna.platform.getTools().value.includes('read_files')
            }
        } catch {
            hasReadFilesTool = true
        }

        if (this.cfg.cache.enabled) {
            const hit = await this.cache.get(key)
            if (hit) {
                debug('缓存命中', key)
                return JSON.stringify(
                    formatOutput(
                        hit,
                        true,
                        this.cfg.cache.enabled && this.cfg.cache.cacheMedia,
                        this.cfg.debug,
                        hasReadFilesTool
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

            let saved: CachedResult
            if (!this.cfg.cache.enabled) {
                saved = createTransientResult(key, result)
            } else {
                try {
                    saved = await this.cache.set(
                        key,
                        result,
                        platform === 'bilibili' && this.cfg.bilibili.mergeAudio
                    )
                } catch (err) {
                    this.ctx.logger(name).warn(
                        `缓存写入失败，回退直出结果：${err instanceof Error ? err.message : String(err)}`
                    )
                    debug('缓存写入失败详情', err)
                    saved = createTransientResult(key, result)
                }
            }

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
                    this.cfg.debug,
                    hasReadFilesTool
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
        const quote = resolveQuote(session)
        const eventQuoteRaw = getEventQuote(session)
        const eventQuote = quote && quote === eventQuoteRaw ? undefined : eventQuoteRaw

        const cards = await Promise.all(
            extractCardItems(
                { content: session.content || '' } as Parameters<typeof extractCardItems>[0],
                elements
            ).map((item) =>
                normalizeCardItem(ctx, item, cfg.timeoutSeconds)
            )
        )
        const quoteCards = await Promise.all(
            extractCardItems(
                {
                    content:
                        quote && typeof quote === 'object' && typeof (quote as Record<string, unknown>)['content'] === 'string'
                            ? ((quote as Record<string, unknown>)['content'] as string)
                            : ''
                } as Parameters<typeof extractCardItems>[0],
                quote && typeof quote === 'object' && Array.isArray((quote as Record<string, unknown>)['elements'])
                    ? ((quote as Record<string, unknown>)['elements'] as h[])
                    : []
            ).map((item) =>
                normalizeCardItem(ctx, item, cfg.timeoutSeconds)
            )
        )

        if (cards.length) {
            for (const item of cards) {
                elements.push(h.text(formatCardText(item)))
            }
            session.elements = elements
        }

        injectQuoteContent(quote, eventQuote, quoteCards)

        return next()
    }, true)

    ctx.on('ready', async () => {
        await cache.init()
        if (!cfg.tool.enabled) {
            return
        }

        const toolName = (cfg.tool.name || 'read_social_media').trim() || 'read_social_media'
        const tool = new SocialReaderTool(ctx, cfg, cache)
        ctx.effect(() => ctx.chatluna.platform.registerTool(toolName, {
            description: tool.description,
            selector() {
                return true
            },
            createTool() {
                return new SocialReaderTool(ctx, cfg, cache)
            },
            meta: {
                source: 'extension',
                group: 'social-media-reader',
                tags: ['social-media-reader'],
                defaultMain: true,
                defaultChatluna: true,
                defaultCharacter: true,
                defaultCharacterGroup: true,
                defaultCharacterPrivate: true
            } as ChatLunaToolMeta & Record<string, boolean | string | string[]>
        }))
    })
}

function formatOutput(
    data: CachedResult,
    fromCache: boolean,
    preferStoredLink: boolean,
    includeVerbose: boolean,
    hasReadFilesTool: boolean
) {
    const storedImages = data.cached.images.map((item) => item.stored)
    const commentImageMap = new Map(
        (data.cached.commentImages || []).map((item) => [item.source, item.stored])
    )
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

    const cover = pickOne(images) || data.result.cover || ''
    const primaryVideo = pickOne(videos)
    const primaryAudio = pickOne(audios)
    const output: Record<string, unknown> = {
        url: data.result.url,
        platform: data.result.platform
    }

    if (cover) {
        output.cover = cover
    }

    output.title = data.result.title

    if (data.result.author) {
        output.author = data.result.author
    }

    if (data.result.platform === 'bilibili') {
        const extra = data.result.extra as Record<string, unknown> | undefined
        const description = data.result.content || ''
        const durationSec = Number(extra?.['durationSec'] || 0)
        const engagement =
            extra && typeof extra['engagement'] === 'object'
                ? (extra['engagement'] as Record<string, unknown>)
                : undefined
        const hotComments =
            extra && Array.isArray(extra['hotComments'])
                ? (extra['hotComments'] as unknown[])
                : undefined
        const pinnedComment =
            extra && typeof extra['pinnedComment'] === 'object'
                ? (extra['pinnedComment'] as Record<string, unknown>)
                : undefined
        const tagsRaw =
            extra && Array.isArray(extra['tags'])
                ? (extra['tags'] as unknown[])
                : []

        output.description = description

        const tags = tagsRaw
            .map((item) => {
                if (!item || typeof item !== 'object') {
                    return null
                }

                const row = item as Record<string, unknown>
                const name = String(row.name || '').trim()
                if (!name) {
                    return null
                }

                return name
            })
            .filter((item): item is NonNullable<typeof item> => item !== null)
        if (tags.length) {
            output.tags = tags
        }

        const normalizeComment = (value: unknown) => {
            if (!value || typeof value !== 'object') {
                return null
            }
            const item = value as Record<string, unknown>
            const text = String(item.content || '')
            const likes = Number(item.likes || 0)
            const replies = Number(item.replies || 0)
            const imagesRaw = Array.isArray(item.images)
                ? item.images.filter((it): it is string => typeof it === 'string' && it.length > 0)
                : []
            const images = imagesRaw.map((url) =>
                preferStoredLink ? (commentImageMap.get(url) || url) : url
            )
            if (!text && !images.length) {
                return null
            }
            return {
                content: text || '[图片评论]',
                likes,
                replies,
                ...(images.length ? { images } : {})
            }
        }

        const normalizedPinnedComment = normalizeComment(pinnedComment)
        const normalizedHotComments = hotComments
            ? hotComments
                .map((item) => normalizeComment(item))
                .filter((item): item is NonNullable<ReturnType<typeof normalizeComment>> => item !== null)
            : []

        if (mergedVideo) {
            output.video = mergedVideo
        } else if (primaryVideo || primaryAudio) {
            output.videoResources = {
                ...(primaryVideo ? { video: primaryVideo } : {}),
                ...(primaryAudio ? { audio: primaryAudio } : {})
            }
        }

        output.duration = formatDuration(durationSec)

        if (engagement) {
            output.engagement = engagement
        }
        if (normalizedPinnedComment) {
            output.pinnedComment = normalizedPinnedComment
        }
        if (normalizedHotComments.length) {
            output.hotComments = normalizedHotComments
        }

    } else {
        output.content = data.result.content

        if (primaryVideo) {
            output.video = primaryVideo
        } else if (images.length) {
            output.resources = { images }
        }
    }

    const noteTargets: string[] = []
    if (cover) {
        noteTargets.push('`cover`')
    }
    if (mergedVideo || (data.result.platform === 'xiaohongshu' && primaryVideo)) {
        noteTargets.push('`video`')
    }
    if (!mergedVideo && primaryVideo) {
        noteTargets.push('`videoResources.video`')
    }
    if (!mergedVideo && primaryAudio) {
        noteTargets.push('`videoResources.audio`')
    }
    if (data.result.platform === 'xiaohongshu' && images.length && !primaryVideo) {
        noteTargets.push('`resources.images`')
    }

    const note = hasReadFilesTool ? createMediaNote(noteTargets, data.result.platform, !!(mergedVideo || primaryVideo)) : undefined

    if (!includeVerbose) {
        return {
            ...output,
            ...(note ? { note } : {})
        }
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
        },
        ...(note ? { note } : {})
    }
}

function createMediaNote(targets: string[], platform: string, hasVideo: boolean) {
    const uniqueTargets = [...new Set(targets)]
    const contentType = platform === 'xiaohongshu' && !hasVideo ? 'post' : 'video'

    const targetText = uniqueTargets.length
        ? `If the user asks you to view the content in this ${contentType}, you MUST use the \`read_files\` tool to directly read the media URLs from ${joinWithAnd(uniqueTargets)} to obtain specific information, without worrying about factors such as duration or size.`
        : `If the user asks you to view the content in this ${contentType}, you MUST use the \`read_files\` tool to directly read the media URLs to obtain specific information, without worrying about factors such as duration or size.`

    return `Textual information cannot fully represent the content within media. ${targetText}`
}

function joinWithAnd(items: string[]) {
    if (items.length <= 1) {
        return items[0] || ''
    }
    if (items.length === 2) {
        return `${items[0]} and ${items[1]}`
    }
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function formatDuration(totalSeconds: number) {
    const sec = Number.isFinite(totalSeconds) && totalSeconds > 0
        ? Math.floor(totalSeconds)
        : 0
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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
            commentImages: [],
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

function injectQuoteContent(quote: unknown, eventQuote: unknown, cards: ReturnType<typeof extractCardItems>) {
    if (!cards.length) return
    const injected = cards.map((item) => formatCardText(item)).join('\n')

    if (quote && typeof quote === 'object') {
        const target = quote as Record<string, unknown>
        const previous = typeof target['content'] === 'string' ? target['content'].trim() : ''
        target['content'] = previous ? `${previous}\n${injected}` : injected
    }

    if (eventQuote && typeof eventQuote === 'object') {
        const target = eventQuote as Record<string, unknown>
        const previous = typeof target['content'] === 'string' ? target['content'].trim() : ''
        target['content'] = previous ? `${previous}\n${injected}` : injected
    }
}

function resolveQuote(session: unknown) {
    if (!session || typeof session !== 'object') return undefined
    const target = session as Record<string, unknown>

    if (target['quote'] && typeof target['quote'] === 'object') {
        return target['quote']
    }

    const event = target['event'] as Record<string, unknown>
    if (!event || typeof event !== 'object') return undefined

    const message = event['message'] as Record<string, unknown>
    if (!message || typeof message !== 'object') return undefined

    const quote = message['quote']
    if (!quote || typeof quote !== 'object') return undefined

    target['quote'] = quote
    return quote
}

function getEventQuote(session: unknown) {
    if (!session || typeof session !== 'object') return undefined
    const event = (session as Record<string, unknown>)['event']
    if (!event || typeof event !== 'object') return undefined
    const message = (event as Record<string, unknown>)['message']
    if (!message || typeof message !== 'object') return undefined
    const quote = (message as Record<string, unknown>)['quote']
    if (!quote || typeof quote !== 'object') return undefined
    return quote
}
