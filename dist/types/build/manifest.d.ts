/** Entrada individual en `/dist/.mx-img/manifest.json` */
export interface MxImgManifestEntry {
    /** Hash único determinista de la imagen codificada */
    hash: string;
    /** Nombre del archivo binario dentro de `.mx-img/` (ej. `<hash>.mximg`) */
    fileName: string;
    /** Ruta original normalizada de la imagen fuente */
    sourcePath: string;
    /** Nombre base del archivo original (ej. `periodic-surface.jpeg`) */
    baseName: string;
    /** Ancho de la imagen en píxeles */
    width: number;
    /** Alto de la imagen en píxeles */
    height: number;
    /** Tamaño total en bytes del archivo `.mximg` (cabecera de 32B + payload) */
    totalBytes: number;
    /** Cantidad total de coeficientes complejos 1D */
    numCoefficients: number;
    /** Índice radial límite de crominancia */
    kCroma: number;
    /** Umbral de radio cromático empleado */
    umbralRadioCroma: number;
}
/** Estructura del archivo `/dist/.mx-img/manifest.json` */
export interface MxImgManifest {
    version: 1;
    generatedAt: string;
    entriesByHash: Record<string, MxImgManifestEntry>;
    /** Mapa de alias de rutas/nombres hacia su `hash` para resolución rápida */
    hashBySource: Record<string, string>;
}
/**
 * Calcula un hash SHA-256 determinista de 12 caracteres hexadecimales a partir de los
 * bytes de la imagen original y el parámetro `umbralRadioCroma`.
 */
export declare function computeMxImgHash(imageBytes: Uint8Array, umbralRadioCroma?: number): string;
/**
 * Normaliza una ruta o referencia de imagen para indexarla de forma consistente.
 */
export declare function normalizeSourceRef(ref: string): string;
/**
 * Crea un manifest vacío.
 */
export declare function createEmptyManifest(): MxImgManifest;
/**
 * Registra una entrada en el manifest indexándola por su hash y múltiples alias de ruta
 * (ruta relativa, nombre de archivo, `/assets/images/<nombre>`, etc.).
 */
export declare function registerManifestEntry(manifest: MxImgManifest, entry: MxImgManifestEntry, extraAliases?: string[]): void;
/**
 * Busca una entrada en el manifest ya sea por `hash` directo o por ruta/nombre de imagen.
 */
export declare function resolveManifestEntry(manifest: MxImgManifest, idOrSrc: string): MxImgManifestEntry | undefined;
/**
 * Carga `/dist/.mx-img/manifest.json` si existe, o retorna un manifest vacío.
 */
export declare function loadManifest(mxImgDir: string): Promise<MxImgManifest>;
/**
 * Guarda `/dist/.mx-img/manifest.json` en disco.
 */
export declare function saveManifest(mxImgDir: string, manifest: MxImgManifest): Promise<string>;
