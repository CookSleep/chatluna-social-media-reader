import type { ReadConfig as Config } from '../config.js';
export declare function parseXiaohongshu(inputUrl: string, cfg: Config): Promise<{
    platform: "xiaohongshu";
    title: string;
    content: string;
    cover: string;
    author: string;
    url: string;
    images: string[];
    videos: string[];
    audios: never[];
}>;
