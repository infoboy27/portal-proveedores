#!/bin/sh
# Corre via cron (ver sync-purchase-orders.crontab) para automatizar
# bc-sync-orders, que hasta 2026-08-20 era invocacion manual (Dias 7-9 del
# compromiso con Adsemble). Independiente del proceso de la app, igual que
# el patron ya usado en dondeta/deploy/uptime-check.sh.
set -eu

URL="${PORTAL_SUPABASE_URL:-https://api.proveedores.jfmcss.com}/functions/v1/bc-sync-orders"
ANON_KEY="${PORTAL_ANON_KEY:?PORTAL_ANON_KEY debe estar definido}"
LOG_FILE="${PORTAL_SYNC_LOG:-$HOME/adsemble/portal/logs/sync-purchase-orders.log}"

mkdir -p "$(dirname "$LOG_FILE")"

response=$(curl -sS --max-time 120 -X POST "$URL" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json")

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $response" >>"$LOG_FILE"

case "$response" in
  *'"ok":true'*) exit 0 ;;
  *)
    echo "bc-sync-orders fallo: $response" >&2
    exit 1
    ;;
esac
