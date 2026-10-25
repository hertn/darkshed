#!/bin/sh
cd "$(dirname "$0")" || exit 1
./runtime/node launcher/start.mjs
printf '\nPress Enter to close. '; read _
