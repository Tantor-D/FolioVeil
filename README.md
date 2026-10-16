# FolioVeil

桌面浏览器上的本地阅读扩展，支持 **本地 TXT、微信读书和番茄小说**。阅读内容显示在独立标签页，采用 ChatGPT 风格界面；不提供 AI 对话，也不将阅读正文提交给 ChatGPT。

![FolioVeil：自备内容，换壳阅读，一键遮挡](docs/demo/overview.gif)

*自制 TXT 样本与真实插件界面演示：原文 → 换壳阅读 → 隐私遮挡 → 继续。*

> **定位与使用边界**：FolioVeil 是一个方便“摸鱼阅读”的展示外壳，让独立阅读页不再展示原站 UI。书籍、TXT 文件、账号和阅读权限需要用户自行获取；登录、购买及授权等步骤仍在原平台完成。本项目不提供书籍资源或阅读权限，也不承诺替用户解决内容获取问题。插件仅辅助读取和展示用户已有权访问的内容，不保证来源内容的可用性或完整性。原网站标签仍保留真实界面和地址，详情见下方隐私说明。

**[下载插件 ZIP](https://github.com/Tantor-D/FolioVeil/releases/latest) · [安装教程](INSTALL.md) · [在线图文使用指南](https://tantor-d.github.io/FolioVeil/) · [问题反馈](https://github.com/Tantor-D/FolioVeil/issues)**

## 安装

1. 从 [Releases](https://github.com/Tantor-D/FolioVeil/releases/latest) 下载 `FolioVeil-1.0.0-chromium.zip`，解压到固定文件夹。不要下载 GitHub 自动生成的 Source code 压缩包来安装。
2. 打开 Edge 的 `edge://extensions`，或 Chrome 的 `chrome://extensions`，开启“开发人员模式”。
3. 点击“加载解压缩的扩展”，选择解压后**直接包含 `manifest.json`** 的文件夹，再将 FolioVeil 固定到工具栏。

完整步骤和更新方法见 [INSTALL.md](INSTALL.md)。当前源码版本 **1.0.1**（修复商店上传的重复清单问题）；已发布 ZIP 版本以 Releases 为准（[1.0.1 修复说明](docs/releases/1.0.1.md)）；手动安装与扩展商店上架状态互相独立。主要实站验证使用桌面 Edge；Chrome 使用相同的 Chromium 扩展包，仍需按实际浏览器检查。

## 开始阅读

- **TXT**：点击插件图标 → “打开本地 TXT 阅读页” → 选择文件。支持目录、编码选择和本机章节级续读；刷新后需重新选择文件。
- **微信读书／番茄小说**：先在原网站打开你有权阅读的具体正文页，再点击插件图标 → “打开独立阅读页”。保持来源标签可用。
- **获取后续内容**：按 **N**，或点击底部 **↑**；无需输入文字。微信读书单栏按章获取，双栏按批获取。
- **设置与隐私**：阅读页右上角“分享”打开本地操作面板，可调整显示、图片、连接和隐私遮挡；不会执行对外分享。

详细图文、快捷键及故障处理见 **[在线使用指南](https://tantor-d.github.io/FolioVeil/)**。也可阅读 [Markdown 指南](docs/user-guide/README.md)，或下载 Release 中的离线 HTML 指南。

## 支持范围与隐私

正文在本机来源标签与阅读页之间传递。TXT 正文只在内存中使用，续读位置和设置保存在浏览器本地。网站来源仍需要访问原网站；插件不会绕过登录、付费或试读限制。

隐私遮挡不能隐藏原站地址、浏览器历史和设备管理记录。详情见 [隐私说明](docs/privacy.md)。项目与 OpenAI、微信读书、番茄小说没有官方隶属或背书关系。

已知限制：网站正文获取依赖原站结构；微信读书双栏含图连续读取可能中途停止；TXT 的部分组合快捷键和弹窗控制可能无响应，可从“分享”进入操作面板；不提供网站整书目录或完整历史恢复。当前正式入口不支持 EPUB、PDF 或 Word。手机端不在支持范围。

## 从源码构建

安装当前受支持的 Node.js LTS 和 npm，在项目根目录运行：

```sh
npm ci
npm run check
```

构建目录为 `dist/extension-chromium`，在扩展管理页加载该目录即可。`npm run check` 包含类型检查、测试和构建。功能源码位于 `apps/` 和 `packages/`，`tests/` 为测试，`tooling/` 为构建工具。主题构建使用仓库内的本地资源，不在运行时下载原站脚本。

## 致谢

番茄小说字体映射参考并交叉核对了 [romcere/fanqienovel-decryptor](https://github.com/romcere/fanqienovel-decryptor) 的 [font_map.py](https://github.com/romcere/fanqienovel-decryptor/blob/main/dicts/font_map.py)。感谢作者公开相关实现与技术思路。本插件仅使用当前页面可访问的正文，不调用该项目的章节下载接口。

## 支持开发者

感兴趣欢迎 **[Star ⭐](https://github.com/Tantor-D/FolioVeil)**。如果 FolioVeil 帮到了你，也欢迎通过微信赞赏，请我喝杯奶茶。

<img src="docs/support/wechat.png" alt="微信赞赏码" width="320">

## 许可证

本项目原创代码采用 [MIT](LICENSE)。第三方样式、字体、图标、图片、商标和其他外部资源不因本项目采用 MIT 而获得重新授权，详见 [第三方资源说明](THIRD_PARTY_NOTICES.md)。
