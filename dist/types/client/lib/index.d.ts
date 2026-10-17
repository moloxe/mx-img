import { type MxImgClientCommand, type MxImgServerChunkFrame } from "../../server/protocol.ts";
export type MxImgLifecycleState = "sleeping" | "active" | "paused" | "completed" | "error";
export interface MxImgInitOptions {
    /** URL del servicio de streaming (ej. `"http://localhost:8080/.mx-img/stream"` o `"ws://..."`) */
    streamUrl: string;
    /** Margen del IntersectionObserver (por defecto `"0px"`) */
    rootMargin?: string;
    /** Umbral de visibilidad (0..1) para considerar visible al elemento (por defecto `0.05`) */
    threshold?: number;
    /** Tamaño de porción por defecto a solicitar en bytes (por defecto 100 KB) */
    chunkSize?: number;
}
export interface MxImgProgressDetail {
    id: string;
    state: MxImgLifecycleState;
    receivedBytes: number;
    targetBytes: number;
    totalAssetBytes: number;
    progressPercent: number;
    chromaPercent: number;
    coeficientesUsados: number;
    totalCoefficients: number;
    width: number;
    height: number;
    decodeTimeMs: number;
}
/**
 * Gestor de la única conexión WebSocket por cliente (`StreamConnectionManager`).
 *
 * Garantiza que exista **1 sola conexión** abierta hacia `streamUrl` para servir
 * todas las imágenes `<canvas is="mx-img">` visibles del documento.
 */
declare class StreamConnectionManager {
    private config;
    private ws;
    private isConnecting;
    private pendingCommands;
    private subscribers;
    private intersectionObserver;
    private mutationObserver;
    private reconnectTimer;
    configure(options: MxImgInitOptions): void;
    getConfig(): MxImgInitOptions | null;
    isConnected(): boolean;
    ensureConnected(forceReconnect?: boolean): void;
    sendCommand(cmd: MxImgClientCommand): void;
    registerElement(id: string, element: MxImg): void;
    unregisterElement(id: string, element: MxImg): void;
    private routeFrameToSubscribers;
    private hasActiveSubscribers;
    private resubscribeActiveWithOffset;
    private setupIntersectionObserver;
    /**
     * Transforma automáticamente cualquier etiqueta `<mx-img src="..."></mx-img>` en
     * `<canvas is="mx-img" src="..."></canvas>` preservando todos los atributos equivalentes de `canvas`.
     */
    setupDomUpgrader(): void;
    private dispatchConnectionEvent;
}
/** Instancia singleton del gestor de conexión única por cliente */
export declare const connectionManager: StreamConnectionManager;
declare const BaseCanvasClass: typeof HTMLCanvasElement;
/**
 * Custom Element `MxImg` que extiende directamente a `HTMLCanvasElement` (`<canvas is="mx-img">`).
 *
 * Comportamiento según visibilidad (`IntersectionObserver`):
 * - Si no es visible al iniciar: permanece dormido (`sleeping`, 0 bytes transferidos).
 * - Si es visible: inicia o continúa solicitando progresivamente las porciones que faltan (`active`).
 * - Si se deja de ver antes de terminar: se pone en pausa (`paused`).
 */
export declare class MxImg extends BaseCanvasClass {
    static get observedAttributes(): string[];
    private decoder;
    private state;
    private streamId;
    private hasStartedStream;
    private currentlyVisible;
    private receivedBytes;
    private targetBytes;
    private totalAssetBytes;
    private rafDecodeId;
    private decodeTimerId;
    private lastDecodeMs;
    private lastDecodedBytes;
    private lastDecodeTimestamp;
    connectedCallback(): void;
    disconnectedCallback(): void;
    private clearScheduledDecode;
    attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void;
    attachToManager(): void;
    private syncStreamAttributes;
    private resetStreamState;
    /**
     * Manejador invocado por el `IntersectionObserver` cuando cambia la visibilidad del canvas.
     */
    handleVisibilityChange(isVisible: boolean): void;
    /**
     * Inicia o reanuda la solicitud de porciones faltantes al servidor.
     */
    startOrResume(customOffsetBytes?: number): void;
    /**
     * Pausa la transferencia de porciones de esta imagen.
     */
    pause(): void;
    /**
     * Recibe un frame binario desde `StreamConnectionManager`, acumula los coeficientes
     * y programa/ejecuta la fase de decodificación sobre el `<canvas>`.
     */
    receiveChunkFrame(frame: MxImgServerChunkFrame): void;
    private scheduleDecodeRender;
    /**
     * Fase de decodificación del Custom Element `MxImg`.
     * Reconstruye la imagen RGB desde el espectro parcial acumulado (2D-IFFT + YCbCr->RGB)
     * y la dibuja en el contexto 2D de este `HTMLCanvasElement`.
     */
    decode(): MxImgProgressDetail | null;
    handleStreamError(message: string): void;
    getState(): MxImgLifecycleState;
    isVisibleInViewport(): boolean;
    getReceivedBytes(): number;
    getTargetBytes(): number;
    getMaxPercent(): number | undefined;
    getChunkSize(): number | undefined;
    private updateStateAttribute;
    private dispatchProgressEvent;
}
/**
 * Registra el Custom Element `<canvas is="mx-img">` y configura la conexión única
 * hacia el servidor de streaming.
 */
export declare function registerMxImgElement(): void;
/**
 * Inicializa la librería cliente `mx-img` con la URL del servidor de streaming
 * y abre el único puerto/conexión WebSocket para servir los canvas visibles.
 */
export declare function init(options: MxImgInitOptions): void;
export {};
