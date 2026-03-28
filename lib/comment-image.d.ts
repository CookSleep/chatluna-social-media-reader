import { Context } from 'koishi';
import { Config } from './config';
export declare function toMarkdownImage(text: string, url: string): string;
export declare function describeCommentImages(ctx: Context, cfg: Config, items: Array<{
    url: string;
    text: string;
}>): Promise<Map<string, string>>;
