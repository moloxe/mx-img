import type { EncodedFourierColor1D, ImageDimensions } from "./types.ts";

/** Magic header de 8 bytes para archivos binarios de stream MxImg ("MXIMG001") */
export const MXIMG_MAGIC = new Uint8Array([0x4d, 0x58, 0x49, 0x4d, 0x47, 0x30, 0x30, 0x31]);

/** Longitud fija en bytes de la cabecera de un archivo .mximg */
export const HEADER_BYTE_LENGTH = 32;

/** Bytes por cada coeficiente complejo [real: Float64, imag: Float64] */
export const BYTES_PER_COEFFICIENT = 16;

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
export function parseMxImgHeader(buffer: Uint8Array): MxImgHeader {
  if (buffer.byteLength < HEADER_BYTE_LENGTH) {
    throw new Error("Buffer demasiado corto para contener cabecera MXIMG001");
  }

  for (let i = 0; i < MXIMG_MAGIC.length; i++) {
    if (buffer[i] !== MXIMG_MAGIC[i]) {
      throw new Error("Cabecera mágica inválida: se esperaba MXIMG001");
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, HEADER_BYTE_LENGTH);
  const height = view.getUint32(8, true);
  const width = view.getUint32(12, true);
  const umbralRadioCroma = view.getFloat64(16, true);
  const numCoefficients = view.getUint32(24, true);
  const kCroma = view.getUint32(28, true);

  return {
    dims: [height, width],
    height,
    width,
    umbralRadioCroma,
    numCoefficients,
    kCroma,
    totalExpectedBytes: HEADER_BYTE_LENGTH + numCoefficients * BYTES_PER_COEFFICIENT,
  };
}

/**
 * Empaqueta un flujo `EncodedFourierColor1D` en un buffer binario con cabecera de 32 bytes
 * seguido de los coeficientes complejos Float64 para transmisión o almacenamiento.
 */
export function serializeFourierStream(encoded: EncodedFourierColor1D): Uint8Array {
  const payloadBytes = encoded.secuencia1D.byteLength;
  const output = new Uint8Array(HEADER_BYTE_LENGTH + payloadBytes);
  output.set(MXIMG_MAGIC, 0);

  const view = new DataView(output.buffer, output.byteOffset, HEADER_BYTE_LENGTH);
  view.setUint32(8, encoded.dims[0], true); // height
  view.setUint32(12, encoded.dims[1], true); // width
  view.setFloat64(16, encoded.umbralRadioCroma, true);
  view.setUint32(24, encoded.numCoefficients, true);
  view.setUint32(28, encoded.kCroma, true);

  const coeffBytes = new Uint8Array(
    encoded.secuencia1D.buffer,
    encoded.secuencia1D.byteOffset,
    encoded.secuencia1D.byteLength
  );
  output.set(coeffBytes, HEADER_BYTE_LENGTH);
  return output;
}

/**
 * Deserializa un buffer binario `.mximg` (completo o truncado/parcial) a `EncodedFourierColor1D`.
 */
export function deserializeFourierStream(buffer: Uint8Array): EncodedFourierColor1D {
  const header = parseMxImgHeader(buffer);

  const availableBytes = buffer.byteLength - HEADER_BYTE_LENGTH;
  const availableFloats = Math.floor(availableBytes / BYTES_PER_COEFFICIENT) * 2; // pares [re, im] completos

  const secuencia1D = new Float64Array(availableFloats);
  const dataView = new DataView(
    buffer.buffer,
    buffer.byteOffset + HEADER_BYTE_LENGTH,
    availableFloats * 8
  );
  for (let i = 0; i < availableFloats; i++) {
    secuencia1D[i] = dataView.getFloat64(i * 8, true);
  }

  return {
    secuencia1D,
    numCoefficients: availableFloats / 2,
    dims: header.dims,
    umbralRadioCroma: header.umbralRadioCroma,
    kCroma: header.kCroma,
  };
}
