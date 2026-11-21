# 文章转 Instagram Carousel

用 Codex 把文章拆成 5–6 张 1080 × 1080 JPEG，并生成 Caption 和相关 hashtag。图卡在本机渲染，默认通过已登录的 Chrome 发布。

## 本机预览

使用 Node.js 22 或更新版本，并安装 Chrome。设备需要有支持中文的系统字体。可通过 `CHROME_PATH` 指定 Chrome 或 Chromium 的可执行文件。

```sh
npm ci
npm run demo
npm test
```

演示使用虚构内容。执行后可在 `example/preview.jpg` 看总览，在 `example/media/` 看单张图。演示贴文会被版本检查和 API 发布命令拦下。

## 处理自己的文章

让 Codex 按 [工作流 Prompt](PROMPT.md) 准备图卡文案。每篇稿件保存为 `runs/<稿件名>/article.md` 和 `runs/<稿件名>/carousel.json`。

```sh
node preview.mjs runs/<稿件名>
node preview.mjs --check runs/<稿件名> <版本号>
```

第一条命令会生成图卡和预览，第二条会核对文件和版本，并按顺序输出图卡路径、Caption。单图可在稿件 JSON 里设置 `"format": "single"`。

确认该版本后，使用已登录的 Chrome 上传。Codex 的 Chrome 扩展可能需要开启本机文件访问，详见 [浏览器扩展说明](https://learn.chatgpt.com/docs/chrome-extension#upload-files)。浏览器路线只需要正常的 Instagram 登录。

## 可选的 Meta API 发布

API 路线支持 Carousel，需要 Instagram 专业账号、带发布权限的 Instagram Login token 和 Cloudinary。先把配置样板复制成本机 `.env`，填入自己的资料，并限制该文件权限。本机认证资料只保存在配置文件里，发布时只把已批准的 JPEG 上传至 Cloudinary，让 Meta 读取。

- `node --env-file=.env publish.mjs check-account` 核对目标账号及发布额度。
- 启用发布时把 `IG_PUBLISH_MODE` 设为 `review`。
- `node --env-file=.env publish.mjs publish runs/<稿件名> --approved <版本号>` 发布核对过的版本。
- 发布记录保存在本机 `.publish-state/`。发文回执不明确时，脚本暂停重复发布并提醒核对。

[Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login) · [Meta 发布文档](https://developers.facebook.com/documentation/instagram-platform/content-publishing) · [Cloudinary 签名上传](https://cloudinary.com/documentation/authentication_signatures)
