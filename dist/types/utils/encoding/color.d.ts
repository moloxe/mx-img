import type { RawRgbImage, YCbCrPlanes } from "./types.ts";
/**
 * Convierte una imagen RGB [0, 255] al espacio YCbCr en punto flotante (Float64)
 * siguiendo la matriz estándar ITU-R BT.601 de rango completo:
 *
 *   Y  = 0.299 * R + 0.587 * G + 0.114 * B
 *   Cb = 128.0 - 0.168736 * R - 0.331264 * G + 0.5 * B
 *   Cr = 128.0 + 0.5 * R - 0.418688 * G - 0.081312 * B
 */
export declare function rgbToYCbCr(imgRgb: RawRgbImage): YCbCrPlanes;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const rgb_to_ycbcr: typeof rgbToYCbCr;
/**
 * Convierte los planos YCbCr de vuelta al espacio RGB y recorta al
 * rango válido [0, 255] con redondeo al entero más cercano (uint8):
 *
 *   R = Y + 1.402 * (Cr - 128)
 *   G = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128)
 *   B = Y + 1.772 * (Cb - 128)
 */
export declare function ycbcrToRgb(planes: YCbCrPlanes): RawRgbImage;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const ycbcr_to_rgb: typeof ycbcrToRgb;
/**
 * Calcula el Error Cuadrático Medio (MSE) entre dos imágenes RGB.
 */
export declare function computeMse(original: Uint8Array, reconstructed: Uint8Array): number;
/**
 * Calcula el Peak Signal-to-Noise Ratio (PSNR) en dB entre dos imágenes RGB.
 */
export declare function computePsnr(original: Uint8Array, reconstructed: Uint8Array): number;
