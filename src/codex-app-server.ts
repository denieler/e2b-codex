import WebSocket from "ws";

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
};

type NotificationHandler = (
  message: Required<Pick<JsonRpcMessage, "method">> & JsonRpcMessage,
) => void;

export class CodexAppServerClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private nextId = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on("message", (data) => {
      this.handleIncomingMessage(typeof data === "string" ? data : data.toString("utf8"));
    });
    this.socket.on("error", (error) => {
      this.rejectAllPending(error);
    });
    this.socket.on("close", () => {
      this.rejectAllPending(new Error("Codex websocket connection closed."));
    });
  }

  static async connect(url: string, authToken?: string) {
    const socket = new WebSocket(url, {
      headers: authToken
        ? {
            Authorization: `Bearer ${authToken}`,
          }
        : undefined,
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", () => reject(new Error("Unable to open Codex websocket.")));
    });

    return new CodexAppServerClient(socket);
  }

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async initialize(clientInfo?: {
    name?: string;
    title?: string;
    version?: string;
  }) {
    await this.request("initialize", {
      clientInfo: {
        name: clientInfo?.name ?? "e2b_codex",
        title: clientInfo?.title ?? "E2B Codex",
        version: clientInfo?.version ?? "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  async request(method: string, params: Record<string, unknown>) {
    const id = this.nextId++;
    const payload = { id, method, params };

    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.socket.send(JSON.stringify(payload));
    return resultPromise;
  }

  notify(method: string, params: Record<string, unknown>) {
    this.socket.send(JSON.stringify({ method, params }));
  }

  close() {
    this.socket.close();
  }

  private handleIncomingMessage(raw: string) {
    if (!raw) {
      return;
    }

    const message = JSON.parse(raw) as JsonRpcMessage;
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }

      pending.resolve(message.result ?? {});
      return;
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message as Required<Pick<JsonRpcMessage, "method">> & JsonRpcMessage);
      }
    }
  }

  private rejectAllPending(error: unknown) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
