# 🛠️ Guia de Configuração DevOps — SIGA

> **Última atualização:** 2026-03 | **Autor:** Pipeline gerado automaticamente

---

## 📐 Visão Geral da Arquitetura

```
feature/* ──► dev ──► hml ──► main (prd)
                │        │         │
               CI      CI+QG     CI+QG+Aprovação
```

| Branch   | Pipeline                         | Quality Gate | Aprovações | Deploy        |
|----------|----------------------------------|:------------:|:----------:|---------------|
| `dev`    | `.azure-pipelines/ci-dev.yml`    | Informacional| —          | Não aplicável |
| `hml`    | `.azure-pipelines/ci-hml.yml`    | ✅ Bloqueante | 1 revisor  | siga-hml      |
| `main`   | `.azure-pipelines/ci-prd.yml`    | ✅ Bloqueante | 2 revisores| siga-prd      |

---

## 🔧 Pré-Requisitos de Configuração

### 1. Azure DevOps — Service Connections

No portal Azure DevOps > **Project Settings > Service Connections**:

#### SonarCloud
```
Tipo: SonarCloud
Nome (EXATO): SonarCloud
Token: <gerar em https://sonarcloud.io/account/security>
Organization: eppcage
```

> ⚠️ O nome `SonarCloud` deve ser EXATO — é referenciado nas tasks dos pipelines.

#### Servidores de Deploy (opcional)
```
Tipo: SSH
Nome: siga-hml-server   (para ambiente HML)
Nome: siga-prd-server   (para ambiente PRD)
```

---

### 2. Azure DevOps — Variable Groups

Em **Pipelines > Library**, criar 3 grupos de variáveis:

#### `siga-dev-vars`
| Variável           | Descrição                                 | Secreto |
|--------------------|-------------------------------------------|:-------:|
| `SUPABASE_URL`     | URL do projeto Supabase DEV               | ❌      |
| `SUPABASE_ANON_KEY`| Chave anônima Supabase DEV                | ✅      |
| `NPM_TOKEN`        | Token npm (se usar registry privado)      | ✅      |

#### `siga-hml-vars`
| Variável            | Descrição                                 | Secreto |
|---------------------|-------------------------------------------|:-------:|
| `SUPABASE_URL`      | URL do projeto Supabase HML               | ❌      |
| `SUPABASE_ANON_KEY` | Chave anônima Supabase HML                | ✅      |
| `TEAMS_WEBHOOK_URL` | Webhook do canal Teams para notificações  | ✅      |

#### `siga-prd-vars`
| Variável            | Descrição                                 | Secreto |
|---------------------|-------------------------------------------|:-------:|
| `SUPABASE_URL`      | URL do projeto Supabase PRD               | ❌      |
| `SUPABASE_ANON_KEY` | Chave anônima Supabase PRD                | ✅      |
| `TEAMS_WEBHOOK_URL` | Webhook do canal Teams (canal de alertas) | ✅      |

---

### 3. Azure DevOps — Environments (Gates de Aprovação)

Em **Pipelines > Environments**, criar dois environments:

#### `siga-hml`
- **Approvals**: 1 aprovador (sugestão: tech lead ou QA lead)
- **Timeout**: 2 horas
- **Instructions**: "Verifique os resultados de teste e o Quality Gate SonarCloud antes de aprovar."

#### `siga-prd`
- **Approvals**: 2 aprovadores (tech lead + gestor/dono do sistema)
- **Exclusive lock**: ✅ habilitado (evita deploys simultâneos)
- **Timeout**: 4 horas
- **Required template**: Pode vincular ao pipeline `ci-prd.yml`

---

### 4. SonarCloud — Configuração do Projeto

1. Acesse [sonarcloud.io](https://sonarcloud.io) e faça login com GitHub
2. Em **+** > **Analyze new project** > selecione `EPPCAGE/SIGA`
3. Anote o **Project Key**: `eppcage_gesproc`
4. Em **Administration > Quality Gates**, configure dois quality gates:

#### Quality Gate — HML
| Métrica                    | Condição    |
|----------------------------|-------------|
| Coverage                   | ≥ 65%       |
| Security Rating             | ≥ B         |
| Reliability Rating          | ≥ B         |
| Duplicated Lines (%)        | ≤ 5%        |
| New Blocker Issues          | = 0         |

#### Quality Gate — PRD (mais rigoroso)
| Métrica                    | Condição    |
|----------------------------|-------------|
| Coverage                   | ≥ 70%       |
| Security Rating             | = A         |
| Reliability Rating          | ≥ A         |
| Maintainability Rating      | ≥ A         |
| Duplicated Lines (%)        | ≤ 3%        |
| New Critical Issues         | = 0         |

5. Gere o **SONAR_TOKEN** em `My Account > Security` e adicione como secret nos Variable Groups.

---

### 5. GitHub — Habilitando GitHub Advanced Security (GHAS)

> Requer plano GitHub Team ou GitHub Enterprise (ou repositório público).

#### Passo a passo:
1. Acesse `github.com/EPPCAGE/SIGA` > **Settings**
2. Em **Security > Code security and analysis**:
   - ✅ **Dependency graph**: Enable
   - ✅ **Dependabot alerts**: Enable
   - ✅ **Dependabot security updates**: Enable
   - ✅ **Code scanning**: Enable (escolha "CodeQL" como ferramenta)
   - ✅ **Secret scanning**: Enable
   - ✅ **Secret scanning push protection**: Enable (bloqueia push com segredos)

3. O workflow `.github/workflows/codeql.yml` já está configurado e será executado automaticamente.

#### Branch Protection Rules (em `Settings > Branches`):

Para `main`:
```
Branch name pattern: main
☑ Require a pull request before merging
  - Required approvals: 2
  - Dismiss stale pull request approvals when new commits are pushed
  - Require review from Code Owners (CODEOWNERS)
☑ Require status checks to pass before merging
  - CodeQL (javascript-typescript)
  - npm audit — PR Check
  - Dependency Review
  - Testes Unitários PRD
☑ Require conversation resolution before merging
☑ Do not allow bypassing the above settings
```

Para `hml`:
```
Branch name pattern: hml
☑ Require a pull request before merging
  - Required approvals: 1
  - Require review from Code Owners
☑ Require status checks to pass before merging
  - CodeQL (javascript-typescript)
  - Dependency Review
☑ Require conversation resolution before merging
```

---

## 🔄 Fluxo de Desenvolvimento

### Feature → Dev
```bash
git checkout -b feature/minha-feature dev
# ... desenvolver ...
git push origin feature/minha-feature
# Abrir PR para dev
# Pipeline ci-dev.yml executa automaticamente
```

### Dev → HML (quando features estão prontas para QA)
```bash
git checkout hml
git merge --no-ff dev -m "merge: feature/X para hml"
git push origin hml
# Pipeline ci-hml.yml executa automaticamente
# QG SonarCloud deve passar
# Aguardar aprovação manual no Azure DevOps
```

### HML → PRD (após validação em homologação)
```bash
git checkout main
git merge --no-ff hml -m "release: v1.X.0"
git tag -a v1.X.0 -m "Release 1.X.0"
git push origin main --tags
# Pipeline ci-prd.yml executa automaticamente
# QG SonarCloud (modo PRD) deve passar
# npm audit sem HIGH/CRITICAL obrigatório
# Aguardar 2 aprovações no Azure DevOps
```

---

## 📊 Arquivos Criados

| Arquivo                                    | Finalidade                                     |
|--------------------------------------------|------------------------------------------------|
| `.azure-pipelines/ci-dev.yml`              | CI para branches de desenvolvimento            |
| `.azure-pipelines/ci-hml.yml`              | CI/CD com quality gate para homologação        |
| `.azure-pipelines/ci-prd.yml`              | CI/CD com aprovação dupla para produção        |
| `sonar-project.properties`                 | Configuração do projeto SonarCloud             |
| `.github/workflows/codeql.yml`             | SAST com CodeQL (GHAS)                         |
| `.github/workflows/dependency-review.yml`  | Revisão de dependências em PRs (GHAS)          |
| `.github/CODEOWNERS`                       | Revisores obrigatórios por área de código      |
| `.github/pull_request_template.md`         | Template de checklist para pull requests       |

---

## 🚨 Troubleshooting

### SonarCloud — "Service connection not found"
- Verifique que o nome da service connection é exatamente `SonarCloud` (maiúscula S e C).
- A service connection deve ter permissão para todos os pipelines (em Project Settings > Service Connections > Security).

### Pipeline falha em "Quality Gate"
- Acesse [sonarcloud.io/organizations/eppcage/projects](https://sonarcloud.io/organizations/eppcage/projects)
- Veja os detalhes do Quality Gate na análise mais recente
- Endpoints de métricas: `sonarcloud.io/api/qualitygates/project_status?projectKey=eppcage_gesproc`

### npm audit bloqueando PRD sem nova vulnerabilidade
- Execute `npm audit fix` para resolver automaticamente
- Para vulnerabilidades sem fix disponível: `npm audit fix --force` (⚠️ pode causar breaking changes)
- Documente exceções conhecidas em `docs/SECURITY_EXCEPTIONS.md`

### CodeQL — análise não aparece no Security tab
- Verifique que GitHub Advanced Security está habilitado no repositório
- O token `GITHUB_TOKEN` precisa ter permissão `security-events: write` (já configurado no workflow)
