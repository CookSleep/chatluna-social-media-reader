import { h, Session } from 'koishi';
interface CardHit {
    platform: 'bilibili' | 'xiaohongshu';
    title: string;
    url: string;
}
export declare function extractCardItems(session: Session, elements: h[]): CardHit[];
export declare function formatCardText(item: CardHit): string;
export {};
