import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { basename, join, resolve } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { buildSingleMxImgAsset } from "../build/builder.ts";
import {
  loadManifest,
  type MxImgManifest,
  resolveManifestEntry,
  saveManifest,
} from "../build/manifest.ts";
import { HEADER_BYTE_LENGTH } from "../utils/encoding/binary.ts";
import {
  DEFAULT_CHUNK_SIZE_BYTES,
  encodeServerChunkFrame,
  type MxImgClientCommand,
  type MxImgServerErrorMessage,
} from "./protocol.ts";

export interface StreamTaskState {
  id: string;
  assetBytes: Uint8Array;
  offsetBytes: number;
  targetBytes: number;
  chunkSizeBytes: number;
  status: "active" | "paused" | "completed";
  sentEmbeddedHeader: boolean;
}

export interface ClientSessionData {
  sessionId: string;
  /** Mapa de tareas por `id` de imagen dentro de esta única conexión de cliente */
  tasks: Map<string, StreamTaskState>;
  /** Cola circular (Round-Robin) de IDs de imágenes activas */
  activeQueue: string[];
  /** Indica si el bucle del planificador ya está programado */
  schedulerRunning: boolean;
  /** Cantidad de comandos del cliente en proceso de resolución asíncrona */
  pendingCommands: number;
  /** Cadena secuencial para procesar comandos en estricto orden FIFO */
  commandChain: Promise<void>;
  /** Pausa opcional entre rondas/porciones (en ms) */
  throttleDelayMs: number;
  /** Timer activo del planificador */
  timer: ReturnType<typeof setTimeout> | null;
}

export interface MxImgSocketTransport {
  data: ClientSessionData;
  readonly readyState: number;
  sendBinary(data: Uint8Array): void;
  sendText(text: string): void;
}

export interface MxImgStreamServerOptions {
  /** Puerto donde escucha el servicio (por defecto `8080`) */
  port?: number;
  /** Hostname del servidor (por defecto `"localhost"`) */
  hostname?: string;
  /** Ruta del endpoint de stream (por defecto `"/.mx-img/stream"`) */
  streamPath?: string;
  /** Directorio raíz del proyecto */
  rootDir?: string;
  /** Directorio donde residen los bundles `.mximg` y `manifest.json` (por defecto `"dist/.mx-img"`) */
  mxImgDir?: string;
  /** Directorio de imágenes fuente para fallback bajo demanda en desarrollo */
  fallbackAssetsDir?: string;
  /** Tamaño de porción equitativa por defecto en bytes (por defecto 100 KB = `102400`) */
  defaultChunkSizeBytes?: number;
  /** Retardo entre turnos en ms (por defecto `1` ms para ceder el event loop a comandos de pausa) */
  defaultThrottleDelayMs?: number;
  /** Si se provee, permite registrar buffers personalizados en memoria (útil para tests unitarios de tamaños exactos) */
  customAssets?: Record<string, Uint8Array>;
  /** Manejador HTTP adicional para rutas estáticas (ej. usado por el servidor de mockup) */
  onHttpRequest?: (
    req: Request,
    server: Server<ClientSessionData>
  ) => Promise<Response | null> | Response | null;
}

export function createMxImgStreamEngine(options: MxImgStreamServerOptions = {}) {
  const streamPath = options.streamPath ?? "/.mx-img/stream";
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const mxImgDir = resolve(rootDir, options.mxImgDir ?? "dist/.mx-img");
  const fallbackAssetsDir = resolve(rootDir, options.fallbackAssetsDir ?? "src/assets/images");
  const defaultChunkSizeBytes = options.defaultChunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
  const defaultThrottleDelayMs = options.defaultThrottleDelayMs ?? 1;

  const assetCache = new Map<string, Uint8Array>();
  if (options.customAssets) {
    for (const [k, v] of Object.entries(options.customAssets)) {
      assetCache.set(k, v);
    }
  }

  let manifestCache: MxImgManifest | null = null;

  async function getManifest(): Promise<MxImgManifest> {
    if (!manifestCache) {
      manifestCache = await loadManifest(mxImgDir);
    }
    return manifestCache;
  }

  async function resolveAssetBytes(id: string): Promise<Uint8Array | null> {
    const cleanId = id.trim();
    const cached = assetCache.get(cleanId);
    if (cached) {
      return cached;
    }

    const manifest = await getManifest();
    let entry = resolveManifestEntry(manifest, cleanId);

    // Si aún no estaba en memoria, recargar manifest de disco por si se ejecutó un build reciente
    if (!entry) {
      manifestCache = await loadManifest(mxImgDir);
      entry = resolveManifestEntry(manifestCache, cleanId);
    }

    if (entry) {
      const bundlePath = join(mxImgDir, entry.fileName);
      if (existsSync(bundlePath)) {
        const bytes = new Uint8Array(await readFile(bundlePath));
        assetCache.set(cleanId, bytes);
        assetCache.set(entry.hash, bytes);
        return bytes;
      }
    }

    // Fallback directo a `<mxImgDir>/<id>.mximg` si se pasó un hash válido sin manifest
    const directBundlePath = join(
      mxImgDir,
      cleanId.endsWith(".mximg") ? cleanId : `${cleanId}.mximg`
    );
    if (existsSync(directBundlePath)) {
      const bytes = new Uint8Array(await readFile(directBundlePath));
      assetCache.set(cleanId, bytes);
      return bytes;
    }

    // Fallback en modo desarrollo/mockup: buscar imagen fuente en disco y compilarla hacia `/dist/.mx-img/*`
    const withoutQuery = cleanId
      .split("?")[0]
      .split("#")[0]
      .replace(/^\/@fs\//, "/");
    const cleanRel = withoutQuery.replace(/^(\.\.\/)+/, "").replace(/^\//, "");
    const base = basename(cleanRel);
    const unhashedBase = base.replace(/^(.+)\.[a-zA-Z0-9_-]{6,16}(\.[a-zA-Z0-9]+)$/, "$1$2");

    const candidateSourcePaths = [
      withoutQuery,
      resolve(rootDir, cleanRel),
      resolve(rootDir, "src", cleanRel),
      join(fallbackAssetsDir, base),
      ...(unhashedBase !== base ? [join(fallbackAssetsDir, unhashedBase)] : []),
    ];

    for (const candidate of candidateSourcePaths) {
      if (existsSync(candidate) && !candidate.endsWith(".mximg")) {
        const activeManifest = await getManifest();
        const builtEntry = await buildSingleMxImgAsset(candidate, mxImgDir, activeManifest, {
          rootDir,
          aliases: [cleanId, withoutQuery],
        });
        await saveManifest(mxImgDir, activeManifest);
        const bundlePath = join(mxImgDir, builtEntry.fileName);
        const bytes = new Uint8Array(await readFile(bundlePath));
        assetCache.set(cleanId, bytes);
        assetCache.set(builtEntry.hash, bytes);
        return bytes;
      }
    }

    return null;
  }

  function computeTargetBytes(totalBytes: number, maxPercent?: number, maxBytes?: number): number {
    let target = totalBytes;
    if (maxBytes !== undefined && maxBytes > 0) {
      target = Math.min(target, Math.floor(maxBytes));
    }
    if (maxPercent !== undefined && maxPercent > 0 && maxPercent < 100) {
      const payloadBytes = Math.max(0, totalBytes - HEADER_BYTE_LENGTH);
      const rawTargetPayload = Math.floor((payloadBytes * maxPercent) / 100);
      const alignedPayload = Math.max(16, Math.floor(rawTargetPayload / 16) * 16);
      target = Math.min(target, Math.min(totalBytes, HEADER_BYTE_LENGTH + alignedPayload));
    }
    return Math.max(Math.min(HEADER_BYTE_LENGTH, totalBytes), target);
  }

  function removeFromActiveQueue(session: ClientSessionData, id: string): void {
    const idx = session.activeQueue.indexOf(id);
    if (idx !== -1) {
      session.activeQueue.splice(idx, 1);
    }
  }

  function enqueueActiveTask(session: ClientSessionData, id: string): void {
    if (!session.activeQueue.includes(id)) {
      session.activeQueue.push(id);
    }
  }

  function scheduleNextTurn(ws: MxImgSocketTransport): void {
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

  function processOneRoundRobinTurn(ws: MxImgSocketTransport): void {
    const session = ws.data;
    if (ws.readyState !== 1 || session.activeQueue.length === 0 || session.pendingCommands > 0) {
      return;
    }

    const id = session.activeQueue.shift()!;
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

    let embeddedHeader: Uint8Array | undefined;
    if (
      chunkStart > 0 &&
      !task.sentEmbeddedHeader &&
      task.assetBytes.byteLength >= HEADER_BYTE_LENGTH
    ) {
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
      embeddedHeader,
    });

    ws.sendBinary(frameBytes);

    if (session.activeQueue.length > 0) {
      scheduleNextTurn(ws);
    }
  }

  async function handleClientCommand(
    ws: MxImgSocketTransport,
    cmd: MxImgClientCommand
  ): Promise<void> {
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
          task.targetBytes = computeTargetBytes(
            task.assetBytes.byteLength,
            cmd.maxPercent,
            cmd.maxBytes
          );
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
        maxBytes: cmd.maxBytes,
      });
      return;
    }

    if (cmd.type === "start") {
      const assetBytes = await resolveAssetBytes(cmd.id);
      if (!assetBytes) {
        const errMsg: MxImgServerErrorMessage = {
          type: "error",
          id: cmd.id,
          message: `No se encontró el asset MxImg para '${cmd.id}'`,
        };
        ws.sendText(JSON.stringify(errMsg));
        return;
      }

      const targetBytes = computeTargetBytes(assetBytes.byteLength, cmd.maxPercent, cmd.maxBytes);
      const startOffset = Math.max(0, Math.min(cmd.offsetBytes ?? 0, targetBytes));
      const chunkSizeBytes =
        cmd.chunkSize && cmd.chunkSize > 0 ? Math.floor(cmd.chunkSize) : defaultChunkSizeBytes;

      const existing = session.tasks.get(cmd.id);
      const task: StreamTaskState = {
        id: cmd.id,
        assetBytes,
        offsetBytes: startOffset,
        targetBytes,
        chunkSizeBytes,
        status: startOffset >= targetBytes ? "completed" : "active",
        sentEmbeddedHeader: existing?.sentEmbeddedHeader ?? false,
      };

      session.tasks.set(cmd.id, task);
      if (task.status === "active") {
        enqueueActiveTask(session, cmd.id);
        scheduleNextTurn(ws);
      }
    }
  }

  function createSession(): ClientSessionData {
    return {
      sessionId: randomUUID(),
      tasks: new Map(),
      activeQueue: [],
      schedulerRunning: false,
      pendingCommands: 0,
      commandChain: Promise.resolve(),
      throttleDelayMs: defaultThrottleDelayMs,
      timer: null,
    };
  }

  function handleIncomingMessage(ws: MxImgSocketTransport, message: string | Uint8Array): void {
    const session = ws.data;
    session.pendingCommands++;
    session.commandChain = session.commandChain
      .then(async () => {
        try {
          const text = typeof message === "string" ? message : new TextDecoder().decode(message);
          const cmd = JSON.parse(text) as MxImgClientCommand;
          await handleClientCommand(ws, cmd);
        } catch (err) {
          const errMsg: MxImgServerErrorMessage = {
            type: "error",
            id: "unknown",
            message: err instanceof Error ? err.message : "Comando inválido",
          };
          ws.sendText(JSON.stringify(errMsg));
        } finally {
          session.pendingCommands = Math.max(0, session.pendingCommands - 1);
          if (session.pendingCommands === 0 && session.activeQueue.length > 0) {
            scheduleNextTurn(ws);
          }
        }
      })
      .catch(() => {
        session.pendingCommands = Math.max(0, session.pendingCommands - 1);
      });
  }

  function cleanupSession(session: ClientSessionData): void {
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
    cleanupSession,
  };
}

function encodeWsServerFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const len = payload.byteLength;
  let headerLen = 2;
  if (len >= 65536) {
    headerLen = 10;
  } else if (len >= 126) {
    headerLen = 4;
  }

  const out = new Uint8Array(headerLen + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    out[1] = len;
  } else if (len < 65536) {
    out[1] = 126;
    out[2] = (len >> 8) & 0xff;
    out[3] = len & 0xff;
  } else {
    out[1] = 127;
    const dv = new DataView(out.buffer, out.byteOffset, 10);
    dv.setUint32(2, 0, false);
    dv.setUint32(6, len, false);
  }
  out.set(payload, headerLen);
  return out;
}

const attachedServers = new WeakSet<object>();

/**
 * Adjunta el manejador WebSocket de `<mx-img />` (`/.mx-img/stream`) sobre cualquier servidor
 * `node:http` / Vite / Astro (`httpServer.on("upgrade")`).
 */
export function attachMxImgUpgradeHandler(
  httpServer:
    { on?: (event: string, listener: (...args: any[]) => void) => unknown } | null | undefined,
  options: MxImgStreamServerOptions = {}
): void {
  if (!httpServer || typeof httpServer.on !== "function" || attachedServers.has(httpServer)) {
    return;
  }
  attachedServers.add(httpServer);

  const engine = createMxImgStreamEngine(options);
  const textEncoder = new TextEncoder();

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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

      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );

      if ("setNoDelay" in socket && typeof (socket as any).setNoDelay === "function") {
        (socket as any).setNoDelay(true);
      }

      const session = engine.createSession();
      let isOpen = true;

      const wsAdapter: MxImgSocketTransport = {
        data: session,
        get readyState() {
          return isOpen && !socket.destroyed && socket.writable ? 1 : 3;
        },
        sendBinary(data: Uint8Array) {
          if (this.readyState === 1) {
            socket.write(encodeWsServerFrame(0x02, data));
          }
        },
        sendText(text: string) {
          if (this.readyState === 1) {
            socket.write(encodeWsServerFrame(0x01, textEncoder.encode(text)));
          }
        },
      };

      let recvBuf: Buffer = Buffer.alloc(0);

      const processBuffer = (chunk: Buffer) => {
        if (chunk.length > 0) {
          recvBuf = recvBuf.length === 0 ? chunk : Buffer.concat([recvBuf, chunk]);
        }

        while (recvBuf.length >= 2) {
          const byte0 = recvBuf[0];
          const byte1 = recvBuf[1];
          const opcode = byte0 & 0x0f;
          const masked = (byte1 & 0x80) !== 0;
          let payloadLen = byte1 & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (recvBuf.length < 4) return;
            payloadLen = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (recvBuf.length < 10) return;
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
            for (let i = 0; i < payloadLen; i++) {
              payload[i] ^= maskKey[i & 3];
            }
          }

          if (opcode === 0x08) {
            isOpen = false;
            engine.cleanupSession(session);
            socket.end(encodeWsServerFrame(0x08, new Uint8Array(0)));
            return;
          }
          if (opcode === 0x09) {
            if (wsAdapter.readyState === 1) {
              socket.write(encodeWsServerFrame(0x0a, payload));
            }
            continue;
          }
          if (opcode === 0x01 || opcode === 0x02) {
            engine.handleIncomingMessage(wsAdapter, payload);
          }
        }
      };

      if (head && head.length > 0) {
        processBuffer(head);
      }

      socket.on("data", (chunk: Buffer) => {
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

let autoHookInstalled = false;

/**
 * Registra un hook automático sobre `http.Server.prototype.listen` para que servidores standalone
 * de Astro (`@astrojs/node`) sirvan automáticamente `/.mx-img/stream` en el mismo puerto.
 */
export function installMxImgAutoServerHook(options: MxImgStreamServerOptions = {}): void {
  if (autoHookInstalled) return;
  autoHookInstalled = true;

  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args: any[]) {
    attachMxImgUpgradeHandler(this, options);
    return origListen.apply(this, args as any);
  };
}

/**
 * Crea y levanta el servidor de streaming de `<mx-img />` sobre Bun (`Bun.serve`).
 *
 * Cumple los requisitos de la Fase 2:
 * - Endpoint en `http://localhost:8080/.mx-img/stream` (`ws://localhost:8080/.mx-img/stream`).
 * - 1 única conexión WebSocket por cliente.
 * - Planificador Round-Robin equitativo por porciones (ej. 100 KB por turno para cada imagen activa).
 * - Soporta iniciar (`start`), pausar (`pause`), continuar (`resume`) e inicios con desfase (`offsetBytes`).
 */
export function createMxImgStreamServer(options: MxImgStreamServerOptions = {}): {
  server: Server<ClientSessionData>;
  port: number;
  streamUrl: string;
  registerMemoryAsset: (id: string, bytes: Uint8Array) => void;
  stop: (closeActiveConnections?: boolean) => void;
} {
  const port = options.port ?? 8080;
  const hostname = options.hostname ?? "localhost";
  const engine = createMxImgStreamEngine(options);
  const { streamPath } = engine;

  const server = Bun.serve<ClientSessionData>({
    port,
    hostname,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      if (url.pathname === streamPath) {
        const upgraded = srv.upgrade(req, {
          data: engine.createSession(),
        });

        if (upgraded) {
          return undefined;
        }

        return new Response(
          JSON.stringify({
            service: "mx-img-stream",
            status: "ok",
            endpoint: streamPath,
            protocol: "websocket",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
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
      open(_ws) {
        // Conexión única establecida para este cliente
      },
      message(ws, message) {
        engine.handleIncomingMessage(ws as ServerWebSocket<ClientSessionData>, message);
      },
      close(ws) {
        engine.cleanupSession(ws.data);
      },
    },
  });

  const actualPort = server.port ?? port;
  return {
    server,
    port: actualPort,
    streamUrl: `http://${hostname}:${actualPort}${streamPath}`,
    registerMemoryAsset(id: string, bytes: Uint8Array) {
      engine.assetCache.set(id, bytes);
    },
    stop(closeActiveConnections = true) {
      server.stop(closeActiveConnections);
    },
  };
}

// CLI: `bun run src/server/stream-server.ts`
if (import.meta.main) {
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;
  const { streamUrl } = createMxImgStreamServer({ port });
  console.log("=".repeat(80));
  console.log("🚀 MX-IMG STREAM SERVER (Bun WebSocket Multiplexer)");
  console.log("=".repeat(80));
  console.log(`• Endpoint de stream : ${streamUrl}`);
  console.log(
    `• Tamaño de porción  : ${(DEFAULT_CHUNK_SIZE_BYTES / 1024).toFixed(0)} KB (Round-Robin Equitativo)`
  );
  console.log("=".repeat(80));
}
