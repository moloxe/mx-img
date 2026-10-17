/**
 * Tipos base para el pipeline de codificación y decodificación progresiva
 * en el dominio de Fourier (<mx-img /> - Fase 1).
 */
/** Dimensiones espaciales de una imagen (alto H y ancho W) */
export type ImageDimensions = [height: number, width: number];
/** Imagen RGB cruda en memoria (buffer entrelazado [R, G, B, ...]) */
export interface RawRgbImage {
    /** Píxeles RGB en rango [0, 255] de longitud height * width * 3 */
    data: Uint8Array;
    width: number;
    height: number;
    channels: 3;
}
/** Canales YCbCr separados en punto flotante de doble precisión (ITU-R BT.601 rango completo) */
export interface YCbCrPlanes {
    y: Float64Array;
    cb: Float64Array;
    cr: Float64Array;
    width: number;
    height: number;
}
/** Resultado del mapa de ordenamiento radial determinista para dimensiones (H, W) */
export interface RadialOrderMap {
    /** Índices 1D (0 .. H*W - 1) ordenados por distancia radial creciente y ángulo polar */
    ordenRadial: Int32Array;
    /** Distancia euclidiana al cuadrado correspondiente a cada posición de `ordenRadial` */
    distSqOrdenada: Float64Array;
    height: number;
    width: number;
}
/**
 * Resultado de `encodeFourierColor1D` (`encode_fourier_color_1d`).
 *
 * `secuencia1D` almacena los coeficientes complejos (complex128) en un `Float64Array`
 * entrelazado de longitud `2 * numCoefficients`: `[real_0, imag_0, real_1, imag_1, ...]`.
 */
export interface EncodedFourierColor1D {
    /** Arreglo contiguo de pares [real, imag] en Float64 (equivalente a np.complex128) */
    secuencia1D: Float64Array;
    /** Cantidad de coeficientes complejos en la secuencia (secuencia1D.length / 2) */
    numCoefficients: number;
    /** Dimensiones espaciales [height, width] */
    dims: ImageDimensions;
    /** Fracción del radio espectral máximo hasta donde se entrelazan Cb y Cr */
    umbralRadioCroma: number;
    /** Índice radial límite k_croma hasta donde se transmiten tuplas [Y_k, Cb_k, Cr_k] */
    kCroma: number;
}
/** Opciones para la decodificación progresiva */
export interface DecodeProgressiveOptions {
    /** Umbral de radio cromático empleado durante la codificación (por defecto 0.15) */
    umbralRadioCroma?: number;
    /**
     * Nivel de progreso a decodificar:
     * - Si se omite, decodifica todos los coeficientes presentes en `secuenciaParcial`.
     * - Puede especificarse como porcentaje (`porcentaje`: 0.01 - 100) o cantidad de coeficientes `k`.
     */
    porcentaje?: number;
    /** Cantidad exacta de coeficientes complejos `K` a tomar del prefijo del stream */
    maxCoeficientes?: number;
    /** Si es true, retorna también los 3 espectros 2D complejos parciales (Y, Cb, Cr) */
    incluirEspectrosParciales?: boolean;
}
/** Resultado de `decodeFourierColorProgressive` (`decode_fourier_color_progresivo`) */
export interface DecodedFourierColorResult {
    /** Imagen RGB reconstruida en formato Uint8Array (H * W * 3) */
    imagenRgb: RawRgbImage;
    /** Cantidad de coeficientes complejos K utilizados en la reconstrucción */
    coeficientesUsados: number;
    /** Coeficientes de luminancia Y recibidos */
    kYRecibidos: number;
    /** Coeficientes de crominancia (por canal Cb/Cr) recibidos */
    kCromaRecibidos: number;
    /** Porcentaje de crominancia completado (0 - 100%) */
    porcentajeCromaCompletado: number;
    /** Espectros 2D parciales centrados [real, imag] por canal (si incluirEspectrosParciales = true) */
    espectrosParciales?: {
        espY2D: Float64Array;
        espCb2D: Float64Array;
        espCr2D: Float64Array;
    };
}
