window.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    mode: 'entra',
    entra: {
      // Application (client) ID do app registrado no Entra ID
      clientId: '00000000-0000-0000-0000-000000000000',
      // Directory (tenant) ID do tenant da SEFAZ-RS
      tenantId: '00000000-0000-0000-0000-000000000000',
      // URL publica do frontend no servidor local
      redirectUri: window.location.origin,
      // Controle de permissao no frontend
      adminEmails: ['admin@sefaz.rs.gov.br'],
      editorEmails: ['editor1@sefaz.rs.gov.br', 'editor2@sefaz.rs.gov.br'],
    },
  },
};
