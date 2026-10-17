import { type MxImgHeader } from "./binary.ts";
import type { DecodedFourierColorResult, DecodeProgressiveOptions, ImageDimensions } from "./types.ts";
/**
 * Extrae un prefijo `secuencia[:K]` del flujo 1D según un porcentaje (`0.01 - 100%`)
 * o una cantidad absoluta de coeficientes complejos `K`.
 */
export declare function sliceStreamByProgress(secuencia1D: Float64Array, progreso?: number, maxCoeficientes?: number): {
    slice: Float64Array;
    k: number;
    porcentaje: number;
};
/**
 * Decodifica progresivamente cualquier prefijo `secuenciaParcial` (`secuencia[:K]`)
 * del flujo 1D entrelazado para reconstruir la imagen en color RGB y opcionalmente
 * los espectros 2D parciales centrados `(Y, Cb, Cr)`.
 *
 * Equivalente directo y optimizado de `decode_fourier_color_progresivo` en
 * `experiments/notebooks/2026-10-new-format-03.ipynb`:
 *
 * 1. Reutiliza `ordenRadial` y `kCroma` a partir de `(h, w)`.
 * 2. Inicializa 3 buffers espectrales complejos de ceros de tamaño `H * W`.
 * 3. Desentrelaza las tuplas `[Y_k, Cb_k, Cr_k]` en la zona baja (`< 3 * kCroma`)
 *    e inyecta los coeficientes restantes (`>= 3 * kCroma`) en la luminancia `Y`.
 *    Si `K < 3` y aún no llegó el DC de `Cb` o `Cr`, asigna DC neutro (`128 * H * W`).
 * 4. Ejecuta `ifftshift` + `2D-IFFT` por canal, convierte de YCbCr a RGB y acota a `0..255` (`uint8`).
 */
export declare function decodeFourierColorProgressive(secuenciaParcial: Float64Array, shapeOriginal: ImageDimensions, optionsOrUmbral?: number | DecodeProgressiveOptions): DecodedFourierColorResult;
/** Alias compatible con la nomenclatura del notebook en Python */
export declare const decode_fourier_color_progresivo: typeof decodeFourierColorProgressive;
/**
 * Decodificador incremental de streams `.mximg` para el cliente (`<canvas is="mx-img">`).
 *
 * Acumula porciones binarias (`chunks`) en un buffer continuo del archivo `.mximg`,
 * inyecta únicamente los nuevos coeficientes complejos recibidos en las matrices
 * espectrales `espY`, `espCb` y `espCr`, y genera un buffer RGBA (`Uint8ClampedArray`)
 * listo para `ImageData` en `<canvas>`.
 */
export declare class ProgressiveFourierDecoder {
    private streamBuffer;
    private header;
    private espY;
    private espCb;
    private espCr;
    private ordenRadial;
    private injectedCoefficients;
    private receivedBytes;
    /**
     * Incorpora una porción de bytes en la posición `offsetBytes` del stream `.mximg`.
     */
    appendChunk(chunk: Uint8Array, offsetBytes: number, totalBytes?: number): void;
    getHeader(): MxImgHeader | null;
    getReceivedBytes(): number;
    getInjectedCoefficients(): number;
    /**
     * Inyecta en `espY`, `espCb` y `espCr` todos los coeficientes completos
     * recibidos desde `this.injectedCoefficients` hasta `availableCoeffs`.
     */
    private injectPendingCoefficients;
    /**
     * Ejecuta la 2D-IFFT sobre los espectros acumulados hasta el momento y devuelve
     * un buffer RGBA (`Uint8ClampedArray`) listo para `ctx.putImageData()`.
     */
    decodeToRgba(): {
        rgba: Uint8ClampedArray;
        width: number;
        height: number;
        coeficientesUsados: number;
        totalCoefficients: number;
        porcentajeCompletado: number;
        porcentajeCromaCompletado: number;
    } | null;
}
