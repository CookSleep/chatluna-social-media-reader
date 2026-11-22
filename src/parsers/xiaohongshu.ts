import { load } from 'js-yaml'

import type { ReadConfig as Config } from '../config.js'
import { SocialParseResult } from '../types.js'
import { normalizeInputUrl, fetchPost, readLimited } from '../utils/url.js'

export async function parseXiaohongshu(inputUrl: string, cfg: Config) {
    const normalized = normalizeInputUrl(inputUrl)
    if (!normalized) {
        throw new Error('小红书链接无效。')
    }

    const canonical = toCanonicalXiaohongshuUrl(normalized)
    const { html, finalUrl } = await fetchHtml(canonical, cfg)
    if (new URL(finalUrl).pathname === '/login') throw new Error('小红书要求登录，无法匿名读取这篇笔记。')
    const state = parseInitialState(html)
    if (!state) {
        throw new Error('提取小红书初始数据失败。')
    }

    const id = new URL(finalUrl).pathname.match(/\/(?:discovery\/item|explore)\/([a-z0-9]+)/i)?.[1]
    const notes = deepGet(state, ['note', 'noteDetailMap']) as Record<string, { note?: unknown }> | undefined
    const rows = Object.values(notes || {})
    const note =
        deepGet(state, ['noteData', 'data', 'noteData'])
        || (id && notes?.[id]?.note)
        || (rows.length === 1 && !id ? rows[0].note : undefined)

    if (!note || typeof note !== 'object') throw new Error('页面没有可读取的小红书笔记。')

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
        url: finalUrl,
        images,
        videos,
        audios: []
    } satisfies SocialParseResult
}

async function fetchHtml(url: string, cfg: Config) {
    let err: Error
    for (let i = 0; i < cfg.xiaohongshu.maxRetries; i++) {
        try {
            const timeout = AbortSignal.timeout(cfg.timeoutSeconds * 1000)
            const response = await fetchPost(url, {
                signal: cfg.signal ? AbortSignal.any([cfg.signal, timeout]) : timeout,
                headers: { 'user-agent': cfg.xiaohongshu.userAgent, 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://www.xiaohongshu.com/' }
            })
            if (!response.ok) { await response.body?.cancel(); throw new Error('小红书 HTTP ' + response.status) }
            const text = (await readLimited(response, 8 * 1024 * 1024)).toString('utf8')
            if (!text) {
                throw new Error('空页面响应。')
            }
            return { html: text, finalUrl: response.url || url }
        } catch (e) {
            cfg.signal?.throwIfAborted()
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

    const text = script.replace(/^window\.__INITIAL_STATE__\s*=\s*/, '').replace(/;\s*$/, '')
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
        out.push(formatUrl(url).replace(/^http:/, 'https:'))
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
