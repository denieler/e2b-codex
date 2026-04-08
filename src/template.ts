import { Template } from "e2b";

import {
  CODEX_CONFIG_PATH,
  CODEX_HOME_DIR,
  renderCodexConfig,
} from "./codex-config.js";

const codexInstallScript = `
set -eux
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) TARGET="x86_64-unknown-linux-musl" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-musl" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

VERSION="\${CODEX_VERSION:-latest}"
ASSET="codex-$TARGET.tar.gz"
BASE_URL="https://github.com/openai/codex/releases"

if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="$BASE_URL/latest/download/$ASSET"
else
  DOWNLOAD_URL="$BASE_URL/download/$VERSION/$ASSET"
fi

curl -fsSL "$DOWNLOAD_URL" -o /tmp/codex.tar.gz
mkdir -p /tmp/codex-extract
tar -xzf /tmp/codex.tar.gz -C /tmp/codex-extract

BIN_PATH="/tmp/codex-extract/codex-$TARGET"
if [ ! -f "$BIN_PATH" ]; then
  echo "Codex binary not found after extraction." >&2
  exit 1
fi

install -m 0755 "$BIN_PATH" /usr/local/bin/codex
codex --version
`;

const codexConfigScript = `
set -eux
mkdir -p "${CODEX_HOME_DIR}"
cat > "${CODEX_CONFIG_PATH}" <<'EOF'
${renderCodexConfig()}EOF
`;

export const template = Template()
  .fromTemplate("base")
  .setUser("root")
  .aptInstall(["ca-certificates", "curl", "git", "tar", "unzip"], {
    noInstallRecommends: true,
  })
  .makeDir("/workspace", { mode: 0o755 })
  .runCmd(codexInstallScript)
  .runCmd(codexConfigScript)
  .runCmd("sh -lc 'command -v codex && codex --version'");
