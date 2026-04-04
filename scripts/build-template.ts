import { Template, defaultBuildLogger } from "e2b";

import { loadLocalEnvFile, requireEnvVar } from "../src/env.js";
import { template } from "../src/template.js";

async function main() {
  loadLocalEnvFile();

  const apiKey = requireEnvVar("E2B_API_KEY");
  const templateName = process.env.E2B_TEMPLATE_NAME || "e2b-codex-runtime";
  const cpuCount = Number(process.env.E2B_TEMPLATE_CPU_COUNT || 2);
  const memoryMB = Number(process.env.E2B_TEMPLATE_MEMORY_MB || 2048);

  const buildInfo = await Template.build(template, templateName, {
    apiKey,
    cpuCount,
    memoryMB,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log("");
  console.log(`Template name: ${buildInfo.name}`);
  console.log(`Template ID: ${buildInfo.templateId}`);
  console.log(`Build ID: ${buildInfo.buildId}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
