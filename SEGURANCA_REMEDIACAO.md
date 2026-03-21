# SIGA — Remediação de Segurança (Março 2026)

> **Destinatários:** Equipe de TI / SEFAZ-RS  
> **Commit de referência:** `4ad348c`  
> **Data:** 2026-03-21  
> **Responsável técnico:** Escritório de Processos — CAGE-RS

---

## Contexto

Foi realizada uma auditoria de segurança do código-fonte do SIGA com base nos critérios da **OWASP Top 10**.  
Este documento descreve cada problema identificado, a solução aplicada e as ações que **dependem da TI** para serem concluídas.

---

## Correções já aplicadas (zero configuração necessária)

### 1. E-mail pessoal removido do código-fonte

| Item | Detalhe |
|------|---------|
| **Arquivo** | `index.html` |
| **Problema** | O endereço `f.ctourinho@gmail.com` estava hardcoded no JavaScript de runtime. Qualquer pessoa com acesso ao fonte ou ao DevTools do navegador conseguia ver o e-mail. |
| **Solução** | A referência foi removida. A lógica que dependia dela agora usa o flag `isAdmin`, que é derivado da lista `adminEmails` definida em `public-config.js` — arquivo controlado pela TI, não versionado com credenciais reais. |
| **Impacto operacional** | Nenhum. O comportamento para admins permanece idêntico. |

---

### 2. Bundle de desenvolvimento do BPMN substituído pelo de produção

| Item | Detalhe |
|------|---------|
| **Arquivo** | `index.html` |
| **Problema** | O sistema carregava `bpmn-modeler.development.js` — versão com mensagens de debug, logs verbosos e sem minificação. Expõe detalhes internos da biblioteca nas ferramentas de desenvolvedor. |
| **Solução** | Trocado para `bpmn-modeler.production.min.js` (mesma versão `@17`, mesma CDN `unpkg.com`). |
| **Impacto operacional** | Nenhum. O editor BPMN funciona da mesma forma; apenas o tamanho do script carregado diminui (~40%). |

---

### 3. Política CORS restrita (backend Node)

| Item | Detalhe |
|------|---------|
| **Arquivo** | `scripts/local-backend.js` |
| **Problema** | O header `Access-Control-Allow-Origin` estava configurado como `*` (qualquer origem). Qualquer site malicioso aberto no mesmo navegador poderia fazer requisições à API local em nome do usuário autenticado. |
| **Solução** | O valor agora é lido da variável de ambiente `SIGA_ALLOWED_ORIGIN`. O padrão interno é `http://localhost:8080`. Em produção, defina a variável com a URL real do frontend. |
| **Como configurar em produção** | No `docker-compose.yml` (seção `backend → environment`), adicione: `SIGA_ALLOWED_ORIGIN=http://IP_DO_SERVIDOR:8080` |

---

### 4. Headers de segurança HTTP no Nginx (frontend)

| Item | Detalhe |
|------|---------|
| **Arquivo** | `docker/frontend/nginx.conf` |
| **Problema** | O servidor não enviava nenhum header de segurança HTTP. Isso permite ataques de clickjacking, sniffing de MIME-type, cross-site scripting, vazamento de Referer e acesso a recursos do dispositivo. |
| **Solução** | Adicionados 6 headers HTTP padrão de mercado: |

| Header | Valor configurado | Proteção |
|--------|-------------------|----------|
| `X-Frame-Options` | `DENY` | Impede a página de ser embutida em `<iframe>` (bloqueia clickjacking) |
| `X-Content-Type-Options` | `nosniff` | Impede que o browser "adivinhe" o tipo de arquivo e execute scripts disfarçados |
| `X-XSS-Protection` | `1; mode=block` | Filtro XSS legado em browsers mais antigos |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limita o que é enviado no cabeçalho `Referer` para domínios externos |
| `Permissions-Policy` | geolocalização/câmera/microfone bloqueados | Impede que a página acesse recursos sensíveis do dispositivo |
| `Content-Security-Policy` | Permite apenas fontes conhecidas (self, unpkg, jsdelivr, fonts.google, excalidraw) | Bloqueia scripts e recursos injetados de origens não autorizadas |

---

### 5. Containers Docker rodando como usuário não-root

| Item | Detalhe |
|------|---------|
| **Arquivos** | `docker/backend/Dockerfile`, `docker/frontend/Dockerfile` |
| **Problema** | Ambos os containers executavam como `root` por padrão. Se um atacante comprometesse o processo interno do container, teria privilégios de root. |
| **Solução** | Adicionada a diretiva `USER node` no backend e `USER nginx` no frontend — usuários sem privilégios que já existem nas imagens base `node:20-alpine` e `nginx:1.27-alpine`. |
| **Impacto operacional** | Nenhum para operação normal. A pasta `data/` no host continua acessível via volume montado. |

---

## Ações pendentes — requerem suporte da TI

### A. Configurar `SIGA_ALLOWED_ORIGIN` no ambiente de produção

**Onde:** `docker-compose.yml`, serviço `backend`.

```yaml
services:
  backend:
    environment:
      - SIGA_ALLOWED_ORIGIN=http://SEU_IP_OU_HOSTNAME:8080
```

Substitua `SEU_IP_OU_HOSTNAME:8080` pelo endereço real que os usuários acessam.

---

### B. Habilitar HTTPS / TLS

O servidor atualmente serve apenas HTTP (porta 80 → 8080).  
Para um ambiente de produção, o TLS deve ser terminado **antes** do Nginx — geralmente por um **reverse proxy** ou **load balancer** da rede da SEFAZ.

Opções recomendadas:
1. **Reverse proxy corporativo** (F5, HAProxy, IIS ARR) — termina TLS e faz proxy para o container na 8080.
2. **Nginx com certificado** — copiar o certificado `.crt` / `.key` para o container e adicionar bloco `server { listen 443 ssl; ... }` no `nginx.conf`.

Com HTTPS ativo, altere o `SIGA_ALLOWED_ORIGIN` para `https://` e ajuste o `Content-Security-Policy` se necessário.

---

### C. Configurar autenticação Microsoft Entra ID

O frontend já está preparado para autenticação via **MSAL / Microsoft Entra ID**. Para ativar:

1. **Registrar o aplicativo no Entra ID** (Azure AD do tenant da SEFAZ-RS):
   - Tipo: Aplicação Web (SPA)
   - Redirect URI: `https://URL_DO_SISTEMA` (com HTTPS)
   - Permissões: `openid`, `profile`, `email`

2. **Copiar o exemplo de configuração:**
   ```bash
   cp public-config.entra.example.js public-config.js
   ```

3. **Preencher `public-config.js`** com os dados do registro:
   ```js
   window.__SIGA_RUNTIME__ = {
     apiUrl: '/api',
     auth: {
       mode: 'entra',           // trocar de 'local' para 'entra'
       entra: {
         clientId: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',  // Application (Client) ID
         tenantId: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',  // Directory (Tenant) ID
         redirectUri: 'https://URL_DO_SISTEMA',
         adminEmails: ['email.do.admin@sefaz.rs.gov.br'],
         editorEmails: ['editor1@sefaz.rs.gov.br', 'editor2@sefaz.rs.gov.br'],
       },
     },
   };
   ```

4. **Rebuild dos containers:**
   ```bash
   docker compose up -d --build
   ```

> ⚠️ **Nunca versionar `public-config.js` com credenciais reais.** O arquivo já está no `.gitignore`.

---

## Resumo de severidade — antes × depois

| Problema | Severidade OWASP | Status |
|----------|-----------------|--------|
| E-mail pessoal no código-fonte | BLOQUEANTE — Exposição de dados | ✅ Corrigido |
| Bundle de desenvolvimento em produção | ATENÇÃO — Vazamento de informação | ✅ Corrigido |
| CORS wildcard `*` | BLOQUEANTE — Broken Access Control | ✅ Corrigido |
| Ausência de headers HTTP de segurança | BLOQUEANTE — Security Misconfiguration | ✅ Corrigido |
| Containers rodando como root | BLOQUEANTE — Security Misconfiguration | ✅ Corrigido |
| Sem HTTPS | BLOQUEANTE — Cryptographic Failure | ⏳ Pendente TI |
| Sem autenticação Entra ID | BLOQUEANTE — Auth Failure | ⏳ Pendente TI |

---

## Como aplicar a atualização no servidor

```bash
# 1. Atualizar o código
git pull origin main

# 2. Reconstruir e reiniciar os containers
docker compose down
docker compose up -d --build

# 3. Verificar saúde
curl http://localhost:8080/api/health
```

---

## Dúvidas

Contato técnico: **epp.cage@sefaz.rs.gov.br**
