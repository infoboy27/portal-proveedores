#!/bin/sh
# Corre via cron para mantener el perfil de proveedores (email, estado)
# sincronizado con BC. A proposito NUNCA manda "inviteNewVendors":true --
# ver el incidente del 2026-08-20 en docs/BITACORA.md. Invitar proveedores
# nuevos sigue siendo una accion deliberada (Users.tsx -> Crear usuario, o
# una decision explicita de Adsemble para invitar en lotes controlados).
set -eu

URL="${PORTAL_SUPABASE_URL:-https://api.proveedores.jfmcss.com}/functions/v1/bc-sync-vendors"
ANON_KEY="${PORTAL_ANON_KEY:?PORTAL_ANON_KEY debe estar definido}"
LOG_FILE="${PORTAL_SYNC_LOG:-$HOME/adsemble/portal/logs/sync-vendors.log}"

mkdir -p "$(dirname "$LOG_FILE")"

response=$(curl -sS --max-time 60 -X POST "$URL" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"inviteNewVendors": false}')

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') $response" >>"$LOG_FILE"

case "$response" in
  *'"ok":true'*) exit 0 ;;
  *)
    echo "bc-sync-vendors fallo: $response" >&2
    exit 1
    ;;
esac
