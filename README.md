# ChatLuna Social Media Reader

![npm](https://img.shields.io/npm/v/koishi-plugin-chatluna-social-media-reader) ![License](https://img.shields.io/badge/license-GPLv3-brightgreen)

为 ChatLuna 提供社交媒体读取工具，支持对主流社交平台内容进行解析、结构化输出与媒体资源提取。

当前支持平台：
- 哔哩哔哩（`bilibili.com`、`b23.tv` 等）
- 小红书（`xiaohongshu.com`、`xhslink.com`）

## ✨ 功能特性

### 1. 🔍 内容读取与解析
- **结构化输出**：读取并解析社交媒体内容，返回标题、正文、作者、平台信息。
- **资源提取**：提取原始媒体资源（图片、视频、音频）链接。
- **存储集成**：支持将解析后的内容与媒体资源同步到 `chatluna-storage-service`（需安装并启用该插件）。

### 2. ⚡ 高效缓存
- **数据库缓存**：解析结果元信息自动缓存到数据库。
- **媒体缓存**：支持将媒体文件缓存到存储服务。
- **配置灵活**：支持配置缓存策略与过期时间。

### 3. ⚙️ 平台特定功能
- **B 站支持**：
  - 视频标签解析：额外输出 `tags` 字段，并放在视频简介下方，仅保留标签名称。
  - 评论区评论解析：启用 `bilibili.parseComments` 后，额外解析评论区热评前 N 条并输出到 `hotComments` 字段，条数可通过 `bilibili.commentsCount` 控制（默认 5）；若存在置顶评论，还会额外输出 `pinnedComment` 字段。
  - 评论图片支持：图文评论会额外输出 `images` 字段；若启用媒体缓存，评论图片也会同步缓存到 `chatluna-storage-service`。
  - 分辨率支持：480P、720P（默认 480P）。
  - 音质支持：64K、132K、192K（默认 64K）。
  - 音视频混流：启用 `bilibili.mergeAudio` 时，自动利用 `ffmpeg` 服务（需 `koishi-plugin-ffmpeg-path`）进行混流处理。

## ⚙️ 主要配置

- `storageService`：存储服务相关配置
- `cacheService`：缓存配置
- `bilibili`：B 站平台特定配置（画质、音质、混流、评论解析、标签解析输出）
- `xiaohongshu`：小红书平台特定配置

## ✅ 使用前置条件

- 本插件需要配合 `chatluna-multimodal-service` 使用，由其负责上下文注入。
- 建议安装并启用 `koishi-plugin-chatluna-storage-service` 以获得完整的媒体缓存能力。
- 若需使用 B 站视频音频混流，请确保安装并配置了 `koishi-plugin-ffmpeg-path`。

## 🛡️ 使用声明

- 本项目仅供学习、研究与合规开发使用。
- 使用者应自行遵守各社交媒体平台的《用户协议》与《robots.txt》规定。
- 请勿将本插件用于任何违法、违规、侵犯版权或违反平台规则的行为，因不当使用产生的任何后果由使用者自行承担。

## 🤝 贡献

欢迎提交 Issue 或 Pull Request 来改进代码。

## 🙏 致谢

- [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)，为 B 站视频详情、标签与相关接口的实现提供了文档参考
- [DD1969 的「Bilibili - 在未登录的情况下照常加载评论」](https://greasyfork.org/zh-CN/scripts/473498-bilibili-%E5%9C%A8%E6%9C%AA%E7%99%BB%E5%BD%95%E7%9A%84%E6%83%85%E5%86%B5%E4%B8%8B%E7%85%A7%E5%B8%B8%E5%8A%A0%E8%BD%BD%E8%AF%84%E8%AE%BA)，为 B 站评论接口兼容性排查提供了参考
