import crypto from 'node:crypto'
import { Config } from '../config'
import { ParseRequest, SocialParseResult } from '../types'
import { resolveRedirect } from '../utils/url'

const BVID_RE = /BV[0-9a-zA-Z]{10}/i
const AVID_RE = /(?:^|[^a-zA-Z0-9])av(\d+)/i
const BILIBILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

export async function parseBilibili(
    inputUrl: string,
    cfg: Config,
    req: ParseRequest,
    debug?: (msg: string, extra?: unknown) => void
) {
    const directId = extractVideoId(inputUrl)
    const resolved = directId
        ? inputUrl
        : await resolveRedirect(inputUrl, cfg.timeoutSeconds * 1000)
    const videoId = directId || extractVideoId(resolved)
    const page = extractPageNo(resolved) || extractPageNo(inputUrl) || 1
    if (!videoId) {
        throw new Error('无法提取 B 站视频 ID。')
    }

    const detail = await fetchVideoDetail(videoId, page, cfg, debug)
    if (!detail.bvid || !detail.cid) {
        throw new Error('B 站视频信息不完整，缺少 bvid 或 cid。')
    }

    const qn = (req.bilibiliVideoQuality || cfg.bilibili.videoQuality) === 720 ? 64 : 32
    const aq = req.bilibiliAudioQuality || cfg.bilibili.audioQuality
    const audioId = aq === 192 ? 30280 : aq === 132 ? 30232 : 30216
    const commentsPromise: Promise<BilibiliCommentResult> = cfg.bilibili.parseComments
        ? fetchHotComments(detail.aid, cfg.bilibili.commentsCount, cfg, debug)
            .catch((err) => {
                const message = err instanceof Error ? err.message : String(err)
                debug?.('B 站热评解析失败，已忽略', message)
                return {
                    hotComments: [] as BilibiliHotComment[],
                    pinnedComment: null as BilibiliHotComment | null
                }
            })
        : Promise.resolve({
            hotComments: [] as BilibiliHotComment[],
            pinnedComment: null as BilibiliHotComment | null
        })
    const playPromise = fetchPlayInfo(detail.bvid, detail.cid, qn, cfg, debug)

    const [play, comments] = await Promise.all([playPromise, commentsPromise])

    const video = pickVideo(play, qn)
    const audio = pickAudio(play, audioId)
    const finalUrl =
        page > 1
            ? `https://www.bilibili.com/video/${detail.bvid}?p=${page}`
            : `https://www.bilibili.com/video/${detail.bvid}`

    return {
        platform: 'bilibili',
        title: detail.title,
        content: buildDescription(detail.description, cfg.bilibili.maxDescLength),
        cover: detail.cover,
        author: detail.owner,
        url: finalUrl,
        images: detail.cover ? [detail.cover] : [],
        videos: video ? [video.url] : [],
        audios: audio ? [audio] : [],
        extra: {
            bvid: detail.bvid,
            aid: detail.aid,
            cid: detail.cid,
            durationSec: detail.durationSec,
            videoQuality: qn === 64 ? 720 : 480,
            audioQuality: aq,
            videoCodecId: video?.codecid ?? 0,
            page,
            engagement: {
                view: detail.stats.view,
                like: detail.stats.like,
                coin: detail.stats.coin,
                favorite: detail.stats.favorite,
                share: detail.stats.share,
                comment: detail.stats.comment
            },
            pinnedComment: comments.pinnedComment,
            hotComments: comments.hotComments
        }
    } satisfies SocialParseResult
}

interface BilibiliHotComment {
    content: string
    likes: number
    replies: number
    images?: string[]
}

interface BilibiliCommentResult {
    hotComments: BilibiliHotComment[]
    pinnedComment: BilibiliHotComment | null
}

async function fetchVideoDetail(
    videoId: { type: 'bv' | 'av'; value: string },
    page: number,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void
) {
    const query = videoId.type === 'bv' ? `bvid=${videoId.value}` : `aid=${videoId.value}`
    const payload = await requestJson(
        `https://api.bilibili.com/x/web-interface/view?${query}`,
        cfg,
        debug,
        'video-detail'
    )
    if (Number(payload.code) !== 0 || !payload.data) {
        throw new Error(`B 站元数据获取失败：${payload.message || payload.code}`)
    }

    const data = payload.data as Record<string, unknown>
    const pages = Array.isArray(data.pages)
        ? (data.pages as Record<string, unknown>[])
        : []
    const picked = pages[page - 1] || pages[0]
    return {
        bvid: String(data.bvid || ''),
        aid: String(data.aid || ''),
        cid: String(
            data.cid
            || picked?.cid
            || ''
        ),
        title: String(data.title || ''),
        description: String(data.desc || ''),
        owner: String((data.owner as Record<string, unknown>)?.name || ''),
        cover: normalizeUrl(String(data.pic || '')),
        durationSec: Number(data.duration || 0),
        stats: {
            view: Number((data.stat as Record<string, unknown>)?.view || 0),
            like: Number((data.stat as Record<string, unknown>)?.like || 0),
            coin: Number((data.stat as Record<string, unknown>)?.coin || 0),
            favorite: Number(
                (data.stat as Record<string, unknown>)?.favorite || 0
            ),
            share: Number((data.stat as Record<string, unknown>)?.share || 0),
            danmaku: Number(
                (data.stat as Record<string, unknown>)?.danmaku || 0
            ),
            comment: Number((data.stat as Record<string, unknown>)?.reply || 0)
        }
    }
}

function extractPageNo(input: string) {
    try {
        const url = new URL(input)
        const p = Number(url.searchParams.get('p') || 0)
        if (Number.isInteger(p) && p > 0) {
            return p
        }
    } catch {
        // ignore
    }
    return 0
}

async function fetchPlayInfo(
    bvid: string,
    cid: string,
    qn: number,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void
) {
    const query = {
        bvid,
        cid,
        qn: String(qn),
        fnval: '16',
        fnver: '0',
        fourk: '0'
    }

    try {
        const payload = await requestJsonWithWbi(
            'https://api.bilibili.com/x/player/wbi/playurl',
            query,
            cfg,
            debug,
            'playurl-wbi'
        )
        if (Number(payload.code) === 0 && payload.data) {
            debug?.('B 站取流使用 WBI 接口成功', { bvid, cid, qn })
            return payload.data as Record<string, unknown>
        }
    } catch {
        debug?.('B 站取流 WBI 接口失败，回退旧接口', { bvid, cid, qn })
    }

    const url =
        'https://api.bilibili.com/x/player/playurl'
        + `?bvid=${encodeURIComponent(bvid)}`
        + `&cid=${encodeURIComponent(cid)}`
        + `&qn=${qn}`
        + '&fnval=16'
        + '&fnver=0'
        + '&fourk=0'

    const payload = await requestJson(url, cfg, debug, 'playurl-fallback')
    if (Number(payload.code) !== 0 || !payload.data) {
        throw new Error(`B 站播放信息获取失败：${payload.message || payload.code}`)
    }
    debug?.('B 站取流回退旧接口成功', { bvid, cid, qn })
    return payload.data as Record<string, unknown>
}

function pickVideo(data: Record<string, unknown>, qn: number) {
    const dash = data.dash as Record<string, unknown> | undefined
    const videos = (dash?.video || []) as Record<string, unknown>[]
    if (!videos.length) return null
    const sorted = videos
        .map((item) => ({
            id: Number(item.id || 0),
            height: Number(item.height || 0),
            codecid: Number(item.codecid || 0),
            bandwidth: Number(item.bandwidth || 0),
            url: normalizeUrl(String(item.baseUrl || item.base_url || ''))
        }))
        .filter((item) => item.url)
        .sort((a, b) => b.height - a.height)

    const pickByCodecPriority = (list: typeof sorted) => {
        const av1 = list
            .filter((item) => item.codecid === 13)
            .sort((a, b) => b.bandwidth - a.bandwidth)[0]
        if (av1) return av1

        const hevc = list
            .filter((item) => item.codecid === 12)
            .sort((a, b) => b.bandwidth - a.bandwidth)[0]
        if (hevc) return hevc

        const avc = list
            .filter((item) => item.codecid === 7)
            .sort((a, b) => b.bandwidth - a.bandwidth)[0]
        if (avc) return avc

        return list.sort((a, b) => b.bandwidth - a.bandwidth)[0] || null
    }

    const byId = sorted.filter((item) => item.id === qn)
    if (byId.length) return pickByCodecPriority(byId)

    if (qn === 64) {
        const h720 = sorted.filter((item) => item.height <= 720)
        if (h720.length) return pickByCodecPriority(h720)
    }

    const h480 = sorted.filter((item) => item.height <= 480)
    if (h480.length) return pickByCodecPriority(h480)
    return pickByCodecPriority(sorted)
}

function pickAudio(data: Record<string, unknown>, audioId: number) {
    const dash = data.dash as Record<string, unknown> | undefined
    const audios = (dash?.audio || []) as Record<string, unknown>[]
    if (!audios.length) return ''
    const sorted = audios
        .map((item) => ({
            id: Number(item.id || 0),
            bw: Number(item.bandwidth || 0),
            url: normalizeUrl(String(item.baseUrl || item.base_url || ''))
        }))
        .filter((item) => item.url)
        .sort((a, b) => b.bw - a.bw)

    const exact = sorted.find((item) => item.id === audioId)
    if (exact) return exact.url
    return sorted[0].url
}

async function requestJson(
    url: string,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void,
    tag = 'unknown'
) {
    const ac = new AbortController()
    const start = Date.now()
    const timer = setTimeout(() => ac.abort(), cfg.timeoutSeconds * 1000)

    try {
        const res = await fetch(url, {
            signal: ac.signal,
            headers: {
                referer: 'https://www.bilibili.com/',
                accept: 'application/json,text/plain,*/*',
                'user-agent': BILIBILI_UA
            }
        })
        const text = await res.text()
        debug?.('B站请求完成', { tag, status: res.status, costMs: Date.now() - start })
        return JSON.parse(text) as Record<string, unknown>
    } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError'
        const message = err instanceof Error ? err.message : String(err)
        debug?.('B站请求异常', { tag, costMs: Date.now() - start, name, message })
        throw new Error(`B站请求失败(${tag})：${name} ${message}`)
    } finally {
        clearTimeout(timer)
    }
}

function extractVideoId(input: string) {
    try {
        const parsed = new URL(input)
        const queryBvid = parsed.searchParams.get('bvid')
        if (queryBvid && BVID_RE.test(queryBvid)) {
            return { type: 'bv' as const, value: normalizeBvid(queryBvid) }
        }
        const queryAid = parsed.searchParams.get('aid')
        if (queryAid && /^\d+$/.test(queryAid)) {
            return { type: 'av' as const, value: queryAid }
        }
        const path = decodeURIComponent(parsed.pathname || '')
        const pathBvid = path.match(/\/video\/(BV[0-9a-zA-Z]{10})/i)?.[1]
        if (pathBvid) {
            return { type: 'bv' as const, value: normalizeBvid(pathBvid) }
        }
        const pathAvid = path.match(/\/video\/av(\d+)/i)?.[1]
        if (pathAvid) {
            return { type: 'av' as const, value: pathAvid }
        }
    } catch {
        // ignore
    }

    const bvid = input.match(BVID_RE)?.[0]
    if (bvid) return { type: 'bv' as const, value: normalizeBvid(bvid) }
    const avid = input.match(AVID_RE)?.[1]
    if (avid) return { type: 'av' as const, value: avid }
    return null
}

function normalizeBvid(value: string) {
    const text = value.trim()
    const exact = text.match(/^(?:bv|BV)([0-9a-zA-Z]{10})$/)
    if (exact) return `BV${exact[1]}`
    return text
}

function normalizeUrl(url: string) {
    if (!url) return ''
    if (url.startsWith('//')) return `https:${url}`
    return url
}

function buildDescription(desc: string, maxDescLength: number) {
    if (!desc) return ''
    if (desc.length > maxDescLength) {
        return `${desc.slice(0, maxDescLength)}...`
    }
    return desc
}

async function fetchHotComments(
    aid: string,
    count: number,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void
): Promise<BilibiliCommentResult> {
    if (!aid || !/^\d+$/.test(aid)) {
        return {
            hotComments: [] as BilibiliHotComment[],
            pinnedComment: null as BilibiliHotComment | null
        }
    }

    const safeCount = Math.min(Math.max(Math.floor(count), 1), 20)
    const seen = new Set<string>()
    const collected: BilibiliHotComment[] = []
    const result = await fetchRootRepliesViaWbi(
        aid,
        safeCount,
        cfg,
        debug
    )
    collectCommentOutputs(result.items, seen, collected)

    return {
        pinnedComment: result.pinnedComment,
        hotComments: collected.slice(0, safeCount)
    }
}

function collectCommentOutputs(
    items: Record<string, unknown>[],
    seen: Set<string>,
    out: BilibiliHotComment[]
) {
    for (const item of items) {
        const rpid = String(item.rpid || item.rpid_str || '')
        if (rpid && seen.has(rpid)) {
            continue
        }

        const parsed = toCommentOutput(item)
        if (!parsed) {
            continue
        }

        if (rpid) {
            seen.add(rpid)
        }
        out.push(parsed)
    }
}

function toCommentOutput(item: Record<string, unknown>) {
    const content = String((item.content as Record<string, unknown>)?.message || '')
    const images = extractCommentImages(item)
    if (!content && !images.length) {
        return null
    }

    return {
        content: content || '[图片评论]',
        likes: Number(item.like || 0),
        replies: Number(item.rcount || item.count || 0),
        ...(images.length ? { images } : {})
    } satisfies BilibiliHotComment
}

async function fetchRootRepliesViaWbi(
    aid: string,
    targetCount: number,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void
) {
    const maxPages = 2
    const out: Record<string, unknown>[] = []
    let pinnedComment: BilibiliHotComment | null = null
    let offset = ''

    for (let i = 0; i < maxPages; i++) {
        const payload = await requestJsonWithWbi(
            'https://api.bilibili.com/x/v2/reply/wbi/main',
            {
                oid: aid,
                type: '1',
                mode: '3',
                plat: '1',
                seek_rpid: '',
                web_location: '1315875',
                pagination_str: JSON.stringify({ offset })
            },
            cfg,
            debug,
            'reply-main-wbi'
        )

        if (Number(payload.code) !== 0 || !payload.data) {
            const code = Number(payload.code)
            const message = String(payload.message || '')
            throw new Error(`B站评论接口失败：code=${code} message=${message}`)
        }

        const data = payload.data as Record<string, unknown>
        if (i === 0) {
            pinnedComment = extractTopCommentFromWbiData(data)
        }
        const topReplies = Array.isArray(data.top_replies)
            ? (data.top_replies as Record<string, unknown>[])
            : []
        const replies = Array.isArray(data.replies)
            ? (data.replies as Record<string, unknown>[])
            : []
        out.push(...topReplies, ...replies)
        if (out.length >= targetCount) {
            break
        }

        const cursor = data.cursor as Record<string, unknown> | undefined
        const pageReply = cursor?.pagination_reply as Record<string, unknown> | undefined
        const nextOffset = String(pageReply?.next_offset || '')
        const isEnd = Boolean(cursor?.is_end)
        if (!nextOffset || isEnd) {
            break
        }
        offset = nextOffset
    }

    return {
        pinnedComment,
        items: out
    }
}

function extractTopCommentFromWbiData(data: Record<string, unknown>) {
    const top = data.top as Record<string, unknown> | undefined
    const upper = top?.upper as Record<string, unknown> | undefined
    if (upper) {
        return toCommentOutput(upper)
    }

    const topReplies = Array.isArray(data.top_replies)
        ? (data.top_replies as Record<string, unknown>[])
        : []
    if (!topReplies.length) {
        return null
    }

    return toCommentOutput(topReplies[0])
}

function extractCommentImages(item: Record<string, unknown>) {
    const content = item.content as Record<string, unknown> | undefined
    const candidates = [
        ...extractImageUrls(content?.pictures),
        ...extractImageUrls(item.pictures)
    ]
    const seen = new Set<string>()
    const out: string[] = []
    for (const url of candidates) {
        const normalized = normalizeUrl(url)
        if (!normalized || seen.has(normalized)) {
            continue
        }
        seen.add(normalized)
        out.push(normalized)
    }
    return out
}

function extractImageUrls(raw: unknown) {
    if (!raw) {
        return [] as string[]
    }
    const items = Array.isArray(raw) ? raw : [raw]
    const out: string[] = []
    for (const item of items) {
        if (typeof item === 'string') {
            out.push(item)
            continue
        }
        if (!item || typeof item !== 'object') {
            continue
        }
        const row = item as Record<string, unknown>
        const candidate = row.img_src || row.img_url || row.src || row.url || row.thumbnail_url
        if (typeof candidate === 'string' && candidate) {
            out.push(candidate)
        }
    }
    return out
}

async function requestJsonWithWbi(
    url: string,
    query: Record<string, string>,
    cfg: Config,
    debug?: (msg: string, extra?: unknown) => void,
    tag = 'wbi'
) {
    const mixin = await getWbiMixinKey(cfg, debug)
    const wts = Math.floor(Date.now() / 1000).toString()
    const sorted = Object.keys(query)
        .sort()
        .map((key) => {
            const value = String(query[key]).replace(/[!'()*]/g, '')
            return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
        })
    sorted.push(`wts=${wts}`)
    const plain = sorted.join('&')
    const wRid = crypto
        .createHash('md5')
        .update(`${plain}${mixin}`)
        .digest('hex')
    const finalUrl = `${url}?${plain}&w_rid=${wRid}`
    return requestJson(finalUrl, cfg, debug, tag)
}

async function getWbiMixinKey(cfg: Config, debug?: (msg: string, extra?: unknown) => void) {
    const now = Date.now()
    if (WBI_MIXIN_CACHE.value && now < WBI_MIXIN_CACHE.expiresAt) {
        return WBI_MIXIN_CACHE.value
    }

    if (!WBI_MIXIN_CACHE.pending) {
        WBI_MIXIN_CACHE.pending = (async () => {
            let lastError = ''
            for (let i = 0; i < 3; i++) {
                try {
                    const payload = await requestJson('https://api.bilibili.com/x/web-interface/nav', cfg, debug, 'wbi-nav')
                    const data = payload.data as Record<string, unknown> | undefined
                    const wbi = data?.wbi_img as Record<string, unknown> | undefined
                    if (!wbi || typeof wbi !== 'object') {
                        throw new Error(`code=${String(payload.code || '')} message=${String(payload.message || '')}`)
                    }
                    const img = String(wbi.img_url || '')
                    const sub = String(wbi.sub_url || '')
                    const imgKey = img.split('/').pop()?.split('.')[0] || ''
                    const subKey = sub.split('/').pop()?.split('.')[0] || ''
                    const raw = `${imgKey}${subKey}`
                    const mixin = WBI_MIXIN_INDEX.map((idx) => raw[idx]).join('').slice(0, 32)
                    if (!mixin || mixin.length < 32) {
                        throw new Error('empty-mixin')
                    }
                    WBI_MIXIN_CACHE.value = mixin
                    WBI_MIXIN_CACHE.expiresAt = Date.now() + 10 * 60 * 1000
                    return mixin
                } catch (err) {
                    lastError = err instanceof Error ? err.message : String(err)
                    if (i < 2) {
                        await sleep(200 * (i + 1))
                    }
                }
            }

            if (WBI_MIXIN_CACHE.value) {
                debug?.('WBI 签名参数刷新失败，回退使用最近缓存', lastError)
                return WBI_MIXIN_CACHE.value
            }

            throw new Error(`获取 WBI 签名参数失败：${lastError || 'unknown-error'}`)
        })()
            .finally(() => {
                WBI_MIXIN_CACHE.pending = null
            })
    }

    return WBI_MIXIN_CACHE.pending
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

const WBI_MIXIN_CACHE: {
    value: string
    expiresAt: number
    pending: Promise<string> | null
} = {
    value: '',
    expiresAt: 0,
    pending: null
}

const WBI_MIXIN_INDEX = [
    46,
    47,
    18,
    2,
    53,
    8,
    23,
    32,
    15,
    50,
    10,
    31,
    58,
    3,
    45,
    35,
    27,
    43,
    5,
    49,
    33,
    9,
    42,
    19,
    29,
    28,
    14,
    39,
    12,
    38,
    41,
    13,
    37,
    48,
    7,
    16,
    24,
    55,
    40,
    61,
    26,
    17,
    0,
    1,
    60,
    51,
    30,
    4,
    22,
    25,
    54,
    21,
    56,
    59,
    6,
    63,
    57,
    62,
    11,
    36,
    20,
    34,
    44,
    52
]
