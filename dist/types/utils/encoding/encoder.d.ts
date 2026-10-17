import type { EncodedFourierColor1D, RawRgbImage } from "./types.ts";
/**
 * Codifica una imagen RGB a una secuencia 1D continua de coeficientes complejos
 * de Fourier en el espacio YCbCr con entrelazado frecuencial y priorización perceptual.
 *
 * Equivalente directo y optimizado de `encode_fourier_color_1d` en
 * `experiments/notebooks/2026-10-new-format-03.ipynb`:
 *
 * 1. Convierte de RGB a YCbCr (ITU-R BT.601 rango completo en Float64).
 * 2. Calcula por única vez el mapa `ordenRadial` y el corte `kCroma`.
 * 3. Aplica 2D-FFT + `fftshift` a cada canal (Y, Cb, Cr).
 * 4. Entrelaza coeficientes en un único arreglo 1D complejo (`Float64Array` de pares `[re, im]`):
 *    - Tramo 1 (`0 <= k < kCroma`): tuplas contiguas `[Y_k, Cb_k, Cr_k]` (ocupa `3 * kCroma` complejos).
 *    - Tramo 2 (`kCroma <= k < H * W`): solo luminancia `[Y_k]` (ocupa `H * W - kCroma` complejos).
 *
 * @param imgRgb Imagen RGB de entrada (`width`, `height`, `data`).
 * @param umbralRadioCroma Fracción del radio espectral máximo hasta donde se envían Cb y Cr
 *                         (por defecto `0.15` = primer 15% del radio; `1.0` = modo 1:1:1 completo).
 */
export declare function encodeFourierColor1D(imgRgb: RawRgbImage, umbralRadioCroma?: number): EncodedFourierColor1D;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const encode_fourier_color_1d: typeof encodeFourierColor1D;
/**
 * Carga una imagen desde una ruta en disco y la codifica en el flujo 1D de Fourier.
 */
export declare function encodeImageFromFile(imagePath: string, umbralRadioCroma?: number): Promise<{
    encoded: EncodedFourierColor1D;
    imageRgb: RawRgbImage;
}>;
