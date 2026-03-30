#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Uso: $0 <output-path>" >&2
  exit 1
fi

output_path="$1"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rm -rf "$output_path"
mkdir -p "$output_path"

items=(
  "docker-compose.yml"
  "index.html"
  "sw.js"
  "package.json"
  "package-lock.json"
  "public-config.entra.example.js"
  "docker"
  "modules"
  "scripts"
)

for item in "${items[@]}"; do
  source_path="$repo_root/$item"
  if [[ ! -e "$source_path" ]]; then
    echo "Item obrigatorio ausente no pacote de deploy: $item" >&2
    exit 1
  fi
  cp -R "$source_path" "$output_path/$item"
done

cat > "$output_path/deploy-manifest.json" <<EOF
{
  "buildId": "${BUILD_BUILDID:-}",
  "branch": "${BUILD_SOURCEBRANCH:-}",
  "commit": "${BUILD_SOURCEVERSION:-}",
  "generatedAt": "$(date -Iseconds)",
  "packageType": "podman-compose-onprem"
}
EOF

echo "Pacote on-prem gerado em: $output_path"
