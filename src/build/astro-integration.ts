import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachMxImgUpgradeHandler } from "../server/stream-server.ts";
import { buildMxImgAssets } from "./builder.ts";
import { mxImgVitePlugin, type MxImgVitePluginOptions } from "./vite-plugin.ts";

export interface MxImgAstroOptions extends MxImgVitePluginOptions {
  /** URL del servicio de streaming para inyectar opcionalmente en el cliente */
  streamUrl?: string;
}

export interface AstroIntegrationLike {
  name: string;
  hooks: {
    "astro:config:setup"?: (params: {
      config: { root?: URL; outDir?: URL; output?: "static" | "server" | "hybrid" };
      updateConfig: (newConfig: Record<string, unknown>) => void;
      injectScript?: (stage: string, content: string) => void;
    }) => Promise<void> | void;
    "astro:server:setup"?: (params: { server: { httpServer?: unknown } }) => Promise<void> | void;
    "astro:build:done"?: (params: { dir: URL }) => Promise<void> | void;
  };
}

/**
 * Integración para Astro (compatible con modo `hybrid`, `server` y `static`).
 *
 * - Registra automáticamente `mxImgVitePlugin` en el pipeline de Vite de Astro.
 * - En proyectos `hybrid` / `server`, asegura que los bundles `.mximg` y el `manifest.json`
 *   queden generados en `/dist/.mx-img/*` (y sincronizados con el directorio de salida de Astro)
 *   para que el servidor de streaming localice cualquier hash consultado.
 */
export function mxImgAstroIntegration(options: MxImgAstroOptions = {}): AstroIntegrationLike {
  let rootDir = process.cwd();
  let distRootDir = resolve(rootDir, "dist");

  return {
    name: "mx-img-astro",
    hooks: {
      async "astro:config:setup"({ config, updateConfig, injectScript }) {
        if (config.root) {
          rootDir = fileURLToPath(config.root);
        }
        if (config.outDir) {
          distRootDir = fileURLToPath(config.outDir);
        } else {
          distRootDir = resolve(rootDir, "dist");
        }

        const plugin = mxImgVitePlugin({
          ...options,
          mxImgSubDir: options.mxImgSubDir ?? ".mx-img",
        });

        updateConfig({
          vite: {
            plugins: [plugin],
          },
        });

        if (injectScript) {
          const initArg = options.streamUrl
            ? `{ streamUrl: ${JSON.stringify(options.streamUrl)} }`
            : "";
          injectScript(
            "before-hydration",
            `import { registerMxImgElement } from "mx-img/client"; registerMxImgElement();`
          );
          injectScript(
            "page",
            `import { init } from "mx-img/client"; init(${initArg}); document.addEventListener("astro:page-load", () => init(${initArg}));`
          );
        }
      },

      async "astro:server:setup"({ server }) {
        attachMxImgUpgradeHandler(server?.httpServer as any, {
          rootDir,
          mxImgDir: join(distRootDir, options.mxImgSubDir ?? ".mx-img"),
          fallbackAssetsDir: options.assetsDir ?? "src/assets/images",
        });
      },

      async "astro:build:done"({ dir }) {
        const buildOutPath = dir ? fileURLToPath(dir) : distRootDir;
        const subDir = options.mxImgSubDir ?? ".mx-img";
        const primaryMxImgDir = join(distRootDir, subDir);

        await buildMxImgAssets({
          rootDir,
          inputDir: options.assetsDir ?? "src/assets/images",
          outDir: primaryMxImgDir,
          umbralRadioCroma: options.umbralRadioCroma ?? 0.15,
        });

        // En Astro hybrid/server `dir` suele apuntar a `dist/client/`; sincronizamos si difiere de `dist/`
        const targetClientMxImgDir = join(buildOutPath, subDir);
        if (
          resolve(targetClientMxImgDir) !== resolve(primaryMxImgDir) &&
          existsSync(primaryMxImgDir)
        ) {
          await mkdir(targetClientMxImgDir, { recursive: true });
          await cp(primaryMxImgDir, targetClientMxImgDir, { recursive: true });
        }

        // Si existe `dist/server/entry.mjs` (ej. @astrojs/node standalone), registrar auto-hook de WebSocket
        const serverEntryPath = join(distRootDir, "server", "entry.mjs");
        if (existsSync(serverEntryPath)) {
          const entryCode = await readFile(serverEntryPath, "utf8");
          if (!entryCode.includes("installMxImgAutoServerHook")) {
            const hookLine = `import { installMxImgAutoServerHook as __mxImgHook } from "mx-img/server";\n__mxImgHook(${JSON.stringify(
              {
                mxImgDir: `dist/${subDir}`,
                fallbackAssetsDir: options.assetsDir ?? "src/assets/images",
              }
            )});\n`;
            await writeFile(serverEntryPath, hookLine + entryCode, "utf8");
          }
        }
      },
    },
  };
}
