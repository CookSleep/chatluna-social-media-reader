var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
import { StructuredTool } from "@langchain/core/tools";
import { h } from "koishi";
import { z } from "zod";

// src/cache.ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Time } from "koishi";

// src/config.ts
import { Schema } from "koishi";
var Config = Schema.intersect([
  Schema.object({
    timeoutSeconds: Schema.number().default(15).description("网络请求超时（秒）。"),
    debug: Schema.boolean().default(false).description("输出调试日志。")
  }).description("基础设置"),
  Schema.object({
    tool: Schema.object({
      enabled: Schema.boolean().default(true).description("注册 ChatLuna 工具。"),
      name: Schema.string().default("read_social_media").description("工具名称。"),
      description: Schema.string().default("读取哔哩哔哩或小红书链接，返回结构化信息与媒体资源链接。").description("工具描述。")
    }).description("工具设置")
  }),
  Schema.object({
    cache: Schema.object({
      enabled: Schema.boolean().default(true).description("启用读取缓存。"),
      ttlSeconds: Schema.number().default(24 * 60 * 60).min(60).description("缓存有效期（秒）。"),
      cacheMedia: Schema.boolean().default(true).description("缓存媒体文件到 chatluna-storage-service（需要安装并启用 `koishi-plugin-chatluna-storage-service`）。"),
      maxMediaMB: Schema.number().min(1).max(100).default(20).description("单个媒体下载上限（MB，按 Base64 URL 编码后大小计算）。")
    }).description("缓存设置")
  }),
  Schema.object({
    xiaohongshu: Schema.object({
      enabled: Schema.boolean().default(true).description("启用小红书解析。"),
      userAgent: Schema.string().default("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36").description("抓取页面使用的 User-Agent。"),
      maxRetries: Schema.number().default(3).min(1).max(6).description("抓取重试次数。"),
      maxImages: Schema.number().default(10).min(1).max(40).description("最多返回图片数量。")
    }).description("小红书设置"),
    bilibili: Schema.object({
      enabled: Schema.boolean().default(true).description("启用 B 站解析。"),
      videoQuality: Schema.union([
        Schema.const(480).description("480P（默认）"),
        Schema.const(720).description("720P")
      ]).default(480).description("视频清晰度（过大可能导致超出请求中内联文件的大小限制）。"),
      audioQuality: Schema.union([
        Schema.const(64).description("64K（默认）"),
        Schema.const(132).description("132K"),
        Schema.const(192).description("192K")
      ]).default(64).description("音频码率（过大可能导致超出请求中内联文件的大小限制）。"),
      maxDescLength: Schema.number().default(500).min(20).max(1e3).description("简介最长字符数。"),
      mergeAudio: Schema.boolean().default(true).description("缓存媒体时合并视频和音频（需要安装并启用 `koishi-plugin-ffmpeg-path`）。")
    }).description("B 站设置")
  })
]);
var name = "chatluna-social-media-reader";
var usage = `## chatluna-social-media-reader
为 ChatLuna 提供社交媒体内容读取工具，如需合并 B 站视频中的音频，需要安装并启用 \`koishi-plugin-chatluna-storage-service\`、\`koishi-plugin-ffmpeg-path\`。`;
var inject = {
  required: ["chatluna", "http", "database", "ffmpeg"],
  optional: ["chatluna_storage"]
};

// src/cache.ts
var TABLE = "chatluna_social_media_cache";
var CacheService = class {
  constructor(ctx, cfg) {
    this.ctx = ctx;
    this.cfg = cfg;
  }
  static {
    __name(this, "CacheService");
  }
  warnedStorageUnavailable = false;
  async init() {
    this.ctx.database.extend(
      TABLE,
      {
        key: { type: "string", length: 64 },
        createdAt: "timestamp",
        expiresAt: "timestamp",
        result: "text",
        cached: "text"
      },
      { primary: "key" }
    );
    if (!this.cfg.cache.enabled) return;
    await this.cleanupExpired();
    this.ctx.setInterval(() => this.cleanupExpired(), Time.minute * 10);
  }
  createKey(req) {
    return crypto.createHash("sha1").update(JSON.stringify(req)).digest("hex");
  }
  async get(key) {
    if (!this.cfg.cache.enabled) return null;
    const rows = await this.ctx.database.get(TABLE, { key });
    if (!rows.length) return null;
    const row = rows[0];
    if (Date.now() > row.expiresAt.getTime()) {
      this.debug("缓存过期，删除记录", { key });
      await this.ctx.database.remove(TABLE, { key });
      return null;
    }
    try {
      return this.decode(row);
    } catch {
      this.debug("缓存记录反序列化失败，删除记录", { key });
      await this.ctx.database.remove(TABLE, { key });
      return null;
    }
  }
  async set(key, result, mergeAudio) {
    const cached = {
      images: [],
      videos: [],
      audios: [],
      mergedVideo: ""
    };
    if (this.cfg.cache.cacheMedia && this.hasStorageService()) {
      cached.images = await this.downloadMany(result.images, "image");
      cached.videos = await this.downloadMany(result.videos, "video");
      cached.audios = await this.downloadMany(result.audios, "audio");
      if (mergeAudio && result.videos[0] && result.audios[0]) {
        const merged = await this.mergeFromSources(
          result.videos[0],
          result.audios[0]
        );
        if (merged) {
          cached.mergedVideo = merged;
        }
      }
    } else if (this.cfg.cache.cacheMedia && !this.warnedStorageUnavailable) {
      this.warnedStorageUnavailable = true;
      this.ctx.logger(name).warn("未检测到 chatluna-storage-service，媒体将仅返回原始链接，不做存储缓存。");
    }
    const now = Date.now();
    const compact = compactResult(result);
    const record = {
      key,
      createdAt: now,
      expiresAt: now + this.cfg.cache.ttlSeconds * 1e3,
      result: compact,
      cached
    };
    await this.ctx.database.upsert(TABLE, [this.encode(record)], ["key"]);
    return record;
  }
  async cleanupExpired() {
    this.debug("开始清理过期缓存");
    await this.ctx.database.remove(TABLE, {
      expiresAt: { $lt: /* @__PURE__ */ new Date() }
    });
  }
  encode(record) {
    return {
      key: record.key,
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
      result: JSON.stringify(record.result),
      cached: JSON.stringify(record.cached)
    };
  }
  decode(row) {
    return {
      key: row.key,
      createdAt: row.createdAt.getTime(),
      expiresAt: row.expiresAt.getTime(),
      result: JSON.parse(row.result),
      cached: JSON.parse(row.cached)
    };
  }
  async downloadMany(urls, kind) {
    const out = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (kind === "image" && isXhsWebImage(url) && !url.includes("!nd_dft_wlteh_jpg_3")) {
        continue;
      }
      try {
        const item = await this.download(url, `${kind}-${i + 1}`);
        if (item) out.push(item);
      } catch (err) {
        this.ctx.logger(name).warn(String(err));
      }
    }
    return out;
  }
  async download(url, base) {
    if (!this.hasStorageService()) return null;
    const payload = await this.fetchWithinLimit(url);
    if (!payload) return null;
    const ext = guessExt(url, payload.contentType);
    const file = await this.ctx.chatluna_storage.createTempFile(
      payload.buffer,
      `${base}${ext}`,
      this.ttlHours()
    );
    return {
      source: url,
      stored: file.url,
      size: payload.buffer.length
    };
  }
  async fetchWithinLimit(url) {
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(),
      this.cfg.timeoutSeconds * 1e3
    );
    try {
      const maxEncoded = this.cfg.cache.maxMediaMB * 1024 * 1024;
      const maxRaw = Math.floor(maxEncoded * 3 / 4);
      const downloadFirst = isXhsWebImage(url);
      let probed = 0;
      if (!downloadFirst) {
        try {
          const head = await fetch(url, {
            method: "HEAD",
            signal: ac.signal,
            headers: {
              referer: "https://www.bilibili.com/",
              "user-agent": this.cfg.xiaohongshu.userAgent
            }
          });
          probed = Number(head.headers.get("content-length") || 0);
        } catch {
          probed = 0;
        }
        if (!Number.isFinite(probed) || probed <= 0) {
          try {
            const probe = await fetch(url, {
              method: "GET",
              signal: ac.signal,
              headers: {
                referer: "https://www.bilibili.com/",
                "user-agent": this.cfg.xiaohongshu.userAgent,
                range: "bytes=0-0"
              }
            });
            const contentRange = probe.headers.get("content-range") || "";
            const total = contentRange.split("/").pop() || "";
            probed = Number(total || 0);
          } catch {
            probed = 0;
          }
        }
      }
      if (probed > maxRaw) {
        this.debug("媒体下载已跳过（探测大小不合法或超限）", {
          url,
          probed,
          maxRaw
        });
        return null;
      }
      const res = await fetch(url, {
        signal: ac.signal,
        headers: {
          referer: "https://www.bilibili.com/",
          "user-agent": this.cfg.xiaohongshu.userAgent
        }
      });
      if (!res.ok) return null;
      const len = Number(res.headers.get("content-length") || 0);
      if (len > maxRaw) {
        this.debug("媒体下载已跳过（响应头大小超限）", {
          url,
          len,
          maxRaw
        });
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > maxRaw) {
        this.debug("媒体下载已跳过（实际大小超限）", {
          url,
          size: buffer.length,
          maxRaw
        });
        return null;
      }
      this.debug("媒体下载成功并准备入库存储", {
        url,
        size: buffer.length
      });
      return {
        buffer,
        contentType: res.headers.get("content-type") || ""
      };
    } finally {
      clearTimeout(timer);
    }
  }
  ttlHours() {
    return Math.max(1, Math.ceil(this.cfg.cache.ttlSeconds / 3600));
  }
  async mergeFromSources(videoUrl, audioUrl) {
    if (!this.hasStorageService()) return "";
    const video = await this.fetchWithinLimit(videoUrl);
    if (!video) return "";
    const audio = await this.fetchWithinLimit(audioUrl);
    if (!audio) return "";
    const merged = await this.mergeMp4(video.buffer, audio.buffer);
    if (!merged) return "";
    const temp = await this.ctx.chatluna_storage.createTempFile(
      merged,
      "merged.mp4",
      this.ttlHours()
    );
    return temp.url;
  }
  hasStorageService() {
    return typeof this.ctx.chatluna_storage?.createTempFile === "function";
  }
  async mergeMp4(video, audio) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chatluna-smr-"));
    const videoFile = path.join(tmp, "video.mp4");
    const audioFile = path.join(tmp, "audio.m4a");
    const outFile = path.join(tmp, "merged.mp4");
    try {
      await fs.writeFile(videoFile, video);
      await fs.writeFile(audioFile, audio);
      await this.ctx.ffmpeg.builder().input(videoFile).input(audioFile).outputOption("-c:v", "copy", "-c:a", "aac", "-shortest").run("file", outFile);
      return await fs.readFile(outFile);
    } catch {
      this.debug("FFmpeg 合并失败");
      return null;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
  debug(message, payload) {
    if (!this.cfg.debug) return;
    if (payload == null) {
      this.ctx.logger(name).debug(message);
      return;
    }
    this.ctx.logger(name).debug(message, payload);
  }
};
function compactResult(result) {
  return {
    platform: result.platform,
    title: result.title,
    content: result.content,
    cover: result.cover,
    author: result.author,
    url: result.url,
    images: result.images,
    videos: result.videos,
    audios: result.audios
  };
}
__name(compactResult, "compactResult");
function guessExt(url, ct) {
  const pathname = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return "";
    }
  })();
  const fromPath = path.extname(pathname);
  if (fromPath) return fromPath;
  if (ct.includes("image/jpeg")) return ".jpg";
  if (ct.includes("image/png")) return ".png";
  if (ct.includes("image/webp")) return ".webp";
  if (ct.includes("video/mp4")) return ".mp4";
  if (ct.includes("audio/mp4")) return ".m4a";
  if (ct.includes("audio/mpeg")) return ".mp3";
  return ".bin";
}
__name(guessExt, "guessExt");
function isXhsWebImage(url) {
  return url.includes("xhscdn.com") && url.includes("sns-webpic");
}
__name(isXhsWebImage, "isXhsWebImage");

// src/utils/url.ts
function normalizeInputUrl(raw) {
  const match = raw.match(/https?:\/\/[^\s]+/i);
  const text = match ? match[0] : raw;
  const value = text.trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return "";
  }
}
__name(normalizeInputUrl, "normalizeInputUrl");
function detectPlatform(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("xiaohongshu.com") || host.includes("xhslink.com")) {
      return "xiaohongshu";
    }
    if (host.includes("bilibili.com") || host.includes("b23.tv") || host.includes("bili22.cn") || host.includes("bili23.cn") || host.includes("bili33.cn") || host.includes("bili2233.cn")) {
      return "bilibili";
    }
    return null;
  } catch {
    return null;
  }
}
__name(detectPlatform, "detectPlatform");
async function resolveRedirect(url, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: ac.signal
    });
    return res.url || url;
  } finally {
    clearTimeout(timer);
  }
}
__name(resolveRedirect, "resolveRedirect");

// src/card.ts
function extractCardItems(session, elements) {
  const payloads = collectCardPayloads(session, elements);
  const hits = /* @__PURE__ */ new Map();
  for (const payload of payloads) {
    const byJson = extractFromJson(payload);
    for (const item of byJson) {
      const normalized = normalizeInputUrl(item.url);
      if (!normalized) continue;
      const platform = detectPlatform(normalized);
      if (platform !== "bilibili" && platform !== "xiaohongshu") continue;
      if (!hits.has(normalized)) {
        hits.set(normalized, {
          platform,
          title: normalizeTitle(item.title),
          url: normalized
        });
      }
    }
    if (byJson.length) {
      continue;
    }
    const urls = extractUrls(payload);
    if (!urls.length) continue;
    const title = extractTitle(payload);
    if (!title) continue;
    for (const rawUrl of urls) {
      const normalized = normalizeInputUrl(rawUrl);
      if (!normalized) continue;
      const platform = detectPlatform(normalized);
      if (platform !== "bilibili" && platform !== "xiaohongshu") continue;
      if (!hits.has(normalized)) {
        hits.set(normalized, {
          platform,
          title,
          url: normalized
        });
      }
    }
  }
  return Array.from(hits.values());
}
__name(extractCardItems, "extractCardItems");
function formatCardText(item) {
  const platformText = item.platform === "bilibili" ? "哔哩哔哩" : "小红书";
  return `【${item.title}-${platformText}】
${item.url}`;
}
__name(formatCardText, "formatCardText");
function collectCardPayloads(session, elements) {
  const out = [];
  if (looksLikeCardPayload(session.content || "")) {
    out.push(session.content);
  }
  const walk = /* @__PURE__ */ __name((nodes) => {
    for (const node of nodes) {
      const attrs = node.attrs;
      const sourceFields = [
        attrs["data"],
        attrs["content"],
        attrs["raw"],
        attrs["json"],
        attrs["xml"],
        attrs["url"]
      ];
      for (const field of sourceFields) {
        if (typeof field === "string" && looksLikeCardPayload(field)) {
          out.push(field);
        }
      }
      if (node.children?.length) {
        walk(node.children);
      }
    }
  }, "walk");
  walk(elements);
  return out;
}
__name(collectCardPayloads, "collectCardPayloads");
function looksLikeCardPayload(text) {
  if (!text) return false;
  return text.includes("meta") || text.includes("<msg") || text.includes("<xml") || text.includes("news") || text.includes("b23.tv") || text.includes("xhslink.com") || text.includes("xiaohongshu.com") || text.includes("bilibili.com");
}
__name(looksLikeCardPayload, "looksLikeCardPayload");
function extractUrls(text) {
  const decoded = text.replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/\\u002F/gi, "/");
  const matches = decoded.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return matches.map((item) => item.replace(/[),.;!?]+$/g, ""));
}
__name(extractUrls, "extractUrls");
function extractTitle(raw) {
  const xmlTitle = raw.match(/\btitle=["']([^"']{1,120})["']/i)?.[1] || raw.match(/<title>([^<]{1,120})<\/title>/i)?.[1] || raw.match(/\bbrief=["']([^"']{1,120})["']/i)?.[1];
  if (xmlTitle) {
    return normalizeTitle(xmlTitle);
  }
  const json = safeJsonParse(raw);
  if (!json) return "";
  const candidate = findTitleInObject(json);
  return normalizeTitle(candidate);
}
__name(extractTitle, "extractTitle");
function safeJsonParse(raw) {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
__name(safeJsonParse, "safeJsonParse");
function extractFromJson(raw) {
  const json = safeJsonParse(raw);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return [];
  }
  const obj = json;
  const meta = obj.meta;
  const detail = meta?.detail_1;
  const news = meta?.news;
  const out = [];
  const push = /* @__PURE__ */ __name((title, url) => {
    if (typeof title !== "string" || typeof url !== "string") return;
    const t = normalizeTitle(title);
    const u = normalizeUrlText(url);
    if (!t || !u) return;
    out.push({ title: t, url: u });
  }, "push");
  push(
    detail?.desc ?? detail?.title ?? obj.prompt,
    detail?.qqdocurl ?? detail?.jumpUrl ?? detail?.url
  );
  push(news?.title ?? news?.desc ?? obj.prompt, news?.jumpUrl);
  if (!out.length) {
    const title = findTitleInObject(obj);
    const urls = extractUrls(raw);
    if (title && urls[0]) {
      out.push({ title, url: urls[0] });
    }
  }
  return out;
}
__name(extractFromJson, "extractFromJson");
function normalizeUrlText(url) {
  return url.replace(/&amp;/g, "&").replace(/\\\//g, "/").replace(/\\u002F/gi, "/").trim();
}
__name(normalizeUrlText, "normalizeUrlText");
function findTitleInObject(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    if (value.startsWith("http")) return "";
    if (value.length < 2 || value.length > 120) return "";
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const title = findTitleInObject(item);
      if (title) return title;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const obj = value;
  const priority = [
    "title",
    "desc",
    "description",
    "brief",
    "prompt",
    "name"
  ];
  for (const key of priority) {
    const matchedKey = Object.keys(obj).find((k) => k.toLowerCase() === key);
    if (!matchedKey) continue;
    const title = findTitleInObject(obj[matchedKey]);
    if (title) return title;
  }
  for (const key of Object.keys(obj)) {
    const title = findTitleInObject(obj[key]);
    if (title) return title;
  }
  return "";
}
__name(findTitleInObject, "findTitleInObject");
function normalizeTitle(text) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
__name(normalizeTitle, "normalizeTitle");

// src/parsers/bilibili.ts
import crypto2 from "node:crypto";
var BVID_RE = /BV[0-9a-zA-Z]{10}/i;
var AVID_RE = /(?:^|[^a-zA-Z0-9])av(\d+)/i;
async function parseBilibili(inputUrl, cfg, req, debug) {
  const resolved = await resolveRedirect(inputUrl, cfg.timeoutSeconds * 1e3);
  const videoId = extractVideoId(resolved) || extractVideoId(inputUrl);
  const page = extractPageNo(resolved) || extractPageNo(inputUrl) || 1;
  if (!videoId) {
    throw new Error("无法提取 B 站视频 ID。");
  }
  const detail = await fetchVideoDetail(videoId, page, cfg);
  if (!detail.bvid || !detail.cid) {
    throw new Error("B 站视频信息不完整，缺少 bvid 或 cid。");
  }
  const qn = (req.bilibiliVideoQuality || cfg.bilibili.videoQuality) === 720 ? 64 : 32;
  const aq = req.bilibiliAudioQuality || cfg.bilibili.audioQuality;
  const audioId = aq === 192 ? 30280 : aq === 132 ? 30232 : 30216;
  const play = await fetchPlayInfo(detail.bvid, detail.cid, qn, cfg, debug);
  const video = pickVideo(play, qn);
  const audio = pickAudio(play, audioId);
  const finalUrl = page > 1 ? `https://www.bilibili.com/video/${detail.bvid}?p=${page}` : `https://www.bilibili.com/video/${detail.bvid}`;
  return {
    platform: "bilibili",
    title: detail.title,
    content: buildContent(detail.description, cfg.bilibili.maxDescLength, detail.stats),
    cover: detail.cover,
    author: detail.owner,
    url: finalUrl,
    images: detail.cover ? [detail.cover] : [],
    videos: video ? [video.url] : [],
    audios: audio ? [audio] : [],
    extra: {
      bvid: detail.bvid,
      aid: detail.aid,
      cid: detail.cid,
      durationSec: detail.durationSec,
      videoQuality: qn === 64 ? 720 : 480,
      audioQuality: aq,
      videoCodecId: video?.codecid ?? 0,
      page
    }
  };
}
__name(parseBilibili, "parseBilibili");
async function fetchVideoDetail(videoId, page, cfg) {
  const query = videoId.type === "bv" ? `bvid=${videoId.value}` : `aid=${videoId.value}`;
  const payload = await requestJson(
    `https://api.bilibili.com/x/web-interface/view?${query}`,
    cfg
  );
  if (Number(payload.code) !== 0 || !payload.data) {
    throw new Error(`B 站元数据获取失败：${payload.message || payload.code}`);
  }
  const data = payload.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const picked = pages[page - 1] || pages[0];
  return {
    bvid: String(data.bvid || ""),
    aid: String(data.aid || ""),
    cid: String(
      data.cid || picked?.cid || ""
    ),
    title: String(data.title || ""),
    description: String(data.desc || ""),
    owner: String(data.owner?.name || ""),
    cover: normalizeUrl(String(data.pic || "")),
    durationSec: Number(data.duration || 0),
    stats: {
      view: Number(data.stat?.view || 0),
      like: Number(data.stat?.like || 0),
      coin: Number(data.stat?.coin || 0),
      favorite: Number(
        data.stat?.favorite || 0
      ),
      share: Number(data.stat?.share || 0),
      danmaku: Number(
        data.stat?.danmaku || 0
      )
    }
  };
}
__name(fetchVideoDetail, "fetchVideoDetail");
function extractPageNo(input) {
  try {
    const url = new URL(input);
    const p = Number(url.searchParams.get("p") || 0);
    if (Number.isInteger(p) && p > 0) {
      return p;
    }
  } catch {
  }
  return 0;
}
__name(extractPageNo, "extractPageNo");
async function fetchPlayInfo(bvid, cid, qn, cfg, debug) {
  const query = {
    bvid,
    cid,
    qn: String(qn),
    fnval: "16",
    fnver: "0",
    fourk: "0"
  };
  try {
    const payload2 = await requestJsonWithWbi(
      "https://api.bilibili.com/x/player/wbi/playurl",
      query,
      cfg
    );
    if (Number(payload2.code) === 0 && payload2.data) {
      debug?.("B 站取流使用 WBI 接口成功", { bvid, cid, qn });
      return payload2.data;
    }
  } catch {
    debug?.("B 站取流 WBI 接口失败，回退旧接口", { bvid, cid, qn });
  }
  const url = `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=16&fnver=0&fourk=0`;
  const payload = await requestJson(url, cfg);
  if (Number(payload.code) !== 0 || !payload.data) {
    throw new Error(`B 站播放信息获取失败：${payload.message || payload.code}`);
  }
  debug?.("B 站取流回退旧接口成功", { bvid, cid, qn });
  return payload.data;
}
__name(fetchPlayInfo, "fetchPlayInfo");
function pickVideo(data, qn) {
  const dash = data.dash;
  const videos = dash?.video || [];
  if (!videos.length) return null;
  const sorted = videos.map((item) => ({
    id: Number(item.id || 0),
    height: Number(item.height || 0),
    codecid: Number(item.codecid || 0),
    bandwidth: Number(item.bandwidth || 0),
    url: normalizeUrl(String(item.baseUrl || item.base_url || ""))
  })).filter((item) => item.url).sort((a, b) => b.height - a.height);
  const pickByCodecPriority = /* @__PURE__ */ __name((list) => {
    const av1 = list.filter((item) => item.codecid === 13).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (av1) return av1;
    const hevc = list.filter((item) => item.codecid === 12).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (hevc) return hevc;
    const avc = list.filter((item) => item.codecid === 7).sort((a, b) => b.bandwidth - a.bandwidth)[0];
    if (avc) return avc;
    return list.sort((a, b) => b.bandwidth - a.bandwidth)[0] || null;
  }, "pickByCodecPriority");
  const byId = sorted.filter((item) => item.id === qn);
  if (byId.length) return pickByCodecPriority(byId);
  if (qn === 64) {
    const h720 = sorted.filter((item) => item.height <= 720);
    if (h720.length) return pickByCodecPriority(h720);
  }
  const h480 = sorted.filter((item) => item.height <= 480);
  if (h480.length) return pickByCodecPriority(h480);
  return pickByCodecPriority(sorted);
}
__name(pickVideo, "pickVideo");
function pickAudio(data, audioId) {
  const dash = data.dash;
  const audios = dash?.audio || [];
  if (!audios.length) return "";
  const sorted = audios.map((item) => ({
    id: Number(item.id || 0),
    bw: Number(item.bandwidth || 0),
    url: normalizeUrl(String(item.baseUrl || item.base_url || ""))
  })).filter((item) => item.url).sort((a, b) => b.bw - a.bw);
  const exact = sorted.find((item) => item.id === audioId);
  if (exact) return exact.url;
  return sorted[0].url;
}
__name(pickAudio, "pickAudio");
async function requestJson(url, cfg) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutSeconds * 1e3);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        referer: "https://www.bilibili.com/",
        accept: "application/json,text/plain,*/*"
      }
    });
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}
__name(requestJson, "requestJson");
function extractVideoId(input) {
  try {
    const parsed = new URL(input);
    const queryBvid = parsed.searchParams.get("bvid");
    if (queryBvid && BVID_RE.test(queryBvid)) {
      return { type: "bv", value: normalizeBvid(queryBvid) };
    }
    const queryAid = parsed.searchParams.get("aid");
    if (queryAid && /^\d+$/.test(queryAid)) {
      return { type: "av", value: queryAid };
    }
    const path2 = decodeURIComponent(parsed.pathname || "");
    const pathBvid = path2.match(/\/video\/(BV[0-9a-zA-Z]{10})/i)?.[1];
    if (pathBvid) {
      return { type: "bv", value: normalizeBvid(pathBvid) };
    }
    const pathAvid = path2.match(/\/video\/av(\d+)/i)?.[1];
    if (pathAvid) {
      return { type: "av", value: pathAvid };
    }
  } catch {
  }
  const bvid = input.match(BVID_RE)?.[0];
  if (bvid) return { type: "bv", value: normalizeBvid(bvid) };
  const avid = input.match(AVID_RE)?.[1];
  if (avid) return { type: "av", value: avid };
  return null;
}
__name(extractVideoId, "extractVideoId");
function normalizeBvid(value) {
  const text = value.trim();
  const exact = text.match(/^(?:bv|BV)([0-9a-zA-Z]{10})$/);
  if (exact) return `BV${exact[1]}`;
  return text;
}
__name(normalizeBvid, "normalizeBvid");
function normalizeUrl(url) {
  if (!url) return "";
  if (url.startsWith("//")) return `https:${url}`;
  return url;
}
__name(normalizeUrl, "normalizeUrl");
function buildContent(desc, maxDescLength, stats) {
  const lines = [
    `播放：${formatCount(stats.view)}，点赞：${formatCount(stats.like)}，投币：${formatCount(stats.coin)}`,
    `收藏：${formatCount(stats.favorite)}，转发：${formatCount(stats.share)}，弹幕：${formatCount(stats.danmaku)}`
  ];
  if (desc) {
    if (desc.length > maxDescLength) {
      lines.push(`简介：${desc.slice(0, maxDescLength)}...`);
    } else {
      lines.push(`简介：${desc}`);
    }
  }
  return lines.join("\n");
}
__name(buildContent, "buildContent");
function formatCount(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1e8) return `${(value / 1e8).toFixed(1).replace(/\.0$/, "")}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, "")}万`;
  return String(Math.floor(value));
}
__name(formatCount, "formatCount");
async function requestJsonWithWbi(url, query, cfg) {
  const mixin = await getWbiMixinKey(cfg);
  const wts = Math.floor(Date.now() / 1e3).toString();
  const sorted = Object.keys(query).sort().map((key) => {
    const value = String(query[key]).replace(/[!'()*]/g, "");
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  });
  sorted.push(`wts=${wts}`);
  const plain = sorted.join("&");
  const wRid = crypto2.createHash("md5").update(`${plain}${mixin}`).digest("hex");
  const finalUrl = `${url}?${plain}&w_rid=${wRid}`;
  return requestJson(finalUrl, cfg);
}
__name(requestJsonWithWbi, "requestJsonWithWbi");
async function getWbiMixinKey(cfg) {
  const payload = await requestJson("https://api.bilibili.com/x/web-interface/nav", cfg);
  if (Number(payload.code) !== 0 || !payload.data) {
    throw new Error("获取 WBI 签名参数失败。");
  }
  const data = payload.data;
  const wbi = data.wbi_img;
  const img = String(wbi.img_url || "");
  const sub = String(wbi.sub_url || "");
  const imgKey = img.split("/").pop()?.split(".")[0] || "";
  const subKey = sub.split("/").pop()?.split(".")[0] || "";
  const raw = `${imgKey}${subKey}`;
  return WBI_MIXIN_INDEX.map((idx) => raw[idx]).join("").slice(0, 32);
}
__name(getWbiMixinKey, "getWbiMixinKey");
var WBI_MIXIN_INDEX = [
  46,
  47,
  18,
  2,
  53,
  8,
  23,
  32,
  15,
  50,
  10,
  31,
  58,
  3,
  45,
  35,
  27,
  43,
  5,
  49,
  33,
  9,
  42,
  19,
  29,
  28,
  14,
  39,
  12,
  38,
  41,
  13,
  37,
  48,
  7,
  16,
  24,
  55,
  40,
  61,
  26,
  17,
  0,
  1,
  60,
  51,
  30,
  4,
  22,
  25,
  54,
  21,
  56,
  59,
  6,
  63,
  57,
  62,
  11,
  36,
  20,
  34,
  44,
  52
];

// src/parsers/xiaohongshu.ts
import { load } from "js-yaml";
async function parseXiaohongshu(ctx, inputUrl, cfg) {
  const normalized = normalizeInputUrl(inputUrl);
  if (!normalized) {
    throw new Error("小红书链接无效。");
  }
  const canonical = toCanonicalXiaohongshuUrl(normalized);
  const html = await fetchHtml(ctx, canonical, cfg);
  const state = parseInitialState(html);
  if (!state) {
    throw new Error("提取小红书初始数据失败。");
  }
  const note = deepGet(state, ["noteData", "data", "noteData"]) || deepGet(state, ["note", "noteDetailMap", "[-1]", "note"]) || {};
  const title = String(deepGet(note, ["title"]) || "未命名笔记");
  const content = String(deepGet(note, ["desc"]) || "");
  const author = String(
    deepGet(note, ["user", "nickname"]) || deepGet(note, ["user", "nickName"]) || ""
  );
  const images = extractImages(note).slice(0, cfg.xiaohongshu.maxImages);
  const videos = extractVideos(note);
  return {
    platform: "xiaohongshu",
    title,
    content,
    cover: images[0] || "",
    author,
    url: canonical,
    images,
    videos,
    audios: []
  };
}
__name(parseXiaohongshu, "parseXiaohongshu");
async function fetchHtml(ctx, url, cfg) {
  let err;
  for (let i = 0; i < cfg.xiaohongshu.maxRetries; i++) {
    try {
      const text = await ctx.http.get(url, {
        responseType: "text",
        timeout: cfg.timeoutSeconds * 1e3,
        headers: {
          "user-agent": cfg.xiaohongshu.userAgent,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          referer: "https://www.xiaohongshu.com/"
        }
      });
      if (!text) {
        throw new Error("空页面响应。");
      }
      return text;
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, (i + 1) * 300));
    }
  }
  throw err;
}
__name(fetchHtml, "fetchHtml");
function parseInitialState(html) {
  const scripts = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)).map((m) => (m[1] || "").trim()).reverse();
  const script = scripts.find((item) => item.startsWith("window.__INITIAL_STATE__"));
  if (!script) return null;
  const text = script.replace(/^window\.__INITIAL_STATE__\s*=\s*/, "");
  try {
    return load(text);
  } catch {
    return null;
  }
}
__name(parseInitialState, "parseInitialState");
function deepGet(data, keys) {
  let value = data;
  for (const key of keys) {
    if (value == null) return null;
    if (key.startsWith("[") && key.endsWith("]")) {
      const idx = Number(key.slice(1, -1));
      if (Number.isNaN(idx)) return null;
      if (Array.isArray(value)) {
        value = value.at(idx);
        continue;
      }
      if (typeof value === "object") {
        const arr = Object.values(value);
        value = arr.at(idx);
        continue;
      }
      return null;
    }
    if (typeof value !== "object") return null;
    value = value[key];
  }
  return value;
}
__name(deepGet, "deepGet");
function extractImages(note) {
  const list = deepGet(note, ["imageList"]);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const url = String(
      deepGet(item, ["urlDefault"]) || deepGet(item, ["url"]) || ""
    );
    if (!url) continue;
    const token = getImageToken(url);
    if (!token) continue;
    out.push(`https://sns-img-bd.xhscdn.com/${token}`);
  }
  return dedupe(out);
}
__name(extractImages, "extractImages");
function extractVideos(note) {
  const key = String(deepGet(note, ["video", "consumer", "originVideoKey"]) || "");
  if (key) {
    return [`https://sns-video-bd.xhscdn.com/${key}`];
  }
  const h264 = deepGet(note, ["video", "media", "stream", "h264"]);
  const h265 = deepGet(note, ["video", "media", "stream", "h265"]);
  const list = [
    ...Array.isArray(h264) ? h264 : [],
    ...Array.isArray(h265) ? h265 : []
  ];
  if (!list.length) return [];
  list.sort((a, b) => {
    const ah = Number(a.height || 0);
    const bh = Number(b.height || 0);
    if (ah !== bh) return ah - bh;
    const ab = Number(a.videoBitrate || 0);
    const bb = Number(b.videoBitrate || 0);
    return ab - bb;
  });
  const best = list[list.length - 1];
  const backups = deepGet(best, ["backupUrls"]);
  if (Array.isArray(backups) && backups[0]) {
    return [formatUrl(String(backups[0]))];
  }
  const master = String(deepGet(best, ["masterUrl"]) || "");
  return master ? [formatUrl(master)] : [];
}
__name(extractVideos, "extractVideos");
function getImageToken(url) {
  const text = formatUrl(url);
  const parts = text.split("/").slice(5);
  if (!parts.length) return "";
  const token = parts.join("/").split("!")[0];
  return token || "";
}
__name(getImageToken, "getImageToken");
function formatUrl(url) {
  return url.replace(/\\\//g, "/").replace(/&amp;/g, "&");
}
__name(formatUrl, "formatUrl");
function dedupe(items) {
  return Array.from(new Set(items));
}
__name(dedupe, "dedupe");
function toCanonicalXiaohongshuUrl(input) {
  try {
    const url = new URL(input);
    const m = url.pathname.match(/\/(?:discovery\/item|explore)\/([0-9a-zA-Z]+)/);
    if (!m?.[1]) {
      return input;
    }
    const token = url.searchParams.get("xsec_token") || "";
    const canonical = new URL(`https://www.xiaohongshu.com/discovery/item/${m[1]}`);
    if (token) {
      canonical.searchParams.set("xsec_token", token);
      canonical.searchParams.set("xsec_source", "pc_user");
    }
    return canonical.toString();
  } catch {
    return input;
  }
}
__name(toCanonicalXiaohongshuUrl, "toCanonicalXiaohongshuUrl");

// src/index.ts
var schema = z.object({
  url: z.string().describe("需要读取的哔哩哔哩或小红书链接。")
});
var SocialReaderTool = class extends StructuredTool {
  constructor(ctx, cfg, cache) {
    super({});
    this.ctx = ctx;
    this.cfg = cfg;
    this.cache = cache;
    this.name = (cfg.tool.name || "read_social_media").trim();
    this.description = (cfg.tool.description || "").trim() || "读取哔哩哔哩或小红书链接，返回结构化信息与资源链接。";
  }
  static {
    __name(this, "SocialReaderTool");
  }
  name;
  description;
  schema = schema;
  async _call(input, _runManager, _runnable) {
    const debug = /* @__PURE__ */ __name((message, payload) => {
      if (!this.cfg.debug) return;
      if (payload == null) {
        this.ctx.logger(name).debug(message);
        return;
      }
      this.ctx.logger(name).debug(message, payload);
    }, "debug");
    const req = {
      url: input.url,
      bilibiliVideoQuality: this.cfg.bilibili.videoQuality,
      bilibiliAudioQuality: this.cfg.bilibili.audioQuality,
      bilibiliMergeAudio: this.cfg.bilibili.mergeAudio,
      xiaohongshuMaxImages: this.cfg.xiaohongshu.maxImages,
      cacheMedia: this.cfg.cache.cacheMedia,
      maxMediaMB: this.cfg.cache.maxMediaMB
    };
    debug("收到工具请求", req);
    const raw = normalizeInputUrl(req.url);
    if (!raw) {
      return "输入中没有可识别的链接。";
    }
    debug("归一化链接", raw);
    const platform = detectPlatform(raw);
    if (!platform) {
      return "当前仅支持小红书与哔哩哔哩链接。";
    }
    debug("识别平台", platform);
    if (platform === "bilibili") {
      req.url = await toCanonicalBilibiliRequestUrl(
        this.ctx,
        raw,
        this.cfg.timeoutSeconds
      );
    } else if (platform === "xiaohongshu") {
      req.url = toCanonicalXiaohongshuUrl2(raw);
    }
    const key = this.cache.createKey(req);
    debug("缓存键", key);
    if (this.cfg.cache.enabled) {
      const hit = await this.cache.get(key);
      if (hit) {
        debug("缓存命中", key);
        return JSON.stringify(
          formatOutput(
            hit,
            true,
            this.cfg.cache.enabled && this.cfg.cache.cacheMedia,
            this.cfg.debug
          ),
          null,
          2
        );
      }
      debug("缓存未命中", key);
    }
    try {
      const result = platform === "xiaohongshu" ? await parseXiaohongshu(this.ctx, req.url, this.cfg) : await parseBilibili(req.url, this.cfg, req, (msg, extra) => debug(msg, extra));
      const saved = this.cfg.cache.enabled ? await this.cache.set(
        key,
        result,
        platform === "bilibili" && this.cfg.bilibili.mergeAudio
      ) : createTransientResult(key, result);
      debug("解析完成", {
        platform,
        images: result.images.length,
        videos: result.videos.length,
        audios: result.audios.length
      });
      return JSON.stringify(
        formatOutput(
          saved,
          false,
          this.cfg.cache.enabled && this.cfg.cache.cacheMedia,
          this.cfg.debug
        ),
        null,
        2
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.ctx.logger(name).error(msg);
      debug("解析异常详情", err);
      return `解析失败：${msg}`;
    }
  }
};
function apply(ctx, cfg) {
  const cache = new CacheService(ctx, cfg);
  ctx.middleware(async (session, next) => {
    const elements = session.elements ?? [];
    const cards = await Promise.all(
      extractCardItems(session, elements).map(
        (item) => normalizeCardItem(ctx, item, cfg.timeoutSeconds)
      )
    );
    if (cards.length) {
      for (const item of cards) {
        elements.push(h.text(formatCardText(item)));
      }
      session.elements = elements;
    }
    return next();
  }, true);
  ctx.on("ready", async () => {
    await cache.init();
    if (!cfg.tool.enabled) {
      return;
    }
    const toolName = (cfg.tool.name || "read_social_media").trim() || "read_social_media";
    ctx.effect(() => ctx.chatluna.platform.registerTool(toolName, {
      selector() {
        return true;
      },
      createTool() {
        return new SocialReaderTool(ctx, cfg, cache);
      }
    }));
  });
}
__name(apply, "apply");
function formatOutput(data, fromCache, preferStoredLink, includeVerbose) {
  const storedImages = data.cached.images.map((item) => item.stored);
  const storedVideos = data.cached.videos.map((item) => item.stored);
  const storedAudios = data.cached.audios.map((item) => item.stored);
  const images = preferStoredLink && storedImages.length ? storedImages : data.result.images;
  const videos = preferStoredLink && storedVideos.length ? storedVideos : data.result.videos;
  const audios = preferStoredLink && storedAudios.length ? storedAudios : data.result.audios;
  const pickOne = /* @__PURE__ */ __name((items) => items.length ? items[0] : "", "pickOne");
  const pickFirst = /* @__PURE__ */ __name((items) => items.length ? items[0] : null, "pickFirst");
  const mergedVideo = preferStoredLink && data.cached.mergedVideo ? data.cached.mergedVideo : "";
  const resources = {};
  if (data.result.platform === "xiaohongshu") {
    const video = pickOne(videos);
    if (video) {
      resources.video = video;
    } else {
      if (images.length) {
        resources.images = images;
      }
    }
  } else {
    const cover = pickOne(images);
    if (cover) {
      resources.cover = cover;
    }
    if (mergedVideo) {
      resources.mergedVideo = mergedVideo;
    } else {
      const video = pickOne(videos);
      const audio = pickOne(audios);
      if (video) resources.video = video;
      if (audio) resources.audio = audio;
    }
  }
  const output = {
    platform: data.result.platform,
    title: data.result.title,
    author: data.result.author,
    content: data.result.content,
    url: data.result.url
  };
  if (Object.keys(resources).length) {
    output.resources = resources;
  }
  if (!includeVerbose) {
    return output;
  }
  return {
    ...output,
    debug: {
      fromCache,
      createdAt: new Date(data.createdAt).toISOString(),
      expiresAt: new Date(data.expiresAt).toISOString(),
      resourceCount: {
        images: images.length,
        videos: videos.length,
        audios: audios.length
      },
      cachedResources: {
        images: pickFirst(data.cached.images),
        videos: pickFirst(data.cached.videos),
        audios: pickFirst(data.cached.audios),
        mergedVideo: data.cached.mergedVideo || ""
      }
    }
  };
}
__name(formatOutput, "formatOutput");
function createTransientResult(key, result) {
  const now = Date.now();
  return {
    key,
    createdAt: now,
    expiresAt: now,
    result,
    cached: {
      images: [],
      videos: [],
      audios: [],
      mergedVideo: ""
    }
  };
}
__name(createTransientResult, "createTransientResult");
function toCanonicalBilibiliUrl(input) {
  const bv = input.match(/BV[0-9a-zA-Z]{10}/i)?.[0];
  const av = input.match(/(?:^|[^a-zA-Z0-9])av(\d+)/i)?.[1];
  let p = 1;
  try {
    const url = new URL(input);
    const qp = Number(url.searchParams.get("p") || 1);
    if (Number.isInteger(qp) && qp > 0) {
      p = qp;
    }
  } catch {
  }
  if (bv) {
    const id = bv.toUpperCase().startsWith("BV") ? `BV${bv.slice(2)}` : bv;
    return p > 1 ? `https://www.bilibili.com/video/${id}?p=${p}` : `https://www.bilibili.com/video/${id}`;
  }
  if (av) {
    return p > 1 ? `https://www.bilibili.com/video/av${av}?p=${p}` : `https://www.bilibili.com/video/av${av}`;
  }
  return input;
}
__name(toCanonicalBilibiliUrl, "toCanonicalBilibiliUrl");
async function toCanonicalBilibiliRequestUrl(ctx, input, timeoutSeconds) {
  let url = input;
  try {
    const host = new URL(input).hostname.toLowerCase();
    if (host.includes("b23.tv") || host.includes("bili22.cn") || host.includes("bili23.cn") || host.includes("bili33.cn") || host.includes("bili2233.cn")) {
      const res = await ctx.http(input, {
        method: "GET",
        timeout: timeoutSeconds * 1e3,
        redirect: "follow"
      });
      url = res.url || input;
    }
  } catch {
    url = input;
  }
  return toCanonicalBilibiliUrl(url);
}
__name(toCanonicalBilibiliRequestUrl, "toCanonicalBilibiliRequestUrl");
async function normalizeCardItem(ctx, item, timeoutSeconds) {
  if (item.platform === "xiaohongshu") {
    return {
      ...item,
      url: toCanonicalXiaohongshuUrl2(item.url)
    };
  }
  let resolved = item.url;
  try {
    const host = new URL(item.url).hostname.toLowerCase();
    if (host.includes("b23.tv") || host.includes("bili22.cn") || host.includes("bili23.cn") || host.includes("bili33.cn") || host.includes("bili2233.cn")) {
      const res = await ctx.http(item.url, {
        method: "GET",
        timeout: timeoutSeconds * 1e3,
        redirect: "follow"
      });
      resolved = res.url || item.url;
    }
  } catch {
    resolved = item.url;
  }
  return {
    ...item,
    url: toCanonicalBilibiliUrl(resolved)
  };
}
__name(normalizeCardItem, "normalizeCardItem");
function toCanonicalXiaohongshuUrl2(input) {
  try {
    const url = new URL(input);
    const m = url.pathname.match(/\/(?:discovery\/item|explore)\/([0-9a-zA-Z]+)/);
    if (!m?.[1]) {
      return input;
    }
    const token = url.searchParams.get("xsec_token") || "";
    const canonical = new URL(`https://www.xiaohongshu.com/discovery/item/${m[1]}`);
    if (token) {
      canonical.searchParams.set("xsec_token", token);
      canonical.searchParams.set("xsec_source", "pc_user");
    }
    return canonical.toString();
  } catch {
    return input;
  }
}
__name(toCanonicalXiaohongshuUrl2, "toCanonicalXiaohongshuUrl");
export {
  Config,
  apply,
  inject,
  name,
  usage
};
