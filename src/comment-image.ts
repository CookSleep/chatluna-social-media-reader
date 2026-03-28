import { HumanMessage } from '@langchain/core/messages'
import { Context } from 'koishi'
import { ModelCapabilities } from 'koishi-plugin-chatluna/llm-core/platform/types'
import { getImageType, getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { Config, DEFAULT_COMMENT_IMAGE_PROMPT } from './config'

export function toMarkdownImage(text: string, url: string) {
    return `![${text.trim() || 'Image'}](${url})`
}

export async function describeCommentImages(
    ctx: Context,
    cfg: Config,
    items: Array<{ url: string; text: string }>
) {
    const out = new Map<string, string>()
    if (!cfg.bilibili.describeCommentImages || !items.length) {
        return out
    }
    if (!cfg.commentImageService.model || cfg.commentImageService.model === '无') {
        return out
    }

    const ref = await ctx.chatluna.createChatModel(cfg.commentImageService.model)
    if (!ref.value) {
        return out
    }
    if (!ref.value.modelInfo.capabilities.includes(ModelCapabilities.ImageInput)) {
        return out
    }

    const list = [...new Map(items.map((item) => [`${item.url}\n${item.text}`, item])).values()]
    let idx = 0

    await Promise.all(
        Array.from({ length: Math.min(cfg.commentImageService.taskConcurrency, list.length) }, async () => {
            while (idx < list.length) {
                const item = list[idx]
                idx += 1
                try {
                    const data = await ctx.http.get<ArrayBuffer>(item.url, {
                        responseType: 'arraybuffer',
                        timeout: cfg.timeoutSeconds * 1000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
                        }
                    })
                    const buf = Buffer.from(data)
                    const mime = getImageType(buf) || 'image/jpeg'
                    const msg = await ref.value.invoke([
                        new HumanMessage({
                            content: [
                                {
                                    type: 'text',
                                    text: `${cfg.commentImageService.prompt || DEFAULT_COMMENT_IMAGE_PROMPT}\n\n该图片所属评论文字：${item.text || '（无）'}`
                                },
                                {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${mime};base64,${buf.toString('base64')}`
                                    }
                                }
                            ]
                        })
                    ])
                    const text = getMessageContent(msg.content).trim()
                    if (text) {
                        out.set(item.url, text)
                    }
                } catch {}
            }
        })
    )

    return out
}
