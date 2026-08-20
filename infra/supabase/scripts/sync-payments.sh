#!/bin/sh
# Corre via cron para automatizar bc-sync-payments (Custom API propia,
# publicada 2026-08-20). Mismo patron que sync-purchase-orders.sh.
set -eu

URL="${PORTAL_SUPABASE_URL:-https://api.proveedores.jfmcss.com}/functions/v1/bc-sync-payments"
ANON_KEY="${PORTAL_ANON_KEY:?PORTAL_ANON_KEY debe estar definido}"
LOG_FILE="${PORTAL_SYNC_LOG:-$HOME/adsemble/portal/logs/sync-payments.log}"

mkdir -p "$(dirname "$LOG_FILE")"

response=$(curl -sS --max-time 120 -X POST "$URL" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json")

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $response" >>"$LOG_FILE"

case "$response" in
  *'"ok":true'*) exit 0 ;;
  *)
    echo "bc-sync-payments fallo: $response" >&2
    exit 1
    ;;
esac
