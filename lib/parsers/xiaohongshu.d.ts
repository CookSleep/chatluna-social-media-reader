import { Context } from 'koishi';
import { Config } from '../config';
export declare function parseXiaohongshu(ctx: Context, inputUrl: string, cfg: Config): Promise<{
    platform: "xiaohongshu";
    title: string;
    content: string;
    cover: string;
    author: string;
    url: string;
    images: string[];
    videos: string[];
    audios: any[];
}>;
