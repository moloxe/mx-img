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
function getFFT1DPlan(n) {
  const cached = planCache.get(n);
  if (cached)
    return cached;
  const factors = factorize(n);
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
      const dirItems = await readdir(inputDir);
      targetFiles = dirItems.filter((name) => SUPPORTED_IMAGE_EXTENSIONS.has(extname(name).toLowerCase())).sort().map((name) => join2(inputDir, name));
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
  const mxImgRegex = /<mx-img\b([^>]*?)(?:\/>|><\/mx-img>)/gi;
  let result = html.replace(mxImgRegex, (fullMatch, attrsStr) => {
    const srcMatch = attrsStr.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!srcMatch)
      return fullMatch;
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
  const canvasMxRegex = /<canvas\b([^>]*?\bis\s*=\s*["']mx-img["'][^>]*?)><\/canvas>/gi;
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
  return { html: result, replacedCount };
}
if (false) {}
// src/build/vite-plugin.ts
import { existsSync as existsSync3 } from "fs";
import { dirname, join as join3, resolve as resolve2 } from "path";
function mxImgVitePlugin(options = {}) {
  let rootDir = process.cwd();
  let outDir = resolve2(rootDir, "dist/.mx-img");
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
        candidatePaths.push(resolve2(dirname(importerPath), rawSrc));
      }
      candidatePaths.push(resolve2(rootDir, rawSrc.replace(/^\//, "")), resolve2(rootDir, "src", rawSrc.replace(/^\//, "")), resolve2(rootDir, options.assetsDir ?? "src/assets/images", rawSrc.split("/").pop() ?? rawSrc));
      for (const candidate of candidatePaths) {
        if (existsSync3(candidate)) {
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
      rootDir = resolve2(config.root ?? process.cwd());
      const viteOutDir = config.build?.outDir ?? "dist";
      outDir = resolve2(rootDir, join3(viteOutDir, mxImgSubDir));
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
      if (!/\.(html|astro|jsx|tsx|vue|svelte)$/i.test(id)) {
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
import { cp, mkdir as mkdir3 } from "fs/promises";
import { existsSync as existsSync4 } from "fs";
import { join as join4, resolve as resolve3 } from "path";
import { fileURLToPath } from "url";
function mxImgAstroIntegration(options = {}) {
  let rootDir = process.cwd();
  let distRootDir = resolve3(rootDir, "dist");
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
          distRootDir = resolve3(rootDir, "dist");
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
        if (options.streamUrl && injectScript) {
          injectScript("page", `import { init } from "mx-img/client"; init({ streamUrl: ${JSON.stringify(options.streamUrl)} });`);
        }
      },
      async "astro:build:done"({ dir }) {
        const buildOutPath = dir ? fileURLToPath(dir) : distRootDir;
        const primaryMxImgDir = join4(distRootDir, options.mxImgSubDir ?? ".mx-img");
        await buildMxImgAssets({
          rootDir,
          inputDir: options.assetsDir ?? "src/assets/images",
          outDir: primaryMxImgDir,
          umbralRadioCroma: options.umbralRadioCroma ?? 0.15
        });
        const targetClientMxImgDir = join4(buildOutPath, options.mxImgSubDir ?? ".mx-img");
        if (resolve3(targetClientMxImgDir) !== resolve3(primaryMxImgDir) && existsSync4(primaryMxImgDir)) {
          await mkdir3(targetClientMxImgDir, { recursive: true });
          await cp(primaryMxImgDir, targetClientMxImgDir, { recursive: true });
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
