import type { Context } from 'cordis';
import type { Config } from './config.js';
export * from './config.js';
export declare function apply(ctx: Context, cfg: Config): Promise<void>;
