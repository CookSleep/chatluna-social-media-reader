import { SocialPlatform } from '../types'

export function normalizeInputUrl(raw: string) {
    const match = raw.match(/https?:\/\/[^\s]+/i)
    const text = match ? match[0] : raw
    const value = text.trim()
    if (!value) return ''

    try {
        const url = new URL(value)
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return ''
        return url.toString()
    } catch {
        return ''
    }
}

export function detectPlatform(url: string): SocialPlatform | null {
    try {
        const host = new URL(url).hostname.toLowerCase()
        if (
            host.includes('xiaohongshu.com') ||
            host.includes('xhslink.com')
        ) {
            return 'xiaohongshu'
        }
        if (
            host.includes('bilibili.com') ||
            host.includes('b23.tv') ||
            host.includes('bili22.cn') ||
            host.includes('bili23.cn') ||
            host.includes('bili33.cn') ||
            host.includes('bili2233.cn')
        ) {
            return 'bilibili'
        }
        return null
    } catch {
        return null
    }
}

export async function resolveRedirect(url: string, timeoutMs: number) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: ac.signal,
            headers: {
                'user-agent':
                    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        })
        return res.url || url
    } catch (err) {
        throw new Error(`短链解析失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
        clearTimeout(timer)
    }
}
