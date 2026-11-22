import type { SocialPlatform } from '../types.js'

const domains = {
    bilibili: ['bilibili.com', 'b23.tv', 'bili22.cn', 'bili23.cn', 'bili33.cn', 'bili2233.cn'],
    xiaohongshu: ['xiaohongshu.com', 'xhslink.com', 'www.rednote.com']
}
const mediaDomains = ['hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'biliimg.com', 'xhscdn.com', 'xiaohongshu.com', 'akamaized.net']
function allowed(url: URL, hosts: string[]) {
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port &&
        hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))
}
export function normalizeInputUrl(raw: string) {
    const candidate = raw.match(/https?:\/\/[^\s]+/i)?.[0]
    try { return candidate ? new URL(candidate).href : '' } catch { return '' }
}
export function detectPlatform(raw: string): SocialPlatform | null {
    try {
        const url = new URL(raw)
        if (allowed(url, domains.bilibili)) return 'bilibili'
        if (allowed(url, domains.xiaohongshu)) return 'xiaohongshu'
    } catch {}
    return null
}
async function fetchAllowed(input: string, options: RequestInit, hosts: string[]) {
    let url = new URL(input)
    for (let n = 0; n < 8; n++) {
        if (!allowed(url, hosts)) throw new Error('链接指向不支持的域名。')
        const response = await fetch(url, { ...options, redirect: 'manual' })
        const location = response.headers.get('location')
        if (![301,302,303,307,308].includes(response.status) || !location) return response
        await response.body?.cancel()
        url = new URL(location, url)
    }
    throw new Error('链接重定向次数过多。')
}
export function isMediaUrl(raw: string) {
    try { return allowed(new URL(raw), mediaDomains) } catch { return false }
}
export function fetchMedia(input: string, options: RequestInit) {
    return fetchAllowed(input, options, mediaDomains)
}
export function fetchPost(input: string, options: RequestInit) {
    const platform = detectPlatform(input)
    if (!platform) throw new Error('不支持该平台链接。')
    return fetchAllowed(input, options, domains[platform])
}
export async function resolveRedirect(input: string, timeout: number, signal?: AbortSignal) {
    const limit = AbortSignal.timeout(timeout)
    const res = await fetchPost(input, { signal: signal ? AbortSignal.any([limit, signal]) : limit })
    await res.body?.cancel()
    return res.url
}
export async function readLimited(response: Response, maxBytes: number): Promise<Buffer<ArrayBuffer>> {
    const chunks: Buffer[] = []
    let size = 0
    const reader = response.body?.getReader()
    if (!reader) throw new Error('空响应。')
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) throw new Error('响应超过大小上限。')
            chunks.push(Buffer.from(value))
        }
        return Buffer.concat(chunks)
    } finally { await reader.cancel(); reader.releaseLock() }
}
