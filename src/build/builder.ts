import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { parseMxImgHeader, serializeFourierStream } from "../utils/encoding/binary.ts";
import { encodeImageFromFile } from "../utils/encoding/encoder.ts";
import {
  computeMxImgHash,
  loadManifest,
  type MxImgManifest,
  type MxImgManifestEntry,
  registerManifestEntry,
  resolveManifestEntry,
  saveManifest,
} from "./manifest.ts";

const SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export interface BuildMxImgOptions {
  /** Directorio raíz del proyecto (por defecto `process.cwd()`) */
  rootDir?: string;
  /** Directorio de imágenes de entrada (por defecto `src/assets/images`) */
  inputDir?: string;
  /** Lista explícita de rutas de imágenes a procesar */
  files?: string[];
  /** Directorio de salida para los bundles `.mximg` (por defecto `dist/.mx-img`) */
  outDir?: string;
  /** Umbral de radio cromático (por defecto `0.15`) */
  umbralRadioCroma?: number;
  /** Si es `true`, recodifica aunque el archivo `<hash>.mximg` ya exista en disco */
  force?: boolean;
}

/**
 * Codifica una imagen individual hacia `<outDir>/<hash>.mximg` y la registra en el manifest.
 * Si el archivo `<hash>.mximg` ya existe en disco y `force` es `false`, reutiliza su cabecera.
 */
export async function buildSingleMxImgAsset(
  imagePath: string,
  outDir: string,
  manifest: MxImgManifest,
  options: { rootDir?: string; umbralRadioCroma?: number; force?: boolean; aliases?: string[] } = {}
): Promise<MxImgManifestEntry> {
  const rootDir = options.rootDir ?? process.cwd();
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;
  const absPath = resolve(rootDir, imagePath);
  const rawSourceBytes = new Uint8Array(await readFile(absPath));
  const hash = computeMxImgHash(rawSourceBytes, umbralRadioCroma);
  const fileName = `${hash}.mximg`;
  const outBinPath = join(outDir, fileName);
  const relSource = relative(rootDir, absPath).replace(/\\/g, "/");
  const baseName = basename(absPath);

  await mkdir(outDir, { recursive: true });

  let entry: MxImgManifestEntry;

  if (!options.force && existsSync(outBinPath)) {
    const existingBytes = new Uint8Array(await readFile(outBinPath));
    const header = parseMxImgHeader(existingBytes);
    entry = {
      hash,
      fileName,
      sourcePath: relSource,
      baseName,
      width: header.width,
      height: header.height,
      totalBytes: existingBytes.byteLength,
      numCoefficients: header.numCoefficients,
      kCroma: header.kCroma,
      umbralRadioCroma: header.umbralRadioCroma,
    };
  } else {
    const { encoded } = await encodeImageFromFile(absPath, umbralRadioCroma);
    const binary = serializeFourierStream(encoded);
    await writeFile(outBinPath, binary);

    entry = {
      hash,
      fileName,
      sourcePath: relSource,
      baseName,
      width: encoded.dims[1],
      height: encoded.dims[0],
      totalBytes: binary.byteLength,
      numCoefficients: encoded.numCoefficients,
      kCroma: encoded.kCroma,
      umbralRadioCroma: encoded.umbralRadioCroma,
    };
  }

  registerManifestEntry(manifest, entry, options.aliases ?? []);
  return entry;
}

/**
 * Procesa todas las imágenes del directorio de entrada (o lista de archivos) y genera
 * los assets progresivos en `/dist/.mx-img/<hash>.mximg` junto con `manifest.json`.
 */
export async function buildMxImgAssets(options: BuildMxImgOptions = {}): Promise<{
  outDir: string;
  manifestPath: string;
  manifest: MxImgManifest;
  entries: MxImgManifestEntry[];
}> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const outDir = resolve(rootDir, options.outDir ?? "dist/.mx-img");
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;

  await mkdir(outDir, { recursive: true });
  const manifest = await loadManifest(outDir);

  let targetFiles: string[] = [];
  if (options.files && options.files.length > 0) {
    targetFiles = options.files.map((f) => resolve(rootDir, f));
  } else {
    const inputDir = resolve(rootDir, options.inputDir ?? "src/assets/images");
    if (existsSync(inputDir)) {
      const dirItems = await readdir(inputDir);
      targetFiles = dirItems
        .filter((name) => SUPPORTED_IMAGE_EXTENSIONS.has(extname(name).toLowerCase()))
        .sort()
        .map((name) => join(inputDir, name));
    }
  }

  const entries: MxImgManifestEntry[] = [];
  for (const filePath of targetFiles) {
    const entry = await buildSingleMxImgAsset(filePath, outDir, manifest, {
      rootDir,
      umbralRadioCroma,
      force: options.force,
    });
    entries.push(entry);
  }

  const manifestPath = await saveManifest(outDir, manifest);
  return { outDir, manifestPath, manifest, entries };
}

/**
 * Transforma etiquetas `<mx-img ...>` y `<canvas is="mx-img" ...>` en código HTML/Astro/JSX
 * reemplazando el atributo `src` por el `hash` generado en `/dist/.mx-img/*` y añadiendo
 * `width` y `height` intrínsecos del canvas si no estaban definidos.
 */
export function transformHtmlForMxImg(
  html: string,
  manifest: MxImgManifest,
  options: { outputTag?: "canvas" | "mx-img" } = {}
): { html: string; replacedCount: number } {
  const outputTag = options.outputTag ?? "canvas";
  let replacedCount = 0;

  // 1. Transformar etiquetas <mx-img ...></mx-img> o <mx-img ... />
  const mxImgRegex = /<mx-img\b([^>]*?)(?:\/>|><\/mx-img>)/gi;
  let result = html.replace(mxImgRegex, (fullMatch, attrsStr: string) => {
    const srcMatch = attrsStr.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) {
      // Si `src={...}` es una expresión dinámica JSX/TSX, convertir igualmente a `<canvas is="mx-img">`
      if (/\bsrc\s*=\s*\{/i.test(attrsStr) && outputTag === "canvas") {
        replacedCount++;
        const hasIsAttr = /\bis\s*=\s*["']mx-img["']/i.test(attrsStr);
        const isAttr = hasIsAttr ? "" : ` is="mx-img"`;
        return `<canvas${isAttr}${attrsStr}></canvas>`;
      }
      return fullMatch;
    }

    const rawSrc = srcMatch[1];
    const entry = resolveManifestEntry(manifest, rawSrc);
    const resolvedSrc = entry ? entry.hash : rawSrc;

    let updatedAttrs = attrsStr.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, `src="${resolvedSrc}"`);

    if (entry) {
      if (!/\bwidth\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` width="${entry.width}"`;
      }
      if (!/\bheight\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` height="${entry.height}"`;
      }
      if (!/\bdata-mx-original-src\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` data-mx-original-src="${rawSrc}"`;
      }
    }

    replacedCount++;
    if (outputTag === "canvas") {
      const hasIsAttr = /\bis\s*=\s*["']mx-img["']/i.test(updatedAttrs);
      const isAttr = hasIsAttr ? "" : ` is="mx-img"`;
      return `<canvas${isAttr}${updatedAttrs}></canvas>`;
    }
    return `<mx-img${updatedAttrs}></mx-img>`;
  });

  // 2. Transformar etiquetas <canvas is="mx-img" src="..."></canvas> que aún no fueron transformadas
  const canvasMxRegex = /<canvas\b([^>]*?\bis\s*=\s*["']mx-img["'][^>]*?)><\/canvas>/gi;
  result = result.replace(canvasMxRegex, (fullMatch, attrsStr: string) => {
    const srcMatch = attrsStr.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) return fullMatch;

    const rawSrc = srcMatch[1];
    const entry = resolveManifestEntry(manifest, rawSrc);
    if (!entry) return fullMatch;

    const alreadyHashed = rawSrc === entry.hash;
    const hasWidth = /\bwidth\s*=/i.test(attrsStr);
    const hasHeight = /\bheight\s*=/i.test(attrsStr);
    if (alreadyHashed && hasWidth && hasHeight) {
      return fullMatch;
    }

    let updatedAttrs = attrsStr.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, `src="${entry.hash}"`);
    if (!hasWidth) {
      updatedAttrs += ` width="${entry.width}"`;
    }
    if (!hasHeight) {
      updatedAttrs += ` height="${entry.height}"`;
    }

    replacedCount++;
    return `<canvas${updatedAttrs}></canvas>`;
  });

  // 3. Transformar llamadas JSX ya compiladas por Oxc/esbuild/Babel: `("mx-img", {` -> `("canvas", { is: "mx-img", `
  if (outputTag === "canvas") {
    const compiledJsxRegex = /\(([\s]*)(["'])mx-img\2(\s*,\s*\{)(?!\s*is\s*:)/g;
    result = result.replace(
      compiledJsxRegex,
      (_fullMatch, leadingWs: string, quote: string, commaBrace: string) => {
        replacedCount++;
        return `(${leadingWs}${quote}canvas${quote}${commaBrace} is: ${quote}mx-img${quote}, `;
      }
    );
  }

  return { html: result, replacedCount };
}

// CLI: `bun run src/build/builder.ts [inputDir] [outDir]`
if (import.meta.main) {
  const inputDir = process.argv[2] ?? "src/assets/images";
  const outDir = process.argv[3] ?? "dist/.mx-img";
  const t0 = performance.now();

  console.log("=".repeat(84));
  console.log("🏗️  MX-IMG BUILDER - Generando bundles progresivos en /dist/.mx-img/*");
  console.log("=".repeat(84));

  const { entries, manifestPath } = await buildMxImgAssets({ inputDir, outDir });
  const elapsed = performance.now() - t0;

  for (const e of entries) {
    const mb = (e.totalBytes / (1024 * 1024)).toFixed(2);
    console.log(
      `  • [${e.hash}] ${e.baseName.padEnd(24)} -> ${e.width}×${e.height} (${mb} MB, K=${e.numCoefficients.toLocaleString()})`
    );
  }
  console.log("-".repeat(84));
  console.log(`✅ ${entries.length} imágenes procesadas en ${elapsed.toFixed(0)} ms`);
  console.log(`📄 Manifest: ${manifestPath}`);
  console.log("=".repeat(84));
}
