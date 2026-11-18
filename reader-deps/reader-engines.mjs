import "../vendor/foliate/view.js";
import { EPUB } from "../vendor/foliate/epub.js";
export { Overlayer } from "../vendor/foliate/overlayer.js";
import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";
import { getDocument } from "pdfjs-dist/build/pdf.mjs";
import { cMaps, standardFonts } from "bookorbit:pdf-assets";
export { TextLayer } from "pdfjs-dist/build/pdf.mjs";

function readPdfAsset(assets, name) {
  if (!Object.hasOwn(assets, name)) throw new Error("缺少 PDF 内置资源：" + name);
  return Uint8Array.from(atob(assets[name]), character => character.charCodeAt(0));
}

class CMapReaderFactory {
  async fetch({ name }) {
    return {
      cMapData: readPdfAsset(cMaps, name + ".bcmap"),
      compressionType: 1,
      isCompressed: true,
    };
  }
}

class StandardFontDataFactory {
  async fetch({ filename }) {
    return readPdfAsset(standardFonts, filename);
  }
}

export function openPdf(bytes) {
  return getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    useWasm: false,
    isEvalSupported: false,
    enableXfa: false,
    CMapReaderFactory,
    StandardFontDataFactory,
  });
}

export async function openEpub(bytes) {
  const archive = new ZipReader(new BlobReader(new Blob([bytes])), { useWebWorkers: false });
  try {
    const entries = new Map((await archive.getEntries()).filter(entry => !entry.directory).map(entry => [entry.filename, entry]));
    function load(name, writer) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.uncompressedSize > 64 * 1024 * 1024) throw new Error("这本 EPUB 包含无法加载的超大资源。");
      return entry.getData(writer, { useWebWorkers: false });
    }
    const book = await new EPUB({
      loadText: name => load(name, new TextWriter()),
      loadBlob: (name, type) => load(name, new BlobWriter(type)),
      getSize: name => entries.get(name)?.uncompressedSize ?? 0,
    }).init();
    return { book, archive };
  } catch (error) {
    await archive.close();
    throw error;
  }
}
