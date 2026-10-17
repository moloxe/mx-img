import sharp from "sharp";
import type { RawRgbImage } from "./types.ts";

export {
  BYTES_PER_COEFFICIENT,
  deserializeFourierStream,
  HEADER_BYTE_LENGTH,
  MXIMG_MAGIC,
  type MxImgHeader,
  parseMxImgHeader,
  serializeFourierStream,
} from "./binary.ts";

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
