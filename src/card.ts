import { h, Session } from 'koishi'
import { detectPlatform, normalizeInputUrl } from './utils/url'

interface CardHit {
    platform: 'bilibili' | 'xiaohongshu'
    title: string
    url: string
}

export function extractCardItems(session: Session, elements: h[]) {
    const payloads = collectCardPayloads(session, elements)
    const hits = new Map<string, CardHit>()

    for (const payload of payloads) {
        const byJson = extractFromJson(payload)
        for (const item of byJson) {
            const normalized = normalizeInputUrl(item.url)
            if (!normalized) continue
            const platform = detectPlatform(normalized)
            if (platform !== 'bilibili' && platform !== 'xiaohongshu') continue
            if (!hits.has(normalized)) {
                hits.set(normalized, {
                    platform,
                    title: normalizeTitle(item.title),
                    url: normalized
                })
            }
        }

        if (byJson.length) {
            continue
        }

        const urls = extractUrls(payload)
        if (!urls.length) continue

        const title = extractTitle(payload)
        if (!title) continue

        for (const rawUrl of urls) {
            const normalized = normalizeInputUrl(rawUrl)
            if (!normalized) continue
            const platform = detectPlatform(normalized)
            if (platform !== 'bilibili' && platform !== 'xiaohongshu') continue

            if (!hits.has(normalized)) {
                hits.set(normalized, {
                    platform,
                    title,
                    url: normalized
                })
            }
        }
    }

    return Array.from(hits.values())
}

export function formatCardText(item: CardHit) {
    const platformText = item.platform === 'bilibili' ? '哔哩哔哩' : '小红书'
    return `【${item.title}-${platformText}】\n${item.url}`
}

function collectCardPayloads(session: Session, elements: h[]) {
    const out: string[] = []

    if (looksLikeCardPayload(session.content || '')) {
        out.push(session.content)
    }

    const quoteContent =
        session.quote && typeof session.quote === 'object' && typeof (session.quote as Record<string, unknown>)['content'] === 'string'
            ? ((session.quote as Record<string, unknown>)['content'] as string)
            : ''
    if (looksLikeCardPayload(quoteContent)) {
        out.push(quoteContent)
    }

    const walk = (nodes: h[]) => {
        for (const node of nodes) {
            const attrs = node.attrs as Record<string, unknown>
            const sourceFields = [
                attrs['data'],
                attrs['content'],
                attrs['raw'],
                attrs['json'],
                attrs['xml'],
                attrs['url']
            ]

            for (const field of sourceFields) {
                if (typeof field === 'string' && looksLikeCardPayload(field)) {
                    out.push(field)
                }
            }

            if (node.children?.length) {
                walk(node.children)
            }
        }
    }

    walk(elements)

    const quoteElements =
        session.quote && typeof session.quote === 'object' && Array.isArray((session.quote as Record<string, unknown>)['elements'])
            ? ((session.quote as Record<string, unknown>)['elements'] as h[])
            : []
    if (quoteElements.length) {
        walk(quoteElements)
    }

    return out
}

function looksLikeCardPayload(text: string) {
    if (!text) return false
    return (
        text.includes('meta')
        || text.includes('<msg')
        || text.includes('<xml')
        || text.includes('news')
        || text.includes('b23.tv')
        || text.includes('xhslink.com')
        || text.includes('xiaohongshu.com')
        || text.includes('bilibili.com')
    )
}

function extractUrls(text: string) {
    const decoded = text
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\u002F/gi, '/')
    const matches = decoded.match(/https?:\/\/[^\s"'<>]+/g) || []
    return matches.map((item) => item.replace(/[),.;!?]+$/g, ''))
}

function extractTitle(raw: string) {
    const xmlTitle =
        raw.match(/\btitle=["']([^"']{1,120})["']/i)?.[1]
        || raw.match(/<title>([^<]{1,120})<\/title>/i)?.[1]
        || raw.match(/\bbrief=["']([^"']{1,120})["']/i)?.[1]

    if (xmlTitle) {
        return normalizeTitle(xmlTitle)
    }

    const json = safeJsonParse(raw)
    if (!json) return ''

    const candidate = findTitleInObject(json)
    return normalizeTitle(candidate)
}

function safeJsonParse(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
    try {
        return JSON.parse(trimmed) as unknown
    } catch {
        return null
    }
}

function extractFromJson(raw: string) {
    const json = safeJsonParse(raw)
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
        return [] as Array<{ title: string; url: string }>
    }

    const obj = json as Record<string, unknown>
    const meta = obj.meta as Record<string, unknown>
    const detail = meta?.detail_1 as Record<string, unknown>
    const news = meta?.news as Record<string, unknown>

    const out: Array<{ title: string; url: string }> = []

    const push = (title: unknown, url: unknown) => {
        if (typeof title !== 'string' || typeof url !== 'string') return
        const t = normalizeTitle(title)
        const u = normalizeUrlText(url)
        if (!t || !u) return
        out.push({ title: t, url: u })
    }

    push(
        detail?.desc ?? detail?.title ?? obj.prompt,
        detail?.qqdocurl ?? detail?.jumpUrl ?? detail?.url
    )
    push(news?.title ?? news?.desc ?? obj.prompt, news?.jumpUrl)

    if (!out.length) {
        const title = findTitleInObject(obj)
        const urls = extractUrls(raw)
        if (title && urls[0]) {
            out.push({ title, url: urls[0] })
        }
    }

    return out
}

function normalizeUrlText(url: string) {
    return url
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/')
        .replace(/\\u002F/gi, '/')
        .trim()
}

function findTitleInObject(value: unknown): string {
    if (value == null) return ''

    if (typeof value === 'string') {
        if (value.startsWith('http')) return ''
        if (value.length < 2 || value.length > 120) return ''
        return value
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const title = findTitleInObject(item)
            if (title) return title
        }
        return ''
    }

    if (typeof value !== 'object') return ''

    const obj = value as Record<string, unknown>
    const priority = [
        'title',
        'desc',
        'description',
        'brief',
        'prompt',
        'name'
    ]

    for (const key of priority) {
        const matchedKey = Object.keys(obj).find((k) => k.toLowerCase() === key)
        if (!matchedKey) continue
        const title = findTitleInObject(obj[matchedKey])
        if (title) return title
    }

    for (const key of Object.keys(obj)) {
        const title = findTitleInObject(obj[key])
        if (title) return title
    }

    return ''
}

function normalizeTitle(text: string) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()
}
