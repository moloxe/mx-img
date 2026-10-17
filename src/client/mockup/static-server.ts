import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildMxImgAssets } from "../../build/builder.ts";
import { createMxImgStreamServer } from "../../server/stream-server.ts";

const ROOT_DIR = resolve(import.meta.dir, "../../..");
const MOCKUP_DIR = import.meta.dir;
const CLIENT_LIB_ENTRY = resolve(import.meta.dir, "../lib/index.ts");
const DIST_MXIMG_DIR = resolve(ROOT_DIR, "dist/.mx-img");
const ASSETS_IMAGES_DIR = resolve(ROOT_DIR, "src/assets/images");

/**
 * Compila `src/client/lib/index.ts` en un bundle ESM para navegador en memoria.
 */
async function bundleClientLibrary(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [CLIENT_LIB_ENTRY],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "inline",
  });

  if (!result.success || result.outputs.length === 0) {
    const logs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`Error compilando src/client/lib/index.ts:\n${logs}`);
  }

  return await result.outputs[0].text();
}

export async function startMockupServer(options: { port?: number; prebuildAssets?: boolean } = {}) {
  const port = options.port ?? (process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080);

  if (options.prebuildAssets !== false) {
    console.log("📦 Verificando/generando bundles en /dist/.mx-img/* ...");
    const { entries } = await buildMxImgAssets({
      rootDir: ROOT_DIR,
      inputDir: ASSETS_IMAGES_DIR,
      outDir: DIST_MXIMG_DIR,
    });
    console.log(`✅ ${entries.length} imágenes listas en /dist/.mx-img/*`);
  }

  let cachedClientBundle = await bundleClientLibrary();

  const streamServer = createMxImgStreamServer({
    port,
    rootDir: ROOT_DIR,
    mxImgDir: DIST_MXIMG_DIR,
    fallbackAssetsDir: ASSETS_IMAGES_DIR,
    defaultThrottleDelayMs: 20, // 20ms por defecto en el mockup para apreciar el streaming progresivo y pausas al hacer scroll
    async onHttpRequest(req) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/" || pathname === "/index.html") {
        const htmlFile = Bun.file(join(MOCKUP_DIR, "index.html"));
        return new Response(htmlFile, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (pathname === "/lib/index.js" || pathname === "/client/lib/index.js") {
        cachedClientBundle = await bundleClientLibrary();
        return new Response(cachedClientBundle, {
          headers: {
            "Content-Type": "application/javascript; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (pathname === "/manifest.json" || pathname === "/.mx-img/manifest.json") {
        const manifestFile = Bun.file(join(DIST_MXIMG_DIR, "manifest.json"));
        if (await manifestFile.exists()) {
          return new Response(manifestFile, {
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
      }

      if (pathname.startsWith("/assets/images/")) {
        const fileName = pathname.slice("/assets/images/".length);
        const imgPath = join(ASSETS_IMAGES_DIR, fileName);
        if (existsSync(imgPath)) {
          return new Response(Bun.file(imgPath));
        }
      }

      return null;
    },
  });

  return streamServer;
}

if (import.meta.main) {
  const srv = await startMockupServer();
  console.log("=".repeat(84));
  console.log("🖼️  MX-IMG LOCAL MOCKUP & STREAM SERVER");
  console.log("=".repeat(84));
  console.log(`• Mockup Web UI      : http://localhost:${srv.port}/`);
  console.log(`• Stream WebSocket   : ${srv.streamUrl}`);
  console.log(`• Bundles Directorio : ${DIST_MXIMG_DIR}`);
  console.log("=".repeat(84));
}
