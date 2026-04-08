import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { Sandbox } from "e2b";

import { loadLocalEnvFile, requireEnvVar } from "../src/env.js";
import {
  connectCodexClient,
  connectCodexSandbox,
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

type ProxyTokenClaims = {
  aud: "proxy";
  exp: number;
  iat: number;
  iss: "openai-proxy";
  jti: string;
  sandbox_id?: string;
  scopes?: string[];
  session_id?: string;
  sub?: string;
};

const PROXY_AUTH_URL = "https://openai-proxy-denieler.fly.dev/auth/token";

function assertEqual(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function base64UrlEncode(value: Buffer) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function createAuthRequestSignature(
  secret: string,
  timestamp: string,
  method: string,
  pathAndQuery: string,
  body: string,
) {
  const payload = `${timestamp}\n${method.toUpperCase()}\n${pathAndQuery}\n${sha256Hex(body)}`;
  return base64UrlEncode(createHmac("sha256", secret).update(payload).digest());
}

function timingSafeEqualText(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function verifyIssuedProxyToken(options: {
  token: string;
  secret: string;
  sandboxId: string;
  scopes: string[];
  sessionId: string;
  subject: string;
}) {
  const segments = options.token.split(".");
  assert(segments.length === 3, "Proxy token is not a JWT.");

  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const expectedSignature = base64UrlEncode(
    createHmac("sha256", options.secret).update(`${encodedHeader}.${encodedPayload}`).digest(),
  );
  assert(
    timingSafeEqualText(encodedSignature, expectedSignature),
    "Proxy token signature verification failed.",
  );

  const header = JSON.parse(base64UrlDecode(encodedHeader).toString("utf8")) as {
    alg?: string;
    typ?: string;
  };
  assert(header.alg === "HS256" && header.typ === "JWT", "Proxy token header is invalid.");

  const claims = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as ProxyTokenClaims;
  assert(claims.aud === "proxy", "Proxy token audience is invalid.");
  assert(claims.iss === "openai-proxy", "Proxy token issuer is invalid.");
  assert(Number.isInteger(claims.iat) && Number.isInteger(claims.exp), "Proxy token timestamps are invalid.");
  assert(claims.exp > claims.iat, "Proxy token expiration is invalid.");
  assert(claims.sandbox_id === options.sandboxId, "Proxy token sandbox_id did not match.");
  assert(claims.session_id === options.sessionId, "Proxy token session_id did not match.");
  assert(claims.sub === options.subject, "Proxy token sub did not match.");
  assertEqual(JSON.stringify(claims.scopes ?? []), JSON.stringify(options.scopes), "proxy token scopes");

  return claims;
}

async function issueProxyToken(options: {
  hmacSecret: string;
  sandboxId: string;
  scopes: string[];
  sessionId: string;
  subject: string;
  tokenSecret: string;
}) {
  const url = new URL(PROXY_AUTH_URL);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    sandbox_id: options.sandboxId,
    scopes: options.scopes,
    session_id: options.sessionId,
    sub: options.subject,
  });
  const signature = createAuthRequestSignature(
    options.hmacSecret,
    timestamp,
    "POST",
    `${url.pathname}${url.search}`,
    body,
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature": signature,
      "x-timestamp": timestamp,
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Proxy auth request failed with ${response.status}: ${await response.text()}`);
  }

  const json = (await response.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
    token_type?: unknown;
  };
  assert(typeof json.access_token === "string", "Proxy auth response did not include access_token.");
  assert(typeof json.expires_in === "number", "Proxy auth response did not include expires_in.");
  assert(json.token_type === "Bearer", "Proxy auth response token_type was not Bearer.");

  const claims = verifyIssuedProxyToken({
    token: json.access_token,
    secret: options.tokenSecret,
    sandboxId: options.sandboxId,
    scopes: options.scopes,
    sessionId: options.sessionId,
    subject: options.subject,
  });
  assert(claims.exp - claims.iat === json.expires_in, "Proxy token ttl did not match expires_in.");

  return json.access_token;
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
  readySandbox: Awaited<ReturnType<typeof connectCodexSandbox>>,
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
  const e2bApiKey = requireEnvVar("E2B_API_KEY");
  const templateId = requireEnvVar("E2B_TEMPLATE_ID");
  const userId = process.env.CODEX_USER_ID || "example-user";
  const sessionId = `smoke-${Date.now()}`;
  const scopes = ["codex:smoke-test"];

  const sandbox = await Sandbox.create(templateId, {
    apiKey: e2bApiKey,
    allowInternetAccess: true,
    metadata: {
      product: "e2b-codex",
      userId,
    },
    timeoutMs: 300_000,
  });

  try {
    const proxyToken = await issueProxyToken({
      hmacSecret: requireEnvVar("OPENAI_PROXY_HMAC_SECRET"),
      sandboxId: sandbox.sandboxId,
      scopes,
      sessionId,
      subject: userId,
      tokenSecret: requireEnvVar("OPENAI_PROXY_TOKEN_SECRET"),
    });

    const readySandbox = await connectCodexSandbox({
      e2bApiKey,
      sandboxId: sandbox.sandboxId,
      openAiProxyToken: proxyToken,
      userId,
    });
    const result = await runSmokeTest(readySandbox, model);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
