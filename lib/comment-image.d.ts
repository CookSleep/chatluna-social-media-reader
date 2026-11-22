import type { Context } from 'cordis';
import { type ReadConfig } from './config.js';
export declare function toMarkdownImage(text: string, url: string): string;
export declare function describeCommentImages(ctx: Context, cfg: ReadConfig, items: Array<{
    url: string;
    text: string;
}>): Promise<Map<string, string>>;
