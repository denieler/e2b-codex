import { createHash } from "node:crypto";

import { Sandbox } from "e2b";

import { CodexAppServerClient } from "./codex-app-server.js";

export type CodexSandboxOptions = {
  e2bApiKey: string;
  openAiApiKey: string;
  userId: string;
  timeoutMs?: number;
  allowInternetAccess?: boolean;
  port?: number;
  workspaceRoot?: string;
  metadata?: Record<string, string>;
};

export type CreateCodexSandboxOptions = CodexSandboxOptions & {
  templateId: string;
};

export type ConnectCodexSandboxOptions = Omit<
  CodexSandboxOptions,
  "allowInternetAccess" | "metadata"
> & {
  sandboxId: string;
};

export type ReadyCodexSandbox = {
  sandbox: Sandbox;
  sandboxId: string;
  websocketUrl: string;
  authToken: string;
  port: number;
  workspaceRoot: string;
};

function createAppServerToken(userId: string) {
  return createHash("sha256")
    .update("e2b-codex")
    .update(":")
    .update(userId)
    .digest("hex");
}

function getTokenFilePath() {
  return "/tmp/e2b-codex-ws-token";
}

async function ensureAppServerRunning(
  sandbox: Sandbox,
  options: Pick<CodexSandboxOptions, "openAiApiKey" | "port" | "workspaceRoot" | "userId">,
) {
  const port = options.port ?? 4571;
  const workspaceRoot = options.workspaceRoot ?? "/workspace";
  const tokenFile = getTokenFilePath();
  const token = createAppServerToken(options.userId);
  const processPattern = `[c]odex app-server --listen ws://0.0.0.0:${port}`;

  await sandbox.files.write(tokenFile, token);

  await sandbox.commands.run(`mkdir -p ${workspaceRoot}`, {
    timeoutMs: 10_000,
  });

  // Codex CLI 0.118.0 loses the auth header when it falls back from websocket
  // streaming to HTTPS while using API-key auth directly. Logging in once inside
  // the sandbox makes app-server use the stored auth path instead.
  await sandbox.commands.run(`sh -lc 'printenv OPENAI_API_KEY | codex login --with-api-key'`, {
    envs: {
      OPENAI_API_KEY: options.openAiApiKey,
    },
    timeoutMs: 20_000,
  });

  const existing = await sandbox.commands.run(
    `bash -lc 'ps -ef | grep "${processPattern}" || true'`,
    {
      timeoutMs: 10_000,
    },
  );
  if (existing.stdout.trim()) {
    return;
  }

  await sandbox.commands.run(
    `codex app-server --listen ws://0.0.0.0:${port} --ws-auth capability-token --ws-token-file ${tokenFile}`,
    {
      background: true,
      envs: {
        OPENAI_API_KEY: options.openAiApiKey,
      },
      timeoutMs: 15_000,
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const started = await sandbox.commands.run(
    `bash -lc 'ps -ef | grep "${processPattern}" || true'`,
    {
      timeoutMs: 10_000,
    },
  );

  if (!started.stdout.trim()) {
    throw new Error("codex app-server did not remain running after startup.");
  }
}

export async function createReadyCodexSandbox(
  options: CreateCodexSandboxOptions,
): Promise<ReadyCodexSandbox> {
  const port = options.port ?? 4571;
  const workspaceRoot = options.workspaceRoot ?? "/workspace";

  const sandbox = await Sandbox.create(options.templateId, {
    apiKey: options.e2bApiKey,
    timeoutMs: options.timeoutMs ?? 300_000,
    allowInternetAccess: options.allowInternetAccess ?? true,
    envs: {
      OPENAI_API_KEY: options.openAiApiKey,
    },
    metadata: {
      product: "e2b-codex",
      userId: options.userId,
      ...(options.metadata ?? {}),
    },
  });

  await ensureAppServerRunning(sandbox, {
    openAiApiKey: options.openAiApiKey,
    port,
    workspaceRoot,
    userId: options.userId,
  });

  return {
    sandbox,
    sandboxId: sandbox.sandboxId,
    websocketUrl: `wss://${sandbox.getHost(port)}`,
    authToken: createAppServerToken(options.userId),
    port,
    workspaceRoot,
  };
}

export async function connectCodexSandbox(
  options: ConnectCodexSandboxOptions,
): Promise<ReadyCodexSandbox> {
  const port = options.port ?? 4571;
  const workspaceRoot = options.workspaceRoot ?? "/workspace";

  const sandbox = await Sandbox.connect(options.sandboxId, {
    apiKey: options.e2bApiKey,
  });

  if (options.timeoutMs) {
    await sandbox.setTimeout(options.timeoutMs);
  }

  await ensureAppServerRunning(sandbox, {
    openAiApiKey: options.openAiApiKey,
    port,
    workspaceRoot,
    userId: options.userId,
  });

  return {
    sandbox,
    sandboxId: sandbox.sandboxId,
    websocketUrl: `wss://${sandbox.getHost(port)}`,
    authToken: createAppServerToken(options.userId),
    port,
    workspaceRoot,
  };
}

export async function connectCodexClient(
  readySandbox: Pick<ReadyCodexSandbox, "websocketUrl" | "authToken">,
) {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const client = await CodexAppServerClient.connect(
        readySandbox.websocketUrl,
        readySandbox.authToken,
      );
      await client.initialize();
      return client;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to open Codex websocket.");
}

export async function runPrompt(options: {
  sandbox: ReadyCodexSandbox;
  prompt: string;
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed";
}) {
  const client = await connectCodexClient(options.sandbox);
  const cwd = options.cwd ?? options.sandbox.workspaceRoot;
  const model = options.model ?? "gpt-5.3-codex";
  const effort = options.effort ?? "medium";
  const summary = options.summary ?? "concise";

  try {
    const started = await client.request("thread/start", {
      model,
      cwd,
    });
    const threadId = String((started.thread as { id?: string } | undefined)?.id ?? "");
    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }

    const agentMessageDeltas = new Map<string, string>();
    let fallbackReply = "";
    let lastAgentReply = "";

    await new Promise<void>((resolve, reject) => {
      const unsubscribe = client.onNotification((message) => {
        const params = (message.params ?? {}) as Record<string, unknown>;

        if (message.method === "item/agentMessage/delta" && typeof params.delta === "string") {
          const itemId = typeof params.itemId === "string" ? params.itemId : "__fallback__";
          const nextText = `${agentMessageDeltas.get(itemId) ?? ""}${params.delta}`;
          agentMessageDeltas.set(itemId, nextText);
          if (itemId === "__fallback__") {
            fallbackReply = nextText;
          }
          return;
        }

        if (message.method === "item/completed") {
          const item = (params.item ?? {}) as Record<string, unknown>;
          const content = Array.isArray(item.content) ? item.content : [];
          const completedText = content
            .map((part) =>
              typeof part === "object" && part && typeof (part as { text?: unknown }).text === "string"
                ? String((part as { text: string }).text)
                : "",
            )
            .join("")
            .trim();
          if (item.type === "agentMessage") {
            const itemId = typeof item.id === "string" ? item.id : "__fallback__";
            const replyText = agentMessageDeltas.get(itemId) ?? completedText;
            if (replyText) {
              lastAgentReply = replyText.trim();
            } else if (completedText) {
              lastAgentReply = completedText;
            }
          }
          return;
        }

        if (message.method === "error") {
          const error = (params.error ?? {}) as Record<string, unknown>;
          const errorMessage = String(error.message ?? "Codex turn failed.");
          const willRetry = Boolean(params.willRetry);
          if (willRetry) {
            return;
          }
          unsubscribe();
          reject(new Error(errorMessage));
          return;
        }

        if (message.method === "turn/completed") {
          unsubscribe();
          const turn = (params.turn ?? {}) as Record<string, unknown>;
          if (String(turn.status ?? "") === "failed") {
            reject(
              new Error(
                String(
                  ((turn.error as Record<string, unknown> | undefined)?.message as string | undefined) ??
                    "Codex turn failed.",
                ),
              ),
            );
            return;
          }
          resolve();
        }
      });

      client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: options.prompt }],
        cwd,
        model,
        effort,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: true,
        },
        summary,
      }).catch((error) => {
        unsubscribe();
        reject(error);
      });
    });

    return {
      threadId,
      reply: lastAgentReply || fallbackReply.trim(),
    };
  } finally {
    client.close();
  }
}
