import type { Server } from "bun";
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
    onHttpRequest?: (req: Request, server: Server<ClientSessionData>) => Promise<Response | null> | Response | null;
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
export declare function createMxImgStreamServer(options?: MxImgStreamServerOptions): {
    server: Server<ClientSessionData>;
    port: number;
    streamUrl: string;
    registerMemoryAsset: (id: string, bytes: Uint8Array) => void;
    stop: (closeActiveConnections?: boolean) => void;
};
