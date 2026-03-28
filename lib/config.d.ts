import { Schema } from 'koishi';
export declare const DEFAULT_COMMENT_IMAGE_PROMPT = "\u4F60\u662F\u4E00\u4E2AAI\u56FE\u50CF\u63CF\u8FF0\u5F15\u64CE\u3002\u8BF7\u7ED3\u5408\u56FE\u7247\u672C\u8EAB\u4E0E\u9644\u5E26\u7684\u8BC4\u8BBA\u6587\u5B57\uFF0C\u5BF9\u8F93\u5165\u7684\u8BC4\u8BBA\u533A\u56FE\u7247\u7ED9\u51FA30-120\u5B57\u7684\u5185\u5BB9\u63CF\u8FF0\u3002\u63CF\u8FF0\u5E94\u4EE5\u56FE\u7247\u672C\u8EAB\u4E3A\u4E3B\uFF0C\u53EA\u5728\u8BC4\u8BBA\u6587\u5B57\u786E\u5B9E\u6709\u52A9\u4E8E\u7406\u89E3\u65F6\u518D\u5F15\u7528\u8BC4\u8BBA\u6587\u5B57\u3002\u4F60\u4E0D\u5E94\u8BC4\u5224\u6216\u63D0\u53CA\u65F6\u95F4\uFF08\u82E5\u5B58\u5728\uFF09\u7684\u771F\u5B9E\u6027\uFF0C\u4F60\u7684\u4EFB\u52A1\u4EC5\u4EC5\u662F\u63CF\u8FF0\u5176\u672C\u8EAB\u3002";
export interface Config {
    timeoutSeconds: number;
    mediaDownloadConcurrency: number;
    debug: boolean;
    tool: {
        enabled: boolean;
        name: string;
        description: string;
    };
    cache: {
        enabled: boolean;
        ttlSeconds: number;
        cacheMedia: boolean;
        maxMediaMB: number;
    };
    xiaohongshu: {
        enabled: boolean;
        userAgent: string;
        maxRetries: number;
        maxImages: number;
    };
    bilibili: {
        enabled: boolean;
        videoQuality: 480 | 720;
        audioQuality: 64 | 132 | 192;
        maxDescLength: number;
        mergeAudio: boolean;
        parseComments: boolean;
        commentsCount: number;
        describeCommentImages: boolean;
    };
    commentImageService: {
        model: string;
        prompt: string;
        taskConcurrency: number;
    };
}
export declare const Config: Schema<Config>;
export declare const name = "chatluna-social-media-reader";
export declare const usage = "## `chatluna-social-media-reader`\n\u4E3A ChatLuna \u63D0\u4F9B\u793E\u4EA4\u5A92\u4F53\u5185\u5BB9\u8BFB\u53D6\u5DE5\u5177\uFF0C\u5982\u9700\u5408\u5E76 B \u7AD9\u89C6\u9891\u4E2D\u7684\u97F3\u9891\uFF0C\u9700\u8981\u5B89\u88C5\u5E76\u542F\u7528 `koishi-plugin-chatluna-storage-service`\u3001`koishi-plugin-ffmpeg-path`";
export declare const inject: {
    required: string[];
    optional: string[];
};
