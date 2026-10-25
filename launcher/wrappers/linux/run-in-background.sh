#!/bin/sh
cd "$(dirname "$0")" || exit 1
./runtime/node launcher/service.mjs install
printf '\nPress Enter to close. '; read _
