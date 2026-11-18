import "./foliate/view.js";
import { EPUB } from "./foliate/epub.js";
export { Overlayer } from "./foliate/overlayer.js";
import { BlobReader, BlobWriter, TextWriter, ZipReader } from "@zip.js/zip.js";
export { getDocument, TextLayer } from "pdfjs-dist/build/pdf.mjs";

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
