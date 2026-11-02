# pot-lite

pot-lite 是 [pot-desktop](https://github.com/pot-app/pot-desktop) 的精简分支，仅面向 Windows x64，保留划词翻译、输入翻译与截图文字识别等核心功能，目标是降低弹窗延迟、识别耗时、常驻资源占用与开机启动开销。

本项目基于 pot-desktop 3.0.7 修改，与上游不再同步。原作者与贡献者信息见上游仓库。

## 与上游的差异

### 已移除的功能

- 插件系统（含插件安装与外部程序调用）
- 生词本（Anki、欧路词典）
- 翻译历史记录
- 自动更新
- 配置备份（WebDAV、阿里云盘、本地）
- 语音朗读（TTS）
- 剪贴板监听
- 本地 HTTP 调用接口
- Tesseract 离线文字识别
- 开发者工具
- 阿拉伯语、波斯语、希伯来语、泰米尔语界面语言

21 个翻译服务及系统文字识别、在线文字识别服务均予以保留。

### 性能相关改动

- 翻译、截图、识别窗口改为常驻隐藏复用，不再每次重新创建 WebView。
- 截图在内存中裁剪，Windows 系统文字识别直接读取内存位图，识别引擎按语言缓存。
- 本地语言检测由 lingua 改为 whatlang，不再内置语言模型。
- 启动阶段不再执行更新检查与服务预热；前端按窗口拆分并按需加载。
- Release 构建启用 LTO 与符号剥离；Tauri 权限白名单按实际用途收紧。

安装包体积由 34.1 MB 降至约 5.8 MB。

## 安装

在 [Releases](https://github.com/KurisuRakko/pot-lite/releases) 下载 `pot-lite_*_x64-setup.exe`。

本程序与原版 pot 使用相同的应用标识，以沿用原有设置与服务密钥。安装前须先卸载原版 pot，两者不可同时安装。

## 构建

构建由 GitHub Actions 完成（`.github/workflows/package.yml`）：推送至 `main` 生成安装包构件，推送 `v*` 标签发布 Release。

本地构建需 Node.js、pnpm 9 与 Rust stable：

```
pnpm install
pnpm tauri build -b nsis
```

## 许可证

GPL-3.0，与上游相同，见 [LICENSE](LICENSE)。
