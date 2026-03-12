export type SocialPlatform = 'xiaohongshu' | 'bilibili';
export interface ParseRequest {
    url: string;
    bilibiliVideoQuality?: 480 | 720;
    bilibiliAudioQuality?: 64 | 132 | 192;
    bilibiliMergeAudio?: boolean;
    bilibiliParseComments?: boolean;
    bilibiliCommentsCount?: number;
    xiaohongshuMaxImages?: number;
    cacheMedia?: boolean;
    maxMediaMB?: number;
}
export interface SocialParseResult {
    platform: SocialPlatform;
    title: string;
    content: string;
    cover?: string;
    author?: string;
    url: string;
    images: string[];
    videos: string[];
    audios: string[];
    extra?: Record<string, unknown>;
}
export interface CachedMediaItem {
    source: string;
    stored: string;
    size: number;
}
export interface CachedResult {
    key: string;
    createdAt: number;
    expiresAt: number;
    result: SocialParseResult;
    cached: {
        images: CachedMediaItem[];
        commentImages: CachedMediaItem[];
        videos: CachedMediaItem[];
        audios: CachedMediaItem[];
        mergedVideo?: string;
    };
}
