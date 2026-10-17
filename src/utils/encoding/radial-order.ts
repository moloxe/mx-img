import type { RadialOrderMap } from "./types.ts";

/** Caché en memoria para el mapa de ordenamiento radial por dimensión "HxW" */
const radialOrderCache = new Map<string, RadialOrderMap>();

/** Caché en memoria para el límite de crominancia por clave "HxW:umbral" */
const chromaLimitCache = new Map<string, number>();

/**
 * Genera por única vez el vector determinista de índices 1D `ordenRadial` para
 * dimensiones `(h, w)`, junto con el arreglo de distancias al cuadrado ordenadas.
 *
 * Equivalente exacto en TypeScript a `generar_orden_radial(h, w)` del notebook:
 * - Ordena primero por distancia euclidiana al cuadrado `dist_sq = (y - cy)^2 + (x - cx)^2`
 * - Desempata por ángulo polar `theta = atan2(y - cy, x - cx)`
 * - Emplea Counting Sort por `dist_sq` entero + Insertion Sort por `theta` dentro de cada anillo,
 *   logrando complejidad O(H * W) en lugar de O(N log N).
 */
export function generateRadialOrder(h: number, w: number): RadialOrderMap {
  const cacheKey = `${h}x${w}`;
  const cached = radialOrderCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const nPix = h * w;
  const cy = Math.floor(h / 2);
  const cx = Math.floor(w / 2);

  // Máxima distancia al cuadrado posible en la grilla
  const maxDy = Math.max(cy, h - 1 - cy);
  const maxDx = Math.max(cx, w - 1 - cx);
  const maxDistSq = maxDy * maxDy + maxDx * maxDx;

  const distSq = new Int32Array(nPix);
  const theta = new Float64Array(nPix);
  const counts = new Int32Array(maxDistSq + 2);

  // 1. Calcular dist_sq y theta para cada coordenada (y, x) y contar frecuencias por dist_sq
  let idx = 0;
  for (let y = 0; y < h; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const d2 = dySq + dx * dx;
      distSq[idx] = d2;
      theta[idx] = Math.atan2(dy, dx);
      counts[d2 + 1]++;
      idx++;
    }
  }

  // 2. Acumular offsets de buckets por dist_sq
  for (let d = 1; d <= maxDistSq + 1; d++) {
    counts[d] += counts[d - 1];
  }

  //Copia de inicios de bucket para ordenar cada anillo por theta
  const bucketStarts = new Int32Array(counts);
  const ordenRadial = new Int32Array(nPix);

  // 3. Distribuir cada índice lineal en su bucket de dist_sq
  for (let i = 0; i < nPix; i++) {
    const d2 = distSq[i];
    const pos = counts[d2]++;
    ordenRadial[pos] = i;
  }

  // 4. Dentro de cada anillo de igual dist_sq, ordenar por theta ascendente (Insertion Sort)
  const distSqOrdenada = new Float64Array(nPix);
  for (let d2 = 0; d2 <= maxDistSq; d2++) {
    const start = bucketStarts[d2];
    const end = bucketStarts[d2 + 1];
    if (start >= end) continue;

    for (let i = start; i < end; i++) {
      distSqOrdenada[i] = d2;
    }

    // Insertion sort estable sobre el pequeño grupo de puntos del mismo radio
    for (let i = start + 1; i < end; i++) {
      const currentIdx = ordenRadial[i];
      const currentTheta = theta[currentIdx];
      let j = i - 1;
      while (j >= start && theta[ordenRadial[j]] > currentTheta) {
        ordenRadial[j + 1] = ordenRadial[j];
        j--;
      }
      ordenRadial[j + 1] = currentIdx;
    }
  }

  const result: RadialOrderMap = {
    ordenRadial,
    distSqOrdenada,
    height: h,
    width: w,
  };

  if (radialOrderCache.size >= 16) {
    const oldestKey = radialOrderCache.keys().next().value;
    if (oldestKey !== undefined) radialOrderCache.delete(oldestKey);
  }
  radialOrderCache.set(cacheKey, result);

  return result;
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const generar_orden_radial = generateRadialOrder;

/**
 * Determina cuántos índices radiales `k_croma` están contenidos dentro de la
 * fracción `umbralRadioCroma` del radio espectral máximo R_max.
 *
 * Equivalente exacto a `calcular_limite_croma(h, w, umbral_radio_croma)` en Python:
 * - Si `umbralRadioCroma >= 1.0` -> retorna `H * W` (modo 1:1:1 completo).
 * - Si `umbralRadioCroma <= 0.0` -> retorna `1` (garantiza al menos componente DC de color).
 * - Usa búsqueda binaria (`searchsorted(..., side='right')`) sobre `distSqOrdenada`.
 */
export function calculateChromaLimit(
  h: number,
  w: number,
  umbralRadioCroma: number = 0.15
): number {
  const nPix = h * w;
  if (umbralRadioCroma >= 1.0) {
    return nPix;
  }
  if (umbralRadioCroma <= 0.0) {
    return 1;
  }

  const cacheKey = `${h}x${w}:${umbralRadioCroma}`;
  const cached = chromaLimitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const { distSqOrdenada } = generateRadialOrder(h, w);
  const cy = Math.floor(h / 2);
  const cx = Math.floor(w / 2);
  const rMaxSq = cy * cy + cx * cx;
  const rCromaSq = umbralRadioCroma * umbralRadioCroma * rMaxSq;

  // Búsqueda binaria equivalente a np.searchsorted(dist_sq_ordenada, r_croma_sq, side='right')
  let low = 0;
  let high = nPix;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (distSqOrdenada[mid] <= rCromaSq) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  const kCroma = Math.max(1, Math.min(nPix, low));

  if (chromaLimitCache.size >= 32) {
    const oldestKey = chromaLimitCache.keys().next().value;
    if (oldestKey !== undefined) chromaLimitCache.delete(oldestKey);
  }
  chromaLimitCache.set(cacheKey, kCroma);

  return kCroma;
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const calcular_limite_croma = calculateChromaLimit;
