import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

        if (options.streamUrl && injectScript) {
          injectScript(
            "page",
            `import { init } from "mx-img/client"; init({ streamUrl: ${JSON.stringify(options.streamUrl)} });`
          );
        }
      },

      async "astro:build:done"({ dir }) {
        const buildOutPath = dir ? fileURLToPath(dir) : distRootDir;
        const primaryMxImgDir = join(distRootDir, options.mxImgSubDir ?? ".mx-img");

        await buildMxImgAssets({
          rootDir,
          inputDir: options.assetsDir ?? "src/assets/images",
          outDir: primaryMxImgDir,
          umbralRadioCroma: options.umbralRadioCroma ?? 0.15,
        });

        // En Astro hybrid/server `dir` suele apuntar a `dist/client/`; sincronizamos si difiere de `dist/`
        const targetClientMxImgDir = join(buildOutPath, options.mxImgSubDir ?? ".mx-img");
        if (
          resolve(targetClientMxImgDir) !== resolve(primaryMxImgDir) &&
          existsSync(primaryMxImgDir)
        ) {
          await mkdir(targetClientMxImgDir, { recursive: true });
          await cp(primaryMxImgDir, targetClientMxImgDir, { recursive: true });
        }
      },
    },
  };
}
