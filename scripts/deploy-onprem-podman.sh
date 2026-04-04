#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 21 ]]; then
  echo "Uso: $0 <package-root> <deploy-root> <ai-provider> <ai-token> <ai-model> <ai-fallback-models> <ai-api-url> <azure-endpoint> <azure-deployment> <azure-api-version> <azure-api-key> <auth-mode> <entra-client-id> <entra-tenant-id> <entra-api-client-id> <entra-api-audience> <entra-api-scope> <admin-emails> <editor-emails> <admin-token> <allowed-origins>" >&2
  exit 1
fi

package_root="$1"
deploy_root="$2"
ai_provider="${3:-github-models}"
ai_token="${4:-}"
ai_model="${5:-}"
ai_fallback_models="${6:-}"
ai_api_url="${7:-}"
azure_endpoint="${8:-}"
azure_deployment="${9:-}"
azure_api_version="${10:-}"
azure_api_key="${11:-}"
auth_mode="${12:-local}"
entra_client_id="${13:-}"
entra_tenant_id="${14:-}"
entra_api_client_id="${15:-}"
entra_api_audience="${16:-}"
entra_api_scope="${17:-}"
admin_emails="${18:-}"
editor_emails="${19:-}"
admin_token="${20:-}"
allowed_origins="${21:-}"

if [[ ! -d "$package_root" ]]; then
  echo "Pacote de deploy nao encontrado: $package_root" >&2
  exit 1
fi

if ! command -v podman >/dev/null 2>&1; then
  echo "Podman nao esta disponivel no servidor de deploy." >&2
  exit 1
fi

compose_cmd=()
if podman compose version >/dev/null 2>&1; then
  compose_cmd=(podman compose)
elif command -v podman-compose >/dev/null 2>&1; then
  compose_cmd=(podman-compose)
else
  echo "Nem 'podman compose' nem 'podman-compose' estao disponiveis." >&2
  exit 1
fi

mkdir -p "$deploy_root"
mkdir -p "$deploy_root/data"

managed_items=(
  "docker-compose.yml"
  "docker"
  "modules"
  "scripts"
  "index.html"
  "sw.js"
  "package.json"
  "package-lock.json"
  "public-config.entra.example.js"
  "public-config.js"
  ".env"
  "deploy-manifest.json"
)

for item in "${managed_items[@]}"; do
  rm -rf "$deploy_root/$item"
done

shopt -s dotglob
for item in "$package_root"/*; do
  name="$(basename "$item")"
  cp -R "$item" "$deploy_root/$name"
done
shopt -u dotglob

bash "$deploy_root/scripts/write-public-config.sh" \
  "$deploy_root/public-config.js" \
  "$auth_mode" \
  "$entra_client_id" \
  "$entra_tenant_id" \
  "$entra_api_client_id" \
  "$entra_api_audience" \
  "$entra_api_scope" \
  "$admin_emails" \
  "$editor_emails"

cat > "$deploy_root/.env" <<EOF
SIGA_AI_PROVIDER=$ai_provider
SIGA_AI_TOKEN=$ai_token
SIGA_AI_MODEL=$ai_model
SIGA_AI_FALLBACK_MODELS=$ai_fallback_models
SIGA_AI_API_URL=$ai_api_url
SIGA_AZURE_ENDPOINT=$azure_endpoint
SIGA_AZURE_DEPLOYMENT=$azure_deployment
SIGA_AZURE_API_VERSION=$azure_api_version
SIGA_AZURE_API_KEY=$azure_api_key
SIGA_AUTH_MODE=$auth_mode
SIGA_ENTRA_TENANT_ID=$entra_tenant_id
SIGA_ENTRA_API_CLIENT_ID=$entra_api_client_id
SIGA_ENTRA_API_AUDIENCE=$entra_api_audience
SIGA_ADMIN_TOKEN=$admin_token
SIGA_ALLOWED_ORIGIN=$allowed_origins
SIGA_FRONTEND_PORT=${SIGA_FRONTEND_PORT:-8081}
EOF

cd "$deploy_root"
# Derruba a stack atual antes do rebuild para liberar nomes/portas do SIGA.
"${compose_cmd[@]}" down --remove-orphans || true
podman rm -f siga-frontend siga-backend || true

if command -v ss >/dev/null 2>&1; then
  ss -ltnp | grep ':8081' || true
fi

"${compose_cmd[@]}" up -d --build

echo "Deploy on-prem concluido em: $deploy_root"
