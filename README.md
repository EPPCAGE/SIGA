# SIGA

## Execucao local

1. Instalar dependencias:

```bash
npm ci
```

2. Backend local (porta 3000):

```bash
npm run local-backend
```

3. Frontend local (porta 5173):

```bash
npm run local-frontend
```

## Testes

- Rodar testes unitarios:

```bash
npm test
```

- Rodar testes com cobertura:

```bash
npm run test:coverage
```

Os testes seguem a estrutura recomendada no guia de desenvolvimento:
- `tests/unit`

## Pipeline (Azure DevOps)

Pipeline canonico:
- `azure-pipelines.yml`

Fluxo atual:
1. `CI`: `npm ci`, validacao de encoding, testes, cobertura, SonarCloud e GHAS
2. `Package`: gera um artefato de deploy on-prem para Linux
3. `Deploy_HML`: opcional, ativado por variavel
4. `Deploy_PRD`: opcional, ativado por variavel e branch `main`

Scripts de apoio:
- `scripts/build-onprem-package.sh`
- `scripts/deploy-onprem-podman.sh`
- `scripts/write-public-config.sh`

Documentacao de configuracao:
- `docs/DEVOPS_SETUP.md`
- `docs/AZURE_DEVOPS_ONPREM_CICD.md`

## Observacoes de conformidade

Para aderencia total ao guia da SEFAZ, ainda e necessario configurar no Azure DevOps:
1. Branch policy em `main` (PR obrigatorio + revisor + build validation + work item)
2. Preencher as variaveis de deploy HML/PRD
3. Confirmar o pool do agente Linux on-prem no Azure DevOps
4. Validar com a Infra o caminho de deploy e a conta do agente
