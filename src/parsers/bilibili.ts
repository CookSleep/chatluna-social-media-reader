import crypto from 'node:crypto'
import { Config } from '../config'
import { ParseRequest, SocialParseResult } from '../types'
import { resolveRedirect } from '../utils/url'

const BVID_RE = /BV[0-9a-zA-Z]{10}/i
const AVID_RE = /(?:^|[^a-zA-Z0-9])av(\d+)/i

export async function parseBilibili(
    inputUrl: string,
    cfg: Config,
    req: ParseRequest,
    debug?: (msg: string, extra?: unknown) => void
) {
    const resolved = await resolveRedirect(inputUrl, cfg.timeoutSeconds * 1000)
    const videoId = extractVideoId(resolved) || extractVideoId(inputUrl)
    const page = extractPageNo(resolved) || extractPageNo(inputUrl) || 1
    if (!videoId) {
        throw new Error('无法提取 B 站视频 ID。')
    }

    const detail = await fetchVideoDetail(videoId, page, cfg)
    if (!detail.bvid || !detail.cid) {
        throw new Error('B 站视频信息不完整，缺少 bvid 或 cid。')
    }

    const qn = (req.bilibiliVideoQuality || cfg.bilibili.videoQuality) === 720 ? 64 : 32
    const aq = req.bilibiliAudioQuality || cfg.bilibili.audioQuality
    const audioId = aq === 192 ? 30280 : aq === 132 ? 30232 : 30216
    const play = await fetchPlayInfo(detail.bvid, detail.cid, qn, cfg, debug)

    const video = pickVideo(play, qn)
    const audio = pickAudio(play, audioId)
    const finalUrl =
        page > 1
            ? `https://www.bilibili.com/video/${detail.bvid}?p=${page}`
            : `https://www.bilibili.com/video/${detail.bvid}`

    return {
        platform: 'bilibili',
        title: detail.title,
        content: buildContent(detail.description, cfg.bilibili.maxDescLength, detail.stats),
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
            page
        }
    } satisfies SocialParseResult
}

async function fetchVideoDetail(
    videoId: { type: 'bv' | 'av'; value: string },
    page: number,
    cfg: Config
) {
    const query = videoId.type === 'bv' ? `bvid=${videoId.value}` : `aid=${videoId.value}`
    const payload = await requestJson(
        `https://api.bilibili.com/x/web-interface/view?${query}`,
        cfg
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
            )
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
            cfg
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

    const payload = await requestJson(url, cfg)
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

async function requestJson(url: string, cfg: Config) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), cfg.timeoutSeconds * 1000)
    try {
        const res = await fetch(url, {
            signal: ac.signal,
            headers: {
                referer: 'https://www.bilibili.com/',
                accept: 'application/json,text/plain,*/*'
            }
        })
        const text = await res.text()
        return JSON.parse(text) as Record<string, unknown>
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

function buildContent(
    desc: string,
    maxDescLength: number,
    stats: Record<string, number>
) {
    const lines = [
        `播放：${formatCount(stats.view)}，点赞：${formatCount(stats.like)}，投币：${formatCount(stats.coin)}`,
        `收藏：${formatCount(stats.favorite)}，转发：${formatCount(stats.share)}，弹幕：${formatCount(stats.danmaku)}`
    ]
    if (desc) {
        if (desc.length > maxDescLength) {
            lines.push(`简介：${desc.slice(0, maxDescLength)}...`)
        } else {
            lines.push(`简介：${desc}`)
        }
    }
    return lines.join('\n')
}

function formatCount(value: number) {
    if (!Number.isFinite(value) || value <= 0) return '0'
    if (value >= 100000000) return `${(value / 100000000).toFixed(1).replace(/\.0$/, '')}亿`
    if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`
    return String(Math.floor(value))
}

async function requestJsonWithWbi(
    url: string,
    query: Record<string, string>,
    cfg: Config
) {
    const mixin = await getWbiMixinKey(cfg)
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
    return requestJson(finalUrl, cfg)
}

async function getWbiMixinKey(cfg: Config) {
    const payload = await requestJson('https://api.bilibili.com/x/web-interface/nav', cfg)
    if (Number(payload.code) !== 0 || !payload.data) {
        throw new Error('获取 WBI 签名参数失败。')
    }
    const data = payload.data as Record<string, unknown>
    const wbi = data.wbi_img as Record<string, unknown>
    const img = String(wbi.img_url || '')
    const sub = String(wbi.sub_url || '')
    const imgKey = img.split('/').pop()?.split('.')[0] || ''
    const subKey = sub.split('/').pop()?.split('.')[0] || ''
    const raw = `${imgKey}${subKey}`
    return WBI_MIXIN_INDEX.map((idx) => raw[idx]).join('').slice(0, 32)
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
