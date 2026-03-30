# Azure DevOps CI/CD On-Premises - SIGA

## O que ja esta pronto

- Pipeline raiz `azure-pipelines.yml`
- Empacotamento de artefato on-prem via `scripts/build-onprem-package.ps1`
- Deploy para servidor com Docker Compose via `scripts/deploy-onprem-docker.ps1`
- Geracao de `public-config.js` em deploy via `scripts/write-public-config.ps1`

## Como o fluxo funciona

1. O Azure DevOps executa o stage `CI`
2. Se tudo passar, o stage `Package` publica um artefato de deploy
3. O stage `Deploy_HML` ou `Deploy_PRD` baixa o artefato no servidor registrado no `Environment`
4. O script de deploy:
   - copia os arquivos para a pasta alvo
   - gera `public-config.js`
   - gera `.env`
   - executa `docker compose up -d --build`

## Premissas do deploy

- O servidor on-prem deve ter Docker Engine e Docker Compose v2
- O servidor deve estar registrado no Azure DevOps como `Virtual machine resource` de um `Environment`
- O servidor precisa ter saida HTTPS/443 para `dev.azure.com`

## Variaveis esperadas no pipeline

### Gerais

- `BUILD_AGENT_POOL`
- `ENABLE_HML_DEPLOY`
- `ENABLE_PRD_DEPLOY`
- `HML_ENVIRONMENT_NAME`
- `PRD_ENVIRONMENT_NAME`

### Deploy HML

- `HML_DEPLOY_ROOT`
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

## Dados que ainda precisam vir da Infra

1. Nome do `Environment` do Azure DevOps para HML e/ou PRD
2. Caminho da pasta de deploy no servidor
3. Confirmacao de que o servidor usa Docker Compose
4. Conta que vai registrar o agente/VM resource
5. Confirmacao de saida HTTPS para `dev.azure.com`
6. Se o frontend vai usar autenticacao `local` ou `entra`
7. Se houver Entra:
   - `clientId`
   - `tenantId`
   - emails de administradores
   - emails de editores

## Como conectar o servidor on-prem ao Azure DevOps

1. No Azure DevOps, abra `Pipelines > Environments`
2. Crie o environment desejado, por exemplo `gesproc-prd`
3. Dentro do environment, escolha `Add resource > Virtual machines`
4. Copie o script PowerShell gerado pelo Azure DevOps
5. Execute o script no proprio servidor on-prem com permissao administrativa
6. Valide que o servidor aparece como `Healthy` no environment

## Como fazer o primeiro deploy

1. Ajuste as variaveis do pipeline
2. Ative `ENABLE_HML_DEPLOY=true` ou `ENABLE_PRD_DEPLOY=true`
3. Rode o pipeline
4. Verifique os logs do stage de deploy
5. Valide `docker compose ps` no servidor
