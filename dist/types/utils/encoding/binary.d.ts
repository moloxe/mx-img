import type { EncodedFourierColor1D, ImageDimensions } from "./types.ts";
/** Magic header de 8 bytes para archivos binarios de stream MxImg ("MXIMG001") */
export declare const MXIMG_MAGIC: Uint8Array<ArrayBuffer>;
/** Longitud fija en bytes de la cabecera de un archivo .mximg */
export declare const HEADER_BYTE_LENGTH = 32;
/** Bytes por cada coeficiente complejo [real: Float64, imag: Float64] */
export declare const BYTES_PER_COEFFICIENT = 16;
/** Metadatos extraídos de la cabecera de 32 bytes de un stream .mximg */
export interface MxImgHeader {
    dims: ImageDimensions;
    height: number;
    width: number;
    umbralRadioCroma: number;
    numCoefficients: number;
    kCroma: number;
    totalExpectedBytes: number;
}
/**
 * Valida y decodifica únicamente los 32 bytes de cabecera de un stream `.mximg`.
 */
export declare function parseMxImgHeader(buffer: Uint8Array): MxImgHeader;
/**
 * Empaqueta un flujo `EncodedFourierColor1D` en un buffer binario con cabecera de 32 bytes
 * seguido de los coeficientes complejos Float64 para transmisión o almacenamiento.
 */
export declare function serializeFourierStream(encoded: EncodedFourierColor1D): Uint8Array;
/**
 * Deserializa un buffer binario `.mximg` (completo o truncado/parcial) a `EncodedFourierColor1D`.
 */
export declare function deserializeFourierStream(buffer: Uint8Array): EncodedFourierColor1D;
