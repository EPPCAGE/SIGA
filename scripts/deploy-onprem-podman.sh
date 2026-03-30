#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 18 ]]; then
  echo "Uso: $0 <package-root> <deploy-root> <ai-provider> <ai-token> <ai-model> <ai-fallback-models> <ai-api-url> <azure-endpoint> <azure-deployment> <azure-api-version> <azure-api-key> <auth-mode> <entra-client-id> <entra-tenant-id> <admin-emails> <editor-emails> <admin-token> <allowed-origins>" >&2
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
admin_emails="${15:-}"
editor_emails="${16:-}"
admin_token="${17:-}"
allowed_origins="${18:-}"

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

"$deploy_root/scripts/write-public-config.sh" \
  "$deploy_root/public-config.js" \
  "$auth_mode" \
  "$entra_client_id" \
  "$entra_tenant_id" \
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
SIGA_ADMIN_TOKEN=$admin_token
SIGA_ALLOWED_ORIGIN=$allowed_origins
EOF

cd "$deploy_root"
"${compose_cmd[@]}" up -d --build

echo "Deploy on-prem concluido em: $deploy_root"
