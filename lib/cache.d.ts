import { Context } from 'koishi';
import { Config } from './config';
import { CachedResult, ParseRequest, SocialParseResult } from './types';
interface SocialMediaCacheRow {
    key: string;
    createdAt: Date;
    expiresAt: Date;
    result: string;
    cached: string;
}
declare module 'koishi' {
    interface Context {
        chatluna_storage?: {
            createTempFile(buffer: Buffer, filename: string, expireHours?: number): Promise<{
                url: string;
            }>;
        };
    }
    interface Tables {
        chatluna_social_media_cache: SocialMediaCacheRow;
    }
}
export declare class CacheService {
    private ctx;
    private cfg;
    private warnedStorageUnavailable;
    constructor(ctx: Context, cfg: Config);
    init(): Promise<void>;
    createKey(req: ParseRequest): string;
    get(key: string): Promise<CachedResult>;
    set(key: string, result: SocialParseResult, mergeAudio: boolean): Promise<CachedResult>;
    private cleanupExpired;
    private encode;
    private decode;
    private downloadMany;
    private download;
    private fetchWithinLimit;
    private ttlHours;
    private mergeFromSources;
    private hasStorageService;
    private mergeMp4;
    private debug;
}
export {};
