import { loadLocalEnvFile, requireEnvVar } from "../src/env.js";
import { createReadyCodexSandbox, runPrompt } from "../src/sandbox.js";

async function main() {
  loadLocalEnvFile();

  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    throw new Error("Usage: npm run example:prompt -- \"Your prompt here\"");
  }

  const readySandbox = await createReadyCodexSandbox({
    e2bApiKey: requireEnvVar("E2B_API_KEY"),
    templateId: requireEnvVar("E2B_TEMPLATE_ID"),
    openAiApiKey: requireEnvVar("OPENAI_API_KEY"),
    userId: process.env.CODEX_USER_ID || "example-user",
    allowInternetAccess: true,
  });

  const result = await runPrompt({
    sandbox: readySandbox,
    prompt,
    cwd: readySandbox.workspaceRoot,
    model: process.env.CODEX_MODEL || "gpt-5.3-codex",
  });

  console.log(JSON.stringify({
    sandboxId: readySandbox.sandboxId,
    websocketUrl: readySandbox.websocketUrl,
    threadId: result.threadId,
    reply: result.reply,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
