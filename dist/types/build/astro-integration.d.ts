import { type MxImgVitePluginOptions } from "./vite-plugin.ts";
export interface MxImgAstroOptions extends MxImgVitePluginOptions {
    /** URL del servicio de streaming para inyectar opcionalmente en el cliente */
    streamUrl?: string;
}
export interface AstroIntegrationLike {
    name: string;
    hooks: {
        "astro:config:setup"?: (params: {
            config: {
                root?: URL;
                outDir?: URL;
                output?: "static" | "server" | "hybrid";
            };
            updateConfig: (newConfig: Record<string, unknown>) => void;
            injectScript?: (stage: string, content: string) => void;
        }) => Promise<void> | void;
        "astro:build:done"?: (params: {
            dir: URL;
        }) => Promise<void> | void;
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
export declare function mxImgAstroIntegration(options?: MxImgAstroOptions): AstroIntegrationLike;
