#!/usr/bin/env node
/**
 * Convert PDF to CMYK (lossless images) and force black/gray to pure K.
 * Requires Ghostscript (`gs`) on PATH and `npm install` in this folder (pdf-lib).
 *
 * Usage (from code/scripts):
 *   node preprint.mjs <input.pdf> [output.pdf]
 *
 * If output is omitted, writes `<input>-CMYK.pdf` next to the input.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from "pdf-lib";

const NEUTRAL_EPS = 0.03;
const BLACK_LUMA = 0.12;

const CMYK_OP =
  /(?<c>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<m>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<y>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<k>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<op>[kK])\b/g;
const GRAY_OP = /(?<g>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<op>[gG])\b/g;
const RGB_OP =
  /(?<r>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<g>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<b>-?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+(?<op>rg|RG)\b/g;

function findIccDir() {
  const candidates = [
    "/opt/homebrew/Cellar/ghostscript",
    "/usr/local/Cellar/ghostscript",
  ];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    for (const ver of readdirSync(root)) {
      const icc = join(root, ver, "share/ghostscript/iccprofiles");
      if (existsSync(join(icc, "default_cmyk.icc"))) return icc;
    }
  }
  const share = [
    "/opt/homebrew/share/ghostscript/iccprofiles",
    "/usr/local/share/ghostscript/iccprofiles",
    "/usr/share/ghostscript/iccprofiles",
  ];
  for (const icc of share) {
    if (existsSync(join(icc, "default_cmyk.icc"))) return icc;
  }
  throw new Error("Could not find Ghostscript ICC profiles (default_cmyk.icc)");
}

function needsAsciiTemp(path) {
  return [...path].some((c) => c.charCodeAt(0) > 127 || /\s/.test(c));
}

function lumaFromCmyk(c, m, y, k) {
  const r = 1.0 - Math.min(1.0, c * (1.0 - k) + k);
  const g = 1.0 - Math.min(1.0, m * (1.0 - k) + k);
  const b = 1.0 - Math.min(1.0, y * (1.0 - k) + k);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function toPureK(c, m, y, k) {
  const isNeutral =
    Math.abs(c - m) <= NEUTRAL_EPS &&
    Math.abs(m - y) <= NEUTRAL_EPS &&
    Math.abs(c - y) <= NEUTRAL_EPS;
  const isBlack = lumaFromCmyk(c, m, y, k) <= BLACK_LUMA;
  if (isNeutral) return [0, 0, 0, Math.min(1, k + Math.min(c, m, y))];
  if (isBlack) {
    return [
      0,
      0,
      0,
      Math.min(1, Math.max(k, 1 - lumaFromCmyk(c, m, y, k))),
    ];
  }
  return [c, m, y, k];
}

function fmt(n) {
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return s || "0";
}

function rewriteContent(bytes) {
  let text = Buffer.from(bytes).toString("latin1");

  text = text.replace(CMYK_OP, (...args) => {
    const g = args[args.length - 1];
    let [c, m, y, k] = toPureK(+g.c, +g.m, +g.y, +g.k);
    return `${fmt(c)} ${fmt(m)} ${fmt(y)} ${fmt(k)} ${g.op}`;
  });

  text = text.replace(GRAY_OP, (...args) => {
    const g = args[args.length - 1];
    const k = Math.max(0, Math.min(1, 1 - +g.g));
    const op = g.op === "g" ? "k" : "K";
    return `0 0 0 ${fmt(k)} ${op}`;
  });

  text = text.replace(RGB_OP, (...args) => {
    const g = args[args.length - 1];
    let c = 1 - +g.r;
    let m = 1 - +g.g;
    let y = 1 - +g.b;
    let k = Math.min(c, m, y);
    if (k >= 1) {
      c = m = y = 0;
    } else {
      c = (c - k) / (1 - k);
      m = (m - k) / (1 - k);
      y = (y - k) / (1 - k);
    }
    [c, m, y, k] = toPureK(c, m, y, k);
    const op = g.op === "rg" ? "k" : "K";
    return `${fmt(c)} ${fmt(m)} ${fmt(y)} ${fmt(k)} ${op}`;
  });

  return Buffer.from(text, "latin1");
}

function gsToCmyk(src, dst) {
  const icc = findIccDir();
  const tmpDir = mkdtempSync(join(tmpdir(), "cmyk-"));
  let workIn = src;
  let workOut = dst;

  try {
    if (needsAsciiTemp(src)) {
      workIn = join(tmpDir, "in.pdf");
      copyFileSync(src, workIn);
    }
    if (needsAsciiTemp(dst)) {
      workOut = join(tmpDir, "out.pdf");
    }

    const cmd = [
      "gs",
      "-dBATCH",
      "-dNOPAUSE",
      "-dNOOUTERSAVE",
      "-sDEVICE=pdfwrite",
      "-dCompatibilityLevel=1.7",
      "-dAutoRotatePages=/None",
      "-sColorConversionStrategy=CMYK",
      "-dProcessColorModel=/DeviceCMYK",
      "-dDeviceGrayToK=true",
      `-sDefaultCMYKProfile=${join(icc, "default_cmyk.icc")}`,
      `-sOutputICCProfile=${join(icc, "default_cmyk.icc")}`,
      "-dOverrideICC=true",
      // gray_to_k.icc as DefaultGrayProfile crashes GS 10.07 on some files
      "-dAutoFilterColorImages=false",
      "-dAutoFilterGrayImages=false",
      "-dColorImageFilter=/FlateEncode",
      "-dGrayImageFilter=/FlateEncode",
      "-dMonoImageFilter=/CCITTFaxEncode",
      "-dEncodeColorImages=true",
      "-dEncodeGrayImages=true",
      "-dEncodeMonoImages=true",
      "-dDownsampleColorImages=false",
      "-dDownsampleGrayImages=false",
      "-dDownsampleMonoImages=false",
      "-dPassThroughJPEGImages=true",
      "-dDetectDuplicateImages=true",
      "-dCompressFonts=true",
      "-dSubsetFonts=true",
      "-dCompressPages=true",
      "-dPreserveOverprintSettings=true",
      `-sOutputFile=${workOut}`,
      workIn,
    ];

    console.log("Running Ghostscript CMYK conversion (lossless images)...");
    const result = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
    if (result.status !== 0) {
      throw new Error(`Ghostscript failed with exit code ${result.status}`);
    }
    if (workOut !== dst) copyFileSync(workOut, dst);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function asName(obj) {
  return obj instanceof PDFName ? obj.asString() : null;
}

function lookup(context, obj) {
  return obj instanceof PDFRef ? context.lookup(obj) : obj;
}

function refKey(ref) {
  return `${ref.objectNumber} ${ref.generationNumber}`;
}

function replaceDecodedStream(context, ref, stream, decodedBytes) {
  const compressed = deflateSync(Buffer.from(decodedBytes));
  const newDict = stream.dict.clone(context);
  newDict.delete(PDFName.of("DecodeParms"));
  newDict.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
  newDict.set(PDFName.of("Length"), PDFNumber.of(compressed.length));
  context.assign(ref, PDFRawStream.of(newDict, new Uint8Array(compressed)));
}

function maybeRewriteStream(context, ref, stream) {
  const decoded = decodePDFRawStream(stream).decode();
  const next = rewriteContent(decoded);
  if (Buffer.compare(Buffer.from(decoded), Buffer.from(next)) !== 0) {
    replaceDecodedStream(context, ref, stream, next);
  }
}

function processCmykImage(context, ref, stream) {
  const cs = lookup(context, stream.dict.get(PDFName.of("ColorSpace")));
  if (asName(cs) !== "/DeviceCMYK") return;

  const width = stream.dict.get(PDFName.of("Width"));
  const height = stream.dict.get(PDFName.of("Height"));
  const bpc = stream.dict.get(PDFName.of("BitsPerComponent"));
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) return;
  if (bpc instanceof PDFNumber && bpc.asNumber() !== 8) return;

  const w = width.asNumber();
  const h = height.asNumber();
  const decoded = Buffer.from(decodePDFRawStream(stream).decode());
  const expected = w * h * 4;
  if (decoded.length < expected) return;

  const buf = Buffer.from(decoded.subarray(0, expected));
  let changed = false;
  for (let i = 0; i < expected; i += 4) {
    const c = buf[i] / 255;
    const m = buf[i + 1] / 255;
    const y = buf[i + 2] / 255;
    const k = buf[i + 3] / 255;
    const [nc, nm, ny, nk] = toPureK(c, m, y, k);
    if (nc !== c || nm !== m || ny !== y || nk !== k) {
      buf[i] = Math.round(nc * 255);
      buf[i + 1] = Math.round(nm * 255);
      buf[i + 2] = Math.round(ny * 255);
      buf[i + 3] = Math.round(nk * 255);
      changed = true;
    }
  }
  if (!changed) return;

  const out =
    decoded.length > expected
      ? Buffer.concat([buf, decoded.subarray(expected)])
      : buf;
  replaceDecodedStream(context, ref, stream, out);
}

function collectMaskKeys(context, pdfDoc) {
  const masks = new Set();
  const seen = new Set();

  function considerImage(stream, streamRef) {
    const imageMask = stream.dict.get(PDFName.of("ImageMask"));
    if (
      imageMask === PDFBool.True ||
      (imageMask instanceof PDFBool && imageMask.asBoolean())
    ) {
      if (streamRef) masks.add(refKey(streamRef));
    }
    for (const key of ["SMask", "Mask"]) {
      const m = stream.dict.get(PDFName.of(key));
      if (m instanceof PDFRef) masks.add(refKey(m));
    }
  }

  function walkResources(res) {
    res = lookup(context, res);
    if (!(res instanceof PDFDict)) return;
    const xobjects = lookup(context, res.get(PDFName.of("XObject")));
    if (!(xobjects instanceof PDFDict)) return;
    for (const raw of xobjects.values()) {
      const ref = raw instanceof PDFRef ? raw : null;
      const obj = lookup(context, raw);
      if (!(obj instanceof PDFRawStream)) continue;
      const key = ref ? refKey(ref) : null;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const subtype = asName(obj.dict.get(PDFName.of("Subtype")));
      if (subtype === "/Image") considerImage(obj, ref);
      else if (subtype === "/Form") walkResources(obj.dict.get(PDFName.of("Resources")));
    }
  }

  for (const page of pdfDoc.getPages()) {
    walkResources(page.node.Resources());
  }
  return masks;
}

function walkAndRewrite(context, pdfDoc, maskKeys) {
  const seen = new Set();

  function walkResources(res) {
    res = lookup(context, res);
    if (!(res instanceof PDFDict)) return;
    const xobjects = lookup(context, res.get(PDFName.of("XObject")));
    if (!(xobjects instanceof PDFDict)) return;

    for (const [, value] of xobjects.entries()) {
      const ref = value instanceof PDFRef ? value : null;
      const obj = lookup(context, value);
      if (!(obj instanceof PDFRawStream) || !ref) continue;
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);

      const subtype = asName(obj.dict.get(PDFName.of("Subtype")));
      if (subtype === "/Image") {
        if (maskKeys.has(key)) continue;
        processCmykImage(context, ref, obj);
      } else if (subtype === "/Form") {
        walkResources(obj.dict.get(PDFName.of("Resources")));
        maybeRewriteStream(context, ref, obj);
      }
    }
  }

  for (const page of pdfDoc.getPages()) {
    const contents = page.node.get(PDFName.of("Contents"));
    const list =
      contents instanceof PDFArray
        ? contents.asArray()
        : contents
          ? [contents]
          : [];
    for (const item of list) {
      const ref = item instanceof PDFRef ? item : null;
      const stream = lookup(context, item);
      if (ref && stream instanceof PDFRawStream) {
        maybeRewriteStream(context, ref, stream);
      }
    }
    walkResources(page.node.Resources());
  }
}

async function forcePureK(pdfPath) {
  console.log("Forcing black/gray to pure K...");
  const bytes = readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  const context = pdfDoc.context;
  const maskKeys = collectMaskKeys(context, pdfDoc);
  console.log(`Skipping ${maskKeys.size} mask image(s)`);
  walkAndRewrite(context, pdfDoc, maskKeys);
  const out = await pdfDoc.save({ useObjectStreams: false });
  writeFileSync(pdfPath, out);
}

async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error(
      "Usage: node preprint.mjs <input.pdf> [output.pdf]",
    );
    process.exit(1);
  }

  const src = resolve(inputArg);
  const out = resolve(
    process.argv[3] ??
      src.replace(/\.pdf$/i, "") + "-CMYK.pdf",
  );
  const tmp = join(tmpdir(), `cmyk-work-${process.pid}.pdf`);

  if (!existsSync(src)) {
    console.error(`Missing source: ${src}`);
    process.exit(1);
  }

  try {
    gsToCmyk(src, tmp);
    copyFileSync(tmp, out);
    await forcePureK(out);
  } finally {
    rmSync(tmp, { force: true });
  }

  const size = statSync(out).size;
  console.log(`Wrote ${out} (${size.toLocaleString()} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
