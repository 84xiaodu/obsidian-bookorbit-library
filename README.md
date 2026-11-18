# BookOrbit Library

在 Obsidian 桌面版浏览 BookOrbit 书库、阅读 EPUB、KEPUB 和 PDF，保存书摘并同步标注。本插件通过 BookOrbit 原生 API 连接你的服务器。

## 安装

1. 从 GitHub Releases 下载最新的 `bookorbit-library-*.zip`。[下载最新版](https://github.com/84xiaodu/obsidian-bookorbit-library/releases/latest)
2. 解压，把整个 `bookorbit-library` 文件夹放到仓库的 `.obsidian/plugins/`。
3. 重启 Obsidian，在 **设置 → 第三方插件**启用 **BookOrbit Library**，然后在插件设置里配置 BookOrbit 地址和认证方式。

需要 Obsidian 桌面版 1.11.5 或更新版本。完整的连接、阅读、删除标注和 Annotator 导出说明见[使用手册](bookorbit-reading/README.md)。

## 账号与联网

同步书库、下载书籍和同步云端标注需要访问插件设置中填写的 BookOrbit 服务器，并使用该服务器的账号或 API Key。插件连接该服务器以完成登录、读取书目和封面、下载书籍，以及按需读取、上传和删除云端标注。凭据保存在 Obsidian 的密钥存储中。已下载的书籍、阅读位置和本地标注可离线使用，PDF 字体随插件提供。

## 从源码构建

需要 Git 和 Node.js 22。

```sh
git clone https://github.com/84xiaodu/obsidian-bookorbit-library.git
cd obsidian-bookorbit-library
npm ci
npm run build
```

构建后的 `main.js` 和 `styles.css` 位于仓库根目录，可与 `manifest.json` 一起安装。GitHub Actions 会保存这三个文件和手动安装 ZIP，并在发布版本标签时将它们附到 Release。

## 许可证

插件自有代码采用 [MIT 许可证](LICENSE)。阅读器使用 [Foliate.js](vendor/foliate/README.md)、[PDF.js](https://github.com/mozilla/pdf.js) 和 [zip.js](https://github.com/gildas-lormeau/zip.js)。第三方代码、PDF CMap 及字体的许可正文随 `main.js` 提供。
