# 第三方资源与商标

根目录 MIT 许可证适用于本项目原创代码及原创文档，不覆盖第三方资源及商标。

## 阅读界面资源

`packages/theme-chatgpt/capture/` 下的页面结构、样式、字体、图标和资源缓存，以及构建后的 `themes/chatgpt/`，包含来自 ChatGPT 页面的第三方素材。资源来源 URL 和内容哈希记录在相应资源 `manifest.json` 中。原网站业务脚本不会随阅读界面运行。

这些素材的权利属于各自权利人。本仓库没有取得将 OpenAI Sans、原站样式、图标或商标重新授权为 MIT 的许可；公开可下载不代表获得任意再分发权。使用或再分发这些素材前，应自行核对和取得所需许可。本说明本身不授予许可。当前资源许可核验尚未完成。

- OpenAI / ChatGPT 名称、标识及相关素材：[OpenAI 品牌与使用条款](https://openai.com/brand/)。本项目与 OpenAI 没有官方隶属、合作或背书关系。
- 缓存中的 KaTeX 字体和样式：上游 [KaTeX MIT 许可证](https://github.com/KaTeX/KaTeX/blob/main/LICENSE)。
- 其他缓存资源以清单所列来源和各权利人的原许可为准；本项目不以 MIT 覆盖它们。

用户指南中的界面截图用于说明操作，截图中的第三方界面及商标仍归相应权利人所有。

## 软件依赖

构建和测试依赖记录在 `package.json` 与 `package-lock.json`。它们各自保留上游许可证；根目录 MIT 不替代依赖的许可证。发布包附带 `THIRD_PARTY_LICENSES.txt`，列出构建依赖及其中实际打包依赖的本地许可文本。

微信读书、番茄小说及其标识属于各自权利人。本项目不会授权用户访问其无权阅读的内容。

## 番茄小说字体映射

字体映射思路和字符数值对照参考并交叉核对自 [romcere/fanqienovel-decryptor](https://github.com/romcere/fanqienovel-decryptor) 的 [dicts/font_map.py](https://github.com/romcere/fanqienovel-decryptor/blob/main/dicts/font_map.py)，感谢作者的公开分享。对应实现为 `packages/adapter-fanqie/src/font-map.ts`；本项目不调用其章节下载接口。

上述致谢用于说明参考来源，不表示本项目获得了对上游实现或映射数据的重新授权，也不表示上游作者为 FolioVeil 背书。上游仓库当前未见独立 LICENSE 文件，不能将其视为已按 MIT 授权。
