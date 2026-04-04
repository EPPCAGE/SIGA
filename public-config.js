globalThis.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    // local | entra
    mode: 'local',
    entra: {
      clientId: '',
      tenantId: '',
      redirectUri: globalThis.location.origin,
      apiClientId: '',
      apiAudience: '',
      apiScope: '',
      adminEmails: ['local@admin'],
      editorEmails: [],
    },
  },
};
