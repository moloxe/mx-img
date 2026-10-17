// @bun
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
function decodeServerChunkFrame(raw) {
  const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buffer.byteLength < BASE_ENVELOPE_BYTES) {
    throw new Error("Frame de stream demasiado corto");
  }
  for (let i = 0;i < FRAME_MAGIC.length; i++) {
    if (buffer[i] !== FRAME_MAGIC[i]) {
      throw new Error("Magic de frame inv\xE1lido (se esperaba MXCH)");
    }
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, BASE_ENVELOPE_BYTES);
  const flags = view.getUint8(4);
  const idByteLength = view.getUint16(6, true);
  const offsetBytes = view.getUint32(8, true);
  const deliveredBytes = view.getUint32(12, true);
  const targetBytes = view.getUint32(16, true);
  const totalAssetBytes = view.getUint32(20, true);
  const isComplete = (flags & FRAME_FLAG_COMPLETED) !== 0;
  const hasEmbeddedHeader = (flags & FRAME_FLAG_HAS_EMBEDDED_HEADER) !== 0;
  let cursor = BASE_ENVELOPE_BYTES;
  const id = textDecoder.decode(buffer.subarray(cursor, cursor + idByteLength));
  cursor += idByteLength;
  let embeddedHeader;
  if (hasEmbeddedHeader) {
    embeddedHeader = buffer.subarray(cursor, cursor + HEADER_BYTE_LENGTH);
    cursor += HEADER_BYTE_LENGTH;
  }
  const payload = buffer.subarray(cursor);
  return {
    id,
    offsetBytes,
    deliveredBytes,
    targetBytes,
    totalAssetBytes,
    isComplete,
    payload,
    embeddedHeader
  };
}
var DEFAULT_STREAM_URL = "/.mx-img/stream";
function toWebSocketUrl(streamUrl = DEFAULT_STREAM_URL) {
  const trimmed = (streamUrl || DEFAULT_STREAM_URL).trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }
  if (trimmed.startsWith("/")) {
    if (typeof window !== "undefined" && window.location?.host) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}${trimmed}`;
    }
    return `ws://localhost${trimmed}`;
  }
  return `ws://${trimmed}`;
}
// src/server/stream-server.ts
import { existsSync as existsSync3 } from "fs";
import { readFile as readFile3 } from "fs/promises";
import { basename as basename3, join as join3, resolve as resolve2 } from "path";

// src/build/builder.ts
import { existsSync as existsSync2 } from "fs";
import { mkdir as mkdir2, readdir, readFile as readFile2, writeFile as writeFile2 } from "fs/promises";
import { basename as basename2, extname, join as join2, relative, resolve } from "path";

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
if (false) {}

// src/server/stream-server.ts
function createMxImgStreamServer(options = {}) {
  const port = options.port ?? 8080;
  const hostname = options.hostname ?? "localhost";
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
    const cleanRel = cleanId.replace(/^(\.\.\/)+/, "").replace(/^\//, "");
    const candidateSourcePaths = [
      resolve2(rootDir, cleanRel),
      resolve2(rootDir, "src", cleanRel),
      join3(fallbackAssetsDir, basename3(cleanRel))
    ];
    for (const candidate of candidateSourcePaths) {
      if (existsSync3(candidate) && !candidate.endsWith(".mximg")) {
        const activeManifest = await getManifest();
        const builtEntry = await buildSingleMxImgAsset(candidate, mxImgDir, activeManifest, {
          rootDir,
          aliases: [cleanId]
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
  const server = Bun.serve({
    port,
    hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type"
          }
        });
      }
      if (url.pathname === streamPath) {
        const upgraded = srv.upgrade(req, {
          data: {
            sessionId: crypto.randomUUID(),
            tasks: new Map,
            activeQueue: [],
            schedulerRunning: false,
            pendingCommands: 0,
            commandChain: Promise.resolve(),
            throttleDelayMs: defaultThrottleDelayMs,
            timer: null
          }
        });
        if (upgraded) {
          return;
        }
        return new Response(JSON.stringify({
          service: "mx-img-stream",
          status: "ok",
          endpoint: streamPath,
          protocol: "websocket"
        }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
      if (options.onHttpRequest) {
        const customResp = await options.onHttpRequest(req, srv);
        if (customResp) {
          return customResp;
        }
      }
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(_ws) {},
      message(ws, message) {
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
      },
      close(ws) {
        const session = ws.data;
        if (session.timer) {
          clearTimeout(session.timer);
          session.timer = null;
        }
        session.activeQueue.length = 0;
        session.tasks.clear();
      }
    }
  });
  const actualPort = server.port ?? port;
  return {
    server,
    port: actualPort,
    streamUrl: `http://${hostname}:${actualPort}${streamPath}`,
    registerMemoryAsset(id, bytes) {
      assetCache.set(id, bytes);
    },
    stop(closeActiveConnections = true) {
      server.stop(closeActiveConnections);
    }
  };
}
if (false) {}
export {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_STREAM_URL,
  FRAME_FLAG_COMPLETED,
  FRAME_FLAG_HAS_EMBEDDED_HEADER,
  createMxImgStreamServer,
  decodeServerChunkFrame,
  encodeServerChunkFrame,
  toWebSocketUrl
};
