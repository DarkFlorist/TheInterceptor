#!/bin/sh
set -eu

# Honor explicit browser paths without skipping the headless display dependencies.
browser_path=''
for browser_binary in "${CHROME_BIN:-}" "${GOOGLE_CHROME_BIN:-}" chromium chromium-browser; do
  if [ -n "$browser_binary" ] && command -v "$browser_binary" >/dev/null 2>&1; then
    browser_path="$(command -v "$browser_binary")"
    break
  fi
done

set --
if [ -z "$browser_path" ]; then set -- "$@" chromium; fi
if ! command -v xauth >/dev/null 2>&1; then set -- "$@" xauth; fi
if ! command -v xvfb-run >/dev/null 2>&1; then set -- "$@" xvfb; fi
if [ "$#" -eq 0 ]; then
  echo "Chrome/Chromium and display helpers are already installed: $browser_path"
  exit 0
fi

if ! command -v apt-get >/dev/null 2>&1; then
  cat >&2 <<'EOF'
This helper only supports Debian/Ubuntu systems with apt-get.
Install Chromium, xauth and xvfb manually, then rerun:
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
run_as_root apt-get install -y --no-install-recommends "$@"

echo "Chrome/Chromium and display helpers are installed. The benchmark can use:"
echo "  bun run benchmark:popup-lifecycle"
