import type { RadialOrderMap } from "./types.ts";
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
export declare function generateRadialOrder(h: number, w: number): RadialOrderMap;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const generar_orden_radial: typeof generateRadialOrder;
/**
 * Determina cuántos índices radiales `k_croma` están contenidos dentro de la
 * fracción `umbralRadioCroma` del radio espectral máximo R_max.
 *
 * Equivalente exacto a `calcular_limite_croma(h, w, umbral_radio_croma)` en Python:
 * - Si `umbralRadioCroma >= 1.0` -> retorna `H * W` (modo 1:1:1 completo).
 * - Si `umbralRadioCroma <= 0.0` -> retorna `1` (garantiza al menos componente DC de color).
 * - Usa búsqueda binaria (`searchsorted(..., side='right')`) sobre `distSqOrdenada`.
 */
export declare function calculateChromaLimit(h: number, w: number, umbralRadioCroma?: number): number;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const calcular_limite_croma: typeof calculateChromaLimit;
