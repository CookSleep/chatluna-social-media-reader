import { SocialPlatform } from '../types';
export declare function normalizeInputUrl(raw: string): string;
export declare function detectPlatform(url: string): SocialPlatform | null;
export declare function resolveRedirect(url: string, timeoutMs: number): Promise<string>;
