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
- `OPENAI_API_KEY`
- `E2B_TEMPLATE_ID`

`E2B_TEMPLATE_ID` must point to a template that already has Codex installed.

### Run one prompt

If you just want to verify the full flow, run:

```bash
E2B_TEMPLATE_ID=<template-id> doppler run -- npm run example:prompt -- "Reply with exactly: test-ok"
```

What this does:

1. Creates a new sandbox from `E2B_TEMPLATE_ID`
2. Starts `codex app-server` inside the sandbox
3. Opens an authenticated websocket connection
4. Starts a Codex thread
5. Sends one prompt
6. Returns the final reply

### Create a ready sandbox in code

```ts
import { createReadyCodexSandbox } from "@denieler/e2b-codex";

const ready = await createReadyCodexSandbox({
  e2bApiKey: process.env.E2B_API_KEY!,
  templateId: process.env.E2B_TEMPLATE_ID!,
  openAiApiKey: process.env.OPENAI_API_KEY!,
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
  openAiApiKey: process.env.OPENAI_API_KEY!,
  userId: "user-123",
});
```

Use this when you already persisted `sandboxId` and want to reconnect to the same sandbox instead of creating a new one.

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
  openAiApiKey: process.env.OPENAI_API_KEY!,
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

### What the build does

The template build:

- starts from E2B `base`
- installs a small set of system packages
- downloads the Codex Linux binary from OpenAI GitHub releases
- installs it to `/usr/local/bin/codex`

Codex is installed at template build time, not at sandbox startup.

### Useful commands

```bash
npm install
npm run typecheck
doppler run -- npm run build:template
E2B_TEMPLATE_ID=<template-id> doppler run -- npm run example:prompt -- "Hello"
```

## Runtime Design

At sandbox startup, the runtime:

- logs Codex into the sandbox using `OPENAI_API_KEY`
- writes a websocket capability token into the sandbox
- starts `codex app-server` as an E2B background process
- waits for it to stay alive
- opens the websocket connection

`codex app-server` is started at runtime, not stored as a pre-running process in the template.

## Notes

- The template is shared. Sandboxes are ephemeral.
- Secrets are injected when the sandbox is created.
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
