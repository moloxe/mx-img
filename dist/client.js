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
    totalExpectedBytes: HEADER_BYTE_LENGTH + numCoefficients * BYTES_PER_COEFFICIENT
  };
}

// src/server/protocol.ts
var DEFAULT_CHUNK_SIZE_BYTES = 100 * 1024;
var FRAME_MAGIC = new Uint8Array([77, 88, 67, 72]);
var BASE_ENVELOPE_BYTES = 24;
var FRAME_FLAG_COMPLETED = 1 << 0;
var FRAME_FLAG_HAS_EMBEDDED_HEADER = 1 << 1;
var textEncoder = new TextEncoder;
var textDecoder = new TextDecoder;
function decodeServerChunkFrame(raw) {
  const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buffer.byteLength < BASE_ENVELOPE_BYTES) {
    throw new Error("Frame de stream demasiado corto");
  }
  for (let i = 0;i < FRAME_MAGIC.length; i++) {
    if (buffer[i] !== FRAME_MAGIC[i]) {
      throw new Error("Magic de frame inválido (se esperaba MXCH)");
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
function ifftshiftAndIfft2dReal(shiftedComplex, height, width) {
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
  const rRe = lineRe.subarray(0, width);
  const rIm = lineIm.subarray(0, width);
  const rScratchRe = scratchRe.subarray(0, width);
  const rScratchIm = scratchIm.subarray(0, width);
  for (let y = 0;y < height; y++) {
    const shiftedY = (y + halfH) % height;
    const srcRowBase = shiftedY * width;
    for (let x = 0;x < width; x++) {
      const shiftedX = (x + halfW) % width;
      const srcOffset = (srcRowBase + shiftedX) * 2;
      rRe[x] = shiftedComplex[srcOffset];
      rIm[x] = -shiftedComplex[srcOffset + 1];
    }
    executeFFT1DForward(rRe, rIm, rScratchRe, rScratchIm, rowPlan);
    const dstRowBase = y * width;
    for (let x = 0;x < width; x++) {
      specRe[dstRowBase + x] = rRe[x];
      specIm[dstRowBase + x] = rIm[x];
    }
  }
  const cRe = lineRe.subarray(0, height);
  const cIm = lineIm.subarray(0, height);
  const cScratchRe = scratchRe.subarray(0, height);
  const cScratchIm = scratchIm.subarray(0, height);
  const realOutput = new Float64Array(nPix);
  const invScale = 1 / nPix;
  for (let x = 0;x < width; x++) {
    for (let y = 0;y < height; y++) {
      const idx = y * width + x;
      cRe[y] = specRe[idx];
      cIm[y] = specIm[idx];
    }
    executeFFT1DForward(cRe, cIm, cScratchRe, cScratchIm, colPlan);
    for (let y = 0;y < height; y++) {
      realOutput[y * width + x] = cRe[y] * invScale;
    }
  }
  return realOutput;
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

// src/utils/encoding/decoder.ts
class ProgressiveFourierDecoder {
  streamBuffer = null;
  header = null;
  espY = null;
  espCb = null;
  espCr = null;
  ordenRadial = null;
  injectedCoefficients = 0;
  receivedBytes = 0;
  appendChunk(chunk, offsetBytes, totalBytes) {
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
      this.espCb[ordenRadial[0] * 2] = 128 * nPix;
      this.espCr[ordenRadial[0] * 2] = 128 * nPix;
    }
    this.injectPendingCoefficients();
  }
  getHeader() {
    return this.header;
  }
  getReceivedBytes() {
    return this.receivedBytes;
  }
  getInjectedCoefficients() {
    return this.injectedCoefficients;
  }
  injectPendingCoefficients() {
    if (!this.header || !this.streamBuffer || !this.ordenRadial || !this.espY || !this.espCb || !this.espCr) {
      return;
    }
    const availablePayloadBytes = Math.max(0, this.receivedBytes - HEADER_BYTE_LENGTH);
    const availableCoeffs = Math.min(this.header.numCoefficients, Math.floor(availablePayloadBytes / BYTES_PER_COEFFICIENT));
    if (availableCoeffs <= this.injectedCoefficients) {
      return;
    }
    const view = new DataView(this.streamBuffer.buffer, this.streamBuffer.byteOffset + HEADER_BYTE_LENGTH, availableCoeffs * BYTES_PER_COEFFICIENT);
    const kCroma = this.header.kCroma;
    const limiteStreamCroma = 3 * kCroma;
    const ordenRadial = this.ordenRadial;
    const espY = this.espY;
    const espCb = this.espCb;
    const espCr = this.espCr;
    for (let idx = this.injectedCoefficients;idx < availableCoeffs; idx++) {
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
  decodeToRgba() {
    if (!this.header || !this.espY || !this.espCb || !this.espCr || this.injectedCoefficients === 0) {
      return null;
    }
    const { height: h, width: w, kCroma, numCoefficients } = this.header;
    const nPix = h * w;
    const yRec = ifftshiftAndIfft2dReal(this.espY, h, w);
    const cbRec = ifftshiftAndIfft2dReal(this.espCb, h, w);
    const crRec = ifftshiftAndIfft2dReal(this.espCr, h, w);
    const rgba = new Uint8ClampedArray(nPix * 4);
    for (let i = 0, p = 0;i < nPix; i++, p += 4) {
      const yVal = yRec[i];
      const cbShift = cbRec[i] - 128;
      const crShift = crRec[i] - 128;
      rgba[p] = Math.round(yVal + 1.402 * crShift);
      rgba[p + 1] = Math.round(yVal - 0.344136 * cbShift - 0.714136 * crShift);
      rgba[p + 2] = Math.round(yVal + 1.772 * cbShift);
      rgba[p + 3] = 255;
    }
    const kCromaRecibidos = Math.min(kCroma, Math.floor(this.injectedCoefficients / 3));
    const porcentajeCromaCompletado = kCromaRecibidos / kCroma * 100;
    const porcentajeCompletado = this.injectedCoefficients / numCoefficients * 100;
    return {
      rgba,
      width: w,
      height: h,
      coeficientesUsados: this.injectedCoefficients,
      totalCoefficients: numCoefficients,
      porcentajeCompletado,
      porcentajeCromaCompletado
    };
  }
}
if (false) {}

// src/client/lib/index.ts
class StreamConnectionManager {
  config = null;
  ws = null;
  isConnecting = false;
  pendingCommands = [];
  subscribers = new Map;
  previews = new Map;
  intersectionObserver = null;
  mutationObserver = null;
  reconnectTimer = null;
  configure(options = {}) {
    const prevUrl = this.config?.streamUrl;
    const resolvedStreamUrl = options.streamUrl ?? DEFAULT_STREAM_URL;
    this.config = {
      rootMargin: "0px",
      threshold: 0.05,
      chunkSize: DEFAULT_CHUNK_SIZE_BYTES,
      ...options,
      streamUrl: resolvedStreamUrl
    };
    this.loadPreviews();
    this.setupIntersectionObserver();
    this.setupDomUpgrader();
    this.ensureConnected(prevUrl !== undefined && prevUrl !== resolvedStreamUrl);
    if (typeof document !== "undefined") {
      const existingCanvases = document.querySelectorAll('canvas[is="mx-img"]');
      for (const el of existingCanvases) {
        if (el instanceof MxImg) {
          el.attachToManager();
        }
      }
    }
  }
  loadPreviews() {
    if (typeof document === "undefined")
      return;
    const scriptTags = document.querySelectorAll("script[data-mx-img-previews]");
    for (const tag of scriptTags) {
      try {
        const text = tag.textContent;
        if (!text)
          continue;
        const data = JSON.parse(text);
        if (data.previews) {
          for (const [hash, item] of Object.entries(data.previews)) {
            this.previews.set(hash, item);
          }
        }
        if (data.aliases && data.previews) {
          for (const [alias, hash] of Object.entries(data.aliases)) {
            const item = data.previews[hash];
            if (item) {
              this.previews.set(alias, item);
            }
          }
        }
      } catch (err) {
        console.warn("[mx-img] Error leyendo data-mx-img-previews:", err);
      }
    }
  }
  getPreview(idOrSrc) {
    if (!idOrSrc)
      return;
    if (this.previews.size === 0) {
      this.loadPreviews();
    }
    const trimmed = idOrSrc.trim();
    if (this.previews.has(trimmed)) {
      return this.previews.get(trimmed);
    }
    const clean = trimmed.split("?")[0].split("#")[0];
    if (this.previews.has(clean)) {
      return this.previews.get(clean);
    }
    const base = clean.split("/").pop();
    if (base && this.previews.has(base)) {
      return this.previews.get(base);
    }
    if (base) {
      const unhashed = base.replace(/^(.+)\.[a-zA-Z0-9_-]{6,16}(\.[a-zA-Z0-9]+)$/, "$1$2");
      if (unhashed !== base && this.previews.has(unhashed)) {
        return this.previews.get(unhashed);
      }
    }
    return;
  }
  getConfig() {
    return this.config;
  }
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  ensureConnected(forceReconnect = false) {
    if (!this.config || typeof WebSocket === "undefined") {
      return;
    }
    if (forceReconnect && this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.isConnecting) {
      return;
    }
    this.isConnecting = true;
    const wsUrl = toWebSocketUrl(this.config.streamUrl);
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    this.ws = socket;
    socket.addEventListener("open", () => {
      this.isConnecting = false;
      this.dispatchConnectionEvent("connected", wsUrl);
      while (this.pendingCommands.length > 0) {
        const cmd = this.pendingCommands.shift();
        socket.send(JSON.stringify(cmd));
      }
    });
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer || event.data instanceof Uint8Array) {
        try {
          const frame = decodeServerChunkFrame(event.data);
          this.routeFrameToSubscribers(frame);
        } catch (err) {
          console.error("[mx-img] Error decodificando frame binario:", err);
        }
      } else if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "error" && msg.id) {
            const subs = this.subscribers.get(msg.id);
            if (subs) {
              for (const el of subs) {
                el.handleStreamError(msg.message ?? "Error en el stream");
              }
            }
          }
        } catch {}
      }
    });
    socket.addEventListener("close", () => {
      this.isConnecting = false;
      this.ws = null;
      this.dispatchConnectionEvent("disconnected", wsUrl);
      if (this.hasActiveSubscribers() && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.ensureConnected();
          this.resubscribeActiveWithOffset();
        }, 1000);
      }
    });
    socket.addEventListener("error", () => {
      this.isConnecting = false;
      console.warn(`[mx-img] Could not connect to stream endpoint "${wsUrl}" (configured streamUrl: "${this.config?.streamUrl}"). Verify that the mx-img stream server is reachable or pass a custom "streamUrl" in init({ streamUrl }).`);
      this.dispatchConnectionEvent("error", wsUrl);
    });
  }
  sendCommand(cmd) {
    this.ensureConnected();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      if ("id" in cmd) {
        this.pendingCommands = this.pendingCommands.filter((existing) => !(("id" in existing) && existing.id === cmd.id));
      }
      this.pendingCommands.push(cmd);
    }
  }
  registerElement(id, element) {
    let set = this.subscribers.get(id);
    if (!set) {
      set = new Set;
      this.subscribers.set(id, set);
    }
    set.add(element);
    if (this.intersectionObserver) {
      this.intersectionObserver.observe(element);
    }
  }
  unregisterElement(id, element) {
    const set = this.subscribers.get(id);
    if (set) {
      set.delete(element);
      if (set.size === 0) {
        this.subscribers.delete(id);
      }
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.unobserve(element);
    }
  }
  routeFrameToSubscribers(frame) {
    const set = this.subscribers.get(frame.id);
    if (!set)
      return;
    for (const element of set) {
      element.receiveChunkFrame(frame);
    }
  }
  hasOtherActiveSubscriber(id, excludeElement) {
    const set = this.subscribers.get(id);
    if (!set)
      return false;
    for (const el of set) {
      if (el !== excludeElement && el.getState() === "active") {
        return true;
      }
    }
    return false;
  }
  getActiveStreamCount() {
    let count = 0;
    for (const set of this.subscribers.values()) {
      for (const el of set) {
        if (el.getState() === "active") {
          count++;
          break;
        }
      }
    }
    return count;
  }
  hasActiveSubscribers() {
    for (const set of this.subscribers.values()) {
      for (const el of set) {
        if (el.getState() === "active") {
          return true;
        }
      }
    }
    return false;
  }
  resubscribeActiveWithOffset() {
    for (const [id, set] of this.subscribers.entries()) {
      for (const el of set) {
        if (el.getState() === "active") {
          this.sendCommand({
            type: "start",
            id,
            offsetBytes: el.getReceivedBytes(),
            maxPercent: el.getMaxPercent(),
            chunkSize: el.getChunkSize() ?? this.config?.chunkSize
          });
          break;
        }
      }
    }
  }
  setupIntersectionObserver() {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }
    const threshold = this.config?.threshold ?? 0.05;
    this.intersectionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (target instanceof MxImg) {
          const isVisible = entry.isIntersecting && entry.intersectionRatio >= threshold;
          target.handleVisibilityChange(isVisible);
        }
      }
    }, {
      root: null,
      rootMargin: this.config?.rootMargin ?? "0px",
      threshold: [0, threshold]
    });
  }
  setupDomUpgrader() {
    if (typeof document === "undefined") {
      return;
    }
    const upgradeAllInRoot = (root) => {
      const bareTags = root.querySelectorAll("mx-img");
      for (const tag of bareTags) {
        const canvas = document.createElement("canvas", { is: "mx-img" });
        canvas.setAttribute("is", "mx-img");
        for (const attr of Array.from(tag.attributes)) {
          canvas.setAttribute(attr.name, attr.value);
        }
        tag.replaceWith(canvas);
      }
    };
    upgradeAllInRoot(document);
    if (!this.mutationObserver && typeof MutationObserver !== "undefined" && document.body) {
      this.mutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const node of Array.from(m.addedNodes)) {
            if (node instanceof HTMLElement) {
              if (node.tagName.toLowerCase() === "mx-img") {
                const canvas = document.createElement("canvas", { is: "mx-img" });
                canvas.setAttribute("is", "mx-img");
                for (const attr of Array.from(node.attributes)) {
                  canvas.setAttribute(attr.name, attr.value);
                }
                node.replaceWith(canvas);
              } else {
                upgradeAllInRoot(node);
              }
            }
          }
        }
      });
      this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
  dispatchConnectionEvent(status, url) {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(new CustomEvent("mx-img:connection", {
        detail: { status, url }
      }));
    }
  }
}
var connectionManager = new StreamConnectionManager;
var BaseCanvasClass = typeof HTMLCanvasElement !== "undefined" ? HTMLCanvasElement : class {
};
function base64ToUint8Array(b64) {
  const binaryStr = atob(b64.trim());
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0;i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

class MxImg extends BaseCanvasClass {
  static get observedAttributes() {
    return [
      "src",
      "data-max-percent",
      "max-percent",
      "data-offset-bytes",
      "data-initial-portion",
      "data-initial-chunk"
    ];
  }
  static sharedDecoders = new Map;
  static decodedFrameCache = new Map;
  decoder = new ProgressiveFourierDecoder;
  state = "sleeping";
  streamId = "";
  hasStartedStream = false;
  currentlyVisible = false;
  receivedBytes = 0;
  targetBytes = 0;
  totalAssetBytes = 0;
  rafDecodeId = null;
  decodeTimerId = null;
  lastDecodeMs = 0;
  lastDecodedBytes = 0;
  lastDecodeTimestamp = 0;
  get src() {
    return typeof this.getAttribute === "function" ? this.getAttribute("src") ?? "" : "";
  }
  set src(value) {
    if (typeof this.setAttribute !== "function")
      return;
    if (value === null || value === undefined || value === "") {
      this.removeAttribute("src");
    } else {
      this.setAttribute("src", String(value));
    }
  }
  connectedCallback() {
    if (typeof this.hasAttribute === "function" && !this.hasAttribute("is")) {
      this.setAttribute("is", "mx-img");
    }
    this.syncStreamAttributes();
    this.updateStateAttribute(this.state);
    this.attachToManager();
  }
  disconnectedCallback() {
    this.clearScheduledDecode();
    if (this.streamId) {
      if (this.state === "active" && !connectionManager.hasOtherActiveSubscriber(this.streamId, this)) {
        connectionManager.sendCommand({ type: "pause", id: this.streamId });
      }
      connectionManager.unregisterElement(this.streamId, this);
    }
  }
  clearScheduledDecode() {
    if (this.rafDecodeId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafDecodeId);
      this.rafDecodeId = null;
    }
    if (this.decodeTimerId !== null) {
      clearTimeout(this.decodeTimerId);
      this.decodeTimerId = null;
    }
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue)
      return;
    if (name === "src") {
      if (this.streamId) {
        connectionManager.unregisterElement(this.streamId, this);
      }
      this.resetStreamState();
      this.syncStreamAttributes();
      this.attachToManager();
    }
  }
  attachToManager() {
    if (!this.streamId) {
      this.syncStreamAttributes();
    }
    if (!this.streamId || !connectionManager.getConfig()) {
      return;
    }
    connectionManager.registerElement(this.streamId, this);
  }
  syncStreamAttributes() {
    const rawSrc = this.getAttribute("src") ?? "";
    this.streamId = rawSrc.trim();
    const initialOffsetAttr = this.getAttribute("data-offset-bytes");
    if (initialOffsetAttr && this.receivedBytes === 0) {
      const parsed = Number.parseInt(initialOffsetAttr, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        this.receivedBytes = parsed;
      }
    }
  }
  getDirectInitialPortion() {
    const raw = this.getAttribute("data-initial-portion") ?? this.getAttribute("data-initial-chunk");
    if (!raw)
      return;
    const totalAttr = this.getAttribute("data-total-bytes");
    const bytesAttr = this.getAttribute("data-offset-bytes");
    const b64 = raw.trim();
    const len = Math.floor(b64.length * 3 / 4);
    const bytes = bytesAttr ? Number.parseInt(bytesAttr, 10) : len;
    const total = totalAttr ? Number.parseInt(totalAttr, 10) : bytes;
    return { b64, bytes, total };
  }
  resetStreamState() {
    this.clearScheduledDecode();
    this.decoder = new ProgressiveFourierDecoder;
    this.state = "sleeping";
    this.hasStartedStream = false;
    this.receivedBytes = 0;
    this.targetBytes = 0;
    this.totalAssetBytes = 0;
    this.lastDecodedBytes = 0;
    this.lastDecodeTimestamp = 0;
    this.updateStateAttribute("sleeping");
  }
  handleVisibilityChange(isVisible) {
    this.currentlyVisible = isVisible;
    if (this.state === "completed") {
      return;
    }
    if (isVisible) {
      this.startOrResume();
    } else {
      if (this.state === "active" || this.hasStartedStream) {
        this.pause();
      } else {
        this.updateStateAttribute("sleeping");
      }
    }
  }
  startOrResume(customOffsetBytes) {
    if (!this.streamId || this.state === "completed") {
      return;
    }
    if (customOffsetBytes !== undefined && customOffsetBytes >= 0) {
      this.receivedBytes = customOffsetBytes;
      MxImg.decodedFrameCache.delete(this.streamId);
      MxImg.sharedDecoders.delete(this.streamId);
    } else {
      if (this.receivedBytes === 0) {
        const preview = connectionManager.getPreview(this.streamId) ?? this.getDirectInitialPortion();
        if (preview && preview.b64) {
          try {
            const bytes = base64ToUint8Array(preview.b64);
            const streamKey2 = this.streamId;
            let activeDecoder = this.decoder;
            if (streamKey2) {
              let shared2 = MxImg.sharedDecoders.get(streamKey2);
              if (!shared2) {
                shared2 = { decoder: new ProgressiveFourierDecoder, deliveredBytes: 0 };
                MxImg.sharedDecoders.set(streamKey2, shared2);
              }
              if (bytes.byteLength > shared2.deliveredBytes) {
                shared2.decoder.appendChunk(bytes, 0, preview.total);
                shared2.deliveredBytes = bytes.byteLength;
              }
              activeDecoder = shared2.decoder;
            } else {
              this.decoder.appendChunk(bytes, 0, preview.total);
            }
            this.receivedBytes = bytes.byteLength;
            this.totalAssetBytes = preview.total;
            const maxPct = this.getMaxPercent();
            this.targetBytes = maxPct !== undefined ? Math.floor(preview.total * (maxPct / 100)) : preview.total;
            const header = activeDecoder.getHeader();
            if (header) {
              if (this.width !== header.width)
                this.width = header.width;
              if (this.height !== header.height)
                this.height = header.height;
            }
            this.decode();
            if (this.receivedBytes >= this.targetBytes) {
              this.clearScheduledDecode();
              this.updateStateAttribute("completed");
              return;
            }
          } catch (err) {
            console.warn("[mx-img] Error decodificando preview:", err);
          }
        }
      }
      const streamKey = this.streamId;
      const shared = streamKey ? MxImg.sharedDecoders.get(streamKey) : null;
      const actualBytes = shared ? shared.deliveredBytes : this.decoder.getReceivedBytes();
      if (this.receivedBytes > 0 && actualBytes === 0) {
        this.receivedBytes = 0;
      }
      const cached = MxImg.decodedFrameCache.get(this.streamId);
      if (cached && cached.isComplete && this.getMaxPercent() === undefined) {
        this.receivedBytes = cached.receivedBytes;
        this.targetBytes = cached.targetBytes;
        this.totalAssetBytes = cached.totalAssetBytes;
        this.hasStartedStream = true;
        this.updateStateAttribute("completed");
        this.decode();
        return;
      }
      if (connectionManager.hasOtherActiveSubscriber(this.streamId, this)) {
        this.hasStartedStream = true;
        this.updateStateAttribute("active");
        if (cached && cached.receivedBytes > this.lastDecodedBytes) {
          this.receivedBytes = cached.receivedBytes;
          this.targetBytes = cached.targetBytes;
          this.totalAssetBytes = cached.totalAssetBytes;
          this.decode();
        }
        return;
      }
    }
    const prevState = this.state;
    this.updateStateAttribute("active");
    if (!this.hasStartedStream || customOffsetBytes !== undefined) {
      this.hasStartedStream = true;
      connectionManager.sendCommand({
        type: "start",
        id: this.streamId,
        offsetBytes: this.receivedBytes,
        maxPercent: this.getMaxPercent(),
        chunkSize: this.getChunkSize()
      });
    } else if (prevState === "paused" || prevState === "sleeping") {
      connectionManager.sendCommand({
        type: "resume",
        id: this.streamId,
        offsetBytes: this.receivedBytes,
        maxPercent: this.getMaxPercent()
      });
    }
  }
  pause() {
    if (!this.streamId || this.state === "completed" || this.state === "sleeping") {
      return;
    }
    this.clearScheduledDecode();
    this.updateStateAttribute("paused");
    if (!connectionManager.hasOtherActiveSubscriber(this.streamId, this)) {
      connectionManager.sendCommand({
        type: "pause",
        id: this.streamId
      });
    }
    if (this.receivedBytes > this.lastDecodedBytes) {
      this.decode();
    }
  }
  receiveChunkFrame(frame) {
    const streamKey = this.streamId || frame.id;
    let activeDecoder = this.decoder;
    if (streamKey) {
      let shared = MxImg.sharedDecoders.get(streamKey);
      if (!shared || frame.offsetBytes === 0 && shared.deliveredBytes > 0) {
        shared = { decoder: new ProgressiveFourierDecoder, deliveredBytes: 0 };
        MxImg.sharedDecoders.set(streamKey, shared);
      }
      if (frame.deliveredBytes > shared.deliveredBytes) {
        if (frame.embeddedHeader) {
          shared.decoder.appendChunk(frame.embeddedHeader, 0, frame.totalAssetBytes);
        }
        shared.decoder.appendChunk(frame.payload, frame.offsetBytes, frame.totalAssetBytes);
        shared.deliveredBytes = frame.deliveredBytes;
      }
      activeDecoder = shared.decoder;
    } else {
      if (frame.embeddedHeader) {
        this.decoder.appendChunk(frame.embeddedHeader, 0, frame.totalAssetBytes);
      }
      this.decoder.appendChunk(frame.payload, frame.offsetBytes, frame.totalAssetBytes);
    }
    this.receivedBytes = frame.deliveredBytes;
    this.targetBytes = frame.targetBytes;
    this.totalAssetBytes = frame.totalAssetBytes;
    const header = activeDecoder.getHeader();
    if (header) {
      if (this.width !== header.width)
        this.width = header.width;
      if (this.height !== header.height)
        this.height = header.height;
    }
    const progressPercent = this.targetBytes > 0 ? Math.min(100, this.receivedBytes / this.targetBytes * 100) : 0;
    const injected = activeDecoder.getInjectedCoefficients();
    const totalCoeffs = header?.numCoefficients ?? 0;
    const kCroma = header?.kCroma ?? 1;
    const chromaPercent = Math.min(100, Math.min(kCroma, Math.floor(injected / 3)) / kCroma * 100);
    this.dispatchProgressEvent("mx-img:progress", {
      id: this.streamId,
      state: frame.isComplete ? "completed" : this.state,
      receivedBytes: this.receivedBytes,
      targetBytes: this.targetBytes,
      totalAssetBytes: this.totalAssetBytes,
      progressPercent,
      chromaPercent,
      coeficientesUsados: injected,
      totalCoefficients: totalCoeffs,
      width: header?.width ?? this.width,
      height: header?.height ?? this.height,
      decodeTimeMs: this.lastDecodeMs
    });
    if (frame.isComplete) {
      this.clearScheduledDecode();
      this.updateStateAttribute("completed");
      this.decode();
      return;
    }
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const isFirstRender = this.lastDecodedBytes === 0;
    const activeStreams = Math.max(1, connectionManager.getActiveStreamCount());
    const cachedFftMs = this.streamId && MxImg.decodedFrameCache.get(this.streamId)?.fftDurationMs || this.lastDecodeMs;
    const minIntervalMs = Math.max(220, Math.min(1200, cachedFftMs * activeStreams * 1.5));
    const elapsedSinceLastDecode = now - this.lastDecodeTimestamp;
    if (isFirstRender || elapsedSinceLastDecode >= minIntervalMs) {
      this.scheduleDecodeRender(0);
    } else if (this.decodeTimerId === null && this.rafDecodeId === null) {
      this.scheduleDecodeRender(minIntervalMs - elapsedSinceLastDecode);
    }
  }
  scheduleDecodeRender(delayMs) {
    if (typeof requestAnimationFrame === "undefined") {
      this.decode();
      return;
    }
    if (delayMs <= 0) {
      if (this.rafDecodeId === null) {
        this.rafDecodeId = requestAnimationFrame(() => {
          this.rafDecodeId = null;
          this.decode();
        });
      }
    } else if (this.decodeTimerId === null) {
      this.decodeTimerId = setTimeout(() => {
        this.decodeTimerId = null;
        if (this.rafDecodeId === null) {
          this.rafDecodeId = requestAnimationFrame(() => {
            this.rafDecodeId = null;
            this.decode();
          });
        }
      }, delayMs);
    }
  }
  decode() {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cached = this.streamId && this.receivedBytes > 0 ? MxImg.decodedFrameCache.get(this.streamId) : undefined;
    const canReuseCached = cached !== undefined && (cached.receivedBytes === this.receivedBytes || this.state !== "completed" && cached.receivedBytes >= this.lastDecodedBytes && t0 - cached.timestamp < 220);
    let decoded = canReuseCached ? cached.decoded : null;
    if (!decoded) {
      const activeDecoder = this.streamId && MxImg.sharedDecoders.get(this.streamId)?.decoder || this.decoder;
      decoded = activeDecoder.decodeToRgba();
      if (!decoded) {
        return null;
      }
      const tFftEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
      const fftDurationMs = tFftEnd - t0;
      if (this.streamId && this.receivedBytes > 0) {
        MxImg.decodedFrameCache.set(this.streamId, {
          receivedBytes: this.receivedBytes,
          targetBytes: this.targetBytes,
          totalAssetBytes: this.totalAssetBytes,
          isComplete: this.state === "completed",
          timestamp: tFftEnd,
          fftDurationMs,
          decoded
        });
      }
    } else if (this.state === "completed" && cached && !cached.isComplete) {
      cached.isComplete = true;
    }
    const {
      rgba,
      width,
      height,
      coeficientesUsados,
      totalCoefficients,
      porcentajeCromaCompletado
    } = decoded;
    if (this.width !== width) {
      this.width = width;
    }
    if (this.height !== height) {
      this.height = height;
    }
    if (typeof this.getContext === "function") {
      const ctx = this.getContext("2d");
      if (ctx && typeof ImageData !== "undefined") {
        const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height);
        ctx.putImageData(imgData, 0, 0);
      }
    }
    const tEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.lastDecodeMs = tEnd - t0;
    this.lastDecodedBytes = this.receivedBytes;
    this.lastDecodeTimestamp = tEnd;
    const progressPercent = this.targetBytes > 0 ? Math.min(100, this.receivedBytes / this.targetBytes * 100) : decoded.porcentajeCompletado;
    const detail = {
      id: this.streamId,
      state: this.state,
      receivedBytes: this.receivedBytes,
      targetBytes: this.targetBytes,
      totalAssetBytes: this.totalAssetBytes,
      progressPercent,
      chromaPercent: porcentajeCromaCompletado,
      coeficientesUsados,
      totalCoefficients,
      width,
      height,
      decodeTimeMs: this.lastDecodeMs
    };
    this.dispatchProgressEvent("mx-img:progress", detail);
    if (this.state === "completed") {
      this.dispatchProgressEvent("mx-img:complete", detail);
    }
    return detail;
  }
  handleStreamError(message) {
    this.updateStateAttribute("error");
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(new CustomEvent("mx-img:error", {
        bubbles: true,
        detail: { id: this.streamId, message }
      }));
    }
  }
  getState() {
    return this.state;
  }
  isVisibleInViewport() {
    return this.currentlyVisible;
  }
  getReceivedBytes() {
    return this.receivedBytes;
  }
  getTargetBytes() {
    return this.targetBytes;
  }
  getMaxPercent() {
    const raw = this.getAttribute("max-percent") ?? this.getAttribute("data-max-percent");
    if (!raw)
      return;
    const val = Number.parseFloat(raw);
    return !Number.isNaN(val) && val > 0 && val <= 100 ? val : undefined;
  }
  getChunkSize() {
    const raw = this.getAttribute("data-chunk-size");
    if (!raw)
      return;
    const val = Number.parseInt(raw, 10);
    return !Number.isNaN(val) && val > 0 ? val : undefined;
  }
  updateStateAttribute(nextState) {
    this.state = nextState;
    if (typeof this.setAttribute === "function") {
      this.setAttribute("data-mx-state", nextState);
    }
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(new CustomEvent("mx-img:state", {
        bubbles: true,
        detail: {
          id: this.streamId,
          state: nextState,
          receivedBytes: this.receivedBytes,
          targetBytes: this.targetBytes
        }
      }));
    }
  }
  dispatchProgressEvent(eventName, detail) {
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(new CustomEvent(eventName, {
        bubbles: true,
        detail
      }));
    }
  }
}
function registerMxImgElement() {
  if (typeof customElements !== "undefined" && !customElements.get("mx-img")) {
    customElements.define("mx-img", MxImg, { extends: "canvas" });
  }
}
function init(options = {}) {
  registerMxImgElement();
  connectionManager.configure(options);
}
if (typeof window !== "undefined") {
  registerMxImgElement();
  if (typeof document !== "undefined") {
    document.addEventListener("astro:page-load", () => {
      connectionManager.loadPreviews();
    });
  }
}
export {
  MxImg,
  connectionManager,
  init,
  registerMxImgElement
};
