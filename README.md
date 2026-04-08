# @denieler/e2b-codex

Use a shared E2B template with Codex preinstalled, then create fresh sandboxes from that template and talk to `codex app-server` over websocket.

![e2b-codex banner](https://raw.githubusercontent.com/denieler/e2b-codex/main/assets/e2b-codex-banner.svg)

This project covers two jobs:

- runtime use: create a sandbox, connect to Codex, send prompts, continue conversations
- template development: build and publish the shared E2B template

## Runtime Use

Install the package:

```bash
npm install @denieler/e2b-codex
```

### What you need

- `E2B_API_KEY`
- `OPENAI_PROXY_TOKEN`
- `E2B_TEMPLATE_ID`

`E2B_TEMPLATE_ID` must point to a template that already has Codex installed.

### Run one prompt

If you want to run the checked-in smoke test, run:

```bash
E2B_TEMPLATE_ID=<template-id> doppler run -- npm run test:smoke
```

What this does:

1. Creates a new sandbox from `E2B_TEMPLATE_ID`
2. Requests a short-lived proxy token from `https://openai-proxy-denieler.fly.dev/auth/token`
3. Signs that auth request with `OPENAI_PROXY_HMAC_SECRET`
4. Verifies the returned JWT locally with `OPENAI_PROXY_TOKEN_SECRET`
5. Starts `codex app-server` inside the sandbox using that token
6. Opens an authenticated websocket connection
7. Sends two turns on the same thread, both involving tool calls
8. Fails if any reply is not the expected final text

For the smoke test, Doppler must provide:

- `E2B_API_KEY`
- `E2B_TEMPLATE_ID`
- `OPENAI_PROXY_HMAC_SECRET`
- `OPENAI_PROXY_TOKEN_SECRET`

The proxy app listens on internal port `8080`, but Fly exposes it publicly on standard HTTPS, so the smoke test uses the public URL without `:8080`.

### Create a ready sandbox in code

```ts
import { createReadyCodexSandbox } from "@denieler/e2b-codex";

const ready = await createReadyCodexSandbox({
  e2bApiKey: process.env.E2B_API_KEY!,
  templateId: process.env.E2B_TEMPLATE_ID!,
  openAiProxyToken: process.env.OPENAI_PROXY_TOKEN!,
  userId: "user-123",
});
```

The returned object includes:

- `sandboxId`
- `websocketUrl`
- `authToken`
- `workspaceRoot`

### Connect to an existing sandbox in code

```ts
import { connectCodexSandbox } from "@denieler/e2b-codex";

const ready = await connectCodexSandbox({
  e2bApiKey: process.env.E2B_API_KEY!,
  sandboxId: "sandbox-id",
  openAiProxyToken: process.env.OPENAI_PROXY_TOKEN!,
  userId: "user-123",
});
```

Use this when you already persisted `sandboxId` and want to reconnect to the same sandbox instead of creating a new one.

This is also the path to use when a user rejoins later with a fresh `OPENAI_PROXY_TOKEN`.
On reconnect, the runtime rewrites the Codex config and restarts `codex app-server` so the newly supplied proxy token is used.

### Connect to Codex over websocket

```ts
import { connectCodexClient } from "@denieler/e2b-codex";

const client = await connectCodexClient(ready);
```

### Start a conversation

```ts
const started = await client.request("thread/start", {
  model: "gpt-5.3-codex",
  cwd: ready.workspaceRoot,
});

const threadId = String((started.thread as { id?: string }).id);
```

### Send turns on the same thread

```ts
await client.request("turn/start", {
  threadId,
  input: [{ type: "text", text: "First message" }],
  cwd: ready.workspaceRoot,
  model: "gpt-5.3-codex",
  effort: "medium",
  approvalPolicy: "never",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [ready.workspaceRoot],
    networkAccess: true,
  },
  summary: "concise",
});
```

To continue the same conversation:

- keep the sandbox alive
- reuse the same `threadId`
- send another `turn/start`

If your websocket connection drops, reconnect using the same `websocketUrl` and `authToken`, then continue using the same `threadId`.

### One-call helper

If you want one fresh sandbox and one prompt, use:

```ts
import { createReadyCodexSandbox, runPrompt } from "@denieler/e2b-codex";

const sandbox = await createReadyCodexSandbox({
  e2bApiKey: process.env.E2B_API_KEY!,
  templateId: process.env.E2B_TEMPLATE_ID!,
  openAiProxyToken: process.env.OPENAI_PROXY_TOKEN!,
  userId: "user-123",
});

const result = await runPrompt({
  sandbox,
  prompt: "Summarize this workspace in one sentence.",
});

console.log(result.reply);
```

## Template Development

Use this section if you are maintaining the template itself.

### Install

```bash
npm install
```

### Build the template

```bash
doppler run -- npm run build:template
```

The build prints:

- template name
- template id
- build id

Use the printed template id as `E2B_TEMPLATE_ID` for runtime use.

If you keep using an older template, the runtime still writes the same Codex provider config at sandbox startup. Rebuilding the template just bakes that config in ahead of time.

### What the build does

The template build:

- starts from E2B `base`
- installs a small set of system packages
- downloads the Codex Linux binary from OpenAI GitHub releases
- installs it to `/usr/local/bin/codex`
- writes `/root/.codex/config.toml` with the `custom_openai_proxy` provider

Codex is installed at template build time, not at sandbox startup.

### Useful commands

```bash
npm install
npm run typecheck
doppler run -- npm run build:template
E2B_TEMPLATE_ID=<template-id> doppler run -- npm run test:smoke
```

## Verification

After any substantial runtime, websocket, or sandbox change, run:

```bash
npm run typecheck
npm run build
E2B_TEMPLATE_ID=<template-id> doppler run -- npm run test:smoke
```

The smoke test covers both of these paths:

- proxy auth token issuance with signed `/auth/token` requests and local JWT verification
- direct websocket usage with `thread/start` plus two `turn/start` calls on the same thread, both involving tool calls

## Runtime Design

At sandbox startup, the runtime:

- injects `OPENAI_PROXY_TOKEN` into the sandbox environment
- writes `~/.codex/config.toml` selecting the `custom_openai_proxy` provider at `https://openai-proxy-denieler.fly.dev/v1`
- writes a websocket capability token into the sandbox
- starts `codex app-server` as an E2B background process
- restarts `codex app-server` on sandbox reconnect so a newly supplied `OPENAI_PROXY_TOKEN` takes effect
- waits for it to stay alive
- opens the websocket connection

`codex app-server` is started at runtime, not stored as a pre-running process in the template.

## Notes

- The template is shared. Sandboxes are ephemeral.
- Secrets are injected when the sandbox is created.
- `OPENAI_API_KEY` is not used by this package.
- The websocket token file is written to `/tmp/e2b-codex-ws-token`.
- The example uses `approvalPolicy: "never"` and `workspaceWrite`.

## Publish

Build the package:

```bash
npm run build
```

Pack it locally:

```bash
npm pack
```

Publish when ready:

```bash
npm publish
```
