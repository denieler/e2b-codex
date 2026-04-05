import { loadLocalEnvFile, requireEnvVar } from "../src/env.js";
import {
  connectCodexClient,
  createReadyCodexSandbox,
} from "../src/sandbox.js";

type TurnOptions = {
  client: Awaited<ReturnType<typeof connectCodexClient>>;
  threadId: string;
  cwd: string;
  model: string;
  prompt: string;
};

type SmokeResult = {
  sandboxId: string;
  websocketUrl: string;
  websocketThreadId: string;
  websocketReply1: string;
  websocketReply2: string;
};

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

async function sendTurn({ client, threadId, cwd, model, prompt }: TurnOptions) {
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
        if (Boolean(params.willRetry)) {
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
      input: [{ type: "text", text: prompt }],
      cwd,
      model,
      effort: "medium",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [cwd],
        networkAccess: true,
      },
      summary: "concise",
    }).catch((error) => {
      unsubscribe();
      reject(error);
    });
  });

  return lastAgentReply || fallbackReply.trim();
}

async function runSmokeTest(
  readySandbox: Awaited<ReturnType<typeof createReadyCodexSandbox>>,
  model: string,
): Promise<SmokeResult> {
  const client = await connectCodexClient(readySandbox);

  try {
    const started = await client.request("thread/start", {
      model,
      cwd: readySandbox.workspaceRoot,
    });
    const threadId = String((started.thread as { id?: string } | undefined)?.id ?? "");
    if (!threadId) {
      throw new Error("Codex did not return a thread id for websocket smoke test.");
    }

    const websocketReply1 = await sendTurn({
      client,
      threadId,
      cwd: readySandbox.workspaceRoot,
      model,
      prompt: "Run `pwd`, then reply with exactly WS-ONE after the command finishes.",
    });
    assertEqual(websocketReply1, "WS-ONE", "websocket turn 1 final reply");

    const websocketReply2 = await sendTurn({
      client,
      threadId,
      cwd: readySandbox.workspaceRoot,
      model,
      prompt:
        "Run `ls -1 | head -n 3`, then tell me what exact text you replied with previously. Reply with exactly WS-ONE.",
    });
    assertEqual(websocketReply2, "WS-ONE", "websocket turn 2 final reply");

    return {
      sandboxId: readySandbox.sandboxId,
      websocketUrl: readySandbox.websocketUrl,
      websocketThreadId: threadId,
      websocketReply1,
      websocketReply2,
    };
  } finally {
    client.close();
  }
}

async function main() {
  loadLocalEnvFile();

  const model = process.env.CODEX_MODEL || "gpt-5.3-codex";
  const readySandbox = await createReadyCodexSandbox({
    e2bApiKey: requireEnvVar("E2B_API_KEY"),
    templateId: requireEnvVar("E2B_TEMPLATE_ID"),
    openAiApiKey: requireEnvVar("OPENAI_API_KEY"),
    userId: process.env.CODEX_USER_ID || "example-user",
    allowInternetAccess: true,
  });

  try {
    const result = await runSmokeTest(readySandbox, model);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await readySandbox.sandbox.kill().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
