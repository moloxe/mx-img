import type { RawRgbImage, YCbCrPlanes } from "./types.ts";

/**
 * Convierte una imagen RGB [0, 255] al espacio YCbCr en punto flotante (Float64)
 * siguiendo la matriz estándar ITU-R BT.601 de rango completo:
 *
 *   Y  = 0.299 * R + 0.587 * G + 0.114 * B
 *   Cb = 128.0 - 0.168736 * R - 0.331264 * G + 0.5 * B
 *   Cr = 128.0 + 0.5 * R - 0.418688 * G - 0.081312 * B
 */
export function rgbToYCbCr(imgRgb: RawRgbImage): YCbCrPlanes {
  const { data, width, height } = imgRgb;
  const nPix = height * width;

  const y = new Float64Array(nPix);
  const cb = new Float64Array(nPix);
  const cr = new Float64Array(nPix);

  for (let i = 0, p = 0; i < nPix; i++, p += 3) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];

    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  return { y, cb, cr, width, height };
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const rgb_to_ycbcr = rgbToYCbCr;

/**
 * Convierte los planos YCbCr de vuelta al espacio RGB y recorta al
 * rango válido [0, 255] con redondeo al entero más cercano (uint8):
 *
 *   R = Y + 1.402 * (Cr - 128)
 *   G = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128)
 *   B = Y + 1.772 * (Cb - 128)
 */
export function ycbcrToRgb(planes: YCbCrPlanes): RawRgbImage {
  const { y, cb, cr, width, height } = planes;
  const nPix = height * width;
  const data = new Uint8Array(nPix * 3);

  for (let i = 0, p = 0; i < nPix; i++, p += 3) {
    const yVal = y[i];
    const cbShift = cb[i] - 128.0;
    const crShift = cr[i] - 128.0;

    const r = Math.round(yVal + 1.402 * crShift);
    const g = Math.round(yVal - 0.344136 * cbShift - 0.714136 * crShift);
    const b = Math.round(yVal + 1.772 * cbShift);

    data[p] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }

  return { data, width, height, channels: 3 };
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const ycbcr_to_rgb = ycbcrToRgb;

/**
 * Calcula el Error Cuadrático Medio (MSE) entre dos imágenes RGB.
 */
export function computeMse(original: Uint8Array, reconstructed: Uint8Array): number {
  if (original.length !== reconstructed.length) {
    throw new Error(
      `Dimensiones incompatibles para MSE: ${original.length} vs ${reconstructed.length}`
    );
  }
  const len = original.length;
  if (len === 0) return 0;

  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    const diff = original[i] - reconstructed[i];
    sumSq += diff * diff;
  }
  return sumSq / len;
}

/**
 * Calcula el Peak Signal-to-Noise Ratio (PSNR) en dB entre dos imágenes RGB.
 */
export function computePsnr(original: Uint8Array, reconstructed: Uint8Array): number {
  const mse = computeMse(original, reconstructed);
  return 10 * Math.log10((255.0 * 255.0) / (mse + 1e-10));
}
