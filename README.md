# BookOrbit Library

在 Obsidian 桌面版浏览 BookOrbit 书库、阅读 EPUB、KEPUB 和 PDF，保存书摘并同步标注。本插件通过 BookOrbit 原生 API 连接你的服务器。

## 安装

1. 从 GitHub Releases 下载 `bookorbit-library-0.4.1.zip`。[下载 0.4.1](https://github.com/84xiaodu/obsidian-bookorbit-library/releases/tag/0.4.1)
2. 解压，把整个 `bookorbit-library` 文件夹放到仓库的 `.obsidian/plugins/`。
3. 重启 Obsidian，在 **设置 → 第三方插件**启用 **BookOrbit Library**，然后在插件设置里配置 BookOrbit 地址和认证方式。

需要 Obsidian 桌面版 1.11.5 或更新版本。完整的连接、阅读、删除标注和 Annotator 导出说明见[使用手册](bookorbit-reading/README.md)。

## 从源码构建

需要 Git 和 Node.js 22。

```sh
git clone --recurse-submodules https://github.com/84xiaodu/obsidian-bookorbit-library.git
cd obsidian-bookorbit-library
npm ci --prefix reader-deps
node build-bookorbit-reader.cjs
```

构建目录为 `release-0.4.1/bookorbit-library/`。文档及第三方许可证随安装包提供。
