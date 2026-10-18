import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMxImgAssets,
  loadManifest,
  mxImgAstroIntegration,
  mxImgVitePlugin,
  resolveManifestEntry,
  transformHtmlForMxImg,
  injectMxImgPreviews,
} from "../index.ts";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const DIST_MXIMG_DIR = resolve(ROOT_DIR, "dist/.mx-img");

describe("MxImg Fase 2: Build (/dist/.mx-img/*), Vite Plugin y Astro Hybrid", () => {
  test("1. Genera el bundle .mximg con hash determinista y manifest.json en /dist/.mx-img/", async () => {
    const sampleImg = resolve(ROOT_DIR, "src/assets/images/voronoi.jpeg");
    const { entries, manifestPath, manifest } = await buildMxImgAssets({
      rootDir: ROOT_DIR,
      files: [sampleImg],
      outDir: DIST_MXIMG_DIR,
    });

    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry.hash).toHaveLength(12);
    expect(entry.fileName).toBe(`${entry.hash}.mximg`);
    expect(existsSync(join(DIST_MXIMG_DIR, entry.fileName))).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);

    // Resolución tanto por hash como por ruta
    expect(resolveManifestEntry(manifest, entry.hash)?.hash).toBe(entry.hash);
    expect(resolveManifestEntry(manifest, "/assets/images/voronoi.jpeg")?.hash).toBe(entry.hash);
    expect(resolveManifestEntry(manifest, "../assets/images/voronoi.jpeg")?.hash).toBe(entry.hash);
  });

  test("2. Transforma etiquetas <mx-img> en <canvas is='mx-img' src='<hash>'> preservando atributos", async () => {
    const manifest = await loadManifest(DIST_MXIMG_DIR);
    const entry = resolveManifestEntry(manifest, "voronoi.jpeg")!;
    expect(entry).toBeDefined();

    const rawHtml = `<div class="gallery"><mx-img src="../assets/images/voronoi.jpeg" class="hero-canvas"></mx-img></div>`;
    const { html, replacedCount } = transformHtmlForMxImg(rawHtml, manifest);

    expect(replacedCount).toBe(1);
    expect(html).toContain(`<canvas is="mx-img"`);
    expect(html).toContain(`src="${entry.hash}"`);
    expect(html).toContain(`width="${entry.width}"`);
    expect(html).toContain(`height="${entry.height}"`);
    expect(html).toContain(`class="hero-canvas"`);
  });

  test("3. Plugin de Vite (mxImgVitePlugin) e integración de Astro (mxImgAstroIntegration) funcionan en modo hybrid", async () => {
    const vitePlugin = mxImgVitePlugin({
      assetsDir: "src/assets/images",
      mxImgSubDir: ".mx-img",
    });

    await vitePlugin.configResolved?.({
      root: ROOT_DIR,
      build: { outDir: "dist" },
    });

    const transformedHtml = await vitePlugin.transformIndexHtml?.(
      `<html><body><mx-img src="/assets/images/voronoi.jpeg"></mx-img></body></html>`
    );

    const manifest = await loadManifest(DIST_MXIMG_DIR);
    const voronoiEntry = resolveManifestEntry(manifest, "voronoi.jpeg")!;
    expect(transformedHtml).toContain(`src="${voronoiEntry.hash}"`);
    expect(transformedHtml).toContain(`is="mx-img"`);

    // Verificar integración con Astro en modo hybrid
    let registeredVitePlugins: unknown[] = [];
    const astroIntegration = mxImgAstroIntegration({
      streamUrl: "http://localhost:8080/.mx-img/stream",
    });

    await astroIntegration.hooks["astro:config:setup"]?.({
      config: {
        root: pathToFileURL(`${ROOT_DIR}/`),
        outDir: pathToFileURL(`${resolve(ROOT_DIR, "dist")}/`),
        output: "hybrid",
      },
      updateConfig(cfg) {
        const viteCfg = cfg.vite as { plugins?: unknown[] } | undefined;
        if (viteCfg?.plugins) {
          registeredVitePlugins = viteCfg.plugins;
        }
      },
    });

    expect(registeredVitePlugins.length).toBe(1);
  });

  test("4. injectMxImgPreviews inyecta un único bloque de previsualizaciones de 8 KB sin duplicados y resolviendo props", async () => {
    const manifest = await loadManifest(DIST_MXIMG_DIR);
    const voronoiEntry = resolveManifestEntry(manifest, "voronoi.jpeg")!;
    expect(voronoiEntry.initialChunkBase64).toBeDefined();
    expect(voronoiEntry.initialChunkBytes).toBe(8 * 1024);

    const sampleHtml = `<!doctype html>
<html>
<body>
  <div class="gallery">
    <canvas is="mx-img" src="${voronoiEntry.hash}"></canvas>
    <canvas is="mx-img" src="../assets/images/voronoi.jpeg"></canvas>
    <astro-island opts="{&quot;photos&quot;:[&quot;/_astro/voronoi.D8-abc.jpeg&quot;]}"></astro-island>
  </div>
</body>
</html>`;

    const { html, injectedCount } = injectMxImgPreviews(sampleHtml, manifest);
    expect(injectedCount).toBe(1); // voronoi resuelto una sola vez a pesar de estar 3 veces
    expect(html).toContain('data-mx-img-previews');
    expect(html).toContain(voronoiEntry.hash);

    // Si se vuelve a ejecutar sobre un HTML ya inyectado, no duplica
    const reinject = injectMxImgPreviews(html, manifest);
    expect(reinject.injectedCount).toBe(0);
    const matchCount = (html.match(/data-mx-img-previews/g) || []).length;
    expect(matchCount).toBe(1);
  });

  test("5. La porción inicial en base64 coincide exactamente con los primeros bytes del archivo .mximg", async () => {
    const manifest = await loadManifest(DIST_MXIMG_DIR);
    const entry = resolveManifestEntry(manifest, "voronoi.jpeg")!;
    const binPath = join(DIST_MXIMG_DIR, entry.fileName);
    const binFile = await Bun.file(binPath).arrayBuffer();
    const binBytes = new Uint8Array(binFile);

    const b64Bytes = Buffer.from(entry.initialChunkBase64!, "base64");
    expect(b64Bytes.byteLength).toBe(entry.initialChunkBytes!);
    expect(b64Bytes.byteLength).toBe(8 * 1024);

    // Comparar byte a byte
    for (let i = 0; i < b64Bytes.byteLength; i++) {
      expect(b64Bytes[i]).toBe(binBytes[i]);
    }
  });
});
