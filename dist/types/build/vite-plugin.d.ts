export interface MxImgVitePluginOptions {
    /** Directorio de imágenes fuente a pre-compilar (por defecto `src/assets/images`) */
    assetsDir?: string;
    /** Subdirectorio dentro del `outDir` de Vite donde se emiten los `.mximg` (por defecto `.mx-img`) */
    mxImgSubDir?: string;
    /** Umbral de radio cromático (por defecto `0.15`) */
    umbralRadioCroma?: number;
    /** Tamaño de porción inicial para previsualizaciones en bytes (por defecto 8 KB = 8192) */
    previewBytes?: number;
    /** Etiqueta de salida tras el build (`"canvas"` con `is="mx-img"` o `"mx-img"`) */
    outputTag?: "canvas" | "mx-img";
}
export interface VitePluginLike {
    name: string;
    enforce?: "pre" | "post";
    configResolved?: (config: {
        root?: string;
        build?: {
            outDir?: string;
        };
    }) => Promise<void> | void;
    configureServer?: (server: {
        httpServer?: unknown;
    }) => Promise<void> | void;
    configurePreviewServer?: (server: {
        httpServer?: unknown;
    }) => Promise<void> | void;
    buildStart?: () => Promise<void> | void;
    transformIndexHtml?: (html: string, ctx?: {
        filename?: string;
    }) => Promise<string> | string;
    transform?: (code: string, id: string) => Promise<{
        code: string;
        map: null;
    } | null> | null;
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
export declare function mxImgVitePlugin(options?: MxImgVitePluginOptions): VitePluginLike;
