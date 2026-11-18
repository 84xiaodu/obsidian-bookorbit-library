const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, setIcon } = require("obsidian");
const http = require("http");
const https = require("https");
const { createHash, randomUUID } = require("crypto");
const { READER, READER_PANEL, ReaderView, ReadingPanel, ReadingStore } = require("./reader.js");

const VIEW = "bookorbit-library-shelf";
const API_PATH = "/api/v1";
const DEFAULTS = { endpoint: "", mode: "key", username: "", accountId: null, folder: "BookOrbit" };
const FORMATS = ["epub", "kepub", "pdf"];
const BOOK_LIMIT = 256 * 1024 * 1024;
const PAGE_SIZE = 24;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function endpointFrom(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的 BookOrbit 地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("地址须使用 HTTP 或 HTTPS，且不能含账号、查询参数或片段。");
  }
  let path = url.pathname.replace(/\/+$/, "");
  // Older settings saved the catalog URL. Normalize it before constructing REST routes.
  if (path.endsWith(API_PATH + "/opds")) path = path.slice(0, -5);
  url.pathname = path.endsWith(API_PATH) ? path : path + API_PATH;
  return url.href;
}

function folderFrom(value) {
  const parts = value.trim().replace(/\\/g, "/").split("/");
  if (parts.some(part => !part || part.startsWith(".") || /[<>:"|?*#^%\[\]\u0000-\u001f]/.test(part)
      || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("请输入仓库内的文件夹路径，例如 BookOrbit 或 阅读/BookOrbit。");
  }
  return normalizePath(parts.join("/"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function secretKey(settings) {
  return "bookorbit-shelf-" + digest(JSON.stringify([settings.endpoint, settings.mode, settings.accountId]));
}

function apiRequest(url, { token, body, method = body === undefined ? "GET" : "POST", accept = "application/json",
  limit = 12 * 1024 * 1024, signal }) {
  const transport = url.startsWith("https:") ? https : http;
  const headers = { Accept: accept, "Accept-Encoding": "identity" };
  if (token) headers.Authorization = "Bearer " + token;
  const payload = body === undefined ? null : JSON.stringify(body);
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  // Redirects are handled as errors so credentials stay with the configured server.
  return new Promise((resolve, reject) => {
    const request = transport.request(url, { method, headers, signal }, response => {
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        response.destroy();
        const explanations = {
          401: "BookOrbit 认证失败。请检查 API Key，或在设置中重新登录。",
          403: "BookOrbit 拒绝访问。请检查账号权限，以及 API Key 的书库与下载权限。",
          404: "BookOrbit 找不到此接口或书籍。请核对服务器地址与版本，再同步书库。",
          429: "BookOrbit 请求过于频繁，请稍后重试。",
        };
        const message = explanations[status] || (status >= 300 && status < 400
          ? "服务器返回了重定向。请使用 BookOrbit 的最终访问地址，并检查反向代理。"
          : `BookOrbit 请求失败（HTTP ${status}）。`);
        reject(Object.assign(new Error(message), { status }));
        return;
      }
      const tooLarge = () => new Error(`服务器返回的数据超过 ${limit / 1024 / 1024} MiB。`);
      if (Number(response.headers["content-length"]) > limit) {
        reject(tooLarge());
        response.destroy();
        return;
      }
      const chunks = [];
      let received = 0;
      response.on("data", chunk => {
        received += chunk.length;
        if (received > limit) {
          reject(tooLarge());
          response.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      response.on("error", reject);
      response.on("end", () => {
        if (!response.complete) {
          reject(new Error("服务器传输中断，请重试。"));
          return;
        }
        resolve({ status, bytes: Buffer.concat(chunks, received), mime: String(response.headers["content-type"] || "").split(";")[0] });
      });
    });
    request.setTimeout(35_000, () => request.destroy(new Error("连接超时，请检查这台电脑是否能访问 BookOrbit。")));
    request.on("error", reject);
    request.end(payload ?? undefined);
  });
}

function parseJson(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("BookOrbit 未返回 JSON。请检查服务器地址和反向代理的登录设置。");
  }
}

function albumBook(row) {
  if (!Number.isSafeInteger(row?.id) || row.id < 1) throw new Error("BookOrbit 返回了无效的书籍编号。");
  const files = (Array.isArray(row.files) ? row.files : []).filter(file =>
    Number.isSafeInteger(file?.id) && file.id > 0 && typeof file.format === "string");
  const preferred = FORMATS.map(format => files.find(file => file.format.toLowerCase() === format && file.role === "primary")
    || files.find(file => file.format.toLowerCase() === format)).find(Boolean);
  const format = preferred?.format.toLowerCase();
  return {
    id: row.id,
    title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : `书籍 ${row.id}`,
    authors: Array.isArray(row.authors) ? row.authors.filter(author => typeof author === "string") : [],
    series: typeof row.seriesName === "string" ? row.seriesName : "",
    libraryId: Number.isSafeInteger(row.libraryId) ? row.libraryId : null,
    addedAt: typeof row.addedAt === "string" ? row.addedAt : "",
    hasCover: row.hasCover === true,
    coverVersion: String(row.coverVersion ?? row.updatedAt ?? ""),
    format: format || files[0]?.format.toLowerCase() || "",
    file: preferred ? { id: preferred.id, extension: format === "kepub" ? "epub" : format } : null,
    editions: files.filter(file => FORMATS.includes(file.format.toLowerCase()))
      .map(file => ({ id: file.id, extension: file.format.toLowerCase() === "pdf" ? "pdf" : "epub" })),
  };
}

class BookOrbitApi {
  constructor(endpoint, mode, secret, signal) {
    Object.assign(this, { endpoint, mode, secret, signal });
    this.accessToken = "";
  }

  async login(username, password) {
    const { bytes } = await apiRequest(this.endpoint + "/auth/login", {
      body: { username, password, clientKind: "native", deviceLabel: "Obsidian" }, signal: this.signal,
    });
    this.setSession(parseJson(bytes));
  }

  setSession(session) {
    if (typeof session?.accessToken !== "string" || !session.accessToken
        || typeof session.refreshToken !== "string" || !session.refreshToken) {
      throw new Error("BookOrbit 未返回原生登录会话。若服务器支持 API Key，可以改用 API Key。");
    }
    this.accessToken = session.accessToken;
    this.secret = session.refreshToken;
    this.onRotate?.(this.secret);
  }

  refresh(previous = "") {
    if (this.accessToken && this.accessToken !== previous) return this.accessToken;
    if (!this.refreshing) {
      this.refreshing = apiRequest(this.endpoint + "/auth/refresh", {
        body: { refreshToken: this.secret }, signal: this.signal,
      }).then(({ bytes }) => {
        this.setSession(parseJson(bytes));
        return this.accessToken;
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async request(route, options = {}) {
    const send = token => apiRequest(this.endpoint + route, {
      ...options, token, signal: options.signal ? AbortSignal.any([options.signal, this.signal]) : this.signal,
    });
    if (this.mode === "key") return send(this.secret);
    const token = this.accessToken || await this.refresh();
    try {
      return await send(token);
    } catch (error) {
      if (error.status !== 401) throw error;
      return send(await this.refresh(token));
    }
  }

  async json(route, body) {
    return parseJson((await this.request(route, { body })).bytes);
  }

  async page(page, size) {
    const payload = await this.json("/books/query", {
      sort: [{ field: "addedAt", dir: "desc" }], pagination: { page, size },
    });
    if (!Array.isArray(payload?.items) || !Number.isSafeInteger(payload.total) || payload.total < 0
        || payload.page !== page || payload.size !== size || payload.items.length > size) {
      throw new Error("BookOrbit 返回了无法识别的书库分页。");
    }
    return { items: payload.items.map(albumBook), total: payload.total };
  }

  async list(onProgress) {
    const rows = await this.json("/libraries");
    if (!Array.isArray(rows)) throw new Error("BookOrbit 返回了无法识别的书库列表。");
    const libraries = rows.filter(row => Number.isSafeInteger(row?.id) && typeof row.name === "string")
      .map(({ id, name }) => ({ id, name }));
    const books = new Map();
    const size = 100;
    for (let page = 0; ; page++) {
      const { items, total } = await this.page(page, size);
      const previous = books.size;
      for (const book of items) books.set(book.id, book);
      onProgress(books.size, total);
      if ((page + 1) * size >= total) {
        if (books.size !== total) throw new Error("同步时服务器书目发生变化，请重试。");
        break;
      }
      if (books.size !== previous + size) throw new Error("同步时服务器书目发生变化，请重试。");
    }
    return { libraries, books: [...books.values()], syncedAt: new Date().toISOString() };
  }

  async thumbnail(book, signal) {
    const { bytes, mime } = await this.request(`/books/${book.id}/thumbnail`, {
      accept: "image/jpeg,image/png,image/webp", limit: 2 * 1024 * 1024, signal,
    });
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("封面格式无法显示。");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }

  async download(book) {
    return this.bookBytes(book, "download");
  }

  async readBook(book) {
    return this.bookBytes(book, "serve");
  }

  async bookBytes(book, action) {
    const { bytes } = await this.request(`/books/files/${book.file.id}/${action}`, {
      accept: "application/octet-stream", limit: BOOK_LIMIT,
    });
    const valid = book.file.extension === "pdf" ? bytes.subarray(0, 1024).includes("%PDF-")
      : bytes.length > 30 && bytes.readUInt32LE(0) === 0x04034b50;
    if (!valid) throw new Error("服务器返回的内容不是有效的电子书文件。");
    if (!bytes.byteOffset && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
}

function bookFileName(book) {
  const title = book.title.normalize("NFC").replace(/[<>:"/\\|?*#^%\[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 80).toWellFormed().replace(/[. ]+$/, "");
  return `${book.id} - ${title || "书籍"}.${book.file.extension}`;
}

class LocalBooks {
  constructor(vault, folder, endpoint) {
    this.vault = vault;
    this.directory = normalizePath(folder + "/书籍/" + digest(endpoint));
    // Read the earlier version's local folder as well so its books and links keep working.
    this.previousDirectory = normalizePath(folder + "/书籍/" + digest(endpoint + "/opds"));
  }

  async files() {
    const files = new Map();
    for (const directory of [this.directory, this.previousDirectory]) {
      if (!await this.vault.adapter.exists(directory)) continue;
      const contents = await this.vault.adapter.list(directory);
      for (const path of contents.files.sort()) {
        const match = /^([1-9]\d*) - (.+)\.(epub|pdf)$/.exec(path.split("/").pop());
        if (match && !files.has(Number(match[1]))) {
          files.set(Number(match[1]), { path, title: match[2], format: match[3] });
        }
      }
    }
    return files;
  }

  async save(api, book) {
    const bytes = await api.download(book);
    api.signal.throwIfAborted();
    let current = "";
    for (const part of this.directory.split("/")) {
      current = current ? current + "/" + part : part;
      const existing = this.vault.getAbstractFileByPath(current);
      if (!existing) await this.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`文件占用了文件夹路径 ${current}。`);
    }
    const target = normalizePath(this.directory + "/" + bookFileName(book));
    const stagedPath = normalizePath(this.directory + "/" + randomUUID() + ".part");
    try {
      const file = await this.vault.createBinary(stagedPath, bytes);
      if (await this.vault.adapter.exists(target)) throw new Error("已有同名文件，请检查书籍文件夹。");
      await this.vault.rename(file, target);
      return { path: target, title: book.title, format: book.file.extension };
    } finally {
      const staged = this.vault.getAbstractFileByPath(stagedPath);
      if (staged instanceof TFile) await this.vault.delete(staged);
    }
  }
}

function action(parent, label, icon, handler, primary = false) {
  const button = parent.createEl("button", { cls: primary ? "bor-button bor-primary" : "bor-button", attr: { type: "button" } });
  setIcon(button.createSpan({ cls: "bor-icon", attr: { "aria-hidden": "true" } }), icon);
  button.createSpan({ text: label });
  button.addEventListener("click", handler);
  return button;
}

class ShelfView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.query = "";
    this.onlyLocal = false;
    this.library = "";
    this.sort = "recent";
    this.page = 0;
    this.covers = new Map();
    this.coverEpoch = -1;
  }

  getViewType() { return VIEW; }
  getDisplayText() { return "BookOrbit 书架"; }
  getIcon() { return "library"; }

  async onOpen() {
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "bor-shelf" });
    this.root.tabIndex = -1;
    const inner = this.root.createDiv({ cls: "bor-inner" });
    const hero = inner.createEl("header", { cls: "bor-hero" });
    const heroText = hero.createDiv({ cls: "bor-hero-text" });
    const brand = heroText.createDiv({ cls: "bor-brand" });
    setIcon(brand.createSpan({ cls: "bor-icon", attr: { "aria-hidden": "true" } }), "orbit");
    brand.createSpan({ text: "BookOrbit" });
    heroText.createEl("h1", { text: "我的书架" });
    this.meta = heroText.createEl("p", { cls: "bor-meta" });
    this.syncButton = action(hero, "同步书库", "refresh-cw", () => this.plugin.sync(), true);

    const controls = inner.createDiv({ cls: "bor-controls" });
    const top = controls.createDiv({ cls: "bor-toolbar" });
    const group = top.createDiv({ cls: "bor-segments", attr: { role: "group", "aria-label": "书籍范围" } });
    this.allButton = this.segment(group, "全部书籍", false);
    this.localButton = this.segment(group, "已下载", true);
    this.bulkButton = action(top, "批量下载", "download", () => this.plugin.confirmBulk());

    const filters = controls.createDiv({ cls: "bor-filters" });
    const search = filters.createDiv({ cls: "bor-search" });
    setIcon(search.createSpan({ cls: "bor-icon", attr: { "aria-hidden": "true" } }), "search");
    this.search = search.createEl("input", {
      attr: { type: "search", placeholder: "搜索书名、作者或系列", "aria-label": "搜索书名、作者或系列" },
    });
    this.search.addEventListener("input", () => {
      this.query = this.search.value;
      this.resetPage();
    });
    this.librarySelect = filters.createEl("select", { attr: { "aria-label": "书库筛选" } });
    this.librarySelect.addEventListener("change", () => {
      this.library = this.librarySelect.value;
      this.resetPage();
    });
    this.sortSelect = filters.createEl("select", { attr: { "aria-label": "排序方式" } });
    this.sortSelect.createEl("option", { text: "最近入库", attr: { value: "recent" } });
    this.sortSelect.createEl("option", { text: "按书名", attr: { value: "title" } });
    this.sortSelect.addEventListener("change", () => {
      this.sort = this.sortSelect.value;
      this.resetPage();
    });
    this.status = inner.createEl("p", { cls: "bor-status", attr: { role: "status" } });
    this.count = inner.createEl("p", { cls: "bor-count", attr: { tabindex: "-1" } });
    this.grid = inner.createDiv({ cls: "bor-grid" });
    this.pager = inner.createDiv({ cls: "bor-pager" });
    this.render();
  }

  async onClose() {
    this.coverRequest?.abort();
    this.covers.clear();
    this.root = null;
  }

  segment(parent, text, local) {
    const button = parent.createEl("button", { text, attr: { type: "button", "aria-pressed": "false" } });
    button.addEventListener("click", () => {
      this.onlyLocal = local;
      this.resetPage();
    });
    return button;
  }

  resetPage() { this.page = 0; this.render(); }
  focusSearch() { this.search?.focus(); }

  render() {
    if (!this.root) return;
    this.coverRequest?.abort();
    this.coverRequest = new AbortController();
    const plugin = this.plugin;
    if (this.coverEpoch !== plugin.coverEpoch) {
      this.covers.clear();
      this.coverEpoch = plugin.coverEpoch;
    }
    const snapshot = plugin.snapshot;
    const local = plugin.local;
    const entries = snapshot?.books || [];
    const libraries = snapshot?.libraries || [];
    const books = new Map(entries.map(book => [book.id, book]));
    for (const [id, file] of local) {
      if (!books.has(id)) books.set(id, { id, title: file.title, authors: [], format: file.format, addedAt: "", series: "", retained: true });
    }
    const tokens = this.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    this.meta.textContent = snapshot
      ? `${entries.length} 本书 · ${local.size} 本已下载`
      : local.size ? `${local.size} 本已下载` : "浏览书库、下载书籍并离线阅读";
    this.status.textContent = plugin.status || (snapshot ? "上次同步 " + new Date(snapshot.syncedAt).toLocaleString() : "");
    this.status.hidden = !this.status.textContent;
    this.status.classList.toggle("bor-error", plugin.statusError);
    this.syncButton.disabled = plugin.busy || !plugin.api;
    this.bulkButton.disabled = plugin.busy || !entries.some(book => book.file && !local.has(book.id));
    this.allButton.setAttribute("aria-pressed", String(!this.onlyLocal));
    this.localButton.setAttribute("aria-pressed", String(this.onlyLocal));
    const libraryKey = JSON.stringify(libraries);
    if (this.libraryKey !== libraryKey) {
      this.libraryKey = libraryKey;
      this.librarySelect.empty();
      this.librarySelect.createEl("option", { text: "所有书库", attr: { value: "" } });
      for (const library of libraries) this.librarySelect.createEl("option", { text: library.name, attr: { value: String(library.id) } });
      if (!libraries.some(library => String(library.id) === this.library)) this.library = "";
      this.librarySelect.value = this.library;
    }
    this.librarySelect.hidden = libraries.length < 2;

    const matches = [...books.values()].filter(book => {
      if (this.onlyLocal && !local.has(book.id)) return false;
      if (this.library && String(book.libraryId) !== this.library) return false;
      const haystack = [book.title, ...book.authors, book.series].join(" ").toLocaleLowerCase();
      return tokens.every(token => haystack.includes(token));
    });
    if (this.sort === "title") matches.sort((a, b) => collator.compare(a.title, b.title));
    this.grid.empty();
    this.pager.empty();
    if (!matches.length) {
      this.count.hidden = true;
      let title = "没有找到书籍";
      let detail = "试试其他关键词，或调整书库筛选。";
      if (!plugin.api && !books.size) {
        title = "连接你的 BookOrbit";
        detail = "在 Obsidian 的 BookOrbit Library 插件设置中保存连接，然后回来同步书库。";
      } else if (!snapshot && !books.size) {
        title = "书架等你来填满";
        detail = "点「同步书库」，从 BookOrbit 读取你的书目。";
      } else if (this.onlyLocal && !local.size) {
        title = "还没有下载的书籍";
        detail = "在「全部书籍」里选择一本书下载。";
      } else if (!books.size) {
        title = "书库里还没有书";
        detail = "确认当前账号或 API Key 有权查看你的书库。";
      }
      const empty = this.grid.createDiv({ cls: "bor-empty" });
      setIcon(empty.createSpan({ cls: "bor-icon", attr: { "aria-hidden": "true" } }), "book-open");
      empty.createEl("h2", { text: title });
      empty.createEl("p", { text: detail });
      return;
    }
    this.count.hidden = false;
    this.count.textContent = `共 ${matches.length} 本`;
    const pageCount = Math.ceil(matches.length / PAGE_SIZE);
    this.page = Math.min(this.page, pageCount - 1);
    const covers = [];
    for (const book of matches.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)) {
      const cover = this.card(book, local.get(book.id), libraries.find(library => library.id === book.libraryId)?.name);
      if (book.hasCover) covers.push({ book, cover });
    }
    if (pageCount > 1) {
      const previous = action(this.pager, "上一页", "chevron-left", () => this.changePage(-1));
      previous.disabled = this.page === 0;
      this.pager.createSpan({ text: `${this.page + 1} / ${pageCount}` });
      const next = action(this.pager, "下一页", "chevron-right", () => this.changePage(1));
      next.disabled = this.page === pageCount - 1;
    }
    this.fetchCovers(covers, this.coverRequest.signal);
  }

  changePage(direction) {
    this.page += direction;
    this.render();
    this.count.focus({ preventScroll: true });
    this.count.scrollIntoView({ block: "start" });
  }

  card(book, file, library) {
    const card = this.grid.createEl("article", { cls: "bor-card" });
    const poster = card.createDiv({ cls: "bor-poster tone-" + (book.id % 5) });
    const mock = poster.createDiv({ cls: "bor-faux-cover", attr: { "aria-hidden": "true" } });
    setIcon(mock.createSpan({ cls: "bor-icon" }), "book-open");
    mock.createSpan({ cls: "bor-cover-title", text: book.title });
    if (book.authors.length) mock.createSpan({ cls: "bor-cover-author", text: book.authors[0] });
    if (file) {
      const badge = poster.createSpan({ cls: "bor-saved", text: "已下载" });
      badge.setAttribute("aria-label", "已下载到本地");
    }
    const description = card.createDiv({ cls: "bor-card-info" });
    description.createEl("h2", { text: book.title, attr: { title: book.title } });
    const subtitle = book.authors.join("、") || (book.retained ? "本地保留" : library || book.series);
    if (subtitle) description.createEl("p", { text: subtitle, attr: { title: subtitle } });
    const footer = card.createDiv({ cls: "bor-card-footer" });
    const format = file?.format || book.format;
    if (format) footer.createSpan({ text: format.toUpperCase(), cls: "bor-format" });
    if (file || book.file) {
      if (!file && book.file) {
        const downloading = this.plugin.workingBook === book.id;
        const download = action(footer, downloading ? "下载中" : "下载", "download", () => this.plugin.activateBook(book, false));
        download.classList.add("bor-card-download");
        const label = "下载《" + book.title + "》";
        download.setAttribute("aria-label", label);
        download.title = label;
        download.disabled = this.plugin.busy;
      }
      const read = action(footer, "阅读", "book-open", () => this.plugin.openReader(book));
      read.setAttribute("aria-label", "阅读《" + book.title + "》");
    }
    return poster;
  }

  fetchCovers(covers, signal) {
    if (!covers.length) return;
    const api = this.plugin.api;
    let cursor = 0;
    const paint = (cover, src) => {
      const image = cover.createEl("img", { cls: "bor-cover-image", attr: { alt: "", decoding: "async" } });
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = src;
    };
    const worker = async () => {
      while (!signal.aborted && cursor < covers.length) {
        const { book, cover } = covers[cursor++];
        const key = `${book.id}:${book.coverVersion}`;
        let image = this.covers.get(key);
        if (!image && api && !this.plugin.statusError) {
          try {
            image = await api.thumbnail(book, signal);
            if (signal.aborted) return;
            this.covers.set(key, image);
            if (this.covers.size > 72) this.covers.delete(this.covers.keys().next().value);
          } catch {
            continue;
          }
        }
        if (image && !signal.aborted) paint(cover, image);
      }
    };
    for (let i = 0; i < Math.min(4, covers.length); i++) void worker();
  }
}

class ConfirmDownload extends Modal {
  constructor(app, count, proceed) {
    super(app);
    this.setTitle("批量下载");
    this.setContent(`将把 ${count} 本 EPUB 或 PDF 下载到当前仓库。`);
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText("取消").onClick(() => this.close()))
      .addButton(button => button.setButtonText("开始下载").setCta().onClick(() => {
        this.close();
        return proceed();
      }));
  }
}

class LibrarySettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    const plugin = this.plugin;
    const draft = { ...plugin.settings, key: "", password: "" };
    new Setting(this.containerEl).setName("BookOrbit 地址")
      .setDesc("填写平时访问 BookOrbit 的完整地址。")
      .addText(input => input.setPlaceholder("https://books.example.com").setValue(draft.endpoint)
        .onChange(value => { draft.endpoint = value; }));
    new Setting(this.containerEl).setName("连接方式")
      .addDropdown(input => input.addOption("key", "API Key").addOption("password", "账号登录")
        .setValue(draft.mode).onChange(value => { draft.mode = value; updateInputs(); }));
    const keyRow = new Setting(this.containerEl).setName("API Key")
      .setDesc("BookOrbit 3.8 起支持。可使用只读 Key，离线下载需要「Download books」权限。");
    const userRow = new Setting(this.containerEl).setName("BookOrbit 用户名")
      .addText(input => input.setValue(draft.username).onChange(value => { draft.username = value; }));
    const passRow = new Setting(this.containerEl).setName("BookOrbit 密码")
      .setDesc("密码仅用于登录。插件保存会话令牌。");
    let keyInput, passInput;
    keyRow.addText(input => {
      input.inputEl.type = "password";
      keyInput = input;
      input.onChange(value => { draft.key = value; });
    });
    passRow.addText(input => {
      input.inputEl.type = "password";
      passInput = input;
      input.onChange(value => { draft.password = value; });
    });
    const updateInputs = () => {
      keyRow.settingEl.style.display = draft.mode === "key" ? "" : "none";
      userRow.settingEl.style.display = passRow.settingEl.style.display = draft.mode === "password" ? "" : "none";
    };
    updateInputs();
    new Setting(this.containerEl).setName("下载文件夹")
      .addText(input => input.setValue(draft.folder).onChange(value => { draft.folder = value; }));
    new Setting(this.containerEl).setName("连接")
      .addButton(button => button.setButtonText("保存并测试").setCta().onClick(async () => {
        const saved = await plugin.run(() => plugin.configure({ ...draft }), false);
        if (saved) {
          draft.key = draft.password = "";
          keyInput.setValue("");
          passInput.setValue("");
          new Notice("BookOrbit 连接成功，设置已保存。");
        }
      }));
  }
}

module.exports = class BookOrbitLibrary extends Plugin {
  async onload() {
    this.controller = new AbortController();
    const data = await this.loadData() || {};
    const previous = data.settings || { endpoint: data.endpoint, folder: data.folder };
    this.settings = { ...DEFAULTS, ...Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== undefined)) };
    if (this.settings.endpoint) {
      try { this.settings.endpoint = endpointFrom(this.settings.endpoint); }
      catch { this.settings.endpoint = ""; }
    }
    this.snapshot = data.snapshot || null;
    this.local = new Map();
    this.coverEpoch = 0;
    this.api = this.savedApi();
    this.reading = new ReadingStore(this);
    try { await this.reading.load(); }
    catch (error) { this.readingError = "阅读记录无法读取。 " + error.message; }
    this.registerView(VIEW, leaf => new ShelfView(leaf, this));
    this.registerView(READER, leaf => new ReaderView(leaf, this));
    this.registerView(READER_PANEL, leaf => new ReadingPanel(leaf, this));
    const workspace = this.app.workspace;
    this.registerEvent(workspace.on("active-leaf-change", leaf => {
      if (leaf?.view instanceof ReaderView) this.setPanelReader(leaf.view);
    }));
    this.registerEvent(workspace.on("css-change", () => {
      for (const leaf of workspace.getLeavesOfType(READER)) {
        if (leaf.view instanceof ReaderView) leaf.view.updateTheme();
      }
    }));
    this.addSettingTab(new LibrarySettings(this.app, this));
    this.addRibbonIcon("library", "打开 BookOrbit 书架", () => this.runOpen());
    this.addCommand({ id: "open-shelf", name: "打开书架", callback: () => this.runOpen() });
    this.addCommand({ id: "sync-shelf", name: "同步书架", callback: () => this.runOpen(() => this.sync()) });
    this.addCommand({ id: "pick-book", name: "搜索书籍", callback: () => this.runOpen(view => view.focusSearch()) });
    this.addCommand({ id: "download-all", name: "批量下载 EPUB 和 PDF", callback: () => this.runOpen(() => this.confirmBulk()) });
    this.addCommand({ id: "reading-panel", name: "阅读器：显示目录与标注", checkCallback: checking => {
      const reader = workspace.getActiveViewOfType(ReaderView) ?? this.panelReader;
      if (!reader || reader.closed) return false;
      if (!checking) void this.openReadingPanel(reader);
      return true;
    } });
    this.addCommand({ id: "reading-highlight", name: "阅读器：为选中文字添加标注", checkCallback: checking => {
      const reader = workspace.getActiveViewOfType(ReaderView);
      if (!reader?.selected || reader.closed) return false;
      if (!checking) reader.editSelection();
      return true;
    } });
    try { await this.refreshLocal(); }
    catch (error) { this.setStatus(error.message, true); }
  }

  onunload() {
    this.controller.abort();
    this.app.workspace.detachLeavesOfType(READER_PANEL);
    this.app.workspace.detachLeavesOfType(READER);
    this.app.workspace.detachLeavesOfType(VIEW);
  }

  storage(settings = this.settings) {
    return new LocalBooks(this.app.vault, folderFrom(settings.folder), settings.endpoint);
  }

  savedApi() {
    if (!this.settings.endpoint || !this.settings.accountId) return null;
    const key = secretKey(this.settings);
    const secret = this.app.secretStorage.getSecret(key);
    if (!secret) return null;
    const client = new BookOrbitApi(this.settings.endpoint, this.settings.mode, secret, this.controller.signal);
    client.onRotate = value => {
      if (this.api === client) this.app.secretStorage.setSecret(key, value);
    };
    return client;
  }

  async configure(draft) {
    const endpoint = endpointFrom(draft.endpoint);
    const folder = folderFrom(draft.folder);
    const mode = draft.mode;
    const username = draft.username.trim();
    const existing = this.settings.endpoint === endpoint && this.settings.mode === mode
      && (mode !== "password" || this.settings.username === username) ? this.api : null;
    const supplied = mode === "key" ? draft.key.trim() : draft.password;
    let client = existing;
    if (supplied) {
      client = new BookOrbitApi(endpoint, mode, mode === "key" ? supplied : "", this.controller.signal);
      if (mode === "password") {
        if (!username) throw new Error("请输入 BookOrbit 用户名。");
        await client.login(username, supplied);
      }
    }
    if (!client) throw new Error(mode === "key" ? "请输入 API Key。" : "请输入 BookOrbit 用户名和密码。");
    const me = await client.json("/auth/me");
    if (!Number.isSafeInteger(me?.id) || me.id < 1) throw new Error("BookOrbit 未返回有效的账号信息。");
    await client.page(0, 1);
    this.controller.signal.throwIfAborted();
    const settings = { endpoint, mode, username: typeof me.username === "string" ? me.username : username, accountId: me.id, folder };
    const key = secretKey(settings);
    const snapshot = existing === client && me.id === this.settings.accountId ? this.snapshot : null;
    const local = await this.storage(settings).files();
    await this.saveData({ settings, snapshot });
    this.api = client;
    this.app.secretStorage.setSecret(key, client.secret);
    client.onRotate = value => {
      if (this.api === client) this.app.secretStorage.setSecret(key, value);
    };
    this.settings = settings;
    this.snapshot = snapshot;
    this.local = local;
    this.coverEpoch++;
    this.setStatus("");
    return true;
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW).map(leaf => leaf.view).filter(view => view instanceof ShelfView);
  }

  render() { for (const view of this.views()) view.render(); }

  setStatus(text, error = false) {
    this.status = text;
    this.statusError = error;
    this.render();
  }

  async refreshLocal() {
    this.local = this.settings.endpoint ? await this.storage().files() : new Map();
    this.render();
  }

  async runOpen(callback) {
    try {
      const workspace = this.app.workspace;
      let leaf = workspace.getLeavesOfType(VIEW)[0];
      if (!leaf) {
        leaf = workspace.getLeaf("tab");
        await leaf.setViewState({ type: VIEW, active: true });
      }
      await workspace.revealLeaf(leaf);
      await this.refreshLocal();
      if (leaf.view instanceof ShelfView) await callback?.(leaf.view);
    } catch (error) {
      if (!this.controller.signal.aborted) new Notice(error.message, 8500);
    }
  }

  async run(task, showOnShelf = true) {
    if (this.controller.signal.aborted) return;
    if (this.busy) { new Notice("BookOrbit 正在处理另一个操作。"); return; }
    this.busy = true;
    this.render();
    try {
      return await task();
    } catch (error) {
      if (!this.controller.signal.aborted) {
        if (showOnShelf) this.setStatus(error.message, true);
        new Notice(error.message, 8500);
      }
    } finally {
      this.busy = false;
      this.workingBook = null;
      this.render();
    }
  }

  connected() {
    if (!this.api) throw new Error("请在插件设置中保存 BookOrbit 连接。");
    return this.api;
  }

  sync() {
    return this.run(async () => {
      const api = this.connected();
      this.setStatus("正在同步书库…");
      const snapshot = await api.list((count, total) => {
        this.status = `正在同步书目 ${count} / ${total}`;
        for (const view of this.views()) if (view.status) view.status.textContent = this.status;
      });
      this.controller.signal.throwIfAborted();
      await this.saveData({ settings: this.settings, snapshot });
      this.snapshot = snapshot;
      await this.refreshLocal();
      this.setStatus("");
      new Notice(`已同步 ${snapshot.books.length} 本书。`);
    });
  }

  async openReader(book) {
    if (this.controller.signal.aborted) return;
    try {
      const workspace = this.app.workspace;
      await this.refreshLocal();
      const existing = workspace.getLeavesOfType(READER).find(leaf =>
        leaf.view instanceof ReaderView && leaf.view.getState().id === book.id && leaf.view.settings === this.settings);
      const leaf = existing || workspace.getLeaf("tab");
      if (!existing) await leaf.setViewState({ type: READER, active: true, state: { id: book.id } });
      await workspace.revealLeaf(leaf);
      if (leaf.view instanceof ReaderView) this.setPanelReader(leaf.view);
    } catch (error) {
      if (!this.controller.signal.aborted) new Notice(error.message, 8500);
    }
  }

  setPanelReader(reader) {
    this.panelReader = reader;
    this.renderReadingPanel();
  }

  renderReadingPanel(reader) {
    if (reader && !this.panelReader && !reader.closed) this.panelReader = reader;
    if (reader && reader !== this.panelReader) return;
    for (const leaf of this.app.workspace.getLeavesOfType(READER_PANEL)) {
      if (leaf.view instanceof ReadingPanel) leaf.view.render(this.panelReader);
    }
  }

  refreshReaderMarks(reader) {
    const workspace = this.app.workspace;
    for (const leaf of workspace.getLeavesOfType(READER)) {
      const view = leaf.view;
      if (view instanceof ReaderView && !view.closed && view.state === reader.state) view.engine?.refreshMarks();
    }
    this.renderReadingPanel();
  }

  async openReadingPanel(reader, side) {
    if (reader.closed || this.controller.signal.aborted) return;
    try {
      if (side) reader.side = side;
      this.setPanelReader(reader);
      const leaf = await this.app.workspace.ensureSideLeaf(READER_PANEL, "right", { active: false, reveal: true });
      if (leaf.view instanceof ReadingPanel) leaf.view.render(this.panelReader);
    } catch (error) {
      if (!this.controller.signal.aborted) new Notice(error.message, 8500);
    }
  }

  readerClosed(reader) {
    if (this.panelReader !== reader) return;
    const available = this.app.workspace.getLeavesOfType(READER)
      .map(leaf => leaf.view).find(view => view instanceof ReaderView && !view.closed);
    this.setPanelReader(available ?? null);
  }

  async activateBook(book, open = true) {
    const saved = this.local.get(book.id);
    if (saved) {
      if (open) await this.openReader(book);
      return;
    }
    return this.run(async () => {
      const api = this.connected();
      if (!book.file) throw new Error("这本书没有可下载的 EPUB 或 PDF。");
      this.workingBook = book.id;
      this.setStatus("正在下载《" + book.title + "》…");
      const file = await this.storage().save(api, book);
      this.local.set(book.id, file);
      this.setStatus("已下载《" + book.title + "》");
      if (open) await this.openReader(book);
    });
  }

  confirmBulk() {
    if (this.busy) { new Notice("BookOrbit 正在处理另一个操作。"); return; }
    const snapshot = this.snapshot;
    const pending = snapshot?.books.filter(book => book.file && !this.local.has(book.id)) || [];
    if (!pending.length) { new Notice("当前书架没有待下载的 EPUB 或 PDF。"); return; }
    const settings = this.settings;
    new ConfirmDownload(this.app, pending.length, () => this.run(async () => {
      if (settings !== this.settings || snapshot !== this.snapshot) throw new Error("书架已更新，请重新选择批量下载。");
      const api = this.connected();
      const storage = this.storage();
      const failures = [];
      let count = 0;
      for (const [index, book] of pending.entries()) {
        this.controller.signal.throwIfAborted();
        if (this.local.has(book.id)) continue;
        this.workingBook = book.id;
        this.setStatus(`正在下载 ${index + 1} / ${pending.length} · ${book.title}`);
        try {
          this.local.set(book.id, await storage.save(api, book));
          count++;
        } catch (error) {
          failures.push(`《${book.title}》 ${error.message}`);
          if (error.status === 401 || error.status === 403) break;
        }
      }
      const message = `已下载 ${count} 本` + (failures.length ? `。失败 ${failures.length} 本。 ${failures[0]}` : "。");
      this.setStatus(message, failures.length > 0);
      new Notice(message, failures.length ? 10000 : 4500);
    })).open();
  }

};
