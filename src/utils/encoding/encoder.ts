import { resolve } from "node:path";
import { rgbToYCbCr } from "./color.ts";
import { fft2dAndShift } from "./fft.ts";
import { loadImageRgb, serializeFourierStream } from "./image-io.ts";
import { calculateChromaLimit, generateRadialOrder } from "./radial-order.ts";
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
export function encodeFourierColor1D(
  imgRgb: RawRgbImage,
  umbralRadioCroma: number = 0.15
): EncodedFourierColor1D {
  const { width: w, height: h } = imgRgb;
  const nPix = h * w;

  // 1. Convertir de RGB a YCbCr antes de la FFT
  const ycbcr = rgbToYCbCr(imgRgb);

  // 2. Obtener el mapa de ordenamiento radial y el límite de crominancia
  const { ordenRadial } = generateRadialOrder(h, w);
  const kCroma = calculateChromaLimit(h, w, umbralRadioCroma);

  // 3. Aplicar 2D-FFT + fftshift a cada canal
  const fY = fft2dAndShift(ycbcr.y, h, w);
  const fCb = fft2dAndShift(ycbcr.cb, h, w);
  const fCr = fft2dAndShift(ycbcr.cr, h, w);

  // 4. Entrelazar coeficientes:
  //    - Hasta kCroma: tuplas contiguas [Y_k, Cb_k, Cr_k]
  //    - Desde kCroma en adelante: únicamente coeficientes [Y_k]
  const totalComplexCoeffs = nPix + 2 * kCroma;
  const secuencia1D = new Float64Array(totalComplexCoeffs * 2);

  // Tramo 1: Núcleo tricromático [Y_k, Cb_k, Cr_k]
  let dst = 0;
  for (let k = 0; k < kCroma; k++) {
    const srcOffset = ordenRadial[k] * 2;

    // Y_k
    secuencia1D[dst] = fY[srcOffset];
    secuencia1D[dst + 1] = fY[srcOffset + 1];
    // Cb_k
    secuencia1D[dst + 2] = fCb[srcOffset];
    secuencia1D[dst + 3] = fCb[srcOffset + 1];
    // Cr_k
    secuencia1D[dst + 4] = fCr[srcOffset];
    secuencia1D[dst + 5] = fCr[srcOffset + 1];

    dst += 6;
  }

  // Tramo 2: Periferia de media y alta frecuencia [Y_k]
  for (let k = kCroma; k < nPix; k++) {
    const srcOffset = ordenRadial[k] * 2;
    secuencia1D[dst] = fY[srcOffset];
    secuencia1D[dst + 1] = fY[srcOffset + 1];
    dst += 2;
  }

  return {
    secuencia1D,
    numCoefficients: totalComplexCoeffs,
    dims: [h, w],
    umbralRadioCroma,
    kCroma,
  };
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const encode_fourier_color_1d = encodeFourierColor1D;

/**
 * Carga una imagen desde una ruta en disco y la codifica en el flujo 1D de Fourier.
 */
export async function encodeImageFromFile(
  imagePath: string,
  umbralRadioCroma: number = 0.15
): Promise<{ encoded: EncodedFourierColor1D; imageRgb: RawRgbImage }> {
  const imageRgb = await loadImageRgb(imagePath);
  const encoded = encodeFourierColor1D(imageRgb, umbralRadioCroma);
  return { encoded, imageRgb };
}

// Ejecución directa como script desde CLI: `bun src/utils/encoding/encoder.ts [imgPath] [umbral] [outPath]`
if (import.meta.main) {
  const defaultImgPath = resolve(import.meta.dir, "../../assets/images/periodic-surface.jpeg");
  const imgPath = process.argv[2] ? resolve(process.argv[2]) : defaultImgPath;
  const umbral = process.argv[3] ? Number.parseFloat(process.argv[3]) : 0.15;
  const outputBinPath = process.argv[4] ? resolve(process.argv[4]) : undefined;

  const t0 = performance.now();
  const { encoded } = await encodeImageFromFile(imgPath, umbral);
  const elapsedMs = performance.now() - t0;

  const [h, w] = encoded.dims;
  const nPix = h * w;
  const n111 = nPix * 3;
  const sizeMb = encoded.secuencia1D.byteLength / (1024 * 1024);
  const savingPct = (1 - encoded.numCoefficients / n111) * 100;

  console.log("=".repeat(80));
  console.log("📦 MX-IMG ENCODER (Bun Runtime) - Flujo 1D Espectral YCbCr");
  console.log("=".repeat(80));
  console.log(`• Imagen de entrada             : ${imgPath}`);
  console.log(`• Dimensiones (W × H × C)       : ${w} × ${h} × 3 (${nPix.toLocaleString()} px)`);
  console.log(
    `• Umbral radio croma            : ${(umbral * 100).toFixed(1)}% (k_croma = ${encoded.kCroma.toLocaleString()})`
  );
  console.log(
    `• Coeficientes complejos 1D     : ${encoded.numCoefficients.toLocaleString()} (${sizeMb.toFixed(2)} MB)`
  );
  console.log(`• Reducción frente a modo 1:1:1 : -${savingPct.toFixed(2)}%`);
  console.log(`• Tiempo de codificación        : ${elapsedMs.toFixed(1)} ms`);
  console.log("=".repeat(80));

  if (outputBinPath) {
    const bin = serializeFourierStream(encoded);
    await Bun.write(outputBinPath, bin);
    console.log(
      `✅ Stream binario guardado en: ${outputBinPath} (${(bin.byteLength / (1024 * 1024)).toFixed(2)} MB)`
    );
  }
}
