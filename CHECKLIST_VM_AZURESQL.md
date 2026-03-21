# Checklist de Execucao - SIGA em Azure VM + Azure SQL

## Dia 1 - Infra base
1. Criar VM Linux (Ubuntu 22.04 LTS) no Azure.
2. Criar NSG com portas:
   - 22 (SSH): apenas IP de administracao.
   - 80/443: publico.
3. Criar Azure SQL Database (camada inicial basica).
4. Configurar firewall do SQL para aceitar apenas IP da VM.
5. Criar Key Vault para segredos.

Pronto do Dia 1:
- VM acessivel por SSH, SQL criado e conectividade VM -> SQL validada.

## Dia 2 - Runtime da aplicacao
1. Instalar Docker e Docker Compose na VM.
2. Criar pastas de deploy:
   - /opt/siga
   - /opt/siga/nginx
   - /opt/siga/api
3. Subir stack inicial:
   - nginx (frontend + proxy /api)
   - api Node/Express
4. Configurar HTTPS com certificado.

Pronto do Dia 2:
- Aplicacao abre por URL publica com API respondendo.

## Dia 3 - Entra ID
1. Registrar app do frontend no Entra.
2. Registrar app da API no Entra.
3. Definir audience/issuer no backend.
4. Testar login e validacao de JWT em endpoint protegido.

Pronto do Dia 3:
- Login corporativo funcionando e API autorizando por token.

## Dia 4 - Banco e migracao
1. Gerar schema SQL Server equivalente as tabelas atuais.
2. Migrar dados (ETL).
3. Validar contagens por tabela.
4. Validar telas/modulos criticos contra Azure SQL.

Pronto do Dia 4:
- Sistema operando com dados no Azure SQL sem dependencias da Supabase.

## Dia 5 - Go-live
1. Rodar checklist final de seguranca.
2. Alterar DNS para VM.
3. Monitorar erros e performance por 24-48h.
4. Congelar ambiente antigo para rollback controlado.

Pronto do Dia 5:
- Producao estabilizada no novo ambiente.

## Variaveis obrigatorias da API
- ENTRA_TENANT_ID
- ENTRA_CLIENT_ID_API
- ENTRA_AUDIENCE
- SQL_SERVER
- SQL_DATABASE
- SQL_USER
- SQL_PASSWORD
- GITHUB_COPILOT_TOKEN

## Criterios de aceite final
1. Login Entra ID obrigatorio para todos os usuarios.
2. Todas as operacoes de leitura/escrita no Azure SQL.
3. Sem chamadas para Supabase em producao.
4. Alertas de erro e disponibilidade ativos.
