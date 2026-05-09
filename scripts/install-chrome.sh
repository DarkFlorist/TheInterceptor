#!/usr/bin/env bash
set -euo pipefail

if command -v chromium >/dev/null 2>&1; then
  echo "chromium is already installed at: $(command -v chromium)"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  cat >&2 <<'EOF'
This helper only supports Debian/Ubuntu systems with apt-get.
Install Chromium manually, then rerun:
  CHROME_BIN=/path/to/chromium bun run benchmark:popup-lifecycle
EOF
  exit 1
fi

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

run_as_root apt-get update
run_as_root apt-get install -y --no-install-recommends chromium xauth xvfb

echo "Chromium installed. The benchmark can use:"
echo "  bun run benchmark:popup-lifecycle"
