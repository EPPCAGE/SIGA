#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 9 ]]; then
  echo "Uso: $0 <output-path> <auth-mode> <entra-client-id> <entra-tenant-id> <entra-api-client-id> <entra-api-audience> <entra-api-scope> <admin-emails> <editor-emails>" >&2
  exit 1
fi

output_path="$1"
auth_mode="${2:-local}"
entra_client_id="${3:-}"
entra_tenant_id="${4:-}"
entra_api_client_id="${5:-}"
entra_api_audience="${6:-}"
entra_api_scope="${7:-}"
admin_emails="${8:-}"
editor_emails="${9:-}"

to_js_array() {
  local raw="$1"
  local result=""
  raw="${raw//;/,}"
  IFS=',' read -r -a items <<< "$raw"
  for item in "${items[@]}"; do
    item="$(echo "$item" | xargs)"
    [[ -z "$item" ]] && continue
    item="$(printf "%s" "$item" | sed "s/'/\\\\'/g")"
    if [[ -n "$result" ]]; then
      result+=", "
    fi
    result+="'$item'"
  done
  if [[ -z "$result" ]]; then
    printf '[]'
  else
    printf '[%s]' "$result"
  fi
}

admin_array="$(to_js_array "$admin_emails")"
editor_array="$(to_js_array "$editor_emails")"

cat > "$output_path" <<EOF
globalThis.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    mode: '$auth_mode',
    entra: {
      clientId: '$entra_client_id',
      tenantId: '$entra_tenant_id',
      redirectUri: globalThis.location.origin,
      apiClientId: '$entra_api_client_id',
      apiAudience: '$entra_api_audience',
      apiScope: '$entra_api_scope',
      adminEmails: $admin_array,
      editorEmails: $editor_array,
    },
  },
};
EOF
