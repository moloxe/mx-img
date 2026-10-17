import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildMxImgAssets, buildSingleMxImgAsset, transformHtmlForMxImg } from "./builder.ts";
import {
  createEmptyManifest,
  type MxImgManifest,
  resolveManifestEntry,
  saveManifest,
} from "./manifest.ts";

export interface MxImgVitePluginOptions {
  /** Directorio de imágenes fuente a pre-compilar (por defecto `src/assets/images`) */
  assetsDir?: string;
  /** Subdirectorio dentro del `outDir` de Vite donde se emiten los `.mximg` (por defecto `.mx-img`) */
  mxImgSubDir?: string;
  /** Umbral de radio cromático (por defecto `0.15`) */
  umbralRadioCroma?: number;
  /** Etiqueta de salida tras el build (`"canvas"` con `is="mx-img"` o `"mx-img"`) */
  outputTag?: "canvas" | "mx-img";
}

export interface VitePluginLike {
  name: string;
  enforce?: "pre" | "post";
  configResolved?: (config: { root?: string; build?: { outDir?: string } }) => Promise<void> | void;
  buildStart?: () => Promise<void> | void;
  transformIndexHtml?: (html: string, ctx?: { filename?: string }) => Promise<string> | string;
  transform?: (code: string, id: string) => Promise<{ code: string; map: null } | null> | null;
  closeBundle?: () => Promise<void> | void;
}

/**
 * Plugin de Vite para `<mx-img />`.
 *
 * - Compila las imágenes referenciadas en `<mx-img src="...">` o `<canvas is="mx-img" src="...">`
 *   al formato espectral `.mximg` dentro de `<outDir>/.mx-img/<hash>.mximg` (por defecto `dist/.mx-img/*`).
 * - Reemplaza el atributo `src` en el HTML/componentes por el `hash` correspondiente.
 * - Genera `<outDir>/.mx-img/manifest.json` para que el servidor de streaming resuelva cada hash.
 */
export function mxImgVitePlugin(options: MxImgVitePluginOptions = {}): VitePluginLike {
  let rootDir = process.cwd();
  let outDir = resolve(rootDir, "dist/.mx-img");
  let manifest: MxImgManifest = createEmptyManifest();
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;
  const mxImgSubDir = options.mxImgSubDir ?? ".mx-img";

  async function ensureReferencedSourcesCompiled(
    code: string,
    importerPath?: string
  ): Promise<void> {
    const tagRegex =
      /<(?:mx-img|canvas\b[^>]*?\bis\s*=\s*["']mx-img["'])[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*?>/gi;
    const matches = [...code.matchAll(tagRegex)];

    for (const match of matches) {
      const rawSrc = match[1];
      if (!rawSrc || resolveManifestEntry(manifest, rawSrc)) {
        continue;
      }

      const candidatePaths: string[] = [];
      if (importerPath) {
        candidatePaths.push(resolve(dirname(importerPath), rawSrc));
      }
      candidatePaths.push(
        resolve(rootDir, rawSrc.replace(/^\//, "")),
        resolve(rootDir, "src", rawSrc.replace(/^\//, "")),
        resolve(
          rootDir,
          options.assetsDir ?? "src/assets/images",
          rawSrc.split("/").pop() ?? rawSrc
        )
      );

      for (const candidate of candidatePaths) {
        if (existsSync(candidate)) {
          await buildSingleMxImgAsset(candidate, outDir, manifest, {
            rootDir,
            umbralRadioCroma,
            aliases: [rawSrc],
          });
          break;
        }
      }
    }
  }

  return {
    name: "vite-plugin-mx-img",
    enforce: "pre",

    async configResolved(config) {
      rootDir = resolve(config.root ?? process.cwd());
      const viteOutDir = config.build?.outDir ?? "dist";
      outDir = resolve(rootDir, join(viteOutDir, mxImgSubDir));
    },

    async buildStart() {
      const built = await buildMxImgAssets({
        rootDir,
        inputDir: options.assetsDir ?? "src/assets/images",
        outDir,
        umbralRadioCroma,
      });
      manifest = built.manifest;
    },

    async transformIndexHtml(html, ctx) {
      await ensureReferencedSourcesCompiled(html, ctx?.filename);
      await saveManifest(outDir, manifest);
      const { html: transformed } = transformHtmlForMxImg(html, manifest, {
        outputTag: options.outputTag ?? "canvas",
      });
      return transformed;
    },

    async transform(code, id) {
      if (!/\.(html|astro|jsx|tsx|vue|svelte)$/i.test(id)) {
        return null;
      }
      if (!code.includes("mx-img")) {
        return null;
      }

      await ensureReferencedSourcesCompiled(code, id);
      const { html: transformed, replacedCount } = transformHtmlForMxImg(code, manifest, {
        outputTag: options.outputTag ?? "canvas",
      });

      if (replacedCount === 0) {
        return null;
      }
      await saveManifest(outDir, manifest);
      return { code: transformed, map: null };
    },

    async closeBundle() {
      await saveManifest(outDir, manifest);
    },
  };
}
