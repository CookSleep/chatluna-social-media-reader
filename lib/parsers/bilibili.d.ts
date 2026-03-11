import { Config } from '../config';
import { ParseRequest } from '../types';
export declare function parseBilibili(inputUrl: string, cfg: Config, req: ParseRequest, debug?: (msg: string, extra?: unknown) => void): Promise<{
    platform: "bilibili";
    title: string;
    content: string;
    cover: string;
    author: string;
    url: string;
    images: string[];
    videos: string[];
    audios: string[];
    extra: {
        bvid: string;
        aid: string;
        cid: string;
        durationSec: number;
        videoQuality: number;
        audioQuality: 64 | 132 | 192;
        videoCodecId: number;
        page: number;
    };
}>;
