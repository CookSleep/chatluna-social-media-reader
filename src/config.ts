import { Schema } from 'koishi'

export const DEFAULT_COMMENT_IMAGE_PROMPT = '你是一个AI图像描述引擎。请结合图片本身与附带的评论文字，对输入的评论区图片给出30-120字的内容描述。描述应以图片本身为主，只在评论文字确实有助于理解时再引用评论文字。你不应评判或提及时间（若存在）的真实性，你的任务仅仅是描述其本身。'

export interface Config {
    timeoutSeconds: number
    mediaDownloadConcurrency: number
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
        parseComments: boolean
        commentsCount: number
        describeCommentImages: boolean
    }
    commentImageService: {
        model: string
        prompt: string
        taskConcurrency: number
    }
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        timeoutSeconds: Schema.number().default(15).description('网络请求超时（秒）'),
        mediaDownloadConcurrency: Schema.number().min(1).max(20).default(6).description('媒体下载并发数'),
        debug: Schema.boolean().default(false).description('输出调试日志')
    }).description('基础设置'),
    Schema.object({
        tool: Schema.object({
            enabled: Schema.boolean().default(true).description('注册 ChatLuna 工具'),
            name: Schema.string().default('read_social_media').description('工具名称'),
            description: Schema.string()
                .default('读取哔哩哔哩或小红书链接，返回结构化信息与媒体资源链接')
                .description('工具描述')
        }).description('工具设置')
    }),
    Schema.object({
        cache: Schema.object({
            enabled: Schema.boolean().default(true).description('启用读取缓存'),
            ttlSeconds: Schema.number().default(24 * 60 * 60).min(60).description('缓存有效期（秒）'),
            cacheMedia: Schema.boolean()
                .default(true)
                .description('缓存媒体文件到 `chatluna-storage-service`（需要安装并启用 `koishi-plugin-chatluna-storage-service`）'),
            maxMediaMB: Schema.number()
                .min(1)
                .max(100)
                .default(20)
                .description('单个媒体下载上限（MB，按 Base64 URL 编码后大小计算）')
        }).description('缓存设置')
    }),
    Schema.object({
        xiaohongshu: Schema.object({
            enabled: Schema.boolean().default(true).description('启用小红书解析'),
            userAgent: Schema.string()
                .default('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')
                .description('抓取页面使用的 User-Agent'),
            maxRetries: Schema.number().default(3).min(1).max(6).description('抓取重试次数'),
            maxImages: Schema.number().default(10).min(1).max(40).description('最多返回图片数量')
        }).description('小红书设置'),
        bilibili: Schema.object({
            enabled: Schema.boolean().default(true).description('启用 B 站解析'),
            parseComments: Schema.boolean()
                .default(false)
                .description('启用后解析 B 站评论区热评前 N 条，并在有置顶时额外输出 `pinnedComment` 字段'),
            commentsCount: Schema.number()
                .default(5)
                .min(1)
                .max(20)
                .description('B 站热评解析条数'),
            videoQuality: Schema.union([
                Schema.const(480).description('480P（默认）'),
                Schema.const(720).description('720P')
            ])
                .default(480)
                .description('视频清晰度（过大可能导致超出请求中内联文件的大小限制）') as Schema<Config['bilibili']['videoQuality']>,
            audioQuality: Schema.union([
                Schema.const(64).description('64K（默认）'),
                Schema.const(132).description('132K'),
                Schema.const(192).description('192K')
            ])
                .default(64)
                .description('音频码率（过大可能导致超出请求中内联文件的大小限制）') as Schema<Config['bilibili']['audioQuality']>,
            maxDescLength: Schema.number().default(500).min(20).max(1000).description('简介最长字符数'),
            mergeAudio: Schema.boolean()
                .default(true)
                .description('缓存媒体时合并视频和音频（需要安装并启用 `koishi-plugin-ffmpeg-path`）'),
            describeCommentImages: Schema.boolean()
                .default(true)
                .description('为评论区图像生成文本描述')
        }).description('B 站设置')
    }),
    Schema.object({
        commentImageService: Schema.object({
            model: Schema.dynamic('model').default('无').description('用于评论区图像描述的多模态模型'),
            prompt: Schema.string().role('textarea').default(DEFAULT_COMMENT_IMAGE_PROMPT).description('评论区图像描述提示词'),
            taskConcurrency: Schema.number().min(1).max(20).default(20).description('评论区图像描述并发数')
        }).description('评论区图像描述服务')
    })
])

export const name = 'chatluna-social-media-reader'

export const usage = `## chatluna-social-media-reader
为 ChatLuna 提供哔哩哔哩与小红书链接读取工具，返回标题、作者、正文与媒体资源链接。

### 能力
- 哔哩哔哩：支持 \`bilibili.com\`、\`b23.tv\` 等短链，输出标签与简介，可选解析热评与置顶评论，并为评论区图片生成描述。
- 小红书：支持 \`xiaohongshu.com\`、\`xhslink.com\`，输出标题、作者、正文、图片与视频。
- 分享卡片：消息中的 B 站、小红书分享卡片会被转成“标题 + 链接”的文字，供模型决定是否读取。

### 依赖
- 必需：\`koishi-plugin-ffmpeg-path\` 提供的 \`ffmpeg\` 服务，以及 \`database\`、\`http\` 服务。
- 可选：\`koishi-plugin-chatluna-storage-service\`，用于缓存图片、视频、音频，并在缓存时合并 B 站视频的音视频。
- 可选：\`koishi-plugin-chatluna-multimodal-service\`，提供 \`read_files\` 工具，让模型读取视频、音频或图片的实际内容。
- 为评论区图片生成描述时，需要在“评论区图像描述服务”中选择支持图片输入的模型。

### 使用声明
- 本插件仅供学习、研究与合规开发使用。
- 使用者应自行遵守各社交媒体平台的用户协议与 robots.txt 规定。
- 请勿将本插件用于任何违法、违规、侵犯版权或违反平台规则的行为，因不当使用产生的任何后果由使用者自行承担。`

export const inject = {
    required: ['chatluna', 'http', 'database', 'ffmpeg'],
    optional: ['chatluna_storage']
}
