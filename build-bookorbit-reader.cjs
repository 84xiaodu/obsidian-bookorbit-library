const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("esbuild");
const source = path.join(__dirname, "bookorbit-reading");
const modules = path.join(__dirname, "node_modules");
const pdf = path.join(modules, "pdfjs-dist");
const foliate = path.join(__dirname, "vendor", "foliate");

async function encodePdfAssets(folder, pattern) {
  const directory = path.join(pdf, folder);
  const files = (await fs.readdir(directory)).filter(name => pattern.test(name)).sort();
  if (!files.length) throw new Error("Missing PDF assets in " + folder);
  const entries = await Promise.all(files.map(async name => [
    name, (await fs.readFile(path.join(directory, name))).toString("base64"),
  ]));
  return Object.fromEntries(entries);
}

const pdfAssets = {
  name: "embedded-pdf-assets",
  setup(build) {
    build.onResolve({ filter: /^bookorbit:pdf-assets$/ }, args => ({
      path: args.path,
      namespace: "bookorbit-pdf-assets",
    }));
    build.onLoad({ filter: /.*/, namespace: "bookorbit-pdf-assets" }, async () => {
      const [cMaps, standardFonts] = await Promise.all([
        encodePdfAssets("cmaps", /\.bcmap$/),
        encodePdfAssets("standard_fonts", /\.(?:pfb|ttf)$/),
      ]);
      return {
        contents: `export const cMaps = ${JSON.stringify(cMaps)};\nexport const standardFonts = ${JSON.stringify(standardFonts)};`,
        loader: "js",
      };
    });
  },
};

const enginePatches = {
  name: "isolated-book-rendering",
  setup(build) {
    build.onLoad({ filter: /[\\/]foliate[\\/].+\.js$/ }, async ({ path: filename }) => {
      let contents = await fs.readFile(filename, "utf8");
      if (path.basename(filename) === "view.js") {
        const start = contents.indexOf("const isZip =");
        const stop = contents.indexOf("class CursorAutohider");
        if (start < 0 || stop <= start) throw new Error("Foliate source changed");
        contents = contents.slice(0, start) + contents.slice(stop);
        contents = contents.replace("|| book.isDirectory) book = await makeBook(book)", "|| book.isDirectory) throw new Error('Expected an EPUB book')");
        contents = contents.replace("{ ...progress, tocItem, pageItem, cfi, range }", "{ ...progress, tocItem, pageItem, cfi, range, reason }");
      }
      if (path.basename(filename) === "epub.js") {
        const marker = "const result = new XMLSerializer().serializeToString(doc)";
        if (!contents.includes(marker)) throw new Error("Foliate serializer changed");
        contents = contents.replace(marker, `
          const head = doc.querySelector('head')
          if (head) {
            for (const meta of head.querySelectorAll('meta[http-equiv]')) meta.remove()
            const policy = doc.createElementNS(head.namespaceURI, 'meta')
            policy.setAttribute('http-equiv', 'Content-Security-Policy')
            policy.setAttribute('content', "default-src 'none'; img-src blob: data:; font-src blob: data:; media-src blob: data:; style-src 'unsafe-inline' blob:; base-uri 'none'; form-action 'none'")
            head.prepend(policy)
          }
          ${marker}`);
      }
      contents = contents.replaceAll("allow-same-origin allow-scripts", "allow-same-origin")
        .replace(/foliate-(view|fxl|paginator)/g, "bor-epub-$1")
        .replace(/customElements.define\(('bor-epub-[^']+'),/, "if (!customElements.get($1)) customElements.define($1,");
      return { contents, loader: "js" };
    });
    build.onLoad({ filter: /[\\/]pdfjs-dist[\\/]build[\\/]pdf\.mjs$/ }, async ({ path: filename }) => {
      let contents = await fs.readFile(filename, "utf8");
      const lookup = "return globalThis.pdfjsWorker?.WorkerMessageHandler || null;";
      if (!contents.includes(lookup)) throw new Error("PDF.js worker initialization changed");
      contents = "import { WorkerMessageHandler as localPdfWorker } from './pdf.worker.min.mjs';\n"
        + contents.replace(lookup, "return localPdfWorker;");
      return { contents, loader: "js" };
    });
  },
};

async function main() {
  const licenses = [
    ["BookOrbit Library", path.join(__dirname, "LICENSE")],
    ["Foliate.js", path.join(foliate, "LICENSE")],
    ["PDF.js", path.join(pdf, "LICENSE")],
    ["PDF CMaps", path.join(pdf, "cmaps", "LICENSE")],
    ["Foxit fonts", path.join(pdf, "standard_fonts", "LICENSE_FOXIT")],
    ["Liberation Sans fonts", path.join(pdf, "standard_fonts", "LICENSE_LIBERATION")],
    ["zip.js", path.join(modules, "@zip.js", "zip.js", "LICENSE")],
  ];
  const notices = await Promise.all(licenses.map(async ([name, file]) => {
    const license = (await fs.readFile(file, "utf8")).replaceAll("\r\n", "\n").replaceAll("*/", "* /").trimEnd();
    return `/*! ${name}\n${license}\n*/`;
  }));
  await esbuild.build({
    absWorkingDir: __dirname,
    entryPoints: [path.join(source, "main.js")],
    outfile: path.join(__dirname, "main.js"),
    format: "cjs",
    bundle: true,
    platform: "browser",
    target: "chrome139",
    external: ["obsidian", "http", "https", "crypto", "fs", "path"],
    banner: { js: notices.join("\n") },
    legalComments: "inline",
    plugins: [enginePatches, pdfAssets],
  });
  await fs.copyFile(path.join(source, "styles.css"), path.join(__dirname, "styles.css"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
