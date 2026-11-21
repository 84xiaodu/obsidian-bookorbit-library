const { ItemView, Menu, Modal, Notice, Setting, TFile, TFolder, normalizePath, setIcon, setTooltip } = require("obsidian");
const { randomUUID, createHash } = require("crypto");
const fs = require("fs").promises;
const path = require("path");

const READER = "bookorbit-library-reader";
const READER_PANEL = "bookorbit-library-reader-panel";
const COLORS = { yellow: "#FACC15", green: "#4ADE80", blue: "#60A5FA", pink: "#F472B6", purple: "#A78BFA", orange: "#FB923C" };
const STYLES = { highlight: "高亮", underline: "下划线", strikethrough: "删除线", squiggly: "波浪线" };
const BUNDLE = () => require("../reader-deps/reader-engines.mjs");
const annotationOperations = new WeakSet();
const progressOperations = new WeakMap();
const progressWrites = new WeakMap();
const nextAutomaticProgress = new WeakMap();
const PROGRESS_BATCH_MS = 8_000;
const PROGRESS_INTERVAL_MS = 30_000;

function automaticProgressAt(api) {
  return Math.max(nextAutomaticProgress.get(api) ?? 0, api.rateLimitUntil ?? 0);
}

function samePosition(left, right) {
  left = left?.cfi || left;
  right = right?.cfi || right;
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if ("page" in left || "page" in right) return left.page === right.page && left.offset === right.offset;
  return left.fraction === right.fraction;
}

function cloudPosition(progress, format, local) {
  if (format === "pdf") {
    if (progress.page == null) return null;
    return local?.page === progress.page ? local : { page: progress.page, offset: 0 };
  }
  if (progress.cfi) return { cfi: progress.cfi, fraction: progress.percentage / 100 };
  return progress.percentage > 0 ? { fraction: progress.percentage / 100 } : null;
}

function color(value) {
  if (Object.hasOwn(COLORS, value)) return COLORS[value];
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ? value : COLORS.yellow;
}

function pdfPosition(value) {
  const valid = rect => rect && ["x", "y", "width", "height"].every(key => Number.isFinite(rect[key]))
    && rect.width > 0 && rect.height > 0;
  if (!value || !Number.isSafeInteger(value.page) || value.page < 0 || !valid(value.rect) || !Array.isArray(value.rects)) return null;
  const rects = value.rects.filter(valid);
  return { page: value.page, rect: value.rect, rects: rects.length ? rects : [value.rect] };
}

function remoteMark(item) {
  if (!Number.isSafeInteger(item?.id) || typeof item.text !== "string") throw new Error("BookOrbit 返回了无效的标注。");
  return {
    id: item.id,
    text: item.text,
    note: typeof item.note === "string" ? item.note : "",
    color: color(item.color),
    style: typeof item.style === "string" ? item.style : "highlight",
    chapterTitle: typeof item.chapterTitle === "string" ? item.chapterTitle : "",
    cfi: typeof item.cfi === "string" && item.cfi.startsWith("epubcfi(") ? item.cfi : null,
    pdf: pdfPosition(item.pdf),
    fileId: item.jumpFileId ?? null,
    origin: typeof item.origin === "string" ? item.origin : "BookOrbit",
    date: item.highlightedAt || item.createdAt || "",
  };
}

function markKey(mark) {
  const geometry = mark.pdf?.rects.map(rect => [rect.x, rect.y, rect.width, rect.height].map(value => Number(value.toFixed(2))));
  return JSON.stringify([
    mark.fileId, mark.cfi ?? [mark.pdf?.page, geometry], mark.text.trim(), mark.note.trim(), color(mark.color), mark.style,
  ]);
}

class ReadingStore {
  constructor(plugin) {
    this.adapter = plugin.app.vault.adapter;
    this.path = normalizePath(plugin.manifest.dir + "/reading.json");
    const base = this.adapter.getBasePath?.();
    this.absolutePath = base ? path.resolve(base, this.path) : null;
    this.queue = Promise.resolve();
    this.books = {};
  }

  async load() {
    const decode = value => {
      const data = JSON.parse(value);
      if (data?.version !== 1 || !data.books || typeof data.books !== "object") throw new Error("阅读记录格式无法读取。");
      return data.books;
    };
    const current = await this.adapter.stat(this.path);
    const pending = this.absolutePath ? await this.adapter.stat(this.path + ".part") : null;
    if (pending && (!current || pending.mtime >= current.mtime)) {
      let recovered;
      try { recovered = decode(await this.adapter.read(this.path + ".part")); }
      catch (error) { if (!current) throw error; }
      if (recovered) {
        await fs.rename(this.absolutePath + ".part", this.absolutePath);
        this.books = recovered;
        return;
      }
    }
    if (current) this.books = decode(await this.adapter.read(this.path));
  }

  book(settings, id) {
    const account = createHash("sha256").update(JSON.stringify([settings.endpoint, settings.accountId])).digest("hex").slice(0, 16);
    const key = account + ":" + id;
    return this.books[key] ??= { positions: {}, remote: [], pending: [] };
  }

  save() {
    const write = async () => {
      const payload = JSON.stringify({ version: 1, books: this.books });
      if (this.absolutePath) {
        const next = this.absolutePath + ".part";
        try {
          await fs.writeFile(next, payload, "utf8");
          await fs.rename(next, this.absolutePath);
        } catch (error) {
          await fs.rm(next, { force: true }).catch(() => {});
          throw error;
        }
      } else {
        await this.adapter.write(this.path, payload);
      }
    };
    const result = this.queue.catch(() => {}).then(write);
    this.queue = result;
    return result;
  }
}

function button(parent, label, icon, handler) {
  const control = parent.createEl("button", { cls: "bor-button", attr: { type: "button" } });
  setIcon(control.createSpan({ cls: "bor-icon", attr: { "aria-hidden": "true" } }), icon);
  control.createSpan({ text: label });
  control.addEventListener("click", handler);
  return control;
}

function iconButton(parent, label, icon, handler) {
  const control = parent.createEl("button", { cls: "clickable-icon bor-reader-icon", attr: { type: "button", "aria-label": label } });
  setIcon(control, icon);
  setTooltip(control, label);
  control.addEventListener("click", handler);
  return control;
}

function selectionPoint(range) {
  const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
  const rect = rects.at(-1);
  if (!rect) return null;
  const frame = range.startContainer.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect();
  return { x: rect.right + (frame?.left ?? 0), y: rect.bottom + (frame?.top ?? 0) };
}

function epubStyle(view) {
  const css = view.root.ownerDocument.defaultView.getComputedStyle(view.root);
  const scale = view.magnification;
  const size = (parseFloat(css.fontSize) || 16) * scale;
  const lineHeight = parseFloat(css.lineHeight);
  const leading = Number.isFinite(lineHeight) ? `${lineHeight * scale}px` : "1.6";
  const link = css.getPropertyValue("--link-color").trim() || "#705dcf";
  const selection = css.getPropertyValue("--text-selection").trim() || "#8668b847";
  const theme = view.root.closest(".theme-dark") ? "dark" : "light";
  return `html { color-scheme: ${theme}; font-size: ${size}px; }
    body { background-color: ${css.backgroundColor} !important; color: ${css.color} !important;
      font-family: ${css.fontFamily} !important; font-size: 1rem !important; line-height: ${leading} !important; }
    p, li, blockquote { line-height: inherit !important; font-family: inherit !important; }
    a { color: ${link}; } ::selection { background: ${selection}; }`;
}

class EpubReader {
  constructor(view) {
    this.view = view;
    this.drawn = new Set();
    this.wheel = event => this.wheelAtBoundary(event);
  }

  async open(bytes, position) {
    const { view } = this;
    const { book, archive } = await BUNDLE().openEpub(bytes);
    if (view.closed) { await archive.close(); return; }
    this.archive = archive;
    const element = view.pageArea.createEl("bor-epub-view", { cls: "bor-epub-frame" });
    this.element = element;
    element.addEventListener("external-link", event => event.preventDefault());
    element.addEventListener("load", ({ detail }) => {
      const capture = () => {
        const selection = detail.doc.getSelection();
        const text = selection?.toString().trim();
        if (!text || !selection.rangeCount) return view.selectionChanged(null);
        try {
          const range = selection.getRangeAt(0);
          const cfi = element.getCFI(detail.index, range);
          const before = range.cloneRange();
          before.selectNodeContents(detail.doc.body);
          before.setEnd(range.startContainer, range.startOffset);
          const after = range.cloneRange();
          after.selectNodeContents(detail.doc.body);
          after.setStart(range.endContainer, range.endOffset);
          view.selectionChanged({ text, cfi, chapterTitle: element.lastLocation?.tocItem?.label ?? "",
            quote: { exact: range.toString(), prefix: before.toString().slice(-40), suffix: after.toString().slice(0, 40) } }, selectionPoint(range));
        } catch { view.selectionChanged(null); }
      };
      detail.doc.addEventListener("pointerup", capture);
      detail.doc.addEventListener("keyup", capture);
      detail.doc.addEventListener("keydown", event => view.handleArrow(event));
      detail.doc.addEventListener("wheel", this.wheel, { passive: false });
      detail.doc.addEventListener("contextmenu", event => { capture(); view.selectionMenu(event, detail.doc); });
    });
    element.addEventListener("draw-annotation", ({ detail: { draw, annotation } }) => {
      const overlays = BUNDLE().Overlayer;
      const method = ["underline", "strikethrough", "squiggly"].includes(annotation.style) ? annotation.style : "highlight";
      draw(overlays[method] || overlays.highlight, { color: color(annotation.color) });
    });
    element.addEventListener("create-overlay", () => queueMicrotask(() => this.refreshMarks()));
    element.addEventListener("relocate", ({ detail }) => {
      const label = detail.tocItem?.label;
      const progress = Number.isFinite(detail.fraction) ? Math.round(detail.fraction * 100) + "%" : "";
      view.setLocation([label, progress].filter(Boolean).join(" · "), detail.cfi, detail.fraction * 100, detail.reason !== "anchor");
      view.selectionChanged(null);
    });
    await element.open(book);
    if (view.closed) { this.close(); return; }
    this.updateAppearance();
    element.renderer?.setAttribute("max-column-count", "1");
    element.renderer?.addEventListener("scroll", () => view.hideSelectionControl());
    element.renderer?.addEventListener("wheel", this.wheel, { passive: false });
    this.setFlow(view.flow);
    view.setContents(book.toc || []);
    const target = this.positionTarget(position);
    try {
      if (target === 0) await element.goTo(0);
      else await element.init({ lastLocation: target, showTextStart: true });
    } catch (error) {
      if (target == null) throw error;
      await element.init({ lastLocation: typeof target === "string" ? this.fractionTarget(position) : null, showTextStart: true });
    }
    this.refreshMarks();
  }

  fractionTarget(position) {
    return Number.isFinite(position?.fraction) ? { fraction: position.fraction } : null;
  }

  positionTarget(position) {
    const cfi = typeof position === "string" ? position : position?.cfi;
    if (!cfi) return this.fractionTarget(position);
    const resolved = this.element.resolveNavigation(cfi);
    if (!this.element.book.sections[resolved?.index]) return this.fractionTarget(position);
    return cfi.includes("!") ? cfi : resolved.index;
  }

  async goToPosition(position) {
    const target = this.positionTarget(position);
    if (target == null) return;
    const result = await this.element.goTo(target);
    const fallback = this.fractionTarget(position);
    if (!result && typeof target === "string" && fallback) await this.element.goTo(fallback);
  }

  updateAppearance() {
    const renderer = this.element?.renderer;
    if (!renderer) return;
    const root = this.view.root;
    const width = root.ownerDocument.defaultView.getComputedStyle(root).getPropertyValue("--file-line-width").trim();
    renderer.setAttribute("max-inline-size", /^\d+(?:\.\d+)?px$/.test(width) ? width : "700px");
    renderer.setStyles?.(epubStyle(this.view));
  }

  setFlow(flow) {
    this.element?.renderer?.setAttribute("flow", flow);
  }

  wheelAtBoundary(event) {
    const renderer = this.element?.renderer;
    if (this.view.flow !== "scrolled" || !this.element?.lastLocation || !renderer?.scrolled || !renderer.viewSize || event.ctrlKey || event.shiftKey
        || Math.abs(event.deltaY) < Math.abs(event.deltaX) || !event.deltaY) return;
    const now = Date.now();
    if (this.blockWheel) {
      if (now - this.lastWheel < 260) { this.lastWheel = now; return; }
      this.blockWheel = false;
    }
    const forward = event.deltaY > 0;
    if (forward ? renderer.atEnd || renderer.viewSize - renderer.end > 2 : renderer.atStart || renderer.start > 2) return;
    event.preventDefault();
    this.blockWheel = true;
    this.lastWheel = now;
    this.view.move(forward ? 1 : -1);
  }

  async move(delta) { await (delta < 0 ? this.element.prev() : this.element.next()); }
  async goTo(target) { return this.element.goTo(target); }
  section(cfi) {
    const index = this.element?.resolveNavigation(cfi)?.index;
    return this.element?.book?.sections[index]?.id;
  }

  refreshMarks() {
    const element = this.element;
    if (!element || this.view.closed) return;
    const active = this.view.marks().filter(mark => mark.cfi && this.view.canLocate(mark));
    const next = new Set(active.map(mark => mark.cfi));
    for (const value of this.drawn) if (!next.has(value)) void Promise.resolve(element.deleteAnnotation({ value })).catch(() => {});
    for (const mark of active) {
      void Promise.resolve(element.addAnnotation({ value: mark.cfi, color: mark.color, style: mark.style })).catch(() => {});
    }
    this.drawn = next;
  }

  close() {
    this.element?.close();
    this.element?.remove();
    this.element = null;
    if (this.archive) { void this.archive.close().catch(() => {}); this.archive = null; }
  }
}

function boundRects(rects) {
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

class PdfReader {
  constructor(view) {
    this.view = view;
    this.area = view.pageArea;
    this.page = 1;
    this.entries = [];
    this.rendering = new Set();
  }

  async open(bytes, position) {
    this.task = BUNDLE().openPdf(bytes);
    this.doc = await this.task.promise;
    if (this.view.closed) return;
    this.estimate = (await this.doc.getPage(1)).getViewport({ scale: 1 });
    if (this.view.closed) return;
    this.area.addClass("bor-pdf-scroll");
    this.stack = this.area.createDiv({ cls: "bor-pdf-stack" });
    const fragment = this.area.ownerDocument.createDocumentFragment();
    for (let index = 1; index <= this.doc.numPages; index++) {
      const frame = this.area.ownerDocument.createElement("div");
      frame.className = "bor-pdf-page";
      frame.setAttribute("aria-label", `第 ${index} 页`);
      fragment.appendChild(frame);
      this.entries.push({ frame, index, natural: null, render: null, revision: 0 });
    }
    this.stack.appendChild(fragment);
    this.layout();
    this.onScroll = () => {
      this.view.hideSelectionControl();
      if (this.viewportFrame != null) return;
      this.viewportFrame = this.area.ownerDocument.defaultView.requestAnimationFrame(() => {
        this.viewportFrame = null;
        this.updateViewport();
      });
    };
    this.area.addEventListener("scroll", this.onScroll, { passive: true });
    this.observer = new ResizeObserver(() => {
      if (this.view.closed) return;
      if (this.width !== this.area.clientWidth) this.updateAppearance();
      else if (this.height !== this.area.clientHeight) {
        this.sizeTail();
        this.updateViewport();
      }
    });
    this.observer.observe(this.area);
    const initial = Number.isSafeInteger(position) ? { page: position, offset: 0 } : position;
    await this.goTo(initial?.page || 1, { offset: initial?.offset || 0 });
    const convert = items => items.map(item => ({ label: item.title, href: item.dest, subitems: convert(item.items || []) }));
    const outline = await this.doc.getOutline().catch(() => null);
    if (outline && !this.view.closed) this.view.setContents(convert(outline));
  }

  async move(delta) { await this.goTo(this.page + delta); }

  updateAppearance() {
    if (!this.entries.length || this.view.closed) return;
    const anchor = this.currentPosition();
    for (const entry of [...this.rendering]) this.discard(entry);
    this.layout();
    void this.goTo(anchor.page, { offset: anchor.offset }).catch(error => this.view.fail(error));
  }

  scale(natural) {
    return Math.max(0.18, Math.min(2, (this.width - 30) / natural.width)) * this.view.magnification;
  }

  size(entry) {
    const natural = entry.natural || this.estimate;
    const scale = this.scale(natural);
    const width = Math.round(natural.width * scale * 100) / 100;
    const height = Math.round(natural.height * scale * 100) / 100;
    entry.frame.style.width = width + "px";
    entry.frame.style.height = height + "px";
    return height;
  }

  layout() {
    this.width = this.area.clientWidth;
    for (const entry of this.entries) this.size(entry);
    this.sizeTail();
  }

  sizeTail() {
    const last = this.entries.at(-1);
    if (!last) return;
    this.height = this.area.clientHeight;
    this.stack.style.paddingBottom = Math.max(12, this.height - parseFloat(last.frame.style.height) - 12) + "px";
  }

  indexAt(y) {
    let first = 0;
    let last = this.entries.length - 1;
    while (first < last) {
      const mid = Math.ceil((first + last) / 2);
      if (this.entries[mid].frame.offsetTop <= y) first = mid;
      else last = mid - 1;
    }
    return first;
  }

  currentPosition() {
    const y = this.area.scrollTop;
    const entry = this.entries[this.indexAt(y + 18)];
    if (!entry) return { page: 1, offset: 0 };
    const offset = Math.max(0, Math.min(0.999, (y - entry.frame.offsetTop + 12) / Math.max(1, entry.frame.offsetHeight)));
    return { page: entry.index, offset: Math.round(offset * 1000) / 1000 };
  }

  updateViewport() {
    if (!this.entries.length || this.view.closed) return;
    const y = this.area.scrollTop;
    const position = this.currentPosition();
    this.page = position.page;
    this.view.setLocation(`${this.page} / ${this.doc.numPages}`, position, this.page / this.doc.numPages * 100);
    const first = Math.max(0, this.indexAt(y) - 1);
    const last = Math.min(this.entries.length - 1, this.indexAt(y + this.area.clientHeight) + 1);
    for (const entry of [...this.rendering]) {
      if (entry.index < first + 1 || entry.index > last + 1) this.discard(entry);
    }
    for (let index = first; index <= last; index++) void this.ensure(this.entries[index]);
  }

  async goTo(number, location = {}) {
    if (!this.entries.length || this.view.closed) return;
    if (typeof number !== "number") {
      const destination = typeof number === "string" ? await this.doc.getDestination(number) : number;
      const pageRef = destination?.[0];
      if (pageRef == null) return;
      number = (typeof pageRef === "number" ? pageRef : await this.doc.getPageIndex(pageRef)) + 1;
    }
    if (!Number.isFinite(number)) return;
    const entry = this.entries[Math.min(this.doc.numPages - 1, Math.max(0, Math.trunc(number) - 1))];
    const navigation = this.navigation = Symbol();
    const natural = (await this.doc.getPage(entry.index)).getViewport({ scale: 1 });
    if (this.view.closed || this.navigation !== navigation) return;
    entry.natural = natural;
    const height = this.size(entry);
    this.sizeTail();
    const offset = location.rect ? Math.max(0, location.rect.y / natural.height * height - this.area.clientHeight * 0.3)
      : Math.max(0, Math.min(0.999, Number(location.offset) || 0)) * height;
    this.area.scrollTop = entry.frame.offsetTop + offset - 12;
    this.view.selectionChanged(null);
    this.updateViewport();
    await this.ensure(entry);
    if (!this.view.closed && this.navigation === navigation) this.updateViewport();
  }

  ensure(entry) {
    if (entry.render) return entry.render;
    const revision = ++entry.revision;
    this.rendering.add(entry);
    entry.render = this.renderPage(entry, revision).catch(error => {
      if (entry.revision !== revision || this.view.closed) return;
      entry.frame.empty();
      entry.frame.createEl("p", { cls: "bor-reader-message", text: "无法显示此页。 " + error.message });
    });
    return entry.render;
  }

  async renderPage(entry, revision) {
    const page = await this.doc.getPage(entry.index);
    if (entry.revision !== revision || this.view.closed) return;
    const active = this.currentPosition();
    const top = entry.frame.offsetHeight;
    const natural = page.getViewport({ scale: 1 });
    entry.natural = natural;
    const height = this.size(entry);
    if (entry.index < active.page && top !== Math.round(height)) this.area.scrollTop += Math.round(height) - top;
    if (entry.index === this.entries.length) this.sizeTail();
    const viewport = page.getViewport({ scale: this.scale(natural) });
    const frame = entry.frame;
    frame.style.setProperty("--total-scale-factor", String(viewport.scale * (page.userUnit || 1)));
    const canvas = frame.createEl("canvas");
    const density = Math.min(this.area.ownerDocument.defaultView.devicePixelRatio || 1, 2,
      Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
    canvas.width = Math.max(1, Math.ceil(viewport.width * density));
    canvas.height = Math.max(1, Math.ceil(viewport.height * density));
    entry.overlay = frame.createDiv({ cls: "bor-pdf-marks", attr: { "aria-hidden": "true" } });
    const layer = frame.createDiv({ cls: "textLayer bor-pdf-text" });
    entry.renderTask = page.render({ canvas, viewport, transform: [density, 0, 0, density, 0, 0] });
    entry.layer = new (BUNDLE().TextLayer)({ textContentSource: page.streamTextContent(), container: layer, viewport });
    await Promise.all([entry.renderTask.promise, entry.layer.render()]);
    if (entry.revision !== revision || this.view.closed) return;
    const capture = () => this.capture(layer, entry);
    layer.addEventListener("pointerup", capture);
    layer.addEventListener("keyup", capture);
    layer.addEventListener("contextmenu", event => { capture(); this.view.selectionMenu(event, layer.ownerDocument); });
    this.paintMarks(entry);
  }

  discard(entry) {
    entry.revision++;
    entry.renderTask?.cancel();
    entry.layer?.cancel();
    entry.renderTask = entry.layer = entry.overlay = entry.render = null;
    entry.frame.empty();
    this.rendering.delete(entry);
  }

  capture(layer, entry) {
    const selection = layer.ownerDocument.getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection.rangeCount || !layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) {
      this.view.selectionChanged(null);
      return;
    }
    const box = entry.frame.getBoundingClientRect();
    const natural = entry.natural;
    const sx = natural.width / box.width;
    const sy = natural.height / box.height;
    const rects = Array.from(selection.getRangeAt(0).getClientRects()).map(rect => ({
      x: Math.max(0, rect.left - box.left) * sx,
      y: Math.max(0, rect.top - box.top) * sy,
      width: (Math.min(rect.right, box.right) - Math.max(rect.left, box.left)) * sx,
      height: (Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top)) * sy,
    })).filter(rect => rect.width >= 1 && rect.height >= 1);
    const unique = [...new Map(rects.map(rect => [JSON.stringify(rect), rect])).values()];
    this.view.selectionChanged(unique.length ? {
      text, pdf: { page: entry.index - 1, rect: boundRects(unique), rects: unique }, chapterTitle: `第 ${entry.index} 页`,
    } : null, selectionPoint(selection.getRangeAt(0)));
  }

  refreshMarks() {
    for (const entry of this.rendering) this.paintMarks(entry);
  }

  paintMarks(entry) {
    if (!entry.overlay || !entry.natural || this.view.closed) return;
    entry.overlay.empty();
    const { width, height } = entry.natural;
    for (const mark of this.view.marks()) {
      if (!mark.pdf || mark.pdf.page !== entry.index - 1 || !this.view.canLocate(mark)) continue;
      for (const rect of mark.pdf.rects) {
        const shape = entry.overlay.createSpan({ cls: "bor-pdf-mark bor-mark-" + (Object.hasOwn(STYLES, mark.style) ? mark.style : "highlight") });
        Object.assign(shape.style, {
          left: (rect.x / width * 100) + "%", top: (rect.y / height * 100) + "%",
          width: (rect.width / width * 100) + "%", height: (rect.height / height * 100) + "%",
          color: color(mark.color),
        });
      }
    }
  }

  close() {
    this.observer?.disconnect();
    if (this.onScroll) this.area.removeEventListener("scroll", this.onScroll);
    if (this.viewportFrame != null) this.area.ownerDocument.defaultView.cancelAnimationFrame(this.viewportFrame);
    for (const entry of [...this.rendering]) this.discard(entry);
    if (this.task) void this.task.destroy().catch(() => {});
  }
}

class MarkModal extends Modal {
  constructor(app, selected, save) {
    super(app);
    this.setTitle("添加标注");
    this.contentEl.createEl("blockquote", { text: selected.text });
    const text = this.contentEl.createEl("textarea", {
      cls: "bor-note-input", attr: { "aria-label": "笔记", placeholder: "写点笔记（可选）", rows: "4" },
    });
    let ink = COLORS.yellow;
    let style = "highlight";
    new Setting(this.contentEl).setName("颜色").addDropdown(dropdown => dropdown.addOption("#FACC15", "黄")
      .addOption("#4ADE80", "绿").addOption("#60A5FA", "蓝").addOption("#F472B6", "粉")
      .addOption("#A78BFA", "紫").setValue(ink).onChange(value => { ink = value; }));
    new Setting(this.contentEl).setName("样式").addDropdown(dropdown => {
      for (const [key, label] of Object.entries(STYLES)) dropdown.addOption(key, label);
      dropdown.setValue(style).onChange(value => { style = value; });
    });
    new Setting(this.contentEl)
      .addButton(control => control.setButtonText("取消").onClick(() => this.close()))
      .addButton(control => control.setButtonText("保存到本地").setCta().onClick(async () => {
        control.setDisabled(true);
        try {
          await save({ ...selected, color: ink, style, note: text.value.trim() });
          this.close();
        } catch (error) {
          new Notice(error.message, 8500);
          control.setDisabled(false);
        }
      }));
  }
}

class DeleteMarkModal extends Modal {
  constructor(app, mark, remove) {
    super(app);
    const local = typeof mark.id === "string";
    this.setTitle("删除标注");
    this.contentEl.createEl("blockquote", { text: mark.text.length > 140 ? mark.text.slice(0, 140) + "…" : mark.text });
    this.contentEl.createEl("p", { text: local ? "删除这条本地标注？" : "将这条标注移到 BookOrbit 回收站？" });
    const error = this.contentEl.createEl("p", { cls: "mod-warning", attr: { role: "alert" } });
    error.hidden = true;
    new Setting(this.contentEl)
      .addButton(control => control.setButtonText("取消").onClick(() => this.close()))
      .addButton(control => control.setButtonText(local ? "删除" : "移到回收站").setWarning().onClick(async () => {
        control.setDisabled(true);
        error.hidden = true;
        try {
          await remove();
          this.close();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          control.setDisabled(false);
        }
      }));
  }
}

function mdText(value) {
  return String(value ?? "").replace(/[&<>"'\[\]()*_`~!#|\\%$=]/g, char => `&#${char.charCodeAt(0)};`);
}

function annotatorBlock(view, mark, local) {
  const chapter = mark.cfi ? view.engine?.section?.(mark.cfi) : null;
  const fingerprint = mark.pdf ? view.engine?.doc?.fingerprints?.[0] : null;
  const source = chapter ? "http://localhost/?loc=" + encodeURIComponent(chapter)
    : fingerprint ? "urn:x-pdf:" + fingerprint : local.path;
  const quote = mark.quote || { exact: mark.text, prefix: "", suffix: "" };
  const taggedStyle = mark.style === "strikethrough" ? "strike-out" : mark.style;
  const tags = ["underline", "strike-out", "squiggly"].includes(taggedStyle) ? [taggedStyle] : [];
  const id = createHash("sha256").update(JSON.stringify([view.book.id, mark.cfi, mark.pdf?.page,
    mark.pdf?.rects.map(rect => [rect.x, rect.y, rect.width, rect.height].map(value => value.toFixed(2))), mark.text])).digest("hex").slice(0, 24);
  const fields = {
    text: mark.note, created: mark.date || undefined, uri: source,
    target: [{ source, selector: [{ type: "TextQuoteSelector", ...quote }] }],
    color: Object.keys(COLORS).find(key => COLORS[key].toLowerCase() === color(mark.color).toLowerCase()) || "yellow",
    ...fingerprint && { document: { documentFingerprint: fingerprint, link: [{ href: source }] } },
    ...mark.pdf && { nativePdf: { version: 1, page: mark.pdf.page + 1, units: "document-utf16" } },
  };
  const words = mdText(quote.exact.replace(/\s+/g, " ").trim());
  const block = [
    ">%%", ">\x60\x60\x60annotation-json", ">" + JSON.stringify(fields), ">\x60\x60\x60", ">%%",
    ">*%%PREFIX%%%%HIGHLIGHT%% ==" + words + "== %%POSTFIX%%*",
    `>%%LINK%%[[#^${id}|show annotation]]`, ">%%COMMENT%%",
    ...mdText(mark.note).split(/\r?\n/).map(line => ">" + line), ">%%TAGS%%",
    tags.length ? ">#" + tags.join(" #") : ">", "^" + id,
  ].join("\n");
  return { id, block };
}

async function exportMarks(view, compatible = false) {
  const { plugin, book, settings } = view;
  const vault = plugin.app.vault;
  const folder = normalizePath(settings.folder + "/标注");
  let current = "";
  for (const part of folder.split("/")) {
    current = current ? current + "/" + part : part;
    const item = vault.getAbstractFileByPath(current);
    if (!item) await vault.createFolder(current);
    else if (!(item instanceof TFolder)) throw new Error("标注目录被同名文件占用。");
  }
  const account = createHash("sha256").update(JSON.stringify([settings.endpoint, settings.accountId])).digest("hex").slice(0, 10);
  const path = normalizePath(`${folder}/${book.id} - ${account}${compatible ? " - Annotator" : ""}.md`);
  if (compatible) {
    const local = plugin.local.get(book.id);
    if (!local || local.format !== view.format) throw new Error("先从书架下载这本书，再导出到 Annotator。");
    const rows = view.marks().filter(mark => view.canLocate(mark)).map(mark => annotatorBlock(view, mark, local));
    if (!rows.length) throw new Error("该本地版本没有可导出的定位标注。");
    const append = original => {
      const known = new Set([...original.matchAll(/^\^([a-f0-9]{24})\s*$/gm)].map(match => match[1]));
      const blocks = [];
      for (const row of rows) if (!known.has(row.id)) { blocks.push(row.block); known.add(row.id); }
      return blocks.length ? original.trimEnd() + "\n\n" + blocks.join("\n\n") + "\n" : original;
    };
    let note = vault.getAbstractFileByPath(path);
    if (!note) {
      const header = `---\nannotation-target: ${JSON.stringify(local.path)}\nannotation-target-type: ${local.format}\n---\n\n# ${mdText(book.title)}\n`;
      note = await vault.create(path, append(header));
    } else {
      if (!(note instanceof TFile)) throw new Error("Annotator 笔记的位置已被文件夹占用。");
      await vault.process(note, original => {
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original)?.[1];
        if (!frontmatter?.split(/\r?\n/).includes("annotation-target: " + JSON.stringify(local.path))) {
          throw new Error("已有同名笔记，或笔记指向了另一份电子书。");
        }
        return append(original);
      });
    }
    await plugin.app.workspace.getLeaf("tab").openFile(note);
    return;
  }
  const start = "<!-- bookorbit-annotations:start -->";
  const end = "<!-- bookorbit-annotations:end -->";
  const chunks = [start, "", "# " + mdText(book.title.replace(/\s+/g, " ")), ""];
  for (const mark of view.marks()) {
    const where = mark.chapterTitle || (mark.pdf ? "第 " + (mark.pdf.page + 1) + " 页" : "");
    if (where) chunks.push("### " + mdText(where.replace(/\s+/g, " ")), "");
    chunks.push(...mdText(mark.text).split(/\r?\n/).map(line => "> " + line), "");
    if (mark.note) chunks.push(mdText(mark.note), "");
  }
  chunks.push(end);
  const body = chunks.join("\n");
  let note = vault.getAbstractFileByPath(path);
  if (!note) note = await vault.create(path, body + "\n");
  else {
    if (!(note instanceof TFile)) throw new Error("标注笔记的位置已被文件夹占用。");
    await vault.process(note, original => {
      const from = original.indexOf(start);
      const to = original.indexOf(end);
      if (from < 0 || to < from || original.lastIndexOf(start) !== from || original.lastIndexOf(end) !== to) {
        throw new Error("已有同名笔记。请移动它后再导出标注。");
      }
      return original.slice(0, from) + body + original.slice(to + end.length);
    });
  }
  await plugin.app.workspace.getLeaf("tab").openFile(note);
}

class ReaderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.closed = false;
    this.magnification = 1;
    this.flow = "scrolled";
    this.side = "marks";
    this.contents = [];
  }

  getViewType() { return READER; }
  getDisplayText() { return this.book?.title || "BookOrbit 阅读"; }
  getIcon() { return "book-open"; }
  getState() { return { id: this.book?.id ?? this.requestedId, flow: this.flow, zoom: this.magnification }; }

  async setState(state, result) {
    await super.setState(state, result);
    this.requestedId = state?.id;
    this.flow = state?.flow === "paginated" ? "paginated" : "scrolled";
    this.magnification = Number.isFinite(state?.zoom) ? Math.max(0.6, Math.min(2, state.zoom)) : 1;
    if (this.root && !this.book) void this.load(this.requestedId);
  }

  async onOpen() {
    this.contentEl.empty();
    this.addAction("library", "打开 BookOrbit 书架", () => this.plugin.runOpen());
    this.addAction("panel-right", "目录与标注", () => this.openPanel());
    this.addAction("sliders-horizontal", "阅读设置", event => this.optionsMenu(event));
    this.root = this.contentEl.createDiv({ cls: "bor-reader" });
    this.stage = this.root.createDiv({ cls: "bor-reader-stage" });
    this.pageArea = this.stage.createDiv({ cls: "bor-reader-page", attr: { "aria-label": "书籍正文" } });
    this.pageArea.tabIndex = 0;
    this.pageArea.addEventListener("keydown", event => this.handleArrow(event));
    this.markButton = button(this.stage, "添加标注", "highlighter", () => this.editSelection());
    this.markButton.classList.add("bor-selection-action");
    this.markButton.hidden = true;
    this.markButton.addEventListener("pointerdown", event => event.preventDefault());
    const foot = this.root.createDiv({ cls: "bor-reader-foot" });
    this.previous = iconButton(foot, "上一页", "chevron-left", () => this.move(-1));
    this.location = foot.createSpan({ cls: "bor-reader-location", attr: { role: "status" } });
    this.next = iconButton(foot, "下一页", "chevron-right", () => this.move(1));
    this.previous.disabled = this.next.disabled = true;
    if (this.requestedId) void this.load(this.requestedId);
  }

  optionsMenu(event) {
    const menu = new Menu();
    if (this.engine && this.format === "epub" && !this.engine.element?.isFixedLayout) {
      for (const [flow, label] of [["scrolled", "连续滚动"], ["paginated", "分页阅读"]]) {
        menu.addItem(item => item.setTitle(label).setIcon(flow === "scrolled" ? "scroll-text" : "book-open")
          .setChecked(this.flow === flow).onClick(() => this.changeFlow(flow)));
      }
      menu.addSeparator();
    }
    menu.addItem(item => item.setTitle("放大").setIcon("plus").setDisabled(!this.engine).onClick(() => this.zoom(1)));
    menu.addItem(item => item.setTitle("缩小").setIcon("minus").setDisabled(!this.engine).onClick(() => this.zoom(-1)));
    menu.addItem(item => item.setTitle("恢复默认").setIcon("rotate-ccw").setDisabled(!this.engine).onClick(() => this.zoom(0)));
    menu.addSeparator();
    menu.addItem(item => item.setTitle("目录与标注").setIcon("panel-right").onClick(() => this.openPanel()));
    if (this.progressRecord) menu.addItem(item => item.setTitle("同步阅读进度").setIcon("refresh-cw")
      .setDisabled(!this.api?.readProgress || !this.engine || this.syncingProgress)
      .onClick(() => this.syncProgress(true)));
    if (this.onlineUrl) menu.addItem(item => item.setTitle("在 BookOrbit 网页打开").setIcon("external-link")
      .onClick(() => this.root.ownerDocument.defaultView.open(this.onlineUrl, "_blank", "noopener,noreferrer")));
    if (event.clientX || event.clientY) menu.showAtMouseEvent(event);
    else {
      const rect = event.currentTarget?.getBoundingClientRect();
      menu.showAtPosition({ x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
    }
  }

  changeFlow(flow) {
    if (this.flow === flow || this.format !== "epub") return;
    const anchor = this.state?.positions[this.slot];
    this.selectionChanged(null);
    this.flow = flow;
    this.engine?.setFlow(flow);
    if (anchor && this.engine) void this.restoreProgress(anchor).catch(error => this.fail(error));
    this.plugin.app.workspace.requestSaveLayout?.();
  }

  openPanel(side) { return this.plugin.openReadingPanel(this, side); }

  async load(id) {
    if (this.loading || this.closed || !Number.isSafeInteger(id)) return;
    this.loading = true;
    try {
      const { plugin } = this;
      this.settings = plugin.settings;
      const local = plugin.local.get(id);
      const entry = plugin.snapshot?.books.find(book => book.id === id);
      const book = entry || (local && { id, title: local.title, file: null });
      if (!book) throw new Error("找不到此书。请先回到书架同步书库。");
      this.book = book;
      this.leaf.updateHeader?.();
      this.api = plugin.api;
      this.format = local?.format || book.file?.extension;
      const alternatives = (book.editions || []).filter(file => file.extension === this.format);
      const linkedFile = book.file?.extension === this.format ? book.file.id : alternatives.length === 1 ? alternatives[0].id : null;
      if (this.api && entry) this.annotationApi = this.api;
      this.fileId = linkedFile;
      this.state = plugin.reading.book(this.settings, id);
      const slot = linkedFile || this.format || "unknown";
      this.slot = String(slot);
      if (linkedFile && (!local || alternatives.length <= 1)) {
        const records = this.state.progress ??= {};
        this.progressRecord = records[this.slot] ??= {};
      }
      if (this.settings.endpoint && entry) {
        const web = this.settings.endpoint.replace(/\/api\/v1$/, "");
        this.onlineUrl = linkedFile ? `${web}/read/${id}/${linkedFile}` : `${web}/book/${id}`;
      }
      this.pageArea.setText("正在打开书籍…");
      this.renderSide();
      if (this.annotationApi) void this.sync(false);
      if (!["epub", "pdf"].includes(this.format)) throw new Error("集成阅读器支持 EPUB 与 PDF。可从侧栏打开 BookOrbit 网页。");
      const progress = this.resumeProgress();
      const bytes = local
        ? await plugin.app.vault.adapter.readBinary(local.path)
        : await plugin.connected().readBook(book);
      await progress;
      if (this.closed) return;
      this.pageArea.empty();
      this.engine = this.format === "epub" ? new EpubReader(this) : new PdfReader(this);
      await this.engine.open(bytes, this.state.positions[this.slot]);
      if (this.closed) return;
      this.progressReady = true;
      if (this.progressRecord?.pending) this.scheduleProgress();
      this.previous.disabled = this.next.disabled = false;
      this.renderSide();
    } catch (error) {
      if (this.closed) return;
      this.pageArea.empty();
      this.pageArea.createEl("p", { text: error.message, cls: "bor-reader-empty" });
    } finally {
      this.loading = false;
    }
  }

  async onClose() {
    this.closed = true;
    this.engine?.close();
    this.plugin.readerClosed?.(this);
    if (this.positionTimer) {
      clearTimeout(this.positionTimer);
      await this.persist().catch(error => new Notice(error.message, 8500));
    }
    this.scheduleProgress();
  }

  marks() {
    const rows = [...(this.state?.pending || []), ...(this.state?.remote || [])];
    const seen = new Set();
    return rows.filter(mark => {
      const key = markKey(mark);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  canLocate(mark) {
    if (this.format === "pdf") return !!mark.pdf && (mark.fileId === this.fileId || mark.id.startsWith?.("local:") && mark.fileId == null);
    if (!mark.cfi) return false;
    return mark.id.startsWith?.("local:") ? mark.fileId === this.fileId
      : !!this.fileId && (mark.fileId == null || mark.fileId === this.fileId);
  }

  setContents(items) { this.contents = items; this.renderSide(); }

  setLocation(label, position, percentage, moved = true) {
    if (this.location.textContent !== label) this.location.textContent = label;
    if (position == null || this.closed) return;
    const previous = this.viewPosition;
    this.viewPosition = position;
    this.viewPercentage = percentage;
    if (samePosition(previous, position)) return;
    const pageMoved = this.format !== "pdf" || position.page !== previous?.page;
    const queued = this.progressReady && !this.positionRestores && moved && pageMoved && this.queueProgress();
    if (queued) this.scheduleProgress();
    if (!queued && samePosition(this.state.positions[this.slot], position)) return;
    this.state.positions[this.slot] = position;
    clearTimeout(this.positionTimer);
    this.positionTimer = setTimeout(() => {
      this.positionTimer = null;
      void this.persist().catch(error => this.fail(error));
    }, 650);
  }

  queueProgress() {
    const position = this.viewPosition;
    if (!this.progressRecord || !Number.isFinite(this.viewPercentage)) return false;
    const valid = this.format === "pdf" ? Number.isSafeInteger(position?.page) && position.page > 0
      : typeof position === "string" && position.startsWith("epubcfi(") && position.length <= 2000;
    if (!valid) return false;
    this.progressRecord.pending = {
      position, percentage: Math.max(0, Math.min(100, this.viewPercentage)), editedAt: Date.now(),
    };
    return true;
  }

  scheduleProgress(delay = PROGRESS_BATCH_MS) {
    const api = this.api;
    if (this.progressTimer != null || !this.progressRecord?.pending || !api?.readProgress || api.signal?.aborted || this.progressWriteDenied) return;
    const wait = Math.max(delay, automaticProgressAt(api) - Date.now());
    const cancel = () => {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    };
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      api.signal?.removeEventListener("abort", cancel);
      if (!api.signal?.aborted) void this.syncProgress();
    }, Math.min(wait, 2_147_483_647));
    api.signal?.addEventListener("abort", cancel, { once: true });
  }

  async resumeProgress() {
    if (!this.progressRecord || !this.api?.readProgress) return;
    const deadline = AbortSignal.timeout(2200);
    const expiry = new Promise(resolve => deadline.addEventListener("abort", resolve, { once: true }));
    await Promise.race([expiry, this.exchangeProgress({ resume: true, signal: deadline }).catch(() => {})]);
  }

  async restoreProgress(position) {
    this.positionRestores = (this.positionRestores || 0) + 1;
    try {
      if (this.format === "pdf") await this.engine.goTo(position.page, { offset: position.offset });
      else await this.engine.goToPosition(position);
    } finally {
      this.positionRestores--;
    }
  }

  async syncProgress(manual = false) {
    if (!this.progressRecord || !this.api?.readProgress) return;
    if (this.syncingProgress) { this.resyncProgress = true; return; }
    this.syncingProgress = true;
    try {
      const before = this.viewPosition;
      const position = await this.exchangeProgress({ manual, signal: AbortSignal.timeout(8000) });
      if (manual && !this.closed && this.engine && samePosition(before, this.viewPosition)) {
        if (position && !samePosition(position, this.viewPosition)) await this.restoreProgress(position);
        new Notice("阅读进度已同步。");
      }
    } catch (error) {
      if (error.status === 403 && this.progressRecord.pending) {
        if (!this.progressWriteDenied || manual) {
          if (!this.closed) new Notice("阅读进度已留在本地。请检查 BookOrbit 账号或 API Key 的读写权限。");
        }
        this.progressWriteDenied = true;
      } else {
        if (error.status === 429) this.scheduleProgress(0);
        if (manual && !this.closed) new Notice("无法同步阅读进度。 " + error.message);
      }
    } finally {
      this.syncingProgress = false;
      if (this.resyncProgress) {
        this.resyncProgress = false;
        this.scheduleProgress();
      }
    }
  }

  async exchangeProgress({ resume = false, manual = false, signal }) {
    const record = this.progressRecord;
    if (!resume && !manual && (!record.pending || this.progressWriteDenied)) return null;
    const remember = async (position, pending) => {
      if (!pending && samePosition(this.state.positions[this.slot], position)) return position;
      if (pending) delete record.pending;
      this.state.positions[this.slot] = position;
      await this.persist();
      return position;
    };
    const queued = (progressOperations.get(record) ?? Promise.resolve()).catch(() => {}).then(async () => {
      signal.throwIfAborted();
      const automatic = !resume && !manual;
      if (automatic) {
        if (!record.pending || this.progressWriteDenied || this.api.signal?.aborted) return null;
        const now = Date.now();
        if (now < automaticProgressAt(this.api)) {
          this.scheduleProgress(0);
          return null;
        }
        nextAutomaticProgress.set(this.api, now + PROGRESS_INTERVAL_MS);
      }
      let pending = record.pending;
      const previousWrite = progressWrites.get(record);
      let clockOffset;
      if (automatic && this.api.progressProtocol === "modern") {
        // The new endpoint compares editedAt and returns the newer position on conflict.
        clockOffset = Math.max(this.api.progressClockSkew ?? 0, (previousWrite?.updatedAt ?? 0) - pending.editedAt);
      } else {
        const remote = await this.api.readProgress(this.fileId, signal);
        signal.throwIfAborted();
        const position = cloudPosition(remote, this.format, this.state.positions[this.slot]);
        pending = record.pending;
        const ownUpdate = previousWrite && (!previousWrite.updatedAt || remote.updatedAt === previousWrite.updatedAt)
          && (this.format === "pdf" ? remote.page === previousWrite.position.page : remote.cfi === previousWrite.position);
        clockOffset = pending && ownUpdate ? Math.max(remote.clockOffset, remote.updatedAt - pending.editedAt) : remote.clockOffset;
        if (position && (!pending || remote.updatedAt > pending.editedAt + clockOffset)) return remember(position, pending);
        if (resume) return null;
        if (!pending && manual && this.queueProgress()) pending = record.pending;
      }
      if (!pending) return null;
      await this.persist();
      signal.throwIfAborted();
      const result = await this.api.writeProgress(this.fileId, this.format, pending, clockOffset, signal);
      this.progressWriteDenied = false;
      if (result.status === "saved") {
        progressWrites.set(record, { updatedAt: result.progress?.updatedAt, position: pending.position });
      }
      if (record.pending !== pending) return null;
      delete record.pending;
      const newer = result.status === "superseded" && cloudPosition(result.progress, this.format, this.state.positions[this.slot]);
      if (newer) this.state.positions[this.slot] = newer;
      await this.persist();
      return newer || null;
    });
    progressOperations.set(record, queued);
    try { return await queued; }
    finally { if (progressOperations.get(record) === queued) progressOperations.delete(record); }
  }

  async persist() {
    if (this.plugin.readingError) throw new Error(this.plugin.readingError);
    return this.plugin.reading.save();
  }

  handleArrow(event) {
    if (!this.engine || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target?.closest?.("button, input, textarea, select")) return;
    if (this.format === "epub" && (event.key === "PageUp" || event.key === "PageDown")) {
      event.preventDefault();
      this.move(event.key === "PageUp" ? -1 : 1);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const rtl = this.engine.element?.book?.dir === "rtl";
    this.move((event.key === "ArrowLeft" ? -1 : 1) * (rtl ? -1 : 1));
  }

  move(delta) { if (this.engine) void this.engine.move(delta).catch(error => this.fail(error)); }
  zoom(delta) {
    if (!this.engine) return;
    this.magnification = delta === 0 ? 1 : Math.max(0.6, Math.min(2, Math.round((this.magnification + delta * .1) * 100) / 100));
    this.selectionChanged(null);
    this.engine.updateAppearance();
    this.plugin.app.workspace.requestSaveLayout?.();
  }

  updateTheme() {
    if (!this.closed && this.format === "epub") this.engine?.updateAppearance();
  }

  onResize() { this.hideSelectionControl(); }

  hideSelectionControl() { if (this.markButton) this.markButton.hidden = true; }

  selectionChanged(selection, point) {
    this.selected = selection;
    this.hideSelectionControl();
    if (!selection || !point || this.closed) return;
    const rect = this.stage.getBoundingClientRect();
    if (point.y < rect.top || point.y > rect.bottom || point.x < rect.left - 3 || point.x > rect.right + 3) return;
    this.markButton.hidden = false;
    const width = this.markButton.offsetWidth;
    const height = this.markButton.offsetHeight;
    const x = Math.min(rect.width - width - 6, Math.max(6, point.x - rect.left - width / 2));
    const y = Math.min(rect.height - height - 6, Math.max(6, point.y - rect.top + 7));
    this.markButton.style.left = Math.max(0, x) + "px";
    this.markButton.style.top = Math.max(0, y) + "px";
  }

  selectionMenu(event, document) {
    if (!this.selected) return;
    event.preventDefault();
    this.hideSelectionControl();
    const frame = document.defaultView.frameElement?.getBoundingClientRect();
    const menu = new Menu();
    menu.addItem(item => item.setTitle("添加标注").setIcon("highlighter").onClick(() => this.editSelection()));
    menu.showAtPosition({ x: event.clientX + (frame?.left ?? 0), y: event.clientY + (frame?.top ?? 0) });
  }

  editSelection() {
    if (!this.selected || !this.state) return;
    new MarkModal(this.plugin.app, this.selected, async selected => {
      const mark = { ...selected, id: "local:" + randomUUID(), fileId: this.fileId, origin: "local", date: new Date().toISOString() };
      if (this.marks().some(row => markKey(row) === markKey(mark))) return;
      this.state.pending.unshift(mark);
      try { await this.persist(); }
      catch (error) {
        this.state.pending = this.state.pending.filter(row => row.id !== mark.id);
        throw error;
      }
      this.selectionChanged(null);
      this.updateMarks();
      await this.openPanel("marks");
    }).open();
  }

  sync(upload) {
    if (!this.annotationApi || this.annotationsBusy || this.closed) return;
    if (this.settings !== this.plugin.settings) {
      this.syncMessage = "BookOrbit 连接已更改，请重新打开这本书后同步。";
      this.renderSide();
      return;
    }
    return this.syncMarks(upload);
  }

  get annotationsBusy() { return annotationOperations.has(this.state); }

  annotationRoute() { return `/books/${this.book.id}/annotations`; }

  async fetchRemoteMarks() {
    const rows = await this.annotationApi.json(this.annotationRoute() + (this.fileId ? "?readerFileId=" + this.fileId : ""));
    if (!Array.isArray(rows)) throw new Error("BookOrbit 返回了无法识别的标注列表。");
    return rows.map(remoteMark);
  }

  async syncMarks(upload) {
    this.syncing = true;
    annotationOperations.add(this.state);
    this.renderSide();
    let uploaded = 0;
    try {
      const route = this.annotationRoute();
      const remoteRows = await this.fetchRemoteMarks();
      const previous = new Map(this.marks().filter(mark => mark.quote).map(mark => [markKey(mark), mark.quote]));
      const remote = remoteRows.map(mark => {
        const quote = previous.get(markKey(mark));
        return quote ? { ...mark, quote } : mark;
      });
      if (this.closed) return;
      this.state.remote = remote;
      const duplicates = new Set(remote.map(markKey));
      this.state.pending = this.state.pending.filter(mark => !duplicates.has(markKey(mark)));
      await this.persist();
      if (upload) {
        for (const mark of [...this.state.pending]) {
          if (this.closed || this.settings !== this.plugin.settings) return;
          if (!this.fileId || mark.fileId !== this.fileId || (!mark.pdf && !mark.cfi)) continue;
          const { text, note, color, style, chapterTitle } = mark;
          const position = mark.pdf ? { pdf: mark.pdf } : { cfi: mark.cfi };
          const result = remoteMark(await this.annotationApi.json(route, {
            ...position, bookFileId: this.fileId, text, color, style, note, chapterTitle: chapterTitle?.slice(0, 500) || null,
          }));
          if (mark.quote) result.quote = mark.quote;
          this.state.remote.unshift(result);
          this.state.pending = this.state.pending.filter(row => row.id !== mark.id);
          await this.persist();
          uploaded++;
        }
      }
      this.syncMessage = upload ? `已上传 ${uploaded} 条标注` : "";
    } catch (error) {
      this.syncMessage = upload && error.status === 403
        ? "上传需要可写 API Key 或账号登录。本地标注已保留。"
        : "BookOrbit 标注同步失败。 " + error.message;
    } finally {
      annotationOperations.delete(this.state);
      this.syncing = false;
      this.updateMarks();
    }
  }

  confirmDeleteMark(mark) {
    if (this.closed || !this.state || this.annotationsBusy) return;
    new DeleteMarkModal(this.plugin.app, mark, () => this.deleteMark(mark.id)).open();
  }

  async deleteMark(id) {
    if (this.closed || !this.state) throw new Error("请重新打开这本书再删除标注。");
    if (this.annotationsBusy) throw new Error("这本书正在同步标注，请稍后再试。");
    annotationOperations.add(this.state);
    this.deleting = true;
    this.syncMessage = "";
    this.renderSide();
    try {
      if (typeof id === "string") await this.deleteLocalMark(id);
      else await this.deleteCloudMark(id);
    } finally {
      annotationOperations.delete(this.state);
      this.deleting = false;
      this.updateMarks();
    }
  }

  async deleteLocalMark(id) {
    const pending = this.state.pending;
    const index = pending.findIndex(mark => mark.id === id);
    if (index < 0) return;
    const [mark] = pending.splice(index, 1);
    try {
      await this.persist();
    } catch (error) {
      this.state.pending.splice(index, 0, mark);
      throw error;
    }
    this.syncMessage = "已删除本地标注。";
  }

  async deleteCloudMark(id) {
    if (!this.state.remote.some(mark => mark.id === id)) return;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("无法识别这条云端标注。");
    if (!this.annotationApi || this.settings !== this.plugin.settings) throw new Error("请连接 BookOrbit 后重新打开这本书。");
    try {
      const response = await this.annotationApi.request(this.annotationRoute() + "/" + id, { method: "DELETE" });
      if (response.status !== 204) throw new Error("BookOrbit 未确认删除标注，请重新读取云端标注。");
    } catch (error) {
      if (error.status === 403) throw new Error("当前连接无权删除云端标注。请使用可写 API Key 或账号登录。");
      if (error.status !== 404 || (await this.fetchRemoteMarks()).some(mark => mark.id === id)) throw error;
    }
    this.state.remote = this.state.remote.filter(mark => mark.id !== id);
    try {
      await this.persist();
      this.syncMessage = "已从阅读器移除云端标注。";
    } catch {
      this.syncMessage = "BookOrbit 已移除标注，本地缓存保存失败。";
    }
  }

  updateMarks() {
    if (this.plugin.refreshReaderMarks) this.plugin.refreshReaderMarks(this);
    else if (!this.closed) {
      this.engine?.refreshMarks();
      this.renderSide();
    }
  }

  jump(mark) {
    if (!this.engine || !this.canLocate(mark)) return;
    const target = mark.pdf ? mark.pdf.page + 1 : mark.cfi;
    void this.engine.goTo(target, mark.pdf ? { rect: mark.pdf.rect } : undefined).catch(error => this.fail(error));
  }

  renderSide() {
    if (!this.closed) this.plugin.renderReadingPanel?.(this);
  }

  fail(error) {
    if (!this.closed) new Notice(error.message, 8500);
  }
}

class ReadingPanel extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() { return READER_PANEL; }
  getDisplayText() { return "BookOrbit 目录与标注"; }
  getIcon() { return "list-tree"; }

  async onOpen() {
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "bor-reader-side" });
    this.title = this.root.createEl("h3", { cls: "bor-panel-title" });
    this.tabs = this.root.createDiv({ cls: "bor-panel-tabs", attr: { role: "group", "aria-label": "阅读侧栏" } });
    this.markTab = this.tabs.createEl("button", { text: "标注", attr: { type: "button" } });
    this.tocTab = this.tabs.createEl("button", { text: "目录", attr: { type: "button" } });
    this.markTab.addEventListener("click", () => this.select("marks"));
    this.tocTab.addEventListener("click", () => this.select("toc"));
    this.tools = this.root.createDiv({ cls: "bor-mark-tools" });
    this.pull = iconButton(this.tools, "读取云端标注", "refresh-cw", () => this.reader?.sync(false));
    this.push = iconButton(this.tools, "上传待同步标注", "upload", () => this.reader?.sync(true));
    this.export = iconButton(this.tools, "导出笔记", "file-text", () => this.exportNotes(false));
    this.annotator = iconButton(this.tools, "导出 Annotator", "file-down", () => this.exportNotes(true));
    this.message = this.root.createEl("p", { cls: "bor-panel-status", attr: { role: "status" } });
    this.list = this.root.createDiv({ cls: "bor-mark-list" });
    this.render(this.plugin.panelReader);
  }

  select(tab) {
    if (!this.reader) return;
    this.reader.side = tab;
    this.render(this.reader, true);
  }

  exportNotes(annotator) {
    if (this.reader) {
      const reader = this.reader;
      void exportMarks(reader, annotator).catch(error => reader.fail(error));
    }
  }

  render(reader, resetScroll = false) {
    if (!this.root) return;
    if (reader?.closed) reader = null;
    const scroll = !resetScroll && this.reader === reader ? this.list.scrollTop : 0;
    this.reader = reader;
    this.title.textContent = reader?.book?.title || "目录与标注";
    this.tabs.hidden = !reader;
    this.tools.hidden = !reader || reader.side !== "marks";
    this.list.empty();
    if (!reader) {
      this.message.hidden = true;
      this.list.createEl("p", { cls: "bor-panel-muted", text: "打开一本书后，这里会显示目录和标注。" });
      return;
    }
    const showing = reader.side === "marks";
    this.markTab.setAttribute("aria-pressed", String(showing));
    this.tocTab.setAttribute("aria-pressed", String(!showing));
    this.pull.disabled = reader.annotationsBusy || !reader.annotationApi;
    this.push.disabled = this.pull.disabled || !reader.fileId || !reader.state?.pending.some(mark => mark.fileId === reader.fileId);
    const marks = reader.marks();
    this.export.disabled = !marks.length;
    this.annotator.disabled = !reader.book || !this.plugin.local.has(reader.book.id) || !marks.some(mark => reader.canLocate(mark));
    const progress = reader.deleting ? "正在删除标注…" : reader.syncing ? "正在同步标注…" : reader.syncMessage || "";
    this.message.textContent = showing ? progress : "";
    this.message.hidden = !this.message.textContent;
    if (showing) this.renderMarks(reader, marks);
    else if (reader.contents.length) this.renderContents(reader, reader.contents, this.list);
    else this.list.createEl("p", { text: "这本书没有可显示的目录。", cls: "bor-panel-muted" });
    this.list.scrollTop = scroll;
  }

  renderContents(reader, items, parent) {
    for (const item of items) {
      const node = parent.createDiv({ cls: "tree-item bor-toc-item" });
      if (item.href) {
        const row = node.createEl("button", { cls: "tree-item-self is-clickable bor-toc-button",
          text: item.label, attr: { type: "button" } });
        row.addEventListener("click", () => { void reader.engine?.goTo(item.href).catch(error => reader.fail(error)); });
      } else if (item.label) node.createDiv({ cls: "tree-item-self", text: item.label });
      if (item.subitems?.length) this.renderContents(reader, item.subitems, node.createDiv({ cls: "tree-item-children" }));
    }
  }

  renderMarks(reader, marks) {
    if (!marks.length) this.list.createEl("p", { text: "在正文里选中文字即可添加标注。", cls: "bor-panel-muted" });
    for (const mark of marks) {
      const card = this.list.createEl("article", { cls: "bor-mark-card" });
      card.style.setProperty("--bor-mark-color", color(mark.color));
      const meta = card.createDiv({ cls: "bor-mark-meta" });
      const source = mark.origin === "local" ? "待上传" : ({ web: "BookOrbit", koreader: "KOReader", kobo: "Kobo" }[mark.origin] || "BookOrbit");
      const label = mark.chapterTitle || (mark.pdf ? "第 " + (mark.pdf.page + 1) + " 页" : "");
      meta.createSpan({ text: [source, label].filter(Boolean).join(" · ") });
      const actions = meta.createDiv({ cls: "bor-mark-actions" });
      if (reader.engine && reader.canLocate(mark)) iconButton(actions, "定位到原文", "locate-fixed", () => reader.jump(mark));
      const remove = iconButton(actions, "删除标注", "trash-2", () => reader.confirmDeleteMark(mark));
      remove.disabled = reader.annotationsBusy;
      card.createEl("blockquote", { text: mark.text });
      if (mark.note) card.createEl("p", { cls: "bor-mark-note", text: mark.note });
    }
  }

}

module.exports = { READER, READER_PANEL, ReaderView, ReadingPanel, ReadingStore };
