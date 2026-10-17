/**
 * Motor FFT 1D y 2D de alto rendimiento en coma flotante de 64 bits (Float64Array).
 *
 * Implementa el algoritmo Mixed-Radix Stockham (auto-ordenado, sin bit-reversal)
 * con tablas trigonométricas precalculadas por dimensión N y soporte Bluestein
 * para factores primos arbitrarios, logrando equivalencia numérica exacta con
 * `np.fft.fft2`, `np.fft.ifft2`, `np.fft.fftshift` y `np.fft.ifftshift`.
 */

interface StockhamStage {
  radix: number;
  m: number;
  q: number;
  /** Twiddles entre etapas: [cos, -sin] para u in [1..radix-1], j in [0..m-1] */
  twiddleRe: Float64Array;
  twiddleIm: Float64Array;
  /** Kernel DFT de tamaño radix x radix (para factores primos > 5) */
  kernelRe?: Float64Array;
  kernelIm?: Float64Array;
}

interface BluesteinData {
  mLen: number;
  mPlan: FFT1DPlan;
  chirpRe: Float64Array;
  chirpIm: Float64Array;
  /** conj(FFT(b)) / M precalculado */
  kernelSpecRe: Float64Array;
  kernelSpecIm: Float64Array;
  bufRe: Float64Array;
  bufIm: Float64Array;
  bufScratchRe: Float64Array;
  bufScratchIm: Float64Array;
}

interface FFT1DPlan {
  n: number;
  stages: StockhamStage[];
  bluestein?: BluesteinData;
}

const planCache = new Map<number, FFT1DPlan>();

/**
 * Factoriza `n` priorizando radices 4, 2, 3, 5 y primos impares subsiguientes.
 */
function factorize(n: number): number[] {
  const factors: number[] = [];
  let rem = n;

  while (rem % 4 === 0) {
    factors.push(4);
    rem = Math.floor(rem / 4);
  }
  while (rem % 2 === 0) {
    factors.push(2);
    rem = Math.floor(rem / 2);
  }
  let d = 3;
  while (d * d <= rem) {
    while (rem % d === 0) {
      factors.push(d);
      rem = Math.floor(rem / d);
    }
    d += 2;
  }
  if (rem > 1) {
    factors.push(rem);
  }
  return factors;
}

function nextPowerOfTwo(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/**
 * Construye o recupera de caché el plan Mixed-Radix Stockham (o Bluestein para primos > 13) para longitud `n`.
 */
function getFFT1DPlan(n: number): FFT1DPlan {
  const cached = planCache.get(n);
  if (cached) return cached;

  const factors = factorize(n);
  const maxFactor = factors.reduce((acc, v) => (v > acc ? v : acc), 1);

  if (maxFactor > 13) {
    const mLen = nextPowerOfTwo(2 * n - 1);
    const mPlan = getFFT1DPlan(mLen);
    const chirpRe = new Float64Array(n);
    const chirpIm = new Float64Array(n);
    const bRe = new Float64Array(mLen);
    const bIm = new Float64Array(mLen);
    const bScratchRe = new Float64Array(mLen);
    const bScratchIm = new Float64Array(mLen);

    const twoN = 2 * n;
    for (let k = 0; k < n; k++) {
      const rem = (k * k) % twoN;
      const angle = (Math.PI * rem) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      chirpRe[k] = c;
      chirpIm[k] = -s;
      bRe[k] = c;
      bIm[k] = s;
      if (k > 0) {
        bRe[mLen - k] = c;
        bIm[mLen - k] = s;
      }
    }

    executeFFT1DForward(bRe, bIm, bScratchRe, bScratchIm, mPlan);

    const invM = 1.0 / mLen;
    for (let i = 0; i < mLen; i++) {
      bRe[i] = bRe[i] * invM;
      bIm[i] = -bIm[i] * invM;
    }

    const plan: FFT1DPlan = {
      n,
      stages: [],
      bluestein: {
        mLen,
        mPlan,
        chirpRe,
        chirpIm,
        kernelSpecRe: bRe,
        kernelSpecIm: bIm,
        bufRe: new Float64Array(mLen),
        bufIm: new Float64Array(mLen),
        bufScratchRe: new Float64Array(mLen),
        bufScratchIm: new Float64Array(mLen),
      },
    };
    planCache.set(n, plan);
    return plan;
  }

  const stages: StockhamStage[] = [];
  let m = 1;

  for (const radix of factors) {
    const q = Math.floor(n / (m * radix));
    const twiddleRe = new Float64Array(radix * m);
    const twiddleIm = new Float64Array(radix * m);

    const baseAngle = (-2 * Math.PI) / (m * radix);
    for (let u = 0; u < radix; u++) {
      for (let j = 0; j < m; j++) {
        const angle = baseAngle * u * j;
        twiddleRe[u * m + j] = Math.cos(angle);
        twiddleIm[u * m + j] = Math.sin(angle);
      }
    }

    let kernelRe: Float64Array | undefined;
    let kernelIm: Float64Array | undefined;
    if (radix !== 2 && radix !== 4) {
      kernelRe = new Float64Array(radix * radix);
      kernelIm = new Float64Array(radix * radix);
      const kAngle = (-2 * Math.PI) / radix;
      for (let v = 0; v < radix; v++) {
        for (let u = 0; u < radix; u++) {
          const angle = kAngle * ((u * v) % radix);
          kernelRe[v * radix + u] = Math.cos(angle);
          kernelIm[v * radix + u] = Math.sin(angle);
        }
      }
    }

    stages.push({ radix, m, q, twiddleRe, twiddleIm, kernelRe, kernelIm });
    m *= radix;
  }

  const plan: FFT1DPlan = { n, stages };
  planCache.set(n, plan);
  return plan;
}

/**
 * Ejecuta una FFT 1D directa sobre buffers separados `(re, im)` de longitud `n`,
 * utilizando buffers de trabajo `scratchRe` y `scratchIm`.
 */
function executeFFT1DForward(
  re: Float64Array,
  im: Float64Array,
  scratchRe: Float64Array,
  scratchIm: Float64Array,
  plan: FFT1DPlan
): void {
  if (plan.bluestein) {
    const {
      mLen,
      mPlan,
      chirpRe,
      chirpIm,
      kernelSpecRe,
      kernelSpecIm,
      bufRe,
      bufIm,
      bufScratchRe,
      bufScratchIm,
    } = plan.bluestein;
    const n = plan.n;

    for (let k = 0; k < n; k++) {
      const xr = re[k];
      const xi = im[k];
      const wr = chirpRe[k];
      const wi = chirpIm[k];
      bufRe[k] = xr * wr - xi * wi;
      bufIm[k] = xr * wi + xi * wr;
    }
    bufRe.fill(0, n, mLen);
    bufIm.fill(0, n, mLen);

    executeFFT1DForward(bufRe, bufIm, bufScratchRe, bufScratchIm, mPlan);

    for (let i = 0; i < mLen; i++) {
      const ar = bufRe[i];
      const ai = -bufIm[i];
      const br = kernelSpecRe[i];
      const bi = kernelSpecIm[i];
      bufRe[i] = ar * br - ai * bi;
      bufIm[i] = ar * bi + ai * br;
    }

    executeFFT1DForward(bufRe, bufIm, bufScratchRe, bufScratchIm, mPlan);

    for (let k = 0; k < n; k++) {
      const cr = bufRe[k];
      const ci = -bufIm[k];
      const wr = chirpRe[k];
      const wi = chirpIm[k];
      re[k] = cr * wr - ci * wi;
      im[k] = cr * wi + ci * wr;
    }
    return;
  }

  let inRe = re;
  let inIm = im;
  let outRe = scratchRe;
  let outIm = scratchIm;

  for (let s = 0; s < plan.stages.length; s++) {
    const stage = plan.stages[s];
    const { radix, m, q, twiddleRe, twiddleIm, kernelRe, kernelIm } = stage;
    const qm = q * m;
    const rm = radix * m;

    if (radix === 2) {
      for (let k = 0; k < q; k++) {
        const inBase0 = k * m;
        const inBase1 = inBase0 + qm;
        const outBase0 = k * rm;
        const outBase1 = outBase0 + m;

        for (let j = 0; j < m; j++) {
          const z0Re = inRe[inBase0 + j];
          const z0Im = inIm[inBase0 + j];

          const x1Re = inRe[inBase1 + j];
          const x1Im = inIm[inBase1 + j];
          const wRe = twiddleRe[m + j];
          const wIm = twiddleIm[m + j];

          const z1Re = x1Re * wRe - x1Im * wIm;
          const z1Im = x1Re * wIm + x1Im * wRe;

          outRe[outBase0 + j] = z0Re + z1Re;
          outIm[outBase0 + j] = z0Im + z1Im;
          outRe[outBase1 + j] = z0Re - z1Re;
          outIm[outBase1 + j] = z0Im - z1Im;
        }
      }
    } else if (radix === 4) {
      for (let k = 0; k < q; k++) {
        const inBase0 = k * m;
        const inBase1 = inBase0 + qm;
        const inBase2 = inBase1 + qm;
        const inBase3 = inBase2 + qm;

        const outBase0 = k * rm;
        const outBase1 = outBase0 + m;
        const outBase2 = outBase1 + m;
        const outBase3 = outBase2 + m;

        for (let j = 0; j < m; j++) {
          const z0Re = inRe[inBase0 + j];
          const z0Im = inIm[inBase0 + j];

          const x1Re = inRe[inBase1 + j];
          const x1Im = inIm[inBase1 + j];
          const w1Re = twiddleRe[m + j];
          const w1Im = twiddleIm[m + j];
          const z1Re = x1Re * w1Re - x1Im * w1Im;
          const z1Im = x1Re * w1Im + x1Im * w1Re;

          const x2Re = inRe[inBase2 + j];
          const x2Im = inIm[inBase2 + j];
          const w2Re = twiddleRe[2 * m + j];
          const w2Im = twiddleIm[2 * m + j];
          const z2Re = x2Re * w2Re - x2Im * w2Im;
          const z2Im = x2Re * w2Im + x2Im * w2Re;

          const x3Re = inRe[inBase3 + j];
          const x3Im = inIm[inBase3 + j];
          const w3Re = twiddleRe[3 * m + j];
          const w3Im = twiddleIm[3 * m + j];
          const z3Re = x3Re * w3Re - x3Im * w3Im;
          const z3Im = x3Re * w3Im + x3Im * w3Re;

          const t0Re = z0Re + z2Re;
          const t0Im = z0Im + z2Im;
          const t1Re = z0Re - z2Re;
          const t1Im = z0Im - z2Im;
          const t2Re = z1Re + z3Re;
          const t2Im = z1Im + z3Im;
          const t3Re = z1Re - z3Re;
          const t3Im = z1Im - z3Im;

          // v = 0: t0 + t2
          outRe[outBase0 + j] = t0Re + t2Re;
          outIm[outBase0 + j] = t0Im + t2Im;
          // v = 1: t1 - i * t3 = (t1Re + t3Im) + i * (t1Im - t3Re)
          outRe[outBase1 + j] = t1Re + t3Im;
          outIm[outBase1 + j] = t1Im - t3Re;
          // v = 2: t0 - t2
          outRe[outBase2 + j] = t0Re - t2Re;
          outIm[outBase2 + j] = t0Im - t2Im;
          // v = 3: t1 + i * t3 = (t1Re - t3Im) + i * (t1Im + t3Re)
          outRe[outBase3 + j] = t1Re - t3Im;
          outIm[outBase3 + j] = t1Im + t3Re;
        }
      }
    } else {
      // Radix general (ej. 3, 5, 7, 11, 13) con kernel precalculado
      const kRe = kernelRe!;
      const kIm = kernelIm!;
      const zRe = new Float64Array(radix);
      const zIm = new Float64Array(radix);

      for (let k = 0; k < q; k++) {
        const inBase = k * m;
        const outBase = k * rm;

        for (let j = 0; j < m; j++) {
          zRe[0] = inRe[inBase + j];
          zIm[0] = inIm[inBase + j];

          for (let u = 1; u < radix; u++) {
            const idx = inBase + u * qm + j;
            const xRe = inRe[idx];
            const xIm = inIm[idx];
            const wRe = twiddleRe[u * m + j];
            const wIm = twiddleIm[u * m + j];
            zRe[u] = xRe * wRe - xIm * wIm;
            zIm[u] = xRe * wIm + xIm * wRe;
          }

          for (let v = 0; v < radix; v++) {
            let sumRe = zRe[0];
            let sumIm = zIm[0];
            const vOff = v * radix;
            for (let u = 1; u < radix; u++) {
              const cRe = kRe[vOff + u];
              const cIm = kIm[vOff + u];
              const zuRe = zRe[u];
              const zuIm = zIm[u];
              sumRe += zuRe * cRe - zuIm * cIm;
              sumIm += zuRe * cIm + zuIm * cRe;
            }
            const outIdx = outBase + v * m + j;
            outRe[outIdx] = sumRe;
            outIm[outIdx] = sumIm;
          }
        }
      }
    }

    const tmpRe = inRe;
    const tmpIm = inIm;
    inRe = outRe;
    inIm = outIm;
    outRe = tmpRe;
    outIm = tmpIm;
  }

  // Si el número de etapas fue impar, el resultado quedó en scratch -> copiamos de vuelta a (re, im)
  if (inRe !== re) {
    re.set(inRe);
    im.set(inIm);
  }
}

/**
 * Calcula la 2D-FFT de un canal real de dimensiones `(height, width)` y aplica
 * `fftshift` para centrar la componente DC en `(Math.floor(height/2), Math.floor(width/2))`.
 *
 * Retorna un `Float64Array` entrelazado `[re_0, im_0, re_1, im_1, ...]` de longitud `2 * height * width`.
 */
export function fft2dAndShift(
  realChannel: Float64Array,
  height: number,
  width: number
): Float64Array {
  const nPix = height * width;
  const specRe = new Float64Array(nPix);
  const specIm = new Float64Array(nPix);

  const rowPlan = getFFT1DPlan(width);
  const colPlan = getFFT1DPlan(height);

  const maxDim = Math.max(width, height);
  const lineRe = new Float64Array(maxDim);
  const lineIm = new Float64Array(maxDim);
  const scratchRe = new Float64Array(maxDim);
  const scratchIm = new Float64Array(maxDim);

  const rRe = lineRe.subarray(0, width);
  const rIm = lineIm.subarray(0, width);
  const rScratchRe = scratchRe.subarray(0, width);
  const rScratchIm = scratchIm.subarray(0, width);

  // 1. FFT 1D por filas
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) {
      rRe[x] = realChannel[rowOffset + x];
      rIm[x] = 0.0;
    }
    executeFFT1DForward(rRe, rIm, rScratchRe, rScratchIm, rowPlan);
    for (let x = 0; x < width; x++) {
      specRe[rowOffset + x] = rRe[x];
      specIm[rowOffset + x] = rIm[x];
    }
  }

  const cRe = lineRe.subarray(0, height);
  const cIm = lineIm.subarray(0, height);
  const cScratchRe = scratchRe.subarray(0, height);
  const cScratchIm = scratchIm.subarray(0, height);

  // 2. FFT 1D por columnas + fftshift integrado al escribir el espectro centrado
  const halfH = Math.floor(height / 2);
  const halfW = Math.floor(width / 2);
  const shiftedComplex = new Float64Array(nPix * 2);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      cRe[y] = specRe[idx];
      cIm[y] = specIm[idx];
    }
    executeFFT1DForward(cRe, cIm, cScratchRe, cScratchIm, colPlan);

    // En fftshift: la coordenada (y, x) se desplaza a ((y + halfH) % height, (x + halfW) % width)
    const shiftedX = (x + halfW) % width;
    for (let y = 0; y < height; y++) {
      const shiftedY = (y + halfH) % height;
      const dstOffset = (shiftedY * width + shiftedX) * 2;
      shiftedComplex[dstOffset] = cRe[y];
      shiftedComplex[dstOffset + 1] = cIm[y];
    }
  }

  return shiftedComplex;
}

/**
 * Aplica `ifftshift` y calcula la 2D-IFFT de un espectro complejo centrado `[re, im, ...]`
 * de dimensiones `(height, width)`, retornando la parte real espacial (`Float64Array` de longitud `height * width`).
 */
export function ifftshiftAndIfft2dReal(
  shiftedComplex: Float64Array,
  height: number,
  width: number
): Float64Array {
  const nPix = height * width;
  const specRe = new Float64Array(nPix);
  const specIm = new Float64Array(nPix);

  const rowPlan = getFFT1DPlan(width);
  const colPlan = getFFT1DPlan(height);

  const maxDim = Math.max(width, height);
  const lineRe = new Float64Array(maxDim);
  const lineIm = new Float64Array(maxDim);
  const scratchRe = new Float64Array(maxDim);
  const scratchIm = new Float64Array(maxDim);

  const halfH = Math.floor(height / 2);
  const halfW = Math.floor(width / 2);

  // Propiedad: IFFT(X) = conj(FFT(conj(X))) / (H * W)
  // 1. ifftshift por filas + conjugado + FFT 1D de cada fila
  const rRe = lineRe.subarray(0, width);
  const rIm = lineIm.subarray(0, width);
  const rScratchRe = scratchRe.subarray(0, width);
  const rScratchIm = scratchIm.subarray(0, width);

  for (let y = 0; y < height; y++) {
    // ifftshift: la fila original `y` proviene de `(y + halfH) % height` en el espectro centrado
    const shiftedY = (y + halfH) % height;
    const srcRowBase = shiftedY * width;

    for (let x = 0; x < width; x++) {
      const shiftedX = (x + halfW) % width;
      const srcOffset = (srcRowBase + shiftedX) * 2;
      rRe[x] = shiftedComplex[srcOffset];
      rIm[x] = -shiftedComplex[srcOffset + 1]; // conjugado para IFFT
    }

    executeFFT1DForward(rRe, rIm, rScratchRe, rScratchIm, rowPlan);

    const dstRowBase = y * width;
    for (let x = 0; x < width; x++) {
      specRe[dstRowBase + x] = rRe[x];
      specIm[dstRowBase + x] = rIm[x];
    }
  }

  // 2. FFT 1D por columnas y extracción de la parte real escalada por 1 / (H * W)
  const cRe = lineRe.subarray(0, height);
  const cIm = lineIm.subarray(0, height);
  const cScratchRe = scratchRe.subarray(0, height);
  const cScratchIm = scratchIm.subarray(0, height);

  const realOutput = new Float64Array(nPix);
  const invScale = 1.0 / nPix;

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      cRe[y] = specRe[idx];
      cIm[y] = specIm[idx];
    }

    executeFFT1DForward(cRe, cIm, cScratchRe, cScratchIm, colPlan);

    for (let y = 0; y < height; y++) {
      realOutput[y * width + x] = cRe[y] * invScale;
    }
  }

  return realOutput;
}
