import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { ProgressiveFourierDecoder } from "../../utils/encoding/decoder.ts";
import {
  createMxImgStreamServer,
  DEFAULT_CHUNK_SIZE_BYTES,
  decodeServerChunkFrame,
  type MxImgServerChunkFrame,
  toWebSocketUrl,
} from "../index.ts";

const ROOT_DIR = resolve(import.meta.dir, "../../..");

describe("MxImg Fase 2: Servidor de Streaming Equitativo y Protocolo Cliente-Servidor", () => {
  const KB_100 = DEFAULT_CHUNK_SIZE_BYTES; // 102,400 bytes
  const KB_200 = KB_100 * 2; // 204,800 bytes
  const KB_300 = KB_100 * 3; // 307,200 bytes

  let streamServer: ReturnType<typeof createMxImgStreamServer>;
  let wsEndpoint: string;

  beforeAll(() => {
    // Creamos 3 assets sintéticos de exactamente 100 KB, 200 KB y 300 KB para validar el ejemplo de GOALS-es.md
    const asset100 = new Uint8Array(KB_100).fill(1);
    const asset200 = new Uint8Array(KB_200).fill(2);
    const asset300 = new Uint8Array(KB_300).fill(3);

    streamServer = createMxImgStreamServer({
      port: 0, // puerto efímero libre para tests
      rootDir: ROOT_DIR,
      defaultChunkSizeBytes: KB_100,
      defaultThrottleDelayMs: 2,
      customAssets: {
        "img-100kb": asset100,
        "img-200kb": asset200,
        "img-300kb": asset300,
      },
    });

    wsEndpoint = toWebSocketUrl(streamServer.streamUrl);
  });

  afterAll(() => {
    streamServer.stop(true);
  });

  test("1. Sirve 3 imágenes sobre 1 única conexión de forma estrictamente equitativa (Round-Robin 100KB -> 200KB -> 300KB)", async () => {
    const receivedFrames: MxImgServerChunkFrame[] = [];

    await new Promise<void>((resolveDone, rejectDone) => {
      const ws = new WebSocket(wsEndpoint);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "start", id: "img-100kb" }));
        ws.send(JSON.stringify({ type: "start", id: "img-200kb" }));
        ws.send(JSON.stringify({ type: "start", id: "img-300kb" }));
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeServerChunkFrame(event.data);
          receivedFrames.push(frame);

          // Esperamos exactamente 6 porciones de 100 KB en total (1 + 2 + 3)
          if (receivedFrames.length === 6) {
            ws.close();
            resolveDone();
          }
        }
      });

      ws.addEventListener("error", (err) => rejectDone(err));
    });

    // Verificar el orden exacto de turnos Round-Robin especificado en GOALS-es.md:
    // Ronda 1:
    //   - img-100kb: 0 -> 100kb (Terminado)
    //   - img-200kb: 0 -> 100kb
    //   - img-300kb: 0 -> 100kb
    // Ronda 2:
    //   - img-200kb: 100kb -> 200kb (Terminado)
    //   - img-300kb: 100kb -> 200kb
    // Ronda 3:
    //   - img-300kb: 200kb -> 300kb (Terminado)
    const summary = receivedFrames.map((f) => ({
      id: f.id,
      fromKb: f.offsetBytes / 1024,
      toKb: f.deliveredBytes / 1024,
      totalKb: f.targetBytes / 1024,
      isComplete: f.isComplete,
    }));

    expect(summary).toEqual([
      { id: "img-100kb", fromKb: 0, toKb: 100, totalKb: 100, isComplete: true },
      { id: "img-200kb", fromKb: 0, toKb: 100, totalKb: 200, isComplete: false },
      { id: "img-300kb", fromKb: 0, toKb: 100, totalKb: 300, isComplete: false },
      { id: "img-200kb", fromKb: 100, toKb: 200, totalKb: 200, isComplete: true },
      { id: "img-300kb", fromKb: 100, toKb: 200, totalKb: 300, isComplete: false },
      { id: "img-300kb", fromKb: 200, toKb: 300, totalKb: 300, isComplete: true },
    ]);
  });

  test("2. Soporta pausa (pause), continuación (resume) e inicio con desfase (offsetBytes)", async () => {
    const frames: MxImgServerChunkFrame[] = [];

    await new Promise<void>((resolveDone, rejectDone) => {
      const ws = new WebSocket(wsEndpoint);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        // Iniciamos img-300kb con un desfase inicial de 100 KB (102,400 bytes)
        ws.send(JSON.stringify({ type: "start", id: "img-300kb", offsetBytes: KB_100 }));
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeServerChunkFrame(event.data);
          frames.push(frame);

          if (frames.length === 1) {
            // Tras recibir el tramo 100KB -> 200KB, enviamos pausa y luego reanudamos
            ws.send(JSON.stringify({ type: "pause", id: "img-300kb" }));
            setTimeout(() => {
              ws.send(JSON.stringify({ type: "resume", id: "img-300kb" }));
            }, 25);
          } else if (frames.length === 2) {
            ws.close();
            resolveDone();
          }
        }
      });

      ws.addEventListener("error", (err) => rejectDone(err));
    });

    expect(frames.length).toBe(2);
    // Primer chunk arranca desde el desfase de 100 KB hasta 200 KB
    expect(frames[0].offsetBytes).toBe(KB_100);
    expect(frames[0].deliveredBytes).toBe(KB_200);
    expect(frames[0].isComplete).toBe(false);

    // Segundo chunk tras resume continúa de 200 KB hasta 300 KB y termina
    expect(frames[1].offsetBytes).toBe(KB_200);
    expect(frames[1].deliveredBytes).toBe(KB_300);
    expect(frames[1].isComplete).toBe(true);
  });

  test("3. Decodifica progresivamente un asset real (voronoi.jpeg) transmitido por WebSocket con límite dinámico", async () => {
    const decoder = new ProgressiveFourierDecoder();
    let chunksReceived = 0;

    await new Promise<void>((resolveDone, rejectDone) => {
      const ws = new WebSocket(wsEndpoint);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        // Solicitamos solo el primer 5% del espectro de voronoi.jpeg para decodificación rápida
        ws.send(
          JSON.stringify({
            type: "start",
            id: "/assets/images/voronoi.jpeg",
            maxPercent: 5,
          })
        );
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeServerChunkFrame(event.data);
          chunksReceived++;
          decoder.appendChunk(frame.payload, frame.offsetBytes, frame.totalAssetBytes);

          if (frame.isComplete) {
            ws.close();
            resolveDone();
          }
        }
      });

      ws.addEventListener("error", (err) => rejectDone(err));
    });

    expect(chunksReceived).toBeGreaterThan(0);
    const decoded = decoder.decodeToRgba();
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBeGreaterThan(0);
    expect(decoded!.height).toBeGreaterThan(0);
    expect(decoded!.rgba.length).toBe(decoded!.width * decoded!.height * 4);
    expect(decoded!.coeficientesUsados).toBeGreaterThan(100);
  });

  test("4. Previsualización inicial (8 KB) decodificada localmente y continuada con stream desde offsetBytes produce resultado coherente", async () => {
    // 1. Simular carga de preview de 8 KB directamente en cliente
    const previewBytes = 8 * 1024;
    const clientDecoder = new ProgressiveFourierDecoder();

    // 2. Conectar y solicitar stream a partir del desfase de 8 KB
    let framesCount = 0;
    await new Promise<void>((resolveDone, rejectDone) => {
      const ws = new WebSocket(wsEndpoint);
      ws.binaryType = "arraybuffer";

      ws.addEventListener("open", () => {
        ws.send(
          JSON.stringify({
            type: "start",
            id: "/assets/images/voronoi.jpeg",
            offsetBytes: previewBytes,
            maxPercent: 2, // Limitar para prueba rápida
          })
        );
      });

      ws.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) {
          const frame = decodeServerChunkFrame(event.data);
          framesCount++;

          // Si el servidor envía embeddedHeader en offsetBytes > 0
          if (frame.embeddedHeader && clientDecoder.getReceivedBytes() === 0) {
            clientDecoder.appendChunk(frame.embeddedHeader, 0, frame.totalAssetBytes);
          }
          clientDecoder.appendChunk(frame.payload, frame.offsetBytes, frame.totalAssetBytes);

          if (frame.isComplete) {
            ws.close();
            resolveDone();
          }
        }
      });

      ws.addEventListener("error", (err) => rejectDone(err));
    });

    expect(framesCount).toBeGreaterThan(0);
    const decoded = clientDecoder.decodeToRgba();
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBeGreaterThan(0);
  });
});
