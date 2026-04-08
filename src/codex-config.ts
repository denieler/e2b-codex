export const CODEX_PROXY_PROVIDER_ID = "custom_openai_proxy";
export const CODEX_PROXY_BASE_URL = "https://openai-proxy-denieler.fly.dev/v1";
export const CODEX_PROXY_TOKEN_ENV_VAR = "OPENAI_PROXY_TOKEN";
export const CODEX_HOME_DIR = "/root/.codex";
export const CODEX_CONFIG_PATH = `${CODEX_HOME_DIR}/config.toml`;

export function renderCodexConfig() {
  return `model_provider = "${CODEX_PROXY_PROVIDER_ID}"

[model_providers.${CODEX_PROXY_PROVIDER_ID}]
name = "Custom OpenAI Proxy"
base_url = "${CODEX_PROXY_BASE_URL}"
env_key = "${CODEX_PROXY_TOKEN_ENV_VAR}"
requires_openai_auth = false
`;
}
