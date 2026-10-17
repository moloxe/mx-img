import sharp from "sharp";
import type { EncodedFourierColor1D, RawRgbImage } from "./types.ts";

/** Magic header de 8 bytes para archivos binarios de stream MxImg ("MXIMG001") */
const MXIMG_MAGIC = new Uint8Array([0x4d, 0x58, 0x49, 0x4d, 0x47, 0x30, 0x30, 0x31]);
const HEADER_BYTE_LENGTH = 32;

/**
 * Carga una imagen desde disco y devuelve sus píxeles crudos en espacio RGB (H x W x 3).
 */
export async function loadImageRgb(imagePath: string): Promise<RawRgbImage> {
  const { data, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const nPix = width * height;

  if (channels === 3) {
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width,
      height,
      channels: 3,
    };
  }

  if (channels === 1) {
    const rgb = new Uint8Array(nPix * 3);
    for (let i = 0, p = 0; i < nPix; i++, p += 3) {
      const v = data[i];
      rgb[p] = v;
      rgb[p + 1] = v;
      rgb[p + 2] = v;
    }
    return { data: rgb, width, height, channels: 3 };
  }

  throw new Error(`Número de canales no soportado (${channels}) en ${imagePath}`);
}

/**
 * Guarda una imagen RGB cruda (`RawRgbImage`) en disco en formato JPEG, PNG o WebP.
 */
export async function saveImageRgb(
  image: RawRgbImage,
  outputPath: string,
  quality: number = 95
): Promise<void> {
  const pipeline = sharp(
    Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    {
      raw: {
        width: image.width,
        height: image.height,
        channels: 3,
      },
    }
  );

  if (outputPath.endsWith(".png")) {
    await pipeline.png().toFile(outputPath);
  } else if (outputPath.endsWith(".webp")) {
    await pipeline.webp({ quality }).toFile(outputPath);
  } else {
    await pipeline.jpeg({ quality }).toFile(outputPath);
  }
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
  const kCroma = view.getUint32(28, true);

  const availableBytes = buffer.byteLength - HEADER_BYTE_LENGTH;
  const availableFloats = Math.floor(availableBytes / 16) * 2; // pares [re, im] completos

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
    dims: [height, width],
    umbralRadioCroma,
    kCroma,
  };
}
