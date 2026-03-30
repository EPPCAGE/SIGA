globalThis.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    // local | entra
    mode: 'entra',
    entra: {
      clientId: '07efc1ef-b923-404e-b056-0be8dbfea66d',
      tenantId: '83bd090b-756e-4a02-a512-e5ea02c03041',
      redirectUri: globalThis.location.origin,
      adminEmails: ['felipet@sefaz.rs.gov.br'],
      editorEmails: [
        'edisonw@sefaz.rs.gov.br',
        'marcelomc@sefaz.rs.gov.br',
        'andreabs@sefaz.rs.gov.br',
        'amandasp@sefaz.rs.gov.br',
      ],
    },
  },
};
