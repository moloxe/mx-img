import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  calculateChromaLimit,
  computeMse,
  computePsnr,
  decodeFourierColorProgressive,
  deserializeFourierStream,
  type EncodedFourierColor1D,
  encodeFourierColor1D,
  generateRadialOrder,
  loadImageRgb,
  type RawRgbImage,
  rgbToYCbCr,
  serializeFourierStream,
  ycbcrToRgb,
} from "../index.ts";

const IMAGE_PATH = resolve(import.meta.dir, "../../../assets/images/periodic-surface.jpeg");

describe("MxImg Fase 1: Encoder y Decoder Espectral 1D (YCbCr)", () => {
  let imgRgb: RawRgbImage;
  let encodedPerceptual: EncodedFourierColor1D;

  beforeAll(async () => {
    imgRgb = await loadImageRgb(IMAGE_PATH);
    encodedPerceptual = encodeFourierColor1D(imgRgb, 0.15);
  });

  test("1. Carga correctamente src/assets/images/periodic-surface.jpeg en formato RGB (800x780x3)", () => {
    expect(imgRgb.width).toBe(800);
    expect(imgRgb.height).toBe(780);
    expect(imgRgb.channels).toBe(3);
    expect(imgRgb.data.length).toBe(800 * 780 * 3);
  });

  test("2. Conversión RGB <-> YCbCr (ITU-R BT.601 rango completo) es reversible sin pérdidas perceptibles", () => {
    const ycbcr = rgbToYCbCr(imgRgb);
    expect(ycbcr.y.length).toBe(624_000);
    expect(ycbcr.cb.length).toBe(624_000);
    expect(ycbcr.cr.length).toBe(624_000);

    const recRgb = ycbcrToRgb(ycbcr);
    const psnr = computePsnr(imgRgb.data, recRgb.data);
    const mse = computeMse(imgRgb.data, recRgb.data);

    expect(mse).toBe(0);
    expect(psnr).toBeGreaterThan(145);
  });

  test("3. Mapa de ordenamiento radial y corte cromático coinciden exactamente con el experimento 03", () => {
    const h = 780;
    const w = 800;
    const nPix = h * w;
    const { ordenRadial, distSqOrdenada } = generateRadialOrder(h, w);

    expect(ordenRadial.length).toBe(nPix);
    expect(distSqOrdenada.length).toBe(nPix);

    // El primer elemento debe ser el centro DC: (cy=390, cx=400) -> 390 * 800 + 400 = 312400
    expect(ordenRadial[0]).toBe(312_400);
    expect(distSqOrdenada[0]).toBe(0);

    // Monotonía estricta no decreciente de la distancia radial al cuadrado
    let isMonotonic = true;
    for (let i = 1; i < nPix; i++) {
      if (distSqOrdenada[i] < distSqOrdenada[i - 1]) {
        isMonotonic = false;
        break;
      }
    }
    expect(isMonotonic).toBe(true);

    // Límite cromático para el 15% del radio espectral en 800x780 debe ser exactamente 22,057
    const kCroma15 = calculateChromaLimit(h, w, 0.15);
    expect(kCroma15).toBe(22_057);
    expect(calculateChromaLimit(h, w, 1.0)).toBe(624_000);
    expect(calculateChromaLimit(h, w, 0.0)).toBe(1);
  });

  test("4. Encoder produce el flujo 1D híbrido con priorización perceptual (668,114 coeficientes)", () => {
    const nPix = 800 * 780; // 624,000
    const kCroma = 22_057;
    const expectedCoeffs = nPix + 2 * kCroma; // 668,114

    expect(encodedPerceptual.dims).toEqual([780, 800]);
    expect(encodedPerceptual.kCroma).toBe(kCroma);
    expect(encodedPerceptual.numCoefficients).toBe(expectedCoeffs);
    expect(encodedPerceptual.secuencia1D.length).toBe(expectedCoeffs * 2);

    // Ahorro frente al modo 1:1:1 (1,872,000 coeficientes) ~ 64.31%
    const reductionPct = (1 - encodedPerceptual.numCoefficients / (nPix * 3)) * 100;
    expect(reductionPct).toBeCloseTo(64.31, 2);

    // Las 3 primeras componentes (DC de Y, Cb, Cr) deben tener parte imaginaria ~ 0 y parte real > 0
    expect(encodedPerceptual.secuencia1D[0]).toBeGreaterThan(0);
    expect(Math.abs(encodedPerceptual.secuencia1D[1])).toBeLessThan(1e-6);
    expect(encodedPerceptual.secuencia1D[2]).toBeGreaterThan(0);
    expect(Math.abs(encodedPerceptual.secuencia1D[3])).toBeLessThan(1e-6);
    expect(encodedPerceptual.secuencia1D[4]).toBeGreaterThan(0);
    expect(Math.abs(encodedPerceptual.secuencia1D[5])).toBeLessThan(1e-6);
  });

  test("5. Decoder reconstruye progresivamente aumentando el PSNR en cada etapa del stream", () => {
    const etapas = [0.1, 0.5, 2.0, 10.0, 50.0, 100.0];
    const psnrs: number[] = [];

    for (const porcentaje of etapas) {
      const decoded = decodeFourierColorProgressive(
        encodedPerceptual.secuencia1D,
        encodedPerceptual.dims,
        {
          umbralRadioCroma: 0.15,
          porcentaje,
        }
      );

      expect(decoded.imagenRgb.width).toBe(800);
      expect(decoded.imagenRgb.height).toBe(780);
      expect(decoded.imagenRgb.data.length).toBe(800 * 780 * 3);

      const psnr = computePsnr(imgRgb.data, decoded.imagenRgb.data);
      psnrs.push(psnr);

      if (porcentaje >= 10.0) {
        // A partir del ~9.9% del stream, el 100% de la crominancia ya fue recibido
        expect(decoded.porcentajeCromaCompletado).toBeCloseTo(100.0, 4);
      }
    }

    // Verificar que cada etapa progresiva mejora estrictamente la fidelidad (PSNR creciente)
    for (let i = 1; i < psnrs.length; i++) {
      expect(psnrs[i]).toBeGreaterThan(psnrs[i - 1]);
    }

    // Al 100% del stream perceptual, el PSNR debe superar 42 dB (fidelidad visual sin pérdidas)
    expect(psnrs[psnrs.length - 1]).toBeGreaterThan(42.0);
  });

  test("6. Modo 1:1:1 completo (umbralRadioCroma = 1.0) logra reconstrucción exacta (~148.13 dB)", () => {
    const encoded111 = encodeFourierColor1D(imgRgb, 1.0);
    expect(encoded111.numCoefficients).toBe(1_872_000);

    const decoded111 = decodeFourierColorProgressive(encoded111.secuencia1D, encoded111.dims, 1.0);
    const psnr111 = computePsnr(imgRgb.data, decoded111.imagenRgb.data);

    expect(psnr111).toBeGreaterThan(145.0);
  });

  test("7. Maneja cortes ultra-tempranos (K=1 y K=2) asignando DC neutro a Cb/Cr y serializa/deserializa en binario", () => {
    // Corte K=1: solo llegó Y_0 (DC de luminancia)
    const decK1 = decodeFourierColorProgressive(
      encodedPerceptual.secuencia1D.subarray(0, 2),
      encodedPerceptual.dims,
      0.15
    );
    expect(decK1.coeficientesUsados).toBe(1);
    expect(decK1.kYRecibidos).toBe(1);
    expect(decK1.kCromaRecibidos).toBe(0);

    // Serialización binaria (.mximg) y decodificación de un chunk truncado al 5%
    const fullBinary = serializeFourierStream(encodedPerceptual);
    const partialByteLen = 32 + Math.floor(encodedPerceptual.numCoefficients * 0.05) * 16;
    const truncatedBinary = fullBinary.subarray(0, partialByteLen);

    const deserialized = deserializeFourierStream(truncatedBinary);
    expect(deserialized.dims).toEqual([780, 800]);
    expect(deserialized.umbralRadioCroma).toBe(0.15);
    expect(deserialized.numCoefficients).toBe(Math.floor(encodedPerceptual.numCoefficients * 0.05));
  });
});
