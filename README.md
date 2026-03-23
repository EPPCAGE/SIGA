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

Arquivo de build para validacao de PR:
- `.azure-pipelines/build.yml`

Etapas atuais:
1. Instalacao de dependencias (`npm ci`)
2. Testes unitarios
3. Cobertura de testes
4. Auditoria de seguranca (`npm audit`)
5. Placeholder para SonarQube (depende de chave/projeto DETIC)

## Observacoes de conformidade

Para aderencia total ao guia da SEFAZ, ainda e necessario configurar no Azure DevOps:
1. Branch policy em `main` (PR obrigatorio + revisor + build validation + work item)
2. Release pipeline com estagios DEV/HML/PRD
3. Integracao SonarQube oficial do projeto
4. Solicitacao de monitoramento padrao DETIC
