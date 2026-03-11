import { load } from 'js-yaml'
import { Context } from 'koishi'
import { Config } from '../config'
import { SocialParseResult } from '../types'
import { normalizeInputUrl } from '../utils/url'

export async function parseXiaohongshu(ctx: Context, inputUrl: string, cfg: Config) {
    const normalized = normalizeInputUrl(inputUrl)
    if (!normalized) {
        throw new Error('小红书链接无效。')
    }

    const canonical = toCanonicalXiaohongshuUrl(normalized)
    const html = await fetchHtml(ctx, canonical, cfg)
    const state = parseInitialState(html)
    if (!state) {
        throw new Error('提取小红书初始数据失败。')
    }

    const note =
        deepGet(state, ['noteData', 'data', 'noteData'])
        || deepGet(state, ['note', 'noteDetailMap', '[-1]', 'note'])
        || {}

    const title = String(deepGet(note, ['title']) || '未命名笔记')
    const content = String(deepGet(note, ['desc']) || '')
    const author = String(
        deepGet(note, ['user', 'nickname'])
        || deepGet(note, ['user', 'nickName'])
        || ''
    )

    const images = extractImages(note).slice(0, cfg.xiaohongshu.maxImages)
    const videos = extractVideos(note)

    return {
        platform: 'xiaohongshu',
        title,
        content,
        cover: images[0] || '',
        author,
        url: canonical,
        images,
        videos,
        audios: []
    } satisfies SocialParseResult
}

async function fetchHtml(ctx: Context, url: string, cfg: Config) {
    let err: Error
    for (let i = 0; i < cfg.xiaohongshu.maxRetries; i++) {
        try {
            const text = await ctx.http.get(url, {
                responseType: 'text',
                timeout: cfg.timeoutSeconds * 1000,
                headers: {
                    'user-agent': cfg.xiaohongshu.userAgent,
                    accept:
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                    referer: 'https://www.xiaohongshu.com/'
                }
            })
            if (!text) {
                throw new Error('空页面响应。')
            }
            return text
        } catch (e) {
            err = e as Error
            await new Promise((r) => setTimeout(r, (i + 1) * 300))
        }
    }
    throw err!
}

function parseInitialState(html: string) {
    const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi))
        .map((m) => (m[1] || '').trim())
        .reverse()

    const script = scripts.find((item) => item.startsWith('window.__INITIAL_STATE__'))
    if (!script) return null

    const text = script.replace(/^window\.__INITIAL_STATE__\s*=\s*/, '')
    try {
        return load(text) as Record<string, unknown>
    } catch {
        return null
    }
}

function deepGet(data: unknown, keys: string[]) {
    let value = data as unknown
    for (const key of keys) {
        if (value == null) return null
        if (key.startsWith('[') && key.endsWith(']')) {
            const idx = Number(key.slice(1, -1))
            if (Number.isNaN(idx)) return null
            if (Array.isArray(value)) {
                value = value.at(idx)
                continue
            }
            if (typeof value === 'object') {
                const arr = Object.values(value as Record<string, unknown>)
                value = arr.at(idx)
                continue
            }
            return null
        }
        if (typeof value !== 'object') return null
        value = (value as Record<string, unknown>)[key]
    }
    return value
}

function extractImages(note: unknown) {
    const list = deepGet(note, ['imageList'])
    if (!Array.isArray(list)) return []

    const out: string[] = []
    for (const item of list) {
        const url = String(
            deepGet(item, ['urlDefault'])
            || deepGet(item, ['url'])
            || ''
        )
        if (!url) continue
        const token = getImageToken(url)
        if (!token) continue
        out.push(`https://sns-img-bd.xhscdn.com/${token}`)
    }
    return dedupe(out)
}

function extractVideos(note: unknown) {
    const key = String(deepGet(note, ['video', 'consumer', 'originVideoKey']) || '')
    if (key) {
        return [`https://sns-video-bd.xhscdn.com/${key}`]
    }

    const h264 = deepGet(note, ['video', 'media', 'stream', 'h264'])
    const h265 = deepGet(note, ['video', 'media', 'stream', 'h265'])
    const list = [
        ...(Array.isArray(h264) ? h264 : []),
        ...(Array.isArray(h265) ? h265 : [])
    ] as Record<string, unknown>[]

    if (!list.length) return []

    list.sort((a, b) => {
        const ah = Number(a.height || 0)
        const bh = Number(b.height || 0)
        if (ah !== bh) return ah - bh
        const ab = Number(a.videoBitrate || 0)
        const bb = Number(b.videoBitrate || 0)
        return ab - bb
    })

    const best = list[list.length - 1]
    const backups = deepGet(best, ['backupUrls'])
    if (Array.isArray(backups) && backups[0]) {
        return [formatUrl(String(backups[0]))]
    }

    const master = String(deepGet(best, ['masterUrl']) || '')
    return master ? [formatUrl(master)] : []
}

function getImageToken(url: string) {
    const text = formatUrl(url)
    const parts = text.split('/').slice(5)
    if (!parts.length) return ''
    const token = parts.join('/').split('!')[0]
    return token || ''
}

function formatUrl(url: string) {
    return url.replace(/\\\//g, '/').replace(/&amp;/g, '&')
}

function dedupe(items: string[]) {
    return Array.from(new Set(items))
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
