window.__SIGA_RUNTIME__ = {
  apiUrl: '/api',
  auth: {
    // local | entra
    mode: 'local',
    entra: {
      clientId: '',
      tenantId: '',
      redirectUri: window.location.origin,
      adminEmails: ['local@admin'],
      editorEmails: [],
    },
  },
};
