// @bun
// src/build/manifest.ts
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, join, posix } from "path";
function computeMxImgHash(imageBytes, umbralRadioCroma = 0.15) {
  const hash = createHash("sha256");
  hash.update(imageBytes);
  hash.update(`:croma=${umbralRadioCroma.toFixed(4)}`);
  return hash.digest("hex").slice(0, 12);
}
function normalizeSourceRef(ref) {
  const clean = ref.trim().replace(/\\/g, "/").split("?")[0].split("#")[0];
  return posix.normalize(clean);
}
function createEmptyManifest() {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    entriesByHash: {},
    hashBySource: {}
  };
}
function registerManifestEntry(manifest, entry, extraAliases = []) {
  manifest.entriesByHash[entry.hash] = entry;
  const aliases = new Set([
    entry.hash,
    entry.sourcePath,
    normalizeSourceRef(entry.sourcePath),
    entry.baseName,
    `/assets/images/${entry.baseName}`,
    `assets/images/${entry.baseName}`,
    `src/assets/images/${entry.baseName}`,
    `/src/assets/images/${entry.baseName}`,
    `../assets/images/${entry.baseName}`,
    `../../assets/images/${entry.baseName}`,
    ...extraAliases.map(normalizeSourceRef)
  ]);
  for (const alias of aliases) {
    if (alias) {
      manifest.hashBySource[alias] = entry.hash;
    }
  }
}
function resolveManifestEntry(manifest, idOrSrc) {
  const trimmed = idOrSrc.trim();
  if (manifest.entriesByHash[trimmed]) {
    return manifest.entriesByHash[trimmed];
  }
  const normalized = normalizeSourceRef(trimmed);
  const byNormalized = manifest.hashBySource[normalized] ?? manifest.hashBySource[trimmed];
  if (byNormalized && manifest.entriesByHash[byNormalized]) {
    return manifest.entriesByHash[byNormalized];
  }
  const base = basename(normalized);
  const byBase = manifest.hashBySource[base];
  if (byBase && manifest.entriesByHash[byBase]) {
    return manifest.entriesByHash[byBase];
  }
  const unhashedBase = base.replace(/^(.+)\.[a-zA-Z0-9_-]{6,16}(\.[a-zA-Z0-9]+)$/, "$1$2");
  if (unhashedBase !== base) {
    const byUnhashed = manifest.hashBySource[unhashedBase];
    if (byUnhashed && manifest.entriesByHash[byUnhashed]) {
      return manifest.entriesByHash[byUnhashed];
    }
  }
  return;
}
async function loadManifest(mxImgDir) {
  const manifestPath = join(mxImgDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    return createEmptyManifest();
  }
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return createEmptyManifest();
  }
}
async function saveManifest(mxImgDir, manifest) {
  await mkdir(mxImgDir, { recursive: true });
  manifest.generatedAt = new Date().toISOString();
  const manifestPath = join(mxImgDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifestPath;
}
// src/build/builder.ts
import { existsSync as existsSync2 } from "fs";
import { mkdir as mkdir2, readdir, readFile as readFile2, writeFile as writeFile2 } from "fs/promises";
import { basename as basename2, extname, join as join2, relative, resolve } from "path";

// src/utils/encoding/binary.ts
var MXIMG_MAGIC = new Uint8Array([77, 88, 73, 77, 71, 48, 48, 49]);
var HEADER_BYTE_LENGTH = 32;
var BYTES_PER_COEFFICIENT = 16;
function parseMxImgHeader(buffer) {
  if (buffer.byteLength < HEADER_BYTE_LENGTH) {
    throw new Error("Buffer demasiado corto para contener cabecera MXIMG001");
  }
  for (let i = 0;i < MXIMG_MAGIC.length; i++) {
    if (buffer[i] !== MXIMG_MAGIC[i]) {
      throw new Error("Cabecera m\xE1gica inv\xE1lida: se esperaba MXIMG001");
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
    totalExpectedBytes: HEADER_BYTE_LENGTH + numCoefficients * BYTES_PER_COEFFICIENT
  };
}
function serializeFourierStream(encoded) {
  const payloadBytes = encoded.secuencia1D.byteLength;
  const output = new Uint8Array(HEADER_BYTE_LENGTH + payloadBytes);
  output.set(MXIMG_MAGIC, 0);
  const view = new DataView(output.buffer, output.byteOffset, HEADER_BYTE_LENGTH);
  view.setUint32(8, encoded.dims[0], true);
  view.setUint32(12, encoded.dims[1], true);
  view.setFloat64(16, encoded.umbralRadioCroma, true);
  view.setUint32(24, encoded.numCoefficients, true);
  view.setUint32(28, encoded.kCroma, true);
  const coeffBytes = new Uint8Array(encoded.secuencia1D.buffer, encoded.secuencia1D.byteOffset, encoded.secuencia1D.byteLength);
  output.set(coeffBytes, HEADER_BYTE_LENGTH);
  return output;
}

// src/utils/encoding/color.ts
function rgbToYCbCr(imgRgb) {
  const { data, width, height } = imgRgb;
  const nPix = height * width;
  const y = new Float64Array(nPix);
  const cb = new Float64Array(nPix);
  const cr = new Float64Array(nPix);
  for (let i = 0, p = 0;i < nPix; i++, p += 3) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  }
  return { y, cb, cr, width, height };
}

// src/utils/encoding/fft.ts
var planCache = new Map;
function factorize(n) {
  const factors = [];
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
function nextPowerOfTwo(v) {
  let p = 1;
  while (p < v)
    p <<= 1;
  return p;
}
function getFFT1DPlan(n) {
  const cached = planCache.get(n);
  if (cached)
    return cached;
  const factors = factorize(n);
  const maxFactor = factors.reduce((acc, v) => v > acc ? v : acc, 1);
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
    for (let k = 0;k < n; k++) {
      const rem = k * k % twoN;
      const angle = Math.PI * rem / n;
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
    const invM = 1 / mLen;
    for (let i = 0;i < mLen; i++) {
      bRe[i] = bRe[i] * invM;
      bIm[i] = -bIm[i] * invM;
    }
    const plan2 = {
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
        bufScratchIm: new Float64Array(mLen)
      }
    };
    planCache.set(n, plan2);
    return plan2;
  }
  const stages = [];
  let m = 1;
  for (const radix of factors) {
    const q = Math.floor(n / (m * radix));
    const twiddleRe = new Float64Array(radix * m);
    const twiddleIm = new Float64Array(radix * m);
    const baseAngle = -2 * Math.PI / (m * radix);
    for (let u = 0;u < radix; u++) {
      for (let j = 0;j < m; j++) {
        const angle = baseAngle * u * j;
        twiddleRe[u * m + j] = Math.cos(angle);
        twiddleIm[u * m + j] = Math.sin(angle);
      }
    }
    let kernelRe;
    let kernelIm;
    if (radix !== 2 && radix !== 4) {
      kernelRe = new Float64Array(radix * radix);
      kernelIm = new Float64Array(radix * radix);
      const kAngle = -2 * Math.PI / radix;
      for (let v = 0;v < radix; v++) {
        for (let u = 0;u < radix; u++) {
          const angle = kAngle * (u * v % radix);
          kernelRe[v * radix + u] = Math.cos(angle);
          kernelIm[v * radix + u] = Math.sin(angle);
        }
      }
    }
    stages.push({ radix, m, q, twiddleRe, twiddleIm, kernelRe, kernelIm });
    m *= radix;
  }
  const plan = { n, stages };
  planCache.set(n, plan);
  return plan;
}
function executeFFT1DForward(re, im, scratchRe, scratchIm, plan) {
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
      bufScratchIm
    } = plan.bluestein;
    const n = plan.n;
    for (let k = 0;k < n; k++) {
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
    for (let i = 0;i < mLen; i++) {
      const ar = bufRe[i];
      const ai = -bufIm[i];
      const br = kernelSpecRe[i];
      const bi = kernelSpecIm[i];
      bufRe[i] = ar * br - ai * bi;
      bufIm[i] = ar * bi + ai * br;
    }
    executeFFT1DForward(bufRe, bufIm, bufScratchRe, bufScratchIm, mPlan);
    for (let k = 0;k < n; k++) {
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
  for (let s = 0;s < plan.stages.length; s++) {
    const stage = plan.stages[s];
    const { radix, m, q, twiddleRe, twiddleIm, kernelRe, kernelIm } = stage;
    const qm = q * m;
    const rm = radix * m;
    if (radix === 2) {
      for (let k = 0;k < q; k++) {
        const inBase0 = k * m;
        const inBase1 = inBase0 + qm;
        const outBase0 = k * rm;
        const outBase1 = outBase0 + m;
        for (let j = 0;j < m; j++) {
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
      for (let k = 0;k < q; k++) {
        const inBase0 = k * m;
        const inBase1 = inBase0 + qm;
        const inBase2 = inBase1 + qm;
        const inBase3 = inBase2 + qm;
        const outBase0 = k * rm;
        const outBase1 = outBase0 + m;
        const outBase2 = outBase1 + m;
        const outBase3 = outBase2 + m;
        for (let j = 0;j < m; j++) {
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
          outRe[outBase0 + j] = t0Re + t2Re;
          outIm[outBase0 + j] = t0Im + t2Im;
          outRe[outBase1 + j] = t1Re + t3Im;
          outIm[outBase1 + j] = t1Im - t3Re;
          outRe[outBase2 + j] = t0Re - t2Re;
          outIm[outBase2 + j] = t0Im - t2Im;
          outRe[outBase3 + j] = t1Re - t3Im;
          outIm[outBase3 + j] = t1Im + t3Re;
        }
      }
    } else {
      const kRe = kernelRe;
      const kIm = kernelIm;
      const zRe = new Float64Array(radix);
      const zIm = new Float64Array(radix);
      for (let k = 0;k < q; k++) {
        const inBase = k * m;
        const outBase = k * rm;
        for (let j = 0;j < m; j++) {
          zRe[0] = inRe[inBase + j];
          zIm[0] = inIm[inBase + j];
          for (let u = 1;u < radix; u++) {
            const idx = inBase + u * qm + j;
            const xRe = inRe[idx];
            const xIm = inIm[idx];
            const wRe = twiddleRe[u * m + j];
            const wIm = twiddleIm[u * m + j];
            zRe[u] = xRe * wRe - xIm * wIm;
            zIm[u] = xRe * wIm + xIm * wRe;
          }
          for (let v = 0;v < radix; v++) {
            let sumRe = zRe[0];
            let sumIm = zIm[0];
            const vOff = v * radix;
            for (let u = 1;u < radix; u++) {
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
  if (inRe !== re) {
    re.set(inRe);
    im.set(inIm);
  }
}
function fft2dAndShift(realChannel, height, width) {
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
  for (let y = 0;y < height; y++) {
    const rowOffset = y * width;
    for (let x = 0;x < width; x++) {
      rRe[x] = realChannel[rowOffset + x];
      rIm[x] = 0;
    }
    executeFFT1DForward(rRe, rIm, rScratchRe, rScratchIm, rowPlan);
    for (let x = 0;x < width; x++) {
      specRe[rowOffset + x] = rRe[x];
      specIm[rowOffset + x] = rIm[x];
    }
  }
  const cRe = lineRe.subarray(0, height);
  const cIm = lineIm.subarray(0, height);
  const cScratchRe = scratchRe.subarray(0, height);
  const cScratchIm = scratchIm.subarray(0, height);
  const halfH = Math.floor(height / 2);
  const halfW = Math.floor(width / 2);
  const shiftedComplex = new Float64Array(nPix * 2);
  for (let x = 0;x < width; x++) {
    for (let y = 0;y < height; y++) {
      const idx = y * width + x;
      cRe[y] = specRe[idx];
      cIm[y] = specIm[idx];
    }
    executeFFT1DForward(cRe, cIm, cScratchRe, cScratchIm, colPlan);
    const shiftedX = (x + halfW) % width;
    for (let y = 0;y < height; y++) {
      const shiftedY = (y + halfH) % height;
      const dstOffset = (shiftedY * width + shiftedX) * 2;
      shiftedComplex[dstOffset] = cRe[y];
      shiftedComplex[dstOffset + 1] = cIm[y];
    }
  }
  return shiftedComplex;
}

// src/utils/encoding/image-io.ts
import sharp from "sharp";
async function loadImageRgb(imagePath) {
  const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const nPix = width * height;
  if (channels === 3) {
    return {
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      width,
      height,
      channels: 3
    };
  }
  if (channels === 1) {
    const rgb = new Uint8Array(nPix * 3);
    for (let i = 0, p = 0;i < nPix; i++, p += 3) {
      const v = data[i];
      rgb[p] = v;
      rgb[p + 1] = v;
      rgb[p + 2] = v;
    }
    return { data: rgb, width, height, channels: 3 };
  }
  throw new Error(`N\xFAmero de canales no soportado (${channels}) en ${imagePath}`);
}

// src/utils/encoding/radial-order.ts
var radialOrderCache = new Map;
var chromaLimitCache = new Map;
function generateRadialOrder(h, w) {
  const cacheKey = `${h}x${w}`;
  const cached = radialOrderCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const nPix = h * w;
  const cy = Math.floor(h / 2);
  const cx = Math.floor(w / 2);
  const maxDy = Math.max(cy, h - 1 - cy);
  const maxDx = Math.max(cx, w - 1 - cx);
  const maxDistSq = maxDy * maxDy + maxDx * maxDx;
  const distSq = new Int32Array(nPix);
  const theta = new Float64Array(nPix);
  const counts = new Int32Array(maxDistSq + 2);
  let idx = 0;
  for (let y = 0;y < h; y++) {
    const dy = y - cy;
    const dySq = dy * dy;
    for (let x = 0;x < w; x++) {
      const dx = x - cx;
      const d2 = dySq + dx * dx;
      distSq[idx] = d2;
      theta[idx] = Math.atan2(dy, dx);
      counts[d2 + 1]++;
      idx++;
    }
  }
  for (let d = 1;d <= maxDistSq + 1; d++) {
    counts[d] += counts[d - 1];
  }
  const bucketStarts = new Int32Array(counts);
  const ordenRadial = new Int32Array(nPix);
  for (let i = 0;i < nPix; i++) {
    const d2 = distSq[i];
    const pos = counts[d2]++;
    ordenRadial[pos] = i;
  }
  const distSqOrdenada = new Float64Array(nPix);
  for (let d2 = 0;d2 <= maxDistSq; d2++) {
    const start = bucketStarts[d2];
    const end = bucketStarts[d2 + 1];
    if (start >= end)
      continue;
    for (let i = start;i < end; i++) {
      distSqOrdenada[i] = d2;
    }
    for (let i = start + 1;i < end; i++) {
      const currentIdx = ordenRadial[i];
      const currentTheta = theta[currentIdx];
      let j = i - 1;
      while (j >= start && theta[ordenRadial[j]] > currentTheta) {
        ordenRadial[j + 1] = ordenRadial[j];
        j--;
      }
      ordenRadial[j + 1] = currentIdx;
    }
  }
  const result = {
    ordenRadial,
    distSqOrdenada,
    height: h,
    width: w
  };
  if (radialOrderCache.size >= 16) {
    const oldestKey = radialOrderCache.keys().next().value;
    if (oldestKey !== undefined)
      radialOrderCache.delete(oldestKey);
  }
  radialOrderCache.set(cacheKey, result);
  return result;
}
function calculateChromaLimit(h, w, umbralRadioCroma = 0.15) {
  const nPix = h * w;
  if (umbralRadioCroma >= 1) {
    return nPix;
  }
  if (umbralRadioCroma <= 0) {
    return 1;
  }
  const cacheKey = `${h}x${w}:${umbralRadioCroma}`;
  const cached = chromaLimitCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const { distSqOrdenada } = generateRadialOrder(h, w);
  const cy = Math.floor(h / 2);
  const cx = Math.floor(w / 2);
  const rMaxSq = cy * cy + cx * cx;
  const rCromaSq = umbralRadioCroma * umbralRadioCroma * rMaxSq;
  let low = 0;
  let high = nPix;
  while (low < high) {
    const mid = low + high >>> 1;
    if (distSqOrdenada[mid] <= rCromaSq) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const kCroma = Math.max(1, Math.min(nPix, low));
  if (chromaLimitCache.size >= 32) {
    const oldestKey = chromaLimitCache.keys().next().value;
    if (oldestKey !== undefined)
      chromaLimitCache.delete(oldestKey);
  }
  chromaLimitCache.set(cacheKey, kCroma);
  return kCroma;
}

// src/utils/encoding/encoder.ts
function encodeFourierColor1D(imgRgb, umbralRadioCroma = 0.15) {
  const { width: w, height: h } = imgRgb;
  const nPix = h * w;
  const ycbcr = rgbToYCbCr(imgRgb);
  const { ordenRadial } = generateRadialOrder(h, w);
  const kCroma = calculateChromaLimit(h, w, umbralRadioCroma);
  const fY = fft2dAndShift(ycbcr.y, h, w);
  const fCb = fft2dAndShift(ycbcr.cb, h, w);
  const fCr = fft2dAndShift(ycbcr.cr, h, w);
  const totalComplexCoeffs = nPix + 2 * kCroma;
  const secuencia1D = new Float64Array(totalComplexCoeffs * 2);
  let dst = 0;
  for (let k = 0;k < kCroma; k++) {
    const srcOffset = ordenRadial[k] * 2;
    secuencia1D[dst] = fY[srcOffset];
    secuencia1D[dst + 1] = fY[srcOffset + 1];
    secuencia1D[dst + 2] = fCb[srcOffset];
    secuencia1D[dst + 3] = fCb[srcOffset + 1];
    secuencia1D[dst + 4] = fCr[srcOffset];
    secuencia1D[dst + 5] = fCr[srcOffset + 1];
    dst += 6;
  }
  for (let k = kCroma;k < nPix; k++) {
    const srcOffset = ordenRadial[k] * 2;
    secuencia1D[dst] = fY[srcOffset];
    secuencia1D[dst + 1] = fY[srcOffset + 1];
    dst += 2;
  }
  return {
    secuencia1D,
    numCoefficients: totalComplexCoeffs,
    dims: [h, w],
    umbralRadioCroma,
    kCroma
  };
}
async function encodeImageFromFile(imagePath, umbralRadioCroma = 0.15) {
  const imageRgb = await loadImageRgb(imagePath);
  const encoded = encodeFourierColor1D(imageRgb, umbralRadioCroma);
  return { encoded, imageRgb };
}
if (false) {}

// src/build/builder.ts
var SUPPORTED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
async function buildSingleMxImgAsset(imagePath, outDir, manifest, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;
  const absPath = resolve(rootDir, imagePath);
  const rawSourceBytes = new Uint8Array(await readFile2(absPath));
  const hash = computeMxImgHash(rawSourceBytes, umbralRadioCroma);
  const fileName = `${hash}.mximg`;
  const outBinPath = join2(outDir, fileName);
  const relSource = relative(rootDir, absPath).replace(/\\/g, "/");
  const baseName = basename2(absPath);
  await mkdir2(outDir, { recursive: true });
  let entry;
  if (!options.force && existsSync2(outBinPath)) {
    const existingBytes = new Uint8Array(await readFile2(outBinPath));
    const header = parseMxImgHeader(existingBytes);
    entry = {
      hash,
      fileName,
      sourcePath: relSource,
      baseName,
      width: header.width,
      height: header.height,
      totalBytes: existingBytes.byteLength,
      numCoefficients: header.numCoefficients,
      kCroma: header.kCroma,
      umbralRadioCroma: header.umbralRadioCroma
    };
  } else {
    const { encoded } = await encodeImageFromFile(absPath, umbralRadioCroma);
    const binary = serializeFourierStream(encoded);
    await writeFile2(outBinPath, binary);
    entry = {
      hash,
      fileName,
      sourcePath: relSource,
      baseName,
      width: encoded.dims[1],
      height: encoded.dims[0],
      totalBytes: binary.byteLength,
      numCoefficients: encoded.numCoefficients,
      kCroma: encoded.kCroma,
      umbralRadioCroma: encoded.umbralRadioCroma
    };
  }
  registerManifestEntry(manifest, entry, options.aliases ?? []);
  return entry;
}
async function buildMxImgAssets(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const outDir = resolve(rootDir, options.outDir ?? "dist/.mx-img");
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;
  await mkdir2(outDir, { recursive: true });
  const manifest = await loadManifest(outDir);
  let targetFiles = [];
  if (options.files && options.files.length > 0) {
    targetFiles = options.files.map((f) => resolve(rootDir, f));
  } else {
    const inputDir = resolve(rootDir, options.inputDir ?? "src/assets/images");
    if (existsSync2(inputDir)) {
      const dirItems = await readdir(inputDir, { recursive: true });
      targetFiles = dirItems.map((item) => String(item)).filter((name) => SUPPORTED_IMAGE_EXTENSIONS.has(extname(name).toLowerCase())).sort().map((name) => join2(inputDir, name));
    }
  }
  const entries = [];
  for (const filePath of targetFiles) {
    const entry = await buildSingleMxImgAsset(filePath, outDir, manifest, {
      rootDir,
      umbralRadioCroma,
      force: options.force
    });
    entries.push(entry);
  }
  const manifestPath = await saveManifest(outDir, manifest);
  return { outDir, manifestPath, manifest, entries };
}
function transformHtmlForMxImg(html, manifest, options = {}) {
  const outputTag = options.outputTag ?? "canvas";
  let replacedCount = 0;
  const mxImgRegex = /<mx-img\b([^>]*?)(?:\/>|>\s*<\/mx-img>)/gi;
  let result = html.replace(mxImgRegex, (fullMatch, attrsStr) => {
    const srcMatch = attrsStr.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch) {
      if (outputTag === "canvas") {
        replacedCount++;
        const hasIsAttr = /\bis\s*=\s*["']mx-img["']/i.test(attrsStr);
        const isAttr = hasIsAttr ? "" : ` is="mx-img"`;
        return `<canvas${isAttr}${attrsStr}></canvas>`;
      }
      return fullMatch;
    }
    const rawSrc = srcMatch[1];
    const entry = resolveManifestEntry(manifest, rawSrc);
    const resolvedSrc = entry ? entry.hash : rawSrc;
    let updatedAttrs = attrsStr.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, `src="${resolvedSrc}"`);
    if (entry) {
      if (!/\bwidth\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` width="${entry.width}"`;
      }
      if (!/\bheight\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` height="${entry.height}"`;
      }
      if (!/\bdata-mx-original-src\s*=/i.test(updatedAttrs)) {
        updatedAttrs += ` data-mx-original-src="${rawSrc}"`;
      }
    }
    replacedCount++;
    if (outputTag === "canvas") {
      const hasIsAttr = /\bis\s*=\s*["']mx-img["']/i.test(updatedAttrs);
      const isAttr = hasIsAttr ? "" : ` is="mx-img"`;
      return `<canvas${isAttr}${updatedAttrs}></canvas>`;
    }
    return `<mx-img${updatedAttrs}></mx-img>`;
  });
  const canvasMxRegex = /<canvas\b([^>]*?\bis\s*=\s*["']mx-img["'][^>]*?)>\s*<\/canvas>/gi;
  result = result.replace(canvasMxRegex, (fullMatch, attrsStr) => {
    const srcMatch = attrsStr.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch)
      return fullMatch;
    const rawSrc = srcMatch[1];
    const entry = resolveManifestEntry(manifest, rawSrc);
    if (!entry)
      return fullMatch;
    const alreadyHashed = rawSrc === entry.hash;
    const hasWidth = /\bwidth\s*=/i.test(attrsStr);
    const hasHeight = /\bheight\s*=/i.test(attrsStr);
    if (alreadyHashed && hasWidth && hasHeight) {
      return fullMatch;
    }
    let updatedAttrs = attrsStr.replace(/\bsrc\s*=\s*["']([^"']+)["']/i, `src="${entry.hash}"`);
    if (!hasWidth) {
      updatedAttrs += ` width="${entry.width}"`;
    }
    if (!hasHeight) {
      updatedAttrs += ` height="${entry.height}"`;
    }
    replacedCount++;
    return `<canvas${updatedAttrs}></canvas>`;
  });
  if (outputTag === "canvas") {
    const compiledJsxRegex = /\(([\s]*)(["'])mx-img\2(\s*,\s*\{)(?!\s*is\s*:)/g;
    result = result.replace(compiledJsxRegex, (_fullMatch, leadingWs, quote, commaBrace) => {
      replacedCount++;
      return `(${leadingWs}${quote}canvas${quote}${commaBrace} is: ${quote}mx-img${quote}, `;
    });
  }
  return { html: result, replacedCount };
}
if (false) {}
// src/build/vite-plugin.ts
import { existsSync as existsSync4 } from "fs";
import { dirname, join as join4, resolve as resolve3 } from "path";

// src/server/stream-server.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { existsSync as existsSync3 } from "fs";
import { readFile as readFile3 } from "fs/promises";
import { basename as basename3, join as join3, resolve as resolve2 } from "path";

// src/server/protocol.ts
var DEFAULT_CHUNK_SIZE_BYTES = 100 * 1024;
var FRAME_MAGIC = new Uint8Array([77, 88, 67, 72]);
var BASE_ENVELOPE_BYTES = 24;
var FRAME_FLAG_COMPLETED = 1 << 0;
var FRAME_FLAG_HAS_EMBEDDED_HEADER = 1 << 1;
var textEncoder = new TextEncoder;
var textDecoder = new TextDecoder;
function encodeServerChunkFrame(frame) {
  const idBytes = textEncoder.encode(frame.id);
  const hasEmbeddedHeader = frame.embeddedHeader !== undefined && frame.embeddedHeader.byteLength === HEADER_BYTE_LENGTH;
  const embeddedLen = hasEmbeddedHeader ? HEADER_BYTE_LENGTH : 0;
  const totalFrameLen = BASE_ENVELOPE_BYTES + idBytes.byteLength + embeddedLen + frame.payload.byteLength;
  const buffer = new Uint8Array(totalFrameLen);
  buffer.set(FRAME_MAGIC, 0);
  let flags = 0;
  if (frame.isComplete)
    flags |= FRAME_FLAG_COMPLETED;
  if (hasEmbeddedHeader)
    flags |= FRAME_FLAG_HAS_EMBEDDED_HEADER;
  const view = new DataView(buffer.buffer, buffer.byteOffset, BASE_ENVELOPE_BYTES);
  view.setUint8(4, flags);
  view.setUint8(5, 0);
  view.setUint16(6, idBytes.byteLength, true);
  view.setUint32(8, frame.offsetBytes, true);
  view.setUint32(12, frame.deliveredBytes, true);
  view.setUint32(16, frame.targetBytes, true);
  view.setUint32(20, frame.totalAssetBytes, true);
  let cursor = BASE_ENVELOPE_BYTES;
  buffer.set(idBytes, cursor);
  cursor += idBytes.byteLength;
  if (hasEmbeddedHeader && frame.embeddedHeader) {
    buffer.set(frame.embeddedHeader, cursor);
    cursor += HEADER_BYTE_LENGTH;
  }
  buffer.set(frame.payload, cursor);
  return buffer;
}

// src/server/stream-server.ts
function createMxImgStreamEngine(options = {}) {
  const streamPath = options.streamPath ?? "/.mx-img/stream";
  const rootDir = resolve2(options.rootDir ?? process.cwd());
  const mxImgDir = resolve2(rootDir, options.mxImgDir ?? "dist/.mx-img");
  const fallbackAssetsDir = resolve2(rootDir, options.fallbackAssetsDir ?? "src/assets/images");
  const defaultChunkSizeBytes = options.defaultChunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const defaultThrottleDelayMs = options.defaultThrottleDelayMs ?? 1;
  const assetCache = new Map;
  if (options.customAssets) {
    for (const [k, v] of Object.entries(options.customAssets)) {
      assetCache.set(k, v);
    }
  }
  let manifestCache = null;
  async function getManifest() {
    if (!manifestCache) {
      manifestCache = await loadManifest(mxImgDir);
    }
    return manifestCache;
  }
  async function resolveAssetBytes(id) {
    const cleanId = id.trim();
    const cached = assetCache.get(cleanId);
    if (cached) {
      return cached;
    }
    const manifest = await getManifest();
    let entry = resolveManifestEntry(manifest, cleanId);
    if (!entry) {
      manifestCache = await loadManifest(mxImgDir);
      entry = resolveManifestEntry(manifestCache, cleanId);
    }
    if (entry) {
      const bundlePath = join3(mxImgDir, entry.fileName);
      if (existsSync3(bundlePath)) {
        const bytes = new Uint8Array(await readFile3(bundlePath));
        assetCache.set(cleanId, bytes);
        assetCache.set(entry.hash, bytes);
        return bytes;
      }
    }
    const directBundlePath = join3(mxImgDir, cleanId.endsWith(".mximg") ? cleanId : `${cleanId}.mximg`);
    if (existsSync3(directBundlePath)) {
      const bytes = new Uint8Array(await readFile3(directBundlePath));
      assetCache.set(cleanId, bytes);
      return bytes;
    }
    const withoutQuery = cleanId.split("?")[0].split("#")[0].replace(/^\/@fs\//, "/");
    const cleanRel = withoutQuery.replace(/^(\.\.\/)+/, "").replace(/^\//, "");
    const base = basename3(cleanRel);
    const unhashedBase = base.replace(/^(.+)\.[a-zA-Z0-9_-]{6,16}(\.[a-zA-Z0-9]+)$/, "$1$2");
    const candidateSourcePaths = [
      withoutQuery,
      resolve2(rootDir, cleanRel),
      resolve2(rootDir, "src", cleanRel),
      join3(fallbackAssetsDir, base),
      ...unhashedBase !== base ? [join3(fallbackAssetsDir, unhashedBase)] : []
    ];
    for (const candidate of candidateSourcePaths) {
      if (existsSync3(candidate) && !candidate.endsWith(".mximg")) {
        const activeManifest = await getManifest();
        const builtEntry = await buildSingleMxImgAsset(candidate, mxImgDir, activeManifest, {
          rootDir,
          aliases: [cleanId, withoutQuery]
        });
        await saveManifest(mxImgDir, activeManifest);
        const bundlePath = join3(mxImgDir, builtEntry.fileName);
        const bytes = new Uint8Array(await readFile3(bundlePath));
        assetCache.set(cleanId, bytes);
        assetCache.set(builtEntry.hash, bytes);
        return bytes;
      }
    }
    return null;
  }
  function computeTargetBytes(totalBytes, maxPercent, maxBytes) {
    let target = totalBytes;
    if (maxBytes !== undefined && maxBytes > 0) {
      target = Math.min(target, Math.floor(maxBytes));
    }
    if (maxPercent !== undefined && maxPercent > 0 && maxPercent < 100) {
      const payloadBytes = Math.max(0, totalBytes - HEADER_BYTE_LENGTH);
      const rawTargetPayload = Math.floor(payloadBytes * maxPercent / 100);
      const alignedPayload = Math.max(16, Math.floor(rawTargetPayload / 16) * 16);
      target = Math.min(target, Math.min(totalBytes, HEADER_BYTE_LENGTH + alignedPayload));
    }
    return Math.max(Math.min(HEADER_BYTE_LENGTH, totalBytes), target);
  }
  function removeFromActiveQueue(session, id) {
    const idx = session.activeQueue.indexOf(id);
    if (idx !== -1) {
      session.activeQueue.splice(idx, 1);
    }
  }
  function enqueueActiveTask(session, id) {
    if (!session.activeQueue.includes(id)) {
      session.activeQueue.push(id);
    }
  }
  function scheduleNextTurn(ws) {
    const session = ws.data;
    if (session.schedulerRunning) {
      return;
    }
    if (session.activeQueue.length === 0 || session.pendingCommands > 0) {
      return;
    }
    session.schedulerRunning = true;
    session.timer = setTimeout(() => {
      session.schedulerRunning = false;
      session.timer = null;
      if (session.pendingCommands > 0) {
        return;
      }
      processOneRoundRobinTurn(ws);
    }, session.throttleDelayMs);
  }
  function processOneRoundRobinTurn(ws) {
    const session = ws.data;
    if (ws.readyState !== 1 || session.activeQueue.length === 0 || session.pendingCommands > 0) {
      return;
    }
    const id = session.activeQueue.shift();
    const task = session.tasks.get(id);
    if (!task || task.status !== "active") {
      if (session.activeQueue.length > 0) {
        scheduleNextTurn(ws);
      }
      return;
    }
    const remaining = task.targetBytes - task.offsetBytes;
    if (remaining <= 0) {
      task.status = "completed";
      if (session.activeQueue.length > 0) {
        scheduleNextTurn(ws);
      }
      return;
    }
    const sliceLen = Math.min(task.chunkSizeBytes, remaining);
    const chunkStart = task.offsetBytes;
    const chunkEnd = chunkStart + sliceLen;
    const payload = task.assetBytes.subarray(chunkStart, chunkEnd);
    let embeddedHeader;
    if (chunkStart > 0 && !task.sentEmbeddedHeader && task.assetBytes.byteLength >= HEADER_BYTE_LENGTH) {
      embeddedHeader = task.assetBytes.subarray(0, HEADER_BYTE_LENGTH);
      task.sentEmbeddedHeader = true;
    } else if (chunkStart === 0) {
      task.sentEmbeddedHeader = true;
    }
    task.offsetBytes = chunkEnd;
    const isComplete = task.offsetBytes >= task.targetBytes;
    if (isComplete) {
      task.status = "completed";
    } else {
      session.activeQueue.push(id);
    }
    const frameBytes = encodeServerChunkFrame({
      id: task.id,
      offsetBytes: chunkStart,
      deliveredBytes: chunkEnd,
      targetBytes: task.targetBytes,
      totalAssetBytes: task.assetBytes.byteLength,
      isComplete,
      payload,
      embeddedHeader
    });
    ws.sendBinary(frameBytes);
    if (session.activeQueue.length > 0) {
      scheduleNextTurn(ws);
    }
  }
  async function handleClientCommand(ws, cmd) {
    const session = ws.data;
    if (cmd.type === "throttle") {
      session.throttleDelayMs = Math.max(0, cmd.delayMs);
      return;
    }
    if (cmd.type === "pause") {
      const task = session.tasks.get(cmd.id);
      if (task && task.status === "active") {
        task.status = "paused";
        removeFromActiveQueue(session, cmd.id);
      }
      return;
    }
    if (cmd.type === "stop") {
      removeFromActiveQueue(session, cmd.id);
      session.tasks.delete(cmd.id);
      return;
    }
    if (cmd.type === "resume") {
      const task = session.tasks.get(cmd.id);
      if (task) {
        if (cmd.offsetBytes !== undefined && cmd.offsetBytes >= 0) {
          task.offsetBytes = Math.min(cmd.offsetBytes, task.targetBytes);
        }
        if (cmd.maxPercent !== undefined || cmd.maxBytes !== undefined) {
          task.targetBytes = computeTargetBytes(task.assetBytes.byteLength, cmd.maxPercent, cmd.maxBytes);
        }
        if (task.offsetBytes < task.targetBytes) {
          task.status = "active";
          enqueueActiveTask(session, cmd.id);
          scheduleNextTurn(ws);
        } else {
          task.status = "completed";
        }
        return;
      }
      await handleClientCommand(ws, {
        type: "start",
        id: cmd.id,
        offsetBytes: cmd.offsetBytes,
        maxPercent: cmd.maxPercent,
        maxBytes: cmd.maxBytes
      });
      return;
    }
    if (cmd.type === "start") {
      const assetBytes = await resolveAssetBytes(cmd.id);
      if (!assetBytes) {
        const errMsg = {
          type: "error",
          id: cmd.id,
          message: `No se encontr\xF3 el asset MxImg para '${cmd.id}'`
        };
        ws.sendText(JSON.stringify(errMsg));
        return;
      }
      const targetBytes = computeTargetBytes(assetBytes.byteLength, cmd.maxPercent, cmd.maxBytes);
      const startOffset = Math.max(0, Math.min(cmd.offsetBytes ?? 0, targetBytes));
      const chunkSizeBytes = cmd.chunkSize && cmd.chunkSize > 0 ? Math.floor(cmd.chunkSize) : defaultChunkSizeBytes;
      const existing = session.tasks.get(cmd.id);
      const task = {
        id: cmd.id,
        assetBytes,
        offsetBytes: startOffset,
        targetBytes,
        chunkSizeBytes,
        status: startOffset >= targetBytes ? "completed" : "active",
        sentEmbeddedHeader: existing?.sentEmbeddedHeader ?? false
      };
      session.tasks.set(cmd.id, task);
      if (task.status === "active") {
        enqueueActiveTask(session, cmd.id);
        scheduleNextTurn(ws);
      }
    }
  }
  function createSession() {
    return {
      sessionId: randomUUID(),
      tasks: new Map,
      activeQueue: [],
      schedulerRunning: false,
      pendingCommands: 0,
      commandChain: Promise.resolve(),
      throttleDelayMs: defaultThrottleDelayMs,
      timer: null
    };
  }
  function handleIncomingMessage(ws, message) {
    const session = ws.data;
    session.pendingCommands++;
    session.commandChain = session.commandChain.then(async () => {
      try {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const cmd = JSON.parse(text);
        await handleClientCommand(ws, cmd);
      } catch (err) {
        const errMsg = {
          type: "error",
          id: "unknown",
          message: err instanceof Error ? err.message : "Comando inv\xE1lido"
        };
        ws.sendText(JSON.stringify(errMsg));
      } finally {
        session.pendingCommands = Math.max(0, session.pendingCommands - 1);
        if (session.pendingCommands === 0 && session.activeQueue.length > 0) {
          scheduleNextTurn(ws);
        }
      }
    }).catch(() => {
      session.pendingCommands = Math.max(0, session.pendingCommands - 1);
    });
  }
  function cleanupSession(session) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    session.activeQueue.length = 0;
    session.tasks.clear();
  }
  return {
    streamPath,
    assetCache,
    createSession,
    handleIncomingMessage,
    cleanupSession
  };
}
function encodeWsServerFrame(opcode, payload) {
  const len = payload.byteLength;
  let headerLen = 2;
  if (len >= 65536) {
    headerLen = 10;
  } else if (len >= 126) {
    headerLen = 4;
  }
  const out = new Uint8Array(headerLen + len);
  out[0] = 128 | opcode & 15;
  if (len < 126) {
    out[1] = len;
  } else if (len < 65536) {
    out[1] = 126;
    out[2] = len >> 8 & 255;
    out[3] = len & 255;
  } else {
    out[1] = 127;
    const dv = new DataView(out.buffer, out.byteOffset, 10);
    dv.setUint32(2, 0, false);
    dv.setUint32(6, len, false);
  }
  out.set(payload, headerLen);
  return out;
}
var attachedServers = new WeakSet;
function attachMxImgUpgradeHandler(httpServer, options = {}) {
  if (!httpServer || typeof httpServer.on !== "function" || attachedServers.has(httpServer)) {
    return;
  }
  attachedServers.add(httpServer);
  const engine = createMxImgStreamEngine(options);
  const textEncoder2 = new TextEncoder;
  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname !== engine.streamPath) {
        return;
      }
      const key = req.headers["sec-websocket-key"];
      if (!key || typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash2("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r
` + `Upgrade: websocket\r
` + `Connection: Upgrade\r
` + `Sec-WebSocket-Accept: ${accept}\r
\r
`);
      if ("setNoDelay" in socket && typeof socket.setNoDelay === "function") {
        socket.setNoDelay(true);
      }
      const session = engine.createSession();
      let isOpen = true;
      const wsAdapter = {
        data: session,
        get readyState() {
          return isOpen && !socket.destroyed && socket.writable ? 1 : 3;
        },
        sendBinary(data) {
          if (this.readyState === 1) {
            socket.write(encodeWsServerFrame(2, data));
          }
        },
        sendText(text) {
          if (this.readyState === 1) {
            socket.write(encodeWsServerFrame(1, textEncoder2.encode(text)));
          }
        }
      };
      let recvBuf = Buffer.alloc(0);
      const processBuffer = (chunk) => {
        if (chunk.length > 0) {
          recvBuf = recvBuf.length === 0 ? chunk : Buffer.concat([recvBuf, chunk]);
        }
        while (recvBuf.length >= 2) {
          const byte0 = recvBuf[0];
          const byte1 = recvBuf[1];
          const opcode = byte0 & 15;
          const masked = (byte1 & 128) !== 0;
          let payloadLen = byte1 & 127;
          let offset = 2;
          if (payloadLen === 126) {
            if (recvBuf.length < 4)
              return;
            payloadLen = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (recvBuf.length < 10)
              return;
            payloadLen = Number(recvBuf.readBigUInt64BE(2));
            offset = 10;
          }
          const maskLen = masked ? 4 : 0;
          if (recvBuf.length < offset + maskLen + payloadLen) {
            return;
          }
          const maskKey = masked ? recvBuf.subarray(offset, offset + 4) : null;
          offset += maskLen;
          const payload = new Uint8Array(payloadLen);
          payload.set(recvBuf.subarray(offset, offset + payloadLen));
          recvBuf = recvBuf.subarray(offset + payloadLen);
          if (maskKey) {
            for (let i = 0;i < payloadLen; i++) {
              payload[i] ^= maskKey[i & 3];
            }
          }
          if (opcode === 8) {
            isOpen = false;
            engine.cleanupSession(session);
            socket.end(encodeWsServerFrame(8, new Uint8Array(0)));
            return;
          }
          if (opcode === 9) {
            if (wsAdapter.readyState === 1) {
              socket.write(encodeWsServerFrame(10, payload));
            }
            continue;
          }
          if (opcode === 1 || opcode === 2) {
            engine.handleIncomingMessage(wsAdapter, payload);
          }
        }
      };
      if (head && head.length > 0) {
        processBuffer(head);
      }
      socket.on("data", (chunk) => {
        processBuffer(chunk);
      });
      const handleClose = () => {
        isOpen = false;
        engine.cleanupSession(session);
      };
      socket.on("close", handleClose);
      socket.on("end", handleClose);
      socket.on("error", handleClose);
    } catch {
      socket.destroy();
    }
  });
}
if (false) {}

// src/build/vite-plugin.ts
function mxImgVitePlugin(options = {}) {
  let rootDir = process.cwd();
  let outDir = resolve3(rootDir, "dist/.mx-img");
  let manifest = createEmptyManifest();
  const umbralRadioCroma = options.umbralRadioCroma ?? 0.15;
  const mxImgSubDir = options.mxImgSubDir ?? ".mx-img";
  async function ensureReferencedSourcesCompiled(code, importerPath) {
    const tagRegex = /<(?:mx-img|canvas\b[^>]*?\bis\s*=\s*["']mx-img["'])[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*?>/gi;
    const matches = [...code.matchAll(tagRegex)];
    for (const match of matches) {
      const rawSrc = match[1];
      if (!rawSrc || resolveManifestEntry(manifest, rawSrc)) {
        continue;
      }
      const candidatePaths = [];
      if (importerPath) {
        candidatePaths.push(resolve3(dirname(importerPath), rawSrc));
      }
      candidatePaths.push(resolve3(rootDir, rawSrc.replace(/^\//, "")), resolve3(rootDir, "src", rawSrc.replace(/^\//, "")), resolve3(rootDir, options.assetsDir ?? "src/assets/images", rawSrc.split("/").pop() ?? rawSrc));
      for (const candidate of candidatePaths) {
        if (existsSync4(candidate)) {
          await buildSingleMxImgAsset(candidate, outDir, manifest, {
            rootDir,
            umbralRadioCroma,
            aliases: [rawSrc]
          });
          break;
        }
      }
    }
  }
  return {
    name: "vite-plugin-mx-img",
    enforce: "pre",
    async configResolved(config) {
      rootDir = resolve3(config.root ?? process.cwd());
      const viteOutDir = config.build?.outDir ?? "dist";
      outDir = resolve3(rootDir, join4(viteOutDir, mxImgSubDir));
    },
    configureServer(server) {
      attachMxImgUpgradeHandler(server?.httpServer, {
        rootDir,
        mxImgDir: outDir,
        fallbackAssetsDir: options.assetsDir ?? "src/assets/images"
      });
    },
    configurePreviewServer(server) {
      attachMxImgUpgradeHandler(server?.httpServer, {
        rootDir,
        mxImgDir: outDir,
        fallbackAssetsDir: options.assetsDir ?? "src/assets/images"
      });
    },
    async buildStart() {
      const built = await buildMxImgAssets({
        rootDir,
        inputDir: options.assetsDir ?? "src/assets/images",
        outDir,
        umbralRadioCroma
      });
      manifest = built.manifest;
    },
    async transformIndexHtml(html, ctx) {
      await ensureReferencedSourcesCompiled(html, ctx?.filename);
      await saveManifest(outDir, manifest);
      const { html: transformed } = transformHtmlForMxImg(html, manifest, {
        outputTag: options.outputTag ?? "canvas"
      });
      return transformed;
    },
    async transform(code, id) {
      const cleanId = id.split("?")[0];
      if (!/\.(html|astro|jsx|tsx|vue|svelte)$/i.test(cleanId)) {
        return null;
      }
      if (!code.includes("mx-img")) {
        return null;
      }
      await ensureReferencedSourcesCompiled(code, id);
      const { html: transformed, replacedCount } = transformHtmlForMxImg(code, manifest, {
        outputTag: options.outputTag ?? "canvas"
      });
      if (replacedCount === 0) {
        return null;
      }
      await saveManifest(outDir, manifest);
      return { code: transformed, map: null };
    },
    async closeBundle() {
      await saveManifest(outDir, manifest);
    }
  };
}
// src/build/astro-integration.ts
import { cp, mkdir as mkdir3, readFile as readFile4, writeFile as writeFile3 } from "fs/promises";
import { existsSync as existsSync5 } from "fs";
import { join as join5, resolve as resolve4 } from "path";
import { fileURLToPath } from "url";
function mxImgAstroIntegration(options = {}) {
  let rootDir = process.cwd();
  let distRootDir = resolve4(rootDir, "dist");
  return {
    name: "mx-img-astro",
    hooks: {
      async "astro:config:setup"({ config, updateConfig, injectScript }) {
        if (config.root) {
          rootDir = fileURLToPath(config.root);
        }
        if (config.outDir) {
          distRootDir = fileURLToPath(config.outDir);
        } else {
          distRootDir = resolve4(rootDir, "dist");
        }
        const plugin = mxImgVitePlugin({
          ...options,
          mxImgSubDir: options.mxImgSubDir ?? ".mx-img"
        });
        updateConfig({
          vite: {
            plugins: [plugin]
          }
        });
        if (injectScript) {
          const initArg = options.streamUrl ? `{ streamUrl: ${JSON.stringify(options.streamUrl)} }` : "";
          injectScript("before-hydration", `import { registerMxImgElement } from "mx-img/client"; registerMxImgElement();`);
          injectScript("page", `import { init } from "mx-img/client"; init(${initArg}); document.addEventListener("astro:page-load", () => init(${initArg}));`);
        }
      },
      async "astro:server:setup"({ server }) {
        attachMxImgUpgradeHandler(server?.httpServer, {
          rootDir,
          mxImgDir: join5(distRootDir, options.mxImgSubDir ?? ".mx-img"),
          fallbackAssetsDir: options.assetsDir ?? "src/assets/images"
        });
      },
      async "astro:build:done"({ dir }) {
        const buildOutPath = dir ? fileURLToPath(dir) : distRootDir;
        const subDir = options.mxImgSubDir ?? ".mx-img";
        const primaryMxImgDir = join5(distRootDir, subDir);
        await buildMxImgAssets({
          rootDir,
          inputDir: options.assetsDir ?? "src/assets/images",
          outDir: primaryMxImgDir,
          umbralRadioCroma: options.umbralRadioCroma ?? 0.15
        });
        const targetClientMxImgDir = join5(buildOutPath, subDir);
        if (resolve4(targetClientMxImgDir) !== resolve4(primaryMxImgDir) && existsSync5(primaryMxImgDir)) {
          await mkdir3(targetClientMxImgDir, { recursive: true });
          await cp(primaryMxImgDir, targetClientMxImgDir, { recursive: true });
        }
        const serverEntryPath = join5(distRootDir, "server", "entry.mjs");
        if (existsSync5(serverEntryPath)) {
          const entryCode = await readFile4(serverEntryPath, "utf8");
          if (!entryCode.includes("installMxImgAutoServerHook")) {
            const hookLine = `import { installMxImgAutoServerHook as __mxImgHook } from "mx-img/server";
__mxImgHook(${JSON.stringify({
              mxImgDir: `dist/${subDir}`,
              fallbackAssetsDir: options.assetsDir ?? "src/assets/images"
            })});
`;
            await writeFile3(serverEntryPath, hookLine + entryCode, "utf8");
          }
        }
      }
    }
  };
}
export {
  buildMxImgAssets,
  buildSingleMxImgAsset,
  computeMxImgHash,
  createEmptyManifest,
  loadManifest,
  mxImgAstroIntegration,
  mxImgVitePlugin,
  normalizeSourceRef,
  registerManifestEntry,
  resolveManifestEntry,
  saveManifest,
  transformHtmlForMxImg
};
