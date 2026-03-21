# SIGA Local On-Prem (SEFAZ-RS)

Este pacote roda o SIGA local em ambiente separado do sistema online, usando Docker.

## Arquitetura

- `frontend` (Nginx): serve `index.html` e faz proxy da API em `/api`.
- `backend` (Node): persiste dados em `data/local-data.json`.
- Persistencia: pasta `data/` no host.

## Pre-requisitos

- Docker Engine 24+
- Docker Compose v2+

## Subir ambiente

No diretorio raiz do SIGA:

```bash
docker compose up -d --build
```

Acesso:

- Sistema: `http://IP_DO_SERVIDOR:8080`
- Health backend (via proxy): `http://IP_DO_SERVIDOR:8080/api/health`

## Carga inicial de dados

1. Copie um `local-data.json` valido para `data/local-data.json`.
2. Reinicie o backend:

```bash
docker compose restart backend
```

Se `data/local-data.json` nao existir, o backend cria um arquivo inicial vazio.

## Login Microsoft Entra ID (preparado)

O frontend ja esta preparado para autenticar via Microsoft Entra ID com MSAL.

1. Copie `public-config.entra.example.js` para `public-config.js`.
2. Preencha `clientId`, `tenantId` e listas de `adminEmails`/`editorEmails`.
3. Rebuild dos containers:

```bash
docker compose up -d --build
```

4. No registro de aplicativo do Entra ID, configure Redirect URI para a URL do frontend local (ex.: `http://IP_DO_SERVIDOR:8080`).

Observacao: o controle de perfil (admin/editor/viewer) e feito por email no frontend.

## Verificacao de segredos hardcoded

- Nao foi identificado password hardcoded no codigo de runtime local.
- Segredos em workflow GitHub estao referenciados via `secrets.*` (nao em texto plano).
- Recomendacao: manter `public-config.js` com valores de ambiente local/on-prem e nao versionar credenciais reais.

## Atualizacao de versao

```bash
docker compose down
docker compose up -d --build
```

## Exportar para instalacao offline (opcional)

Em maquina com internet/build:

```bash
docker compose build
docker save -o siga-images.tar siga-frontend siga-backend
```

No servidor destino:

```bash
docker load -i siga-images.tar
docker compose up -d
```

## Observacoes

- Este ambiente e local e independente do ambiente online.
- O frontend usa `/api` no container, sem depender de `localhost:3000` no navegador.
