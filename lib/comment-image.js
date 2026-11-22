import { DEFAULT_COMMENT_IMAGE_PROMPT } from './config.js';
import { fetchMedia, readLimited } from './utils/url.js';
export function toMarkdownImage(text, url) {
    return `![${text.trim() || 'Image'}](${url})`;
}
export async function describeCommentImages(ctx, cfg, items) {
    const out = new Map();
    const model = cfg.commentImageService.model;
    const ai = ctx.get('ai');
    if (!ai || !cfg.bilibili.describeCommentImages || !model || model === '无' || !items.length)
        return out;
    const pending = [...new Map(items.map(item => [item.url, item])).values()];
    try {
        const bound = await ai.chat(model).bind({ timeout: { total: cfg.timeoutSeconds * 1000 }, signal: cfg.signal });
        await Promise.all(Array.from({ length: Math.min(pending.length, cfg.commentImageService.taskConcurrency) }, async () => {
            for (let item; (item = pending.pop());) {
                try {
                    cfg.signal?.throwIfAborted();
                    const limit = AbortSignal.timeout(cfg.timeoutSeconds * 1000);
                    const file = item.url.startsWith('storage://')
                        ? await ctx.get('chatluna_storage')?.readFile(item.url.slice(10)) : undefined;
                    let bytes = file?.buffer;
                    let mime = file?.type;
                    if (!bytes) {
                        const response = await fetchMedia(item.url, { signal: cfg.signal ? AbortSignal.any([cfg.signal, limit]) : limit });
                        if (!response.ok) {
                            await response.body?.cancel();
                            continue;
                        }
                        bytes = await readLimited(response, cfg.cache.maxMediaMB * 1024 * 1024 * 0.75);
                        mime = response.headers.get('content-type')?.split(';')[0];
                    }
                    if (!mime?.startsWith('image/'))
                        continue;
                    const chunks = [];
                    for await (const part of bound.call({ messages: [{ role: 'user', content: [
                                    { type: 'text', text: (cfg.commentImageService.prompt || DEFAULT_COMMENT_IMAGE_PROMPT) + '\n评论文字：' + item.text },
                                    { type: 'file', mediaType: mime, data: { type: 'data', data: bytes.toString('base64') } }
                                ] }] })) {
                        if (part.type === 'block-end' && part.block.type === 'text')
                            chunks.push(part.block.text);
                    }
                    if (chunks.length)
                        out.set(item.url, chunks.join('').trim());
                }
                catch {
                    cfg.signal?.throwIfAborted();
                }
            }
        }));
    }
    catch {
        cfg.signal?.throwIfAborted();
    }
    return out;
}
