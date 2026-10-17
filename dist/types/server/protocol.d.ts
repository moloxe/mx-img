/** Tamaño de porción por defecto en el reparto equitativo Round-Robin: 100 KB (102,400 bytes) */
export declare const DEFAULT_CHUNK_SIZE_BYTES: number;
export declare const FRAME_FLAG_COMPLETED: number;
export declare const FRAME_FLAG_HAS_EMBEDDED_HEADER: number;
/** Comandos de control enviados por el cliente hacia el servidor sobre la conexión única WebSocket */
export type MxImgClientCommand = {
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
} | {
    type: "pause";
    id: string;
} | {
    type: "resume";
    id: string;
    /** Opcionalmente permite actualizar el desfase al reanudar */
    offsetBytes?: number;
    maxPercent?: number;
    maxBytes?: number;
} | {
    type: "stop";
    id: string;
} | {
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
/**
 * Empaqueta un `MxImgServerChunkFrame` en un único `Uint8Array` para transmitir por WebSocket.
 */
export declare function encodeServerChunkFrame(frame: MxImgServerChunkFrame): Uint8Array;
/**
 * Desempaqueta un frame binario recibido por WebSocket en un `MxImgServerChunkFrame`.
 */
export declare function decodeServerChunkFrame(raw: ArrayBuffer | Uint8Array): MxImgServerChunkFrame;
/** Ruta por defecto del servicio de streaming */
export declare const DEFAULT_STREAM_URL = "/.mx-img/stream";
/**
 * Convierte una URL relativa (`"/.mx-img/stream"`), `http://` o `https://` a `ws://` o `wss://` para la conexión WebSocket.
 */
export declare function toWebSocketUrl(streamUrl?: string): string;
