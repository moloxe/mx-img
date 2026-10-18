import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, posix } from "node:path";

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
  /** Porción inicial en base64 para previsualización inmediata en el cliente */
  initialChunkBase64?: string;
  /** Cantidad de bytes contenidos en la porción inicial */
  initialChunkBytes?: number;
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
export function computeMxImgHash(imageBytes: Uint8Array, umbralRadioCroma: number = 0.15): string {
  const hash = createHash("sha256");
  hash.update(imageBytes);
  hash.update(`:croma=${umbralRadioCroma.toFixed(4)}`);
  return hash.digest("hex").slice(0, 12);
}

/**
 * Normaliza una ruta o referencia de imagen para indexarla de forma consistente.
 */
export function normalizeSourceRef(ref: string): string {
  const clean = ref.trim().replace(/\\/g, "/").split("?")[0].split("#")[0];
  return posix.normalize(clean);
}

/**
 * Crea un manifest vacío.
 */
export function createEmptyManifest(): MxImgManifest {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entriesByHash: {},
    hashBySource: {},
  };
}

/**
 * Registra una entrada en el manifest indexándola por su hash y múltiples alias de ruta
 * (ruta relativa, nombre de archivo, `/assets/images/<nombre>`, etc.).
 */
export function registerManifestEntry(
  manifest: MxImgManifest,
  entry: MxImgManifestEntry,
  extraAliases: string[] = []
): void {
  manifest.entriesByHash[entry.hash] = entry;
  const aliases = new Set<string>([
    entry.hash,
    entry.sourcePath,
    normalizeSourceRef(entry.sourcePath),
    entry.baseName,
    `/assets/images/${entry.baseName}`,
    `assets/images/${entry.baseName}`,
    `src/assets/images/${entry.baseName}`,
    `/src/assets/images/${entry.baseName}`,
    `../assets/images/${entry.baseName}`,
    `../../assets/images/${entry.baseName}`,
    ...extraAliases.map(normalizeSourceRef),
  ]);

  for (const alias of aliases) {
    if (alias) {
      manifest.hashBySource[alias] = entry.hash;
    }
  }
}

/**
 * Busca una entrada en el manifest ya sea por `hash` directo o por ruta/nombre de imagen.
 */
export function resolveManifestEntry(
  manifest: MxImgManifest,
  idOrSrc: string
): MxImgManifestEntry | undefined {
  const trimmed = idOrSrc.trim();
  if (manifest.entriesByHash[trimmed]) {
    return manifest.entriesByHash[trimmed];
  }

  const normalized = normalizeSourceRef(trimmed);
  const byNormalized = manifest.hashBySource[normalized] ?? manifest.hashBySource[trimmed];
  if (byNormalized && manifest.entriesByHash[byNormalized]) {
    return manifest.entriesByHash[byNormalized];
  }

  const base = basename(normalized);
  const byBase = manifest.hashBySource[base];
  if (byBase && manifest.entriesByHash[byBase]) {
    return manifest.entriesByHash[byBase];
  }

  // Fallback para nombres con hash de bundler (ej. Astro/Vite `/_astro/castle.D8-To9eN.jpg` -> `castle.jpg`)
  const unhashedBase = base.replace(/^(.+)\.[a-zA-Z0-9_-]{6,16}(\.[a-zA-Z0-9]+)$/, "$1$2");
  if (unhashedBase !== base) {
    const byUnhashed = manifest.hashBySource[unhashedBase];
    if (byUnhashed && manifest.entriesByHash[byUnhashed]) {
      return manifest.entriesByHash[byUnhashed];
    }
  }

  return undefined;
}

/**
 * Carga `/dist/.mx-img/manifest.json` si existe, o retorna un manifest vacío.
 */
export async function loadManifest(mxImgDir: string): Promise<MxImgManifest> {
  const manifestPath = join(mxImgDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return createEmptyManifest();
  }
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw) as MxImgManifest;
  } catch {
    return createEmptyManifest();
  }
}

/**
 * Guarda `/dist/.mx-img/manifest.json` en disco.
 */
export async function saveManifest(mxImgDir: string, manifest: MxImgManifest): Promise<string> {
  await mkdir(mxImgDir, { recursive: true });
  manifest.generatedAt = new Date().toISOString();
  const manifestPath = join(mxImgDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}
