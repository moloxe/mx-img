/**
 * Motor FFT 1D y 2D de alto rendimiento en coma flotante de 64 bits (Float64Array).
 *
 * Implementa el algoritmo Mixed-Radix Stockham (auto-ordenado, sin bit-reversal)
 * con tablas trigonométricas precalculadas por dimensión N y soporte Bluestein
 * para factores primos arbitrarios, logrando equivalencia numérica exacta con
 * `np.fft.fft2`, `np.fft.ifft2`, `np.fft.fftshift` y `np.fft.ifftshift`.
 */
/**
 * Calcula la 2D-FFT de un canal real de dimensiones `(height, width)` y aplica
 * `fftshift` para centrar la componente DC en `(Math.floor(height/2), Math.floor(width/2))`.
 *
 * Retorna un `Float64Array` entrelazado `[re_0, im_0, re_1, im_1, ...]` de longitud `2 * height * width`.
 */
export declare function fft2dAndShift(realChannel: Float64Array, height: number, width: number): Float64Array;
/**
 * Aplica `ifftshift` y calcula la 2D-IFFT de un espectro complejo centrado `[re, im, ...]`
 * de dimensiones `(height, width)`, retornando la parte real espacial (`Float64Array` de longitud `height * width`).
 */
export declare function ifftshiftAndIfft2dReal(shiftedComplex: Float64Array, height: number, width: number): Float64Array;
