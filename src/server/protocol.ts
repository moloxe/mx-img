import { HEADER_BYTE_LENGTH } from "../utils/encoding/binary.ts";

/** Tamaño de porción por defecto en el reparto equitativo Round-Robin: 100 KB (102,400 bytes) */
export const DEFAULT_CHUNK_SIZE_BYTES = 100 * 1024;

/** Magic de 4 bytes para frames binarios del servidor ("MXCH") */
const FRAME_MAGIC = new Uint8Array([0x4d, 0x58, 0x43, 0x48]);
const BASE_ENVELOPE_BYTES = 24;

export const FRAME_FLAG_COMPLETED = 1 << 0;
export const FRAME_FLAG_HAS_EMBEDDED_HEADER = 1 << 1;

/** Comandos de control enviados por el cliente hacia el servidor sobre la conexión única WebSocket */
export type MxImgClientCommand =
  | {
      type: "start";
      id: string;
      /** Inicio con desfase en bytes dentro del stream `.mximg` (por defecto 0) */
      offsetBytes?: number;
      /** Porcentaje máximo de datos a transferir dinámicamente (0.01 - 100) */
      maxPercent?: number;
      /** Límite máximo de bytes a transferir dinámicamente */
      maxBytes?: number;
      /** Tamaño de porción por turno en bytes (por defecto 100 KB) */
      chunkSize?: number;
    }
  | {
      type: "pause";
      id: string;
    }
  | {
      type: "resume";
      id: string;
      /** Opcionalmente permite actualizar el desfase al reanudar */
      offsetBytes?: number;
      maxPercent?: number;
      maxBytes?: number;
    }
  | {
      type: "stop";
      id: string;
    }
  | {
      type: "throttle";
      /** Pausa en ms entre turnos del planificador para pruebas visuales */
      delayMs: number;
    };

/** Evento de error JSON opcional enviado por el servidor si un hash/ruta no existe */
export interface MxImgServerErrorMessage {
  type: "error";
  id: string;
  message: string;
}

/** Estructura de un frame binario de porción enviado del servidor al cliente */
export interface MxImgServerChunkFrame {
  /** Identificador de la imagen solicitada (hash o ruta enviada por el cliente) */
  id: string;
  /** Offset inicial en bytes de esta porción dentro del archivo `.mximg` */
  offsetBytes: number;
  /** Total de bytes acumulados tras esta porción (`offsetBytes + payload.byteLength`) */
  deliveredBytes: number;
  /** Meta de bytes a entregar para esta petición (considerando `maxPercent`/`maxBytes`) */
  targetBytes: number;
  /** Tamaño total en bytes del archivo `.mximg` completo en el servidor */
  totalAssetBytes: number;
  /** Indica si con esta porción se alcanzó `targetBytes` (envío terminado) */
  isComplete: boolean;
  /** Porción de bytes del archivo `.mximg` correspondiente a `[offsetBytes .. deliveredBytes]` */
  payload: Uint8Array;
  /**
   * Si la petición inició con desfase (`offsetBytes > 0`), contiene los primeros 32 bytes
   * de cabecera `MXIMG001` para que el decodificador conozca las dimensiones sin alterar el conteo de chunks.
   */
  embeddedHeader?: Uint8Array;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Empaqueta un `MxImgServerChunkFrame` en un único `Uint8Array` para transmitir por WebSocket.
 */
export function encodeServerChunkFrame(frame: MxImgServerChunkFrame): Uint8Array {
  const idBytes = textEncoder.encode(frame.id);
  const hasEmbeddedHeader =
    frame.embeddedHeader !== undefined && frame.embeddedHeader.byteLength === HEADER_BYTE_LENGTH;
  const embeddedLen = hasEmbeddedHeader ? HEADER_BYTE_LENGTH : 0;

  const totalFrameLen =
    BASE_ENVELOPE_BYTES + idBytes.byteLength + embeddedLen + frame.payload.byteLength;
  const buffer = new Uint8Array(totalFrameLen);
  buffer.set(FRAME_MAGIC, 0);

  let flags = 0;
  if (frame.isComplete) flags |= FRAME_FLAG_COMPLETED;
  if (hasEmbeddedHeader) flags |= FRAME_FLAG_HAS_EMBEDDED_HEADER;

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

/**
 * Desempaqueta un frame binario recibido por WebSocket en un `MxImgServerChunkFrame`.
 */
export function decodeServerChunkFrame(raw: ArrayBuffer | Uint8Array): MxImgServerChunkFrame {
  const buffer = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (buffer.byteLength < BASE_ENVELOPE_BYTES) {
    throw new Error("Frame de stream demasiado corto");
  }

  for (let i = 0; i < FRAME_MAGIC.length; i++) {
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

  let embeddedHeader: Uint8Array | undefined;
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
    embeddedHeader,
  };
}

/**
 * Convierte una URL `http://` o `https://` a `ws://` o `wss://` para la conexión WebSocket.
 */
export function toWebSocketUrl(streamUrl: string): string {
  const trimmed = streamUrl.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed;
  }
  if (trimmed.startsWith("https://")) {
    return `wss://${trimmed.slice("https://".length)}`;
  }
  if (trimmed.startsWith("http://")) {
    return `ws://${trimmed.slice("http://".length)}`;
  }
  if (typeof window !== "undefined" && trimmed.startsWith("/")) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}${trimmed}`;
  }
  return `ws://${trimmed}`;
}
