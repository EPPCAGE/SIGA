# Azure DevOps CI/CD On-Premises - SIGA

## O que ja esta pronto

- Pipeline raiz `azure-pipelines.yml`
- Empacotamento de artefato on-prem Linux via `scripts/build-onprem-package.sh`
- Deploy para servidor Linux on-prem via agente do Azure DevOps em `scripts/deploy-onprem-podman.sh`
- Geracao de `public-config.js` no deploy via `scripts/write-public-config.sh`

## Como o fluxo funciona agora

1. O Azure DevOps executa o stage `CI`
2. Se tudo passar, o stage `Package` publica um artefato de deploy
3. O stage `Deploy_DEV` ou `Deploy_PRD` roda no agente Linux on-prem
4. O script de deploy:
   - copia os arquivos para a pasta alvo
   - preserva `data/`
   - gera `public-config.js`
   - gera `.env`
   - executa `podman compose up -d --build` ou `podman-compose up -d --build`

## Premissas do deploy

- Servidor Linux on-prem
- Agente do Azure DevOps instalado no proprio servidor de deploy
- Podman instalado no servidor
- `podman compose` ou `podman-compose` disponivel
- Saida HTTPS/443 para `dev.azure.com`

## Dados confirmados com a Infra

- Servidor: `SWDEVPRO01`
- IP: `172.26.237.6`
- Deploy feito pelo agente local do Azure DevOps
- Pool de deploy DEV: `sefaz-self-hosted-deployment-container-dev`
- Pool de deploy PRD: `sefaz-self-hosted-deployment-container-prd`
- Sem uso de `Environment`
- Caminho base de deploy: `/var/docker`
- Aplicacao SIGA em `/var/docker/SIGA`
- Volume persistente do backend: `/var/docker/SIGA/data`
- Runtime de containers: `podman`

## Variaveis esperadas no pipeline

### Gerais

- `BUILD_AGENT_POOL`
- `DEV_DEPLOY_AGENT_POOL`
- `PRD_DEPLOY_AGENT_POOL`
- `ENABLE_DEV_DEPLOY`
- `ENABLE_PRD_DEPLOY`

### Deploy DEV

- `DEV_DEPLOY_ROOT`
- `SIGA_AI_PROVIDER`
- `SIGA_AZURE_ENDPOINT`
- `SIGA_AZURE_DEPLOYMENT`
- `SIGA_AZURE_API_VERSION`
- `SIGA_AZURE_API_KEY`
- `SIGA_AUTH_MODE`
- `SIGA_ENTRA_CLIENT_ID`
- `SIGA_ENTRA_TENANT_ID`
- `SIGA_ADMIN_EMAILS`
- `SIGA_EDITOR_EMAILS`
- `SIGA_ADMIN_TOKEN`
- `SIGA_ALLOWED_ORIGIN`

### Deploy PRD

- `PRD_DEPLOY_ROOT`
- As mesmas variaveis de runtime acima

## O que ainda falta confirmar com a Infra

1. Se a autenticacao do frontend sera `local` ou `entra`
2. Se for `entra`:
   - `clientId`
   - `tenantId`
   - emails de administradores
   - emails de editores

## Como fazer o primeiro deploy

1. Ajuste `BUILD_AGENT_POOL`, `DEV_DEPLOY_AGENT_POOL` e `PRD_DEPLOY_AGENT_POOL`
2. Ajuste `DEV_DEPLOY_ROOT` e/ou `PRD_DEPLOY_ROOT`
3. Preencha as variaveis de runtime
4. Ative `ENABLE_DEV_DEPLOY=true` ou `ENABLE_PRD_DEPLOY=true`
5. Rode o pipeline
6. Verifique os logs do stage de deploy
7. Valide no servidor:
   - `cd /var/docker/SIGA`
   - `podman ps`
   - `podman compose ps` ou `podman-compose ps`
