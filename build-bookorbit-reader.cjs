const fs = require("node:fs/promises");
const path = require("node:path");
const esbuild = require("./reader-deps/node_modules/esbuild");
const source = path.join(__dirname, "bookorbit-reading");
const deps = path.join(__dirname, "reader-deps");
const pdf = path.join(deps, "node_modules", "pdfjs-dist");

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
  const { version } = JSON.parse(await fs.readFile(path.join(source, "manifest.json"), "utf8"));
  const buildDir = path.join(__dirname, "release-" + version, "bookorbit-library");
  const runtime = path.join(buildDir, "runtime");
  await fs.mkdir(runtime, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(source, "main.js")],
    outfile: path.join(buildDir, "main.js"),
    format: "cjs",
    bundle: true,
    platform: "browser",
    target: "chrome139",
    external: ["obsidian", "http", "https", "crypto", "fs", "path"],
    legalComments: "inline",
    plugins: [enginePatches],
  });
  for (const file of ["manifest.json", "styles.css", "README.md"]) {
    await fs.copyFile(path.join(source, file), path.join(buildDir, file));
  }
  for (const folder of ["cmaps", "standard_fonts"]) {
    await fs.cp(path.join(pdf, folder), path.join(runtime, folder), { recursive: true });
  }
  await fs.copyFile(path.join(pdf, "LICENSE"), path.join(runtime, "PDF.js-LICENSE.txt"));
  await fs.copyFile(path.join(deps, "foliate", "LICENSE"), path.join(runtime, "Foliate-LICENSE.txt"));
  await fs.copyFile(path.join(deps, "node_modules", "@zip.js", "zip.js", "LICENSE"), path.join(runtime, "zip.js-LICENSE.txt"));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
