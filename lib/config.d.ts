import { Schema } from 'koishi';
export interface Config {
    timeoutSeconds: number;
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
    };
}
export declare const Config: Schema<Config>;
export declare const name = "chatluna-social-media-reader";
export declare const usage = "## `chatluna-social-media-reader`\n\u4E3A ChatLuna \u63D0\u4F9B\u793E\u4EA4\u5A92\u4F53\u5185\u5BB9\u8BFB\u53D6\u5DE5\u5177\uFF0C\u5982\u9700\u5408\u5E76 B \u7AD9\u89C6\u9891\u4E2D\u7684\u97F3\u9891\uFF0C\u9700\u8981\u5B89\u88C5\u5E76\u542F\u7528 `koishi-plugin-chatluna-storage-service`\u3001`koishi-plugin-ffmpeg-path`";
export declare const inject: {
    required: string[];
    optional: string[];
};
