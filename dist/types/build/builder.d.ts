import { type MxImgManifest, type MxImgManifestEntry } from "./manifest.ts";
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
export declare function buildSingleMxImgAsset(imagePath: string, outDir: string, manifest: MxImgManifest, options?: {
    rootDir?: string;
    umbralRadioCroma?: number;
    force?: boolean;
    aliases?: string[];
}): Promise<MxImgManifestEntry>;
/**
 * Procesa todas las imágenes del directorio de entrada (o lista de archivos) y genera
 * los assets progresivos en `/dist/.mx-img/<hash>.mximg` junto con `manifest.json`.
 */
export declare function buildMxImgAssets(options?: BuildMxImgOptions): Promise<{
    outDir: string;
    manifestPath: string;
    manifest: MxImgManifest;
    entries: MxImgManifestEntry[];
}>;
/**
 * Transforma etiquetas `<mx-img ...>` y `<canvas is="mx-img" ...>` en código HTML/Astro/JSX
 * reemplazando el atributo `src` por el `hash` generado en `/dist/.mx-img/*` y añadiendo
 * `width` y `height` intrínsecos del canvas si no estaban definidos.
 */
export declare function transformHtmlForMxImg(html: string, manifest: MxImgManifest, options?: {
    outputTag?: "canvas" | "mx-img";
}): {
    html: string;
    replacedCount: number;
};
