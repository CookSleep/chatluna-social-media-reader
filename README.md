<div align="center">

# ChatLuna Social Media Reader

[![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-social-media-reader?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-chatluna-social-media-reader)
[![License](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](LICENSE)

**让 ChatLuna 看懂群里分享的 B 站视频和小红书笔记**

为 [ChatLuna](https://github.com/ChatLunaLab/chatluna) 提供社交媒体读取工具：给一个链接，返回标题、作者、正文与媒体资源链接。<br>
支持哔哩哔哩视频（`bilibili.com`、`b23.tv` 等短链）与小红书笔记（`xiaohongshu.com`、`xhslink.com`）。

</div>

---

## ✨ 功能

### 🔍 读取链接
- **结构化输出**：返回平台、标题、作者、正文或简介、封面，以及图片、视频、音频的链接。
- **短链与分 P**：自动展开 B 站短链，保留分 P 页码。
- **分享卡片**：消息中的 B 站、小红书分享卡片（如 QQ 小程序卡片，包括被引用消息里的卡片）会被转成「标题 + 链接」的文字，模型能看到并决定是否读取。

### 📺 哔哩哔哩
- **标签**：输出视频标签，只保留标签名。
- **热评**：可选解析评论区前 N 条热评（默认 5 条，最多 20 条），有置顶评论时一并输出。
- **评论图片**：图文评论附带图片链接，并可调用多模态模型为图片生成描述。
- **清晰度与码率**：视频 480P / 720P，音频 64K / 132K / 192K，默认 480P、64K；数值过大可能超出模型请求中内联文件的大小限制。
- **音视频合并**：缓存媒体时用 ffmpeg 把视频和音频合成一个文件。

### 📕 小红书
- **笔记内容**：标题、作者、正文、图片（默认最多 10 张）与视频。
- **重试**：抓取页面失败时自动重试，次数可设。

### 💾 缓存
- **读取缓存**：解析结果存入数据库，默认保存 1 天。
- **媒体缓存**：启用 `chatluna-storage-service` 时，把图片、视频、音频下载到存储服务并返回存储后的链接；单个文件默认上限 20 MB。
- **配合 `read_files`**：当前可用的工具中有 `read_files` 时，提示模型调用它读取视频、音频或图片的实际内容。

---

## ✅ 前置条件

- Koishi，以及已安装并配置好模型的 [ChatLuna](https://github.com/ChatLunaLab/chatluna)（`koishi-plugin-chatluna` 1.3.36 及以上）。
- 需要 `database`、`http` 服务，以及 [`koishi-plugin-ffmpeg-path`](https://www.npmjs.com/package/koishi-plugin-ffmpeg-path) 提供的 `ffmpeg` 服务。
- 可选：[`koishi-plugin-chatluna-storage-service`](https://www.npmjs.com/package/koishi-plugin-chatluna-storage-service)，用于媒体缓存与 B 站音视频合并。
- 可选：提供 `read_files` 工具的插件（如 `chatluna-multimodal-service`），让模型读取媒体的实际内容。
- 为评论区图片生成描述时，需要一个支持图片输入的模型。

## 📦 安装

在 Koishi 控制台的插件市场中搜索 `chatluna-social-media-reader` 安装，或在 Koishi 项目目录中运行：

```bash
npm install koishi-plugin-chatluna-social-media-reader
```

## ⚙️ 配置

| 分组 | 说明 |
| --- | --- |
| 基础设置 | 网络请求超时（默认 15 秒）、媒体下载并发数（默认 6）、调试日志。开启调试日志时工具输出会附带缓存与资源信息。 |
| `tool` | 是否注册工具、工具名（默认 `read_social_media`）、工具描述。 |
| `cache` | 读取缓存开关与有效期、是否缓存媒体到存储服务、单个媒体大小上限。 |
| `xiaohongshu` | 开关、抓取页面用的 User-Agent、重试次数、最多返回的图片数。 |
| `bilibili` | 开关、热评解析与条数、清晰度、音频码率、简介最长字符数（默认 500）、是否合并音视频、是否描述评论区图片。 |
| `commentImageService` | 评论区图片描述所用的多模态模型、提示词、并发数。 |

## ⚠️ 使用声明

- 本项目仅供学习、研究与合规开发使用。
- 使用者应自行遵守各社交媒体平台的用户协议与 robots.txt 规定。
- 请勿将本插件用于任何违法、违规、侵犯版权或违反平台规则的行为，因不当使用产生的任何后果由使用者自行承担。

## 📄 许可

本项目基于 [GPL-3.0](LICENSE) 开源。

## 🙏 致谢

- [ChatLuna](https://github.com/ChatLunaLab/chatluna)：插件所扩展的 Koishi 大模型对话框架。
- [Koishi](https://koishi.chat/)：机器人框架。
- [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)：为 B 站视频详情、标签与相关接口的实现提供了文档参考。
- [DD1969 的「Bilibili - 在未登录的情况下照常加载评论」](https://greasyfork.org/zh-CN/scripts/473498-bilibili-%E5%9C%A8%E6%9C%AA%E7%99%BB%E5%BD%95%E7%9A%84%E6%83%85%E5%86%B5%E4%B8%8B%E7%85%A7%E5%B8%B8%E5%8A%A0%E8%BD%BD%E8%AF%84%E8%AE%BA)：为 B 站评论接口的兼容性排查提供了参考。
