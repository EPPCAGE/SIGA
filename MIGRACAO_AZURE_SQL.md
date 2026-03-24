# Migracao SIGA para Azure + SQL Server

## Objetivo
Migrar o SIGA para arquitetura Azure com:
- Autenticacao: Microsoft Entra ID
- Banco: Azure SQL Database (SQL Server)
- API/Backend: Azure Functions
- Arquivos: Azure Blob Storage
- Segredos: Azure Key Vault

## Decisao Arquitetural Fechada (20/03/2026)
Arquitetura aprovada para implantacao:
- Hospedagem aplicacao: Azure VM (Linux)
- Banco de dados: Azure SQL Database (SQL Server)
- Autenticacao: Microsoft Entra ID

Implicacoes praticas:
- Nginx + API Node/Express rodando em containers Docker na VM.
- Banco nao roda em container; roda no Azure SQL gerenciado.
- Autorizacao por JWT/claims do Entra ID validada no backend.

## Fase 0 - Preparacao e congelamento
1. Definir janela de migracao (data e horario).
2. Congelar mudancas funcionais no sistema atual.
3. Gerar backup completo atual (dados + arquivos + configuracoes).
4. Definir responsaveis por: banco, backend, frontend, seguranca e homologacao.

Criterio de pronto:
- Janela aprovada, backup validado e equipe definida.

## Fase 1 - Provisionamento Azure
1. Criar Resource Group do SIGA.
2. Criar Azure SQL Database (com servidor SQL logico).
3. Criar Storage Account (Blob) para arquivos.
4. Criar Function App para APIs.
5. Criar App Service ou Static Web Apps para frontend.
6. Criar Key Vault para segredos.
7. Configurar Application Insights para observabilidade.

Criterio de pronto:
- Todos os recursos criados e acessiveis.

## Fase 2 - Autenticacao Entra ID
1. Registrar aplicacao no Entra ID para frontend (SPA/web).
2. Registrar aplicacao para backend/API (Function App).
3. Configurar escopos e permissoes da API.
4. Definir Redirect URIs de homologacao e producao.
5. Configurar validacao de token no backend.

Criterio de pronto:
- Login Entra funcionando em homologacao e token valido nas APIs.

## Fase 3 - Modelagem e migracao para SQL Server
1. Mapear tipos de dados para SQL Server.
3. Criar script de schema SQL Server (DDL).
4. Criar pipeline ETL de migracao de dados.
5. Migrar lotes e validar contagem/consistencia.

Criterio de pronto:
- Dados migrados com validacao de integridade e consultas principais aprovadas.

## Fase 4 - Reescrita backend (Functions)
1. Recriar endpoints equivalentes das funcoes atuais:
   - envio de email
   - proxy de imagem
   - proxy de IA (GitHub Copilot)
2. Implementar camada de acesso a SQL Server.
3. Aplicar autorizacao por perfil (editores/admin).
4. Adicionar limites, validacoes e logs estruturados.

Criterio de pronto:
- APIs do Azure respondendo com os mesmos contratos esperados pelo frontend.

## Fase 5 - Migracao de arquivos para Blob
1. Criar containers e politicas de acesso.
2. Migrar arquivos existentes.
3. Atualizar referencias de URL no sistema.
4. Validar upload/download/preview.

Criterio de pronto:
- Todo fluxo de arquivo operando via Azure Blob Storage.

## Fase 6 - Ajuste do frontend
1. Trocar chamadas de Auth para Entra ID.
2. Trocar chamadas de API para endpoints Azure.

4. Validar modulos criticos (auditoria, relatorios, IA, alertas).

Criterio de pronto:
- Frontend funcionando integralmente contra Azure.

## Fase 7 - Homologacao e cutover
1. Rodar testes de regressao funcional.
2. Rodar testes de carga basica.
3. Aprovar checklist de seguranca (segredos, CORS, permissao, logs).
4. Definir e executar cutover (virada de ambiente).
5. Monitorar 24h/48h pos-go-live.

Criterio de pronto:
- Operacao estavel em producao.

## Checklist tecnico minimo
1. Segredos no Key Vault (nunca no frontend).
2. Function App com Managed Identity quando possivel.
3. SQL com firewall/rede privada conforme politica.
4. Politicas de backup e retencao habilitadas.
5. Alertas de erro e disponibilidade configurados.

## Ordem recomendada de execucao
1. Provisionar Azure.
2. Ativar Entra ID.
3. Criar SQL schema e migrar dados.
4. Subir APIs no Azure Functions.
5. Ajustar frontend.
6. Homologar e virar producao.

## Ordem executiva para a arquitetura aprovada (VM + Azure SQL)
1. Provisionar VM Linux no Azure (com IP publico temporario).
2. Instalar Docker e Docker Compose na VM.
3. Provisionar Azure SQL Database e abrir firewall apenas para a VM.
4. Configurar Entra ID (app frontend + app API).
5. Publicar stack na VM (nginx + api) via compose.
6. Migrar dados para Azure SQL e validar consultas criticas.
7. Fazer cutover de DNS e monitorar.

## Proximo passo imediato (acao)
1. Provisionar o ambiente base Azure (Fase 1).
2. Em paralelo, iniciar inventario de schema e dados do Supabase (Fase 3, item 1).
