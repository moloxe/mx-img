import type { RawRgbImage } from "./types.ts";
export { BYTES_PER_COEFFICIENT, deserializeFourierStream, HEADER_BYTE_LENGTH, MXIMG_MAGIC, type MxImgHeader, parseMxImgHeader, serializeFourierStream, } from "./binary.ts";
/**
 * Carga una imagen desde disco y devuelve sus píxeles crudos en espacio RGB (H x W x 3).
 */
export declare function loadImageRgb(imagePath: string): Promise<RawRgbImage>;
/**
 * Guarda una imagen RGB cruda (`RawRgbImage`) en disco en formato JPEG, PNG o WebP.
 */
export declare function saveImageRgb(image: RawRgbImage, outputPath: string, quality?: number): Promise<void>;
