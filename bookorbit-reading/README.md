# BookOrbit Library 使用手册

在 Obsidian 里浏览 BookOrbit 书库、阅读 EPUB 和 PDF，并保存摘录和标注。书架通过 BookOrbit 原生 API 同步。

## 安装或升级

1. 使用 Obsidian 桌面版 1.11.5 或更新版本。
2. 手动安装时解压 ZIP，把 `bookorbit-library` 文件夹放到仓库的 `.obsidian/plugins/`。升级时用新版压缩包内的程序文件覆盖同名文件。原有连接配置、下载书籍和阅读数据可以继续使用。
3. 重启 Obsidian，在 **设置 → 第三方插件**启用 **BookOrbit Library**。
4. 打开插件设置，填写平时访问 BookOrbit 的地址和下载文件夹，选择连接方式，点击 **保存并测试**。

## 连接 BookOrbit

- **API Key（BookOrbit 3.8 起）**。在 BookOrbit 的 **Settings → You → API keys** 创建一个只读 Key，并选中要查看的书库。需要下载时，给 Key 加上 **Download books** 权限。创建 Key 的账号需要 **Create API keys** 权限。 [BookOrbit API Key 文档](https://github.com/bookorbit/bookorbit/blob/main/docs/API_KEYS.md)
- **账号登录**。使用 BookOrbit 的普通用户名和密码。这种方式使用原生客户端会话，已按 BookOrbit 3.7 的接口核对。仅允许 SSO 的实例请选择 API Key。密码只用于建立会话，刷新令牌或 API Key 存入 Obsidian 的密钥存储。

电脑需要能访问配置的服务器地址。跨互联网访问时使用 HTTPS。如果反向代理把 API 请求重定向到登录页，需要让来自这台电脑的 BookOrbit 原生 API 请求能到达服务器。

## 使用

- 点击 Obsidian 左侧的书架图标，或运行 **BookOrbit Library: 打开书架**。第一次打开点 **同步书库**。
- **全部书籍**显示当前同步的书目与本地保留的书。**已下载**可用于离线找书。上一次同步的书目会缓存到本地，连接不可用时仍能浏览。封面按需从服务器取缩略图。离线重新打开时，书架用排版封面显示书名。
- 点击卡片的 **阅读**打开集成阅读器。已有本地副本时可以离线读。下载图标与 **批量下载** 都会保存本地副本。支持 EPUB、KEPUB 和 PDF，单本上限 256 MiB。
- EPUB 和 PDF 默认连续滚动，重开会恢复本地阅读位置。EPUB 正文使用当前 Obsidian 主题的字体、字号和行距。点标签页右上角 **阅读设置** 可以调整缩放，EPUB 也可以切回分页。
- 打开书时会检查 BookOrbit 上同一文件的进度。阅读位置变动会在短暂停顿后上传，也可在 **阅读设置 → 同步阅读进度** 手动同步。写入需要有读写权限的 API Key 或有权限的 BookOrbit 账号。
- EPUB 用 CFI 同步，PDF 用页码同步，页内滚动位置留在本地。离线时会保留待同步的进度，下次打开书或联网后手动同步时重试。若云端已有更新的进度，会用云端位置续读。
- 点标签页右上角 **目录与标注**，可在 Obsidian 右侧栏查看当前书籍的目录或标注。也可以通过命令面板打开侧栏。
- 选中文字时可以就地添加标注，也可以从右键菜单进入。标注支持颜色、样式和附注。

## 标注互通

- 打开书时会尝试从 BookOrbit 读取该书的标注。也可以点击 **读取云端**。EPUB 使用 CFI 定位，PDF 使用页码和页面坐标。其他版次或找不到锚点的标注仍可从侧栏查看。
- 新标注先保存在本地。要写回 BookOrbit，点击 **上传待同步**。需要可写 API Key 或普通账号会话。只读 Key 仍可读取云端、在本地做标注和导出。扫描版 PDF 需要有可选中的文本层。
- 点标注卡片旁的垃圾桶可以删除本地标注，或将已同步的标注移到 BookOrbit 回收站。删除云端标注需要可写 API Key 或有权操作该标注的账号。
- **导出笔记**生成普通 Markdown 摘录。**导出 Annotator**为已下载的文件生成带 `annotation-target` 和文本引用选择器的 Annotator 笔记。可以在 Annotator 中打开它重新定位文本。重复导出只追加新的标注，Annotator 中的后续修改由该笔记管理。相同摘录出现多次时，Annotator 可能需要人工定位。 [Annotator 项目说明](https://github.com/elias-sundqvist/obsidian-annotator)

阅读位置保存在当前仓库的插件数据中。电子书内的脚本和外链资源在集成阅读器中被禁用。PDF 所需的 CMap 和备用字体随插件打包，可离线使用。项目许可和第三方组件说明见[仓库首页](https://github.com/84xiaodu/obsidian-bookorbit-library#许可证)。

从 0.1.0 升级后，请在插件设置里重新保存连接并同步一次。原有下载文件会按书籍 ID 出现在新版书架里，历史 Markdown 书架仍可从仓库文件列表中访问。

