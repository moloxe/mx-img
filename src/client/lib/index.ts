import {
  DEFAULT_CHUNK_SIZE_BYTES,
  DEFAULT_STREAM_URL,
  decodeServerChunkFrame,
  type MxImgClientCommand,
  type MxImgServerChunkFrame,
  toWebSocketUrl,
} from "../../server/protocol.ts";
import { ProgressiveFourierDecoder } from "../../utils/encoding/decoder.ts";

export type MxImgLifecycleState = "sleeping" | "active" | "paused" | "completed" | "error";

export interface MxImgInitOptions {
  /** Ruta o URL del servicio de streaming (por defecto `"/.mx-img/stream"`) */
  streamUrl?: string;
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
class StreamConnectionManager {
  private config: (Required<Pick<MxImgInitOptions, "streamUrl">> & MxImgInitOptions) | null = null;
  private ws: WebSocket | null = null;
  private isConnecting = false;
  private pendingCommands: MxImgClientCommand[] = [];
  private subscribers = new Map<string, Set<MxImg>>();
  private intersectionObserver: IntersectionObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  public configure(options: MxImgInitOptions = {}): void {
    const prevUrl = this.config?.streamUrl;
    const resolvedStreamUrl = options.streamUrl ?? DEFAULT_STREAM_URL;
    this.config = {
      rootMargin: "0px",
      threshold: 0.05,
      chunkSize: DEFAULT_CHUNK_SIZE_BYTES,
      ...options,
      streamUrl: resolvedStreamUrl,
    };

    this.setupIntersectionObserver();
    this.setupDomUpgrader();
    this.ensureConnected(prevUrl !== undefined && prevUrl !== resolvedStreamUrl);

    // Observar cualquier <canvas is="mx-img"> que ya estuviera en el DOM antes de init()
    if (typeof document !== "undefined") {
      const existingCanvases = document.querySelectorAll('canvas[is="mx-img"]');
      for (const el of existingCanvases) {
        if (el instanceof MxImg) {
          el.attachToManager();
        }
      }
    }
  }

  public getConfig(): (Required<Pick<MxImgInitOptions, "streamUrl">> & MxImgInitOptions) | null {
    return this.config;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public ensureConnected(forceReconnect = false): void {
    if (!this.config || typeof WebSocket === "undefined") {
      return;
    }

    if (forceReconnect && this.ws) {
      this.ws.close();
      this.ws = null;
      this.isConnecting = false;
    }

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
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

      // Enviar comandos que estaban en cola mientras se abría la conexión única
      while (this.pendingCommands.length > 0) {
        const cmd = this.pendingCommands.shift()!;
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
          const msg = JSON.parse(event.data) as { type?: string; id?: string; message?: string };
          if (msg.type === "error" && msg.id) {
            const subs = this.subscribers.get(msg.id);
            if (subs) {
              for (const el of subs) {
                el.handleStreamError(msg.message ?? "Error en el stream");
              }
            }
          }
        } catch {
          // Ignorar mensajes de texto no JSON
        }
      }
    });

    socket.addEventListener("close", () => {
      this.isConnecting = false;
      this.ws = null;
      this.dispatchConnectionEvent("disconnected", wsUrl);

      // Si hay imágenes activas esperando porciones, reconectar con desfase automático
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
      console.warn(
        `[mx-img] Could not connect to stream endpoint "${wsUrl}" (configured streamUrl: "${this.config?.streamUrl}"). Verify that the mx-img stream server is reachable or pass a custom "streamUrl" in init({ streamUrl }).`
      );
      this.dispatchConnectionEvent("error", wsUrl);
    });
  }

  public sendCommand(cmd: MxImgClientCommand): void {
    this.ensureConnected();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    } else {
      // Deduplicar comandos de control pendientes para el mismo id
      if ("id" in cmd) {
        this.pendingCommands = this.pendingCommands.filter(
          (existing) => !("id" in existing && existing.id === cmd.id)
        );
      }
      this.pendingCommands.push(cmd);
    }
  }

  public registerElement(id: string, element: MxImg): void {
    let set = this.subscribers.get(id);
    if (!set) {
      set = new Set();
      this.subscribers.set(id, set);
    }
    set.add(element);

    if (this.intersectionObserver) {
      this.intersectionObserver.observe(element);
    }
  }

  public unregisterElement(id: string, element: MxImg): void {
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

  private routeFrameToSubscribers(frame: MxImgServerChunkFrame): void {
    const set = this.subscribers.get(frame.id);
    if (!set) return;
    for (const element of set) {
      element.receiveChunkFrame(frame);
    }
  }

  public hasOtherActiveSubscriber(id: string, excludeElement: MxImg): boolean {
    const set = this.subscribers.get(id);
    if (!set) return false;
    for (const el of set) {
      if (el !== excludeElement && el.getState() === "active") {
        return true;
      }
    }
    return false;
  }

  private hasActiveSubscribers(): boolean {
    for (const set of this.subscribers.values()) {
      for (const el of set) {
        if (el.getState() === "active") {
          return true;
        }
      }
    }
    return false;
  }

  private resubscribeActiveWithOffset(): void {
    for (const [id, set] of this.subscribers.entries()) {
      for (const el of set) {
        if (el.getState() === "active") {
          this.sendCommand({
            type: "start",
            id,
            offsetBytes: el.getReceivedBytes(),
            maxPercent: el.getMaxPercent(),
            chunkSize: el.getChunkSize() ?? this.config?.chunkSize,
          });
          break;
        }
      }
    }
  }

  private setupIntersectionObserver(): void {
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
    }

    const threshold = this.config?.threshold ?? 0.05;
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const target = entry.target;
          if (target instanceof MxImg) {
            const isVisible = entry.isIntersecting && entry.intersectionRatio >= threshold;
            target.handleVisibilityChange(isVisible);
          }
        }
      },
      {
        root: null,
        rootMargin: this.config?.rootMargin ?? "0px",
        threshold: [0, threshold],
      }
    );
  }

  /**
   * Transforma automáticamente cualquier etiqueta `<mx-img src="..."></mx-img>` en
   * `<canvas is="mx-img" src="..."></canvas>` preservando todos los atributos equivalentes de `canvas`.
   */
  public setupDomUpgrader(): void {
    if (typeof document === "undefined") {
      return;
    }

    const upgradeAllInRoot = (root: ParentNode) => {
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

  private dispatchConnectionEvent(
    status: "connected" | "disconnected" | "error",
    url: string
  ): void {
    if (typeof window !== "undefined" && typeof CustomEvent !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("mx-img:connection", {
          detail: { status, url },
        })
      );
    }
  }
}

/** Instancia singleton del gestor de conexión única por cliente */
export const connectionManager = new StreamConnectionManager();

const BaseCanvasClass: typeof HTMLCanvasElement =
  typeof HTMLCanvasElement !== "undefined"
    ? HTMLCanvasElement
    : (class {} as unknown as typeof HTMLCanvasElement);

/**
 * Custom Element `MxImg` que extiende directamente a `HTMLCanvasElement` (`<canvas is="mx-img">`).
 *
 * Comportamiento según visibilidad (`IntersectionObserver`):
 * - Si no es visible al iniciar: permanece dormido (`sleeping`, 0 bytes transferidos).
 * - Si es visible: inicia o continúa solicitando progresivamente las porciones que faltan (`active`).
 * - Si se deja de ver antes de terminar: se pone en pausa (`paused`).
 */
export class MxImg extends BaseCanvasClass {
  static get observedAttributes(): string[] {
    return ["src", "data-max-percent", "max-percent", "data-offset-bytes"];
  }

  private static decodedFrameCache = new Map<
    string,
    {
      receivedBytes: number;
      targetBytes: number;
      totalAssetBytes: number;
      isComplete: boolean;
      decoded: NonNullable<ReturnType<ProgressiveFourierDecoder["decodeToRgba"]>>;
    }
  >();

  private decoder = new ProgressiveFourierDecoder();
  private state: MxImgLifecycleState = "sleeping";
  private streamId = "";
  private hasStartedStream = false;
  private currentlyVisible = false;
  private receivedBytes = 0;
  private targetBytes = 0;
  private totalAssetBytes = 0;
  private rafDecodeId: number | null = null;
  private decodeTimerId: ReturnType<typeof setTimeout> | null = null;
  private lastDecodeMs = 0;
  private lastDecodedBytes = 0;
  private lastDecodeTimestamp = 0;

  public connectedCallback(): void {
    if (typeof this.hasAttribute === "function" && !this.hasAttribute("is")) {
      this.setAttribute("is", "mx-img");
    }
    this.syncStreamAttributes();
    this.updateStateAttribute(this.state);
    this.attachToManager();
  }

  public disconnectedCallback(): void {
    this.clearScheduledDecode();
    if (this.streamId) {
      if (
        this.state === "active" &&
        !connectionManager.hasOtherActiveSubscriber(this.streamId, this)
      ) {
        connectionManager.sendCommand({ type: "pause", id: this.streamId });
      }
      connectionManager.unregisterElement(this.streamId, this);
    }
  }

  private clearScheduledDecode(): void {
    if (this.rafDecodeId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafDecodeId);
      this.rafDecodeId = null;
    }
    if (this.decodeTimerId !== null) {
      clearTimeout(this.decodeTimerId);
      this.decodeTimerId = null;
    }
  }

  public attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null
  ): void {
    if (oldValue === newValue) return;
    if (name === "src") {
      if (this.streamId) {
        connectionManager.unregisterElement(this.streamId, this);
      }
      this.resetStreamState();
      this.syncStreamAttributes();
      this.attachToManager();
    }
  }

  public attachToManager(): void {
    if (!this.streamId) {
      this.syncStreamAttributes();
    }
    if (!this.streamId || !connectionManager.getConfig()) {
      return;
    }
    connectionManager.registerElement(this.streamId, this);
  }

  private syncStreamAttributes(): void {
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

  private resetStreamState(): void {
    this.clearScheduledDecode();
    this.decoder = new ProgressiveFourierDecoder();
    this.state = "sleeping";
    this.hasStartedStream = false;
    this.receivedBytes = 0;
    this.targetBytes = 0;
    this.totalAssetBytes = 0;
    this.lastDecodedBytes = 0;
    this.lastDecodeTimestamp = 0;
    this.updateStateAttribute("sleeping");
  }

  /**
   * Manejador invocado por el `IntersectionObserver` cuando cambia la visibilidad del canvas.
   */
  public handleVisibilityChange(isVisible: boolean): void {
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
        // Si nunca ha sido visible, permanece dormido
        this.updateStateAttribute("sleeping");
      }
    }
  }

  /**
   * Inicia o reanuda la solicitud de porciones faltantes al servidor.
   */
  public startOrResume(customOffsetBytes?: number): void {
    if (!this.streamId || this.state === "completed") {
      return;
    }

    if (customOffsetBytes !== undefined && customOffsetBytes >= 0) {
      this.receivedBytes = customOffsetBytes;
      MxImg.decodedFrameCache.delete(this.streamId);
    } else {
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
        chunkSize: this.getChunkSize(),
      });
    } else if (prevState === "paused" || prevState === "sleeping") {
      connectionManager.sendCommand({
        type: "resume",
        id: this.streamId,
        offsetBytes: this.receivedBytes,
        maxPercent: this.getMaxPercent(),
      });
    }
  }

  /**
   * Pausa la transferencia de porciones de esta imagen.
   */
  public pause(): void {
    if (!this.streamId || this.state === "completed" || this.state === "sleeping") {
      return;
    }
    this.clearScheduledDecode();
    this.updateStateAttribute("paused");
    if (!connectionManager.hasOtherActiveSubscriber(this.streamId, this)) {
      connectionManager.sendCommand({
        type: "pause",
        id: this.streamId,
      });
    }
    // Si quedaron bytes acumulados sin renderizar al pausar, renderizar el estado actual
    if (this.receivedBytes > this.lastDecodedBytes) {
      this.decode();
    }
  }

  /**
   * Recibe un frame binario desde `StreamConnectionManager`, acumula los coeficientes
   * y programa/ejecuta la fase de decodificación sobre el `<canvas>`.
   */
  public receiveChunkFrame(frame: MxImgServerChunkFrame): void {
    if (frame.embeddedHeader) {
      this.decoder.appendChunk(frame.embeddedHeader, 0, frame.totalAssetBytes);
    }

    this.decoder.appendChunk(frame.payload, frame.offsetBytes, frame.totalAssetBytes);
    this.receivedBytes = frame.deliveredBytes;
    this.targetBytes = frame.targetBytes;
    this.totalAssetBytes = frame.totalAssetBytes;

    const header = this.decoder.getHeader();
    if (header) {
      if (this.width !== header.width) this.width = header.width;
      if (this.height !== header.height) this.height = header.height;
    }

    // Notificar progreso de transferencia en cada porción de 100 KB
    const progressPercent =
      this.targetBytes > 0 ? Math.min(100, (this.receivedBytes / this.targetBytes) * 100) : 0;
    const injected = this.decoder.getInjectedCoefficients();
    const totalCoeffs = header?.numCoefficients ?? 0;
    const kCroma = header?.kCroma ?? 1;
    const chromaPercent = Math.min(
      100,
      (Math.min(kCroma, Math.floor(injected / 3)) / kCroma) * 100
    );

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
      decodeTimeMs: this.lastDecodeMs,
    });

    if (frame.isComplete) {
      this.clearScheduledDecode();
      this.updateStateAttribute("completed");
      this.decode();
      return;
    }

    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const isFirstRender = this.lastDecodedBytes === 0;
    const elapsedSinceLastDecode = now - this.lastDecodeTimestamp;

    if (isFirstRender || elapsedSinceLastDecode >= 220) {
      this.scheduleDecodeRender(0);
    } else if (this.decodeTimerId === null && this.rafDecodeId === null) {
      this.scheduleDecodeRender(220 - elapsedSinceLastDecode);
    }
  }

  private scheduleDecodeRender(delayMs: number): void {
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

  /**
   * Fase de decodificación del Custom Element `MxImg`.
   * Reconstruye la imagen RGB desde el espectro parcial acumulado (2D-IFFT + YCbCr->RGB)
   * y la dibuja en el contexto 2D de este `HTMLCanvasElement`.
   */
  public decode(): MxImgProgressDetail | null {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    const cached =
      this.streamId && this.receivedBytes > 0
        ? MxImg.decodedFrameCache.get(this.streamId)
        : undefined;

    let decoded = cached && cached.receivedBytes === this.receivedBytes ? cached.decoded : null;

    if (!decoded) {
      decoded = this.decoder.decodeToRgba();
      if (!decoded) {
        return null;
      }
      if (this.streamId && this.receivedBytes > 0) {
        MxImg.decodedFrameCache.set(this.streamId, {
          receivedBytes: this.receivedBytes,
          targetBytes: this.targetBytes,
          totalAssetBytes: this.totalAssetBytes,
          isComplete: this.state === "completed",
          decoded,
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
      porcentajeCromaCompletado,
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

    const progressPercent =
      this.targetBytes > 0
        ? Math.min(100, (this.receivedBytes / this.targetBytes) * 100)
        : decoded.porcentajeCompletado;

    const detail: MxImgProgressDetail = {
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
      decodeTimeMs: this.lastDecodeMs,
    };

    this.dispatchProgressEvent("mx-img:progress", detail);
    if (this.state === "completed") {
      this.dispatchProgressEvent("mx-img:complete", detail);
    }

    return detail;
  }

  public handleStreamError(message: string): void {
    this.updateStateAttribute("error");
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(
        new CustomEvent("mx-img:error", {
          bubbles: true,
          detail: { id: this.streamId, message },
        })
      );
    }
  }

  public getState(): MxImgLifecycleState {
    return this.state;
  }

  public isVisibleInViewport(): boolean {
    return this.currentlyVisible;
  }

  public getReceivedBytes(): number {
    return this.receivedBytes;
  }

  public getTargetBytes(): number {
    return this.targetBytes;
  }

  public getMaxPercent(): number | undefined {
    const raw = this.getAttribute("max-percent") ?? this.getAttribute("data-max-percent");
    if (!raw) return undefined;
    const val = Number.parseFloat(raw);
    return !Number.isNaN(val) && val > 0 && val <= 100 ? val : undefined;
  }

  public getChunkSize(): number | undefined {
    const raw = this.getAttribute("data-chunk-size");
    if (!raw) return undefined;
    const val = Number.parseInt(raw, 10);
    return !Number.isNaN(val) && val > 0 ? val : undefined;
  }

  private updateStateAttribute(nextState: MxImgLifecycleState): void {
    this.state = nextState;
    if (typeof this.setAttribute === "function") {
      this.setAttribute("data-mx-state", nextState);
    }
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(
        new CustomEvent("mx-img:state", {
          bubbles: true,
          detail: {
            id: this.streamId,
            state: nextState,
            receivedBytes: this.receivedBytes,
            targetBytes: this.targetBytes,
          },
        })
      );
    }
  }

  private dispatchProgressEvent(eventName: string, detail: MxImgProgressDetail): void {
    if (typeof CustomEvent !== "undefined" && typeof this.dispatchEvent === "function") {
      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          detail,
        })
      );
    }
  }
}

/**
 * Registra el Custom Element `<canvas is="mx-img">` y configura la conexión única
 * hacia el servidor de streaming.
 */
export function registerMxImgElement(): void {
  if (typeof customElements !== "undefined" && !customElements.get("mx-img")) {
    customElements.define("mx-img", MxImg, { extends: "canvas" });
  }
}

/**
 * Inicializa la librería cliente `mx-img` con la URL del servidor de streaming
 * (por defecto `"/.mx-img/stream"`) y abre la única conexión WebSocket para servir los canvas visibles.
 */
export function init(options: MxImgInitOptions = {}): void {
  registerMxImgElement();
  connectionManager.configure(options);
}

// Registro automático si se carga en navegador
if (typeof window !== "undefined") {
  registerMxImgElement();
}
