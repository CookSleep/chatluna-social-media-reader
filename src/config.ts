import { Schema } from 'koishi'

export interface Config {
    timeoutSeconds: number
    debug: boolean
    tool: {
        enabled: boolean
        name: string
        description: string
    }
    cache: {
        enabled: boolean
        ttlSeconds: number
        cacheMedia: boolean
        maxMediaMB: number
    }
    xiaohongshu: {
        enabled: boolean
        userAgent: string
        maxRetries: number
        maxImages: number
    }
    bilibili: {
        enabled: boolean
        videoQuality: 480 | 720
        audioQuality: 64 | 132 | 192
        maxDescLength: number
        mergeAudio: boolean
    }
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        timeoutSeconds: Schema.number().default(15).description('网络请求超时（秒）。'),
        debug: Schema.boolean().default(false).description('输出调试日志。')
    }).description('基础设置'),
    Schema.object({
        tool: Schema.object({
            enabled: Schema.boolean().default(true).description('注册 ChatLuna 工具。'),
            name: Schema.string().default('read_social_media').description('工具名称。'),
            description: Schema.string()
                .default('读取哔哩哔哩或小红书链接，返回结构化信息与媒体资源链接。')
                .description('工具描述。')
        }).description('工具设置')
    }),
    Schema.object({
        cache: Schema.object({
            enabled: Schema.boolean().default(true).description('启用读取缓存。'),
            ttlSeconds: Schema.number().default(24 * 60 * 60).min(60).description('缓存有效期（秒）。'),
            cacheMedia: Schema.boolean()
                .default(true)
                .description('缓存媒体文件到 chatluna-storage-service（需要安装并启用 `koishi-plugin-chatluna-storage-service`）。'),
            maxMediaMB: Schema.number()
                .min(1)
                .max(100)
                .default(20)
                .description('单个媒体下载上限（MB，按 Base64 URL 编码后大小计算）。')
        }).description('缓存设置')
    }),
    Schema.object({
        xiaohongshu: Schema.object({
            enabled: Schema.boolean().default(true).description('启用小红书解析。'),
            userAgent: Schema.string()
                .default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
                .description('抓取页面使用的 User-Agent。'),
            maxRetries: Schema.number().default(3).min(1).max(6).description('抓取重试次数。'),
            maxImages: Schema.number().default(10).min(1).max(40).description('最多返回图片数量。')
        }).description('小红书设置'),
        bilibili: Schema.object({
            enabled: Schema.boolean().default(true).description('启用 B 站解析。'),
            videoQuality: Schema.union([
                Schema.const(480).description('480P（默认）'),
                Schema.const(720).description('720P')
            ])
                .default(480)
                .description('视频清晰度（过大可能导致超出请求中内联文件的大小限制）。') as Schema<Config['bilibili']['videoQuality']>,
            audioQuality: Schema.union([
                Schema.const(64).description('64K（默认）'),
                Schema.const(132).description('132K'),
                Schema.const(192).description('192K')
            ])
                .default(64)
                .description('音频码率（过大可能导致超出请求中内联文件的大小限制）。') as Schema<Config['bilibili']['audioQuality']>,
            maxDescLength: Schema.number().default(500).min(20).max(1000).description('简介最长字符数。'),
            mergeAudio: Schema.boolean()
                .default(true)
                .description('缓存媒体时合并视频和音频（需要安装并启用 `koishi-plugin-ffmpeg-path`）。')
        }).description('B 站设置')
    })
])

export const name = 'chatluna-social-media-reader'

export const usage = `## chatluna-social-media-reader
为 ChatLuna 提供社交媒体内容读取工具，如需合并 B 站视频中的音频，需要安装并启用 \`koishi-plugin-chatluna-storage-service\`、\`koishi-plugin-ffmpeg-path\`。`

export const inject = {
    required: ['chatluna', 'http', 'database', 'ffmpeg'],
    optional: ['chatluna_storage']
}
