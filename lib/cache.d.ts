import type { Context } from 'cordis';
import type { ReadConfig as Config } from './config.js';
import { CachedResult, ParseRequest, SocialParseResult } from './types.js';
interface SocialMediaCacheRow {
    key: string;
    createdAt: Date;
    expiresAt: Date;
    result: string;
    cached: string;
}
declare module '@cordisjs/plugin-database' {
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
    get(key: string): Promise<CachedResult | null>;
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
    private isMediaCacheComplete;
    private convertAudio;
    private mergeMp4;
    private debug;
}
export {};
