// Starts the interactive API reference. If this browser already opened a demo
// board, its sandbox key is filled in so "Test Request" works straight away.
'use strict';
(function () {
  var token = '';
  try {
    var saved = JSON.parse(localStorage.getItem('meridian-hire.sandbox') || 'null');
    if (saved && new Date(saved.expires_at) > new Date()) token = saved.api_key;
  } catch (e) {}
  Scalar.createApiReference('#app', {
    url: '/openapi.json',
    theme: 'default',
    layout: 'modern',
    withDefaultFonts: false,
    showDeveloperTools: 'never',
    telemetry: false,
    agent: { disabled: true },
    defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
    authentication: { preferredSecurityScheme: 'bearerAuth', securitySchemes: { bearerAuth: { token: token } } },
    metaData: { title: 'Meridian Hire API docs' },
  });
})();
