#!/bin/bash
cd "$(dirname "$0")" || exit 1
xattr -dr com.apple.quarantine . 2>/dev/null     # downloaded files are flagged by macOS; this lets the bundled Node run
./runtime/node launcher/service.mjs install
echo; read -n 1 -s -r -p "Press any key to close this window."
