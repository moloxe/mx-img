import {
  BYTES_PER_COEFFICIENT,
  deserializeFourierStream,
  HEADER_BYTE_LENGTH,
  type MxImgHeader,
  parseMxImgHeader,
} from "./binary.ts";
import { computePsnr, ycbcrToRgb } from "./color.ts";
import { ifftshiftAndIfft2dReal } from "./fft.ts";
import { calculateChromaLimit, generateRadialOrder } from "./radial-order.ts";
import type {
  DecodedFourierColorResult,
  DecodeProgressiveOptions,
  ImageDimensions,
} from "./types.ts";

/**
 * Extrae un prefijo `secuencia[:K]` del flujo 1D según un porcentaje (`0.01 - 100%`)
 * o una cantidad absoluta de coeficientes complejos `K`.
 */
export function sliceStreamByProgress(
  secuencia1D: Float64Array,
  progreso?: number,
  maxCoeficientes?: number
): { slice: Float64Array; k: number; porcentaje: number } {
  const nStream = Math.floor(secuencia1D.length / 2);
  if (nStream === 0) {
    return { slice: secuencia1D.subarray(0, 0), k: 0, porcentaje: 0 };
  }

  let k: number;
  if (maxCoeficientes !== undefined) {
    k = Math.min(nStream, Math.max(1, Math.floor(maxCoeficientes)));
  } else if (progreso !== undefined) {
    if (progreso <= 100.0) {
      const pct = Math.max(0, progreso);
      k = Math.max(3, Math.floor(nStream * (pct / 100.0)));
    } else {
      k = Math.min(nStream, Math.max(3, Math.floor(progreso)));
    }
  } else {
    k = nStream;
  }

  k = Math.min(nStream, Math.max(1, k));
  const porcentaje = (k / nStream) * 100.0;
  return {
    slice: secuencia1D.subarray(0, k * 2),
    k,
    porcentaje,
  };
}

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
export function decodeFourierColorProgressive(
  secuenciaParcial: Float64Array,
  shapeOriginal: ImageDimensions,
  optionsOrUmbral: number | DecodeProgressiveOptions = 0.15
): DecodedFourierColorResult {
  const opts: DecodeProgressiveOptions =
    typeof optionsOrUmbral === "number" ? { umbralRadioCroma: optionsOrUmbral } : optionsOrUmbral;

  const umbralRadioCroma = opts.umbralRadioCroma ?? 0.15;
  const [h, w] = shapeOriginal;
  const nPix = h * w;

  // Si se solicitó recorte por porcentaje o maxCoeficientes sobre el buffer recibido:
  const { slice: activeSlice, k } =
    opts.porcentaje !== undefined || opts.maxCoeficientes !== undefined
      ? sliceStreamByProgress(secuenciaParcial, opts.porcentaje, opts.maxCoeficientes)
      : {
          slice: secuenciaParcial,
          k: Math.floor(secuenciaParcial.length / 2),
        };

  // 1. Reutilizar el orden radial y el límite cromático a partir de (h, w)
  const { ordenRadial } = generateRadialOrder(h, w);
  const kCroma = calculateChromaLimit(h, w, umbralRadioCroma);
  const limiteStreamCroma = 3 * kCroma;

  // 2. Inicializar las 3 matrices complejas 2D centradas llenas de ceros (pares [re, im])
  const espY = new Float64Array(nPix * 2);
  const espCb = new Float64Array(nPix * 2);
  const espCr = new Float64Array(nPix * 2);

  // 3. Repartir coeficientes según el tramo del stream alcanzado por K
  const nTriCoeffs = Math.min(k, limiteStreamCroma);
  let kYLow = 0;
  let kCbLow = 0;
  let kCrLow = 0;

  for (let idx = 0; idx < nTriCoeffs; idx++) {
    const kRad = Math.floor(idx / 3);
    const channelMod = idx % 3;
    const dstOffset = ordenRadial[kRad] * 2;
    const srcOffset = idx * 2;

    if (channelMod === 0) {
      espY[dstOffset] = activeSlice[srcOffset];
      espY[dstOffset + 1] = activeSlice[srcOffset + 1];
      kYLow++;
    } else if (channelMod === 1) {
      espCb[dstOffset] = activeSlice[srcOffset];
      espCb[dstOffset + 1] = activeSlice[srcOffset + 1];
      kCbLow++;
    } else {
      espCr[dstOffset] = activeSlice[srcOffset];
      espCr[dstOffset + 1] = activeSlice[srcOffset + 1];
      kCrLow++;
    }
  }

  // Si K = 1 o K = 2 aún no llegó el coeficiente DC de Cb o Cr; asignamos DC neutro (128 * nPix)
  if (kCbLow === 0) {
    espCb[ordenRadial[0] * 2] = 128.0 * nPix;
  }
  if (kCrLow === 0) {
    espCr[ordenRadial[0] * 2] = 128.0 * nPix;
  }

  // Si K supera la zona entrelazada, el resto pertenece íntegramente a la luminancia Y
  let nHigh = 0;
  if (k > limiteStreamCroma) {
    nHigh = Math.min(k - limiteStreamCroma, nPix - kCroma);
    for (let i = 0; i < nHigh; i++) {
      const dstOffset = ordenRadial[kCroma + i] * 2;
      const srcOffset = (limiteStreamCroma + i) * 2;
      espY[dstOffset] = activeSlice[srcOffset];
      espY[dstOffset + 1] = activeSlice[srcOffset + 1];
    }
  }

  // 4. Aplicar ifftshift + 2D-IFFT a cada canal por separado
  const yRec = ifftshiftAndIfft2dReal(espY, h, w);
  const cbRec = ifftshiftAndIfft2dReal(espCb, h, w);
  const crRec = ifftshiftAndIfft2dReal(espCr, h, w);

  // 5. Convertir de YCbCr a RGB y acotar a [0, 255] uint8
  const imagenRgb = ycbcrToRgb({
    y: yRec,
    cb: cbRec,
    cr: crRec,
    width: w,
    height: h,
  });

  const kYRecibidos = kYLow + nHigh;
  const kCromaRecibidos = kCrLow;
  const porcentajeCromaCompletado = (kCromaRecibidos / kCroma) * 100.0;

  return {
    imagenRgb,
    coeficientesUsados: k,
    kYRecibidos,
    kCromaRecibidos,
    porcentajeCromaCompletado,
    espectrosParciales: opts.incluirEspectrosParciales
      ? {
          espY2D: espY,
          espCb2D: espCb,
          espCr2D: espCr,
        }
      : undefined,
  };
}

/** Alias compatible con la nomenclatura del notebook en Python */
export const decode_fourier_color_progresivo = decodeFourierColorProgressive;

/**
 * Decodificador incremental de streams `.mximg` para el cliente (`<canvas is="mx-img">`).
 *
 * Acumula porciones binarias (`chunks`) en un buffer continuo del archivo `.mximg`,
 * inyecta únicamente los nuevos coeficientes complejos recibidos en las matrices
 * espectrales `espY`, `espCb` y `espCr`, y genera un buffer RGBA (`Uint8ClampedArray`)
 * listo para `ImageData` en `<canvas>`.
 */
export class ProgressiveFourierDecoder {
  private streamBuffer: Uint8Array | null = null;
  private header: MxImgHeader | null = null;
  private espY: Float64Array | null = null;
  private espCb: Float64Array | null = null;
  private espCr: Float64Array | null = null;
  private ordenRadial: Int32Array | null = null;
  private injectedCoefficients = 0;
  private receivedBytes = 0;

  /**
   * Incorpora una porción de bytes en la posición `offsetBytes` del stream `.mximg`.
   */
  public appendChunk(chunk: Uint8Array, offsetBytes: number, totalBytes?: number): void {
    const requiredEnd = offsetBytes + chunk.byteLength;

    if (!this.streamBuffer) {
      const initialCap = totalBytes && totalBytes >= requiredEnd ? totalBytes : requiredEnd;
      this.streamBuffer = new Uint8Array(initialCap);
    } else if (this.streamBuffer.byteLength < requiredEnd) {
      const nextCap = Math.max(requiredEnd, totalBytes ?? 0);
      const next = new Uint8Array(nextCap);
      next.set(this.streamBuffer);
      this.streamBuffer = next;
    }

    this.streamBuffer.set(chunk, offsetBytes);
    if (requiredEnd > this.receivedBytes) {
      this.receivedBytes = requiredEnd;
    }

    if (!this.header && this.receivedBytes >= HEADER_BYTE_LENGTH) {
      this.header = parseMxImgHeader(this.streamBuffer);
      const { height: h, width: w } = this.header;
      const nPix = h * w;
      const { ordenRadial } = generateRadialOrder(h, w);
      this.ordenRadial = ordenRadial;
      this.espY = new Float64Array(nPix * 2);
      this.espCb = new Float64Array(nPix * 2);
      this.espCr = new Float64Array(nPix * 2);

      // DC neutro por defecto hasta que lleguen los primeros coeficientes de crominancia
      this.espCb[ordenRadial[0] * 2] = 128.0 * nPix;
      this.espCr[ordenRadial[0] * 2] = 128.0 * nPix;
    }

    this.injectPendingCoefficients();
  }

  public getHeader(): MxImgHeader | null {
    return this.header;
  }

  public getReceivedBytes(): number {
    return this.receivedBytes;
  }

  public getInjectedCoefficients(): number {
    return this.injectedCoefficients;
  }

  /**
   * Inyecta en `espY`, `espCb` y `espCr` todos los coeficientes completos
   * recibidos desde `this.injectedCoefficients` hasta `availableCoeffs`.
   */
  private injectPendingCoefficients(): void {
    if (
      !this.header ||
      !this.streamBuffer ||
      !this.ordenRadial ||
      !this.espY ||
      !this.espCb ||
      !this.espCr
    ) {
      return;
    }

    const availablePayloadBytes = Math.max(0, this.receivedBytes - HEADER_BYTE_LENGTH);
    const availableCoeffs = Math.min(
      this.header.numCoefficients,
      Math.floor(availablePayloadBytes / BYTES_PER_COEFFICIENT)
    );

    if (availableCoeffs <= this.injectedCoefficients) {
      return;
    }

    const view = new DataView(
      this.streamBuffer.buffer,
      this.streamBuffer.byteOffset + HEADER_BYTE_LENGTH,
      availableCoeffs * BYTES_PER_COEFFICIENT
    );

    const kCroma = this.header.kCroma;
    const limiteStreamCroma = 3 * kCroma;
    const ordenRadial = this.ordenRadial;
    const espY = this.espY;
    const espCb = this.espCb;
    const espCr = this.espCr;

    for (let idx = this.injectedCoefficients; idx < availableCoeffs; idx++) {
      const byteOff = idx * BYTES_PER_COEFFICIENT;
      const re = view.getFloat64(byteOff, true);
      const im = view.getFloat64(byteOff + 8, true);

      if (idx < limiteStreamCroma) {
        const kRad = Math.floor(idx / 3);
        const channelMod = idx % 3;
        const dstOffset = ordenRadial[kRad] * 2;
        if (channelMod === 0) {
          espY[dstOffset] = re;
          espY[dstOffset + 1] = im;
        } else if (channelMod === 1) {
          espCb[dstOffset] = re;
          espCb[dstOffset + 1] = im;
        } else {
          espCr[dstOffset] = re;
          espCr[dstOffset + 1] = im;
        }
      } else {
        const i = idx - limiteStreamCroma;
        const radialIdx = kCroma + i;
        if (radialIdx < ordenRadial.length) {
          const dstOffset = ordenRadial[radialIdx] * 2;
          espY[dstOffset] = re;
          espY[dstOffset + 1] = im;
        }
      }
    }

    this.injectedCoefficients = availableCoeffs;
  }

  /**
   * Ejecuta la 2D-IFFT sobre los espectros acumulados hasta el momento y devuelve
   * un buffer RGBA (`Uint8ClampedArray`) listo para `ctx.putImageData()`.
   */
  public decodeToRgba(): {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    coeficientesUsados: number;
    totalCoefficients: number;
    porcentajeCompletado: number;
    porcentajeCromaCompletado: number;
  } | null {
    if (
      !this.header ||
      !this.espY ||
      !this.espCb ||
      !this.espCr ||
      this.injectedCoefficients === 0
    ) {
      return null;
    }

    const { height: h, width: w, kCroma, numCoefficients } = this.header;
    const nPix = h * w;

    const yRec = ifftshiftAndIfft2dReal(this.espY, h, w);
    const cbRec = ifftshiftAndIfft2dReal(this.espCb, h, w);
    const crRec = ifftshiftAndIfft2dReal(this.espCr, h, w);

    const rgba = new Uint8ClampedArray(nPix * 4);
    for (let i = 0, p = 0; i < nPix; i++, p += 4) {
      const yVal = yRec[i];
      const cbShift = cbRec[i] - 128.0;
      const crShift = crRec[i] - 128.0;

      rgba[p] = Math.round(yVal + 1.402 * crShift);
      rgba[p + 1] = Math.round(yVal - 0.344136 * cbShift - 0.714136 * crShift);
      rgba[p + 2] = Math.round(yVal + 1.772 * cbShift);
      rgba[p + 3] = 255;
    }

    const kCromaRecibidos = Math.min(kCroma, Math.floor(this.injectedCoefficients / 3));
    const porcentajeCromaCompletado = (kCromaRecibidos / kCroma) * 100.0;
    const porcentajeCompletado = (this.injectedCoefficients / numCoefficients) * 100.0;

    return {
      rgba,
      width: w,
      height: h,
      coeficientesUsados: this.injectedCoefficients,
      totalCoefficients: numCoefficients,
      porcentajeCompletado,
      porcentajeCromaCompletado,
    };
  }
}

// Ejecución directa como script desde CLI:
// `bun src/utils/encoding/decoder.ts [inputPath] [porcentaje] [outputImgPath]`
if (import.meta.main) {
  const { resolve } = await import("node:path");
  const { encodeImageFromFile } = await import("./encoder.ts");
  const { saveImageRgb } = await import("./image-io.ts");

  const defaultImgPath = resolve(import.meta.dir, "../../assets/images/periodic-surface.jpeg");
  const inputPath = process.argv[2] ? resolve(process.argv[2]) : defaultImgPath;
  const pctArg = process.argv[3] ? Number.parseFloat(process.argv[3]) : undefined;
  const outputImgPath = process.argv[4] ? resolve(process.argv[4]) : undefined;

  let secuencia1D: Float64Array;
  let dims: ImageDimensions;
  let umbralRadioCroma = 0.15;
  let referenceRgb: Uint8Array | undefined;

  if (inputPath.endsWith(".mximg") || inputPath.endsWith(".bin")) {
    const rawBytes = new Uint8Array(await Bun.file(inputPath).arrayBuffer());
    const parsed = deserializeFourierStream(rawBytes);
    secuencia1D = parsed.secuencia1D;
    dims = parsed.dims;
    umbralRadioCroma = parsed.umbralRadioCroma;
  } else {
    const { encoded, imageRgb } = await encodeImageFromFile(inputPath, umbralRadioCroma);
    secuencia1D = encoded.secuencia1D;
    dims = encoded.dims;
    referenceRgb = imageRgb.data;
  }

  const etapas = pctArg !== undefined ? [pctArg] : [0.1, 0.5, 2.0, 10.0, 50.0, 100.0];

  console.log("=".repeat(88));
  console.log("🧩 MX-IMG DECODER (Bun Runtime) - Reconstrucción Progresiva Multicanal");
  console.log("=".repeat(88));
  console.log(
    `${"Stream %".padEnd(11)} ${"Coefs (K)".padEnd(14)} ${"Luma (Y)".padEnd(12)} ${"Croma %".padEnd(11)} ${"PSNR".padEnd(14)} Tiempo`
  );
  console.log("-".repeat(88));

  for (const pct of etapas) {
    const t0 = performance.now();
    const res = decodeFourierColorProgressive(secuencia1D, dims, {
      umbralRadioCroma,
      porcentaje: pct,
    });
    const dt = performance.now() - t0;

    const psnrStr = referenceRgb
      ? `${computePsnr(referenceRgb, res.imagenRgb.data).toFixed(2)} dB`
      : "N/A";

    console.log(
      `${`${pct.toFixed(2)}%`.padEnd(11)} ${res.coeficientesUsados.toLocaleString().padEnd(14)} ${res.kYRecibidos.toLocaleString().padEnd(12)} ${`${res.porcentajeCromaCompletado.toFixed(1)}%`.padEnd(11)} ${psnrStr.padEnd(14)} ${dt.toFixed(1)} ms`
    );

    if (outputImgPath && etapas.length === 1) {
      await saveImageRgb(res.imagenRgb, outputImgPath);
      console.log(`✅ Imagen reconstruida guardada en: ${outputImgPath}`);
    }
  }
  console.log("=".repeat(88));
}
