import type { Context } from 'cordis'
import { h } from '@satorijs/core'
import type {} from '@chatluna/transform'
import type { Config } from './config.js'
import { detectPlatform } from './utils/url.js'

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {}
}

function firstText(...values: unknown[]) {
    return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function preview(title: unknown, url: unknown, cfg: Config) {
    if (typeof title !== 'string' || typeof url !== 'string') return
    const link = url.trim()
    const platform = detectPlatform(link)
    const text = title.replace(/\s+/g, ' ').trim()
    if (!platform || !cfg[platform].enabled || !text) return
    const label = platform === 'bilibili' ? '哔哩哔哩' : '小红书'
    return { type: 'text' as const, text: `【${text}-${label}】\n${link}` }
}

export function registerCards(ctx: Context, cfg: Config) {
    for (const platform of ['onebot', 'qq']) {
        ctx.transform.element(platform + ':share', ({ attrs }) =>
            preview(firstText(attrs.title, attrs.content), attrs.url, cfg), 1)
        ctx.transform.element(platform + ':json', ({ attrs }) => {
            let payload = attrs.data
            if (typeof payload === 'string') {
                try { payload = JSON.parse(payload) } catch { return }
            }
            const card = record(payload)
            const meta = record(card.meta)
            for (const [key, value] of Object.entries(meta)) {
                const item = record(value)
                const title = key === 'detail_1' ? firstText(item.desc, item.title, card.prompt)
                    : firstText(item.title, item.desc, card.prompt)
                for (const link of [item.qqdocurl, item.jumpUrl, item.url]) {
                    const result = preview(title, link, cfg)
                    if (result) return result
                }
            }
            const fields = new Map<string, unknown>()
            for (const [key, value] of Object.entries(record(card.fields))) fields.set(key.toLowerCase(), value)
            if (Array.isArray(card.kv)) {
                for (const row of card.kv) {
                    const { key, value } = record(row)
                    if (typeof key === 'string') fields.set(key.replace(/^#|#$/g, '').toLowerCase(), value)
                }
            }
            const title = firstText(fields.get('title'), fields.get('desc'), card.prompt)
            for (const key of ['jumpurl', 'qqdocurl', 'link', 'url']) {
                const result = preview(title, fields.get(key), cfg)
                if (result) return result
            }
        }, 1)
        ctx.transform.element(platform + ':xml', ({ attrs }) => {
            if (typeof attrs.data !== 'string') return
            const tree = h.parse(attrs.data)
            const msg = h.select(tree, 'msg')[0]
            if (!msg) return
            const title = h.select(msg.children, 'title')[0]
            return preview(firstText(title && h.select(title.children, 'text').map(el => el.attrs.content).join(''),
                title?.attrs.content, msg.attrs.title, msg.attrs.brief), msg.attrs.url, cfg)
        }, 1)
    }
}
