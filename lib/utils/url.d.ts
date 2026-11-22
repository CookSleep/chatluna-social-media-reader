import type { SocialPlatform } from '../types.js';
export declare function normalizeInputUrl(raw: string): string;
export declare function detectPlatform(raw: string): SocialPlatform | null;
export declare function isMediaUrl(raw: string): boolean;
export declare function fetchMedia(input: string, options: RequestInit): Promise<Response>;
export declare function fetchPost(input: string, options: RequestInit): Promise<Response>;
export declare function resolveRedirect(input: string, timeout: number, signal?: AbortSignal): Promise<string>;
export declare function readLimited(response: Response, maxBytes: number): Promise<Buffer<ArrayBuffer>>;
