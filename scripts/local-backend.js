const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const net = require('node:net');

// mammoth@1.x was written for @xmldom/xmldom < 0.9.9. In 0.9.9 two breaking
// changes were introduced that cause DOCX imports to fail:
//   1. parseFromString now requires a valid mimeType (rejects undefined)
//   2. The constructor emits a deprecation warning via the legacy errorHandler
//      callback, which mammoth's error handler treats as a fatal error.
// Patch both issues on the @xmldom/xmldom DOMParser class before mammoth loads.
const _xmldom = require('@xmldom/xmldom');
const _XmldomOrig = _xmldom.DOMParser;
class XmldomDOMParserPatch extends _XmldomOrig {
  constructor(options) {
    const fixed = (options && typeof options.errorHandler === 'function')
      ? { ...options, onError: options.errorHandler, errorHandler: undefined }
      : options;
    super(fixed);
  }
  parseFromString(str, mimeType) {
    return super.parseFromString(str, mimeType || 'text/xml');
  }
}
_xmldom.DOMParser = XmldomDOMParserPatch;
const tls = require('node:tls');
const ExcelJS = require('exceljs');

function loadDotenvIfAvailable() {
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
  } catch (dotenvError) {
    if (dotenvError?.code !== 'MODULE_NOT_FOUND') throw dotenvError;
  }
}

loadDotenvIfAvailable();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.SIGA_MAX_BODY_BYTES || 50 * 1024 * 1024);
const AUTH_MODE = String(process.env.SIGA_AUTH_MODE || 'local').trim().toLowerCase();
const ENTRA_TENANT_ID = String(process.env.SIGA_ENTRA_TENANT_ID || '').trim();
const ENTRA_API_CLIENT_ID = String(process.env.SIGA_ENTRA_API_CLIENT_ID || '').trim();
const ENTRA_API_AUDIENCE = String(process.env.SIGA_ENTRA_API_AUDIENCE || '').trim().replace(/\/$/, '');
const PUBLIC_URL = String(process.env.SIGA_PUBLIC_URL || '').trim().replace(/\/$/, '');
const SMTP_HOST = String(process.env.SIGA_SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SIGA_SMTP_PORT || 587);
const SMTP_SECURE = parseBooleanEnv(process.env.SIGA_SMTP_SECURE, false);
const SMTP_STARTTLS = parseBooleanEnv(process.env.SIGA_SMTP_STARTTLS, !SMTP_SECURE);
const SMTP_USER = String(process.env.SIGA_SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SIGA_SMTP_PASS || '').trim();
const SMTP_FROM_EMAIL = normalizeEmail(process.env.SIGA_SMTP_FROM_EMAIL || '');
const SMTP_FROM_NAME = String(process.env.SIGA_SMTP_FROM_NAME || 'SIGA').trim() || 'SIGA';
function readBootstrapEmails(value) {
  return new Set(
    String(value || '')
      .split(/[;,]/)
      .map((item) => normalizeEmail(item))
      .filter(Boolean)
  );
}

const BOOTSTRAP_ADMIN_EMAILS = readBootstrapEmails(process.env.SIGA_ADMIN_EMAILS);
const BOOTSTRAP_EDITOR_EMAILS = readBootstrapEmails(process.env.SIGA_EDITOR_EMAILS);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_MIME = 'application/msword';
const DATA_FILE = process.env.SIGA_DATA_FILE
  ? path.resolve(process.env.SIGA_DATA_FILE)
  : path.resolve(__dirname, '..', 'backups', 'local-data.json');

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080'
];

const ALLOWED_ORIGINS = (process.env.SIGA_ALLOWED_ORIGIN
  ? process.env.SIGA_ALLOWED_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS);

const WRITE_ROUTES = new Set([
  'POST /data',
  'POST /ai',
  'POST /parse-xlsx'
]);
const VIEW_ROUTES = new Set(['GET /data']);
const ACCESS_SELF_SERVICE_ROUTES = new Set(['GET /access-state', 'POST /access-request']);
const OPEN_ROUTES = new Set(['GET /health']);

const ADMIN_TOKEN = String(process.env.SIGA_ADMIN_TOKEN || '').trim();
const AUTH_CLOCK_SKEW_SECONDS = 300;
const ENTRA_CONFIG_CACHE_MS = 60 * 60 * 1000;
const ENTRA_JWKS_CACHE_MS = 15 * 60 * 1000;
let _entraOpenIdConfigCache = null;
let _entraJwksCache = null;

function parseBooleanEnv(value, defaultValue = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'sim', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'nao', 'não', 'off'].includes(text)) return false;
  return defaultValue;
}

function readAdminToken(req) {
  return String(req.headers['x-siga-admin-token'] || '').trim();
}

function readBearerToken(req) {
  const bearer = String(req.headers.authorization || '').trim();
  if (!bearer.toLowerCase().startsWith('bearer ')) return '';
  return bearer.slice(7).trim();
}

function isEntraAuthMode() {
  return AUTH_MODE === 'entra';
}

function isEntraConfigured() {
  return Boolean(ENTRA_TENANT_ID && (ENTRA_API_AUDIENCE || ENTRA_API_CLIENT_ID));
}

function base64UrlToBuffer(value) {
  const normalized = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padding = (4 - (normalized.length % 4 || 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padding), 'base64');
}

function decodeJwtPart(value, label) {
  try {
    return JSON.parse(base64UrlToBuffer(value).toString('utf8'));
  } catch (error) {
    error.statusCode = 401;
    error.message = `Token JWT invalido (${label})`;
    throw error;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    const error = new Error(`Falha ao consultar ${url}: HTTP ${response.status}`);
    error.statusCode = 503;
    throw error;
  }
  return response.json();
}

async function getEntraOpenIdConfig(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _entraOpenIdConfigCache && _entraOpenIdConfigCache.expiresAt > now) {
    return _entraOpenIdConfigCache.value;
  }
  if (!ENTRA_TENANT_ID) {
    const error = new Error('SIGA_ENTRA_TENANT_ID nao configurado');
    error.statusCode = 500;
    throw error;
  }
  const config = await fetchJson(`https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0/.well-known/openid-configuration`);
  _entraOpenIdConfigCache = {
    value: config,
    expiresAt: now + ENTRA_CONFIG_CACHE_MS,
  };
  return config;
}

async function getEntraSigningKeys(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _entraJwksCache && _entraJwksCache.expiresAt > now) {
    return _entraJwksCache.value;
  }
  const config = await getEntraOpenIdConfig(forceRefresh);
  const jwks = await fetchJson(config.jwks_uri);
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  _entraJwksCache = {
    value: keys,
    expiresAt: now + ENTRA_JWKS_CACHE_MS,
  };
  return keys;
}

function getExpectedEntraAudiences() {
  const values = [ENTRA_API_AUDIENCE, ENTRA_API_CLIENT_ID];
  if (ENTRA_API_CLIENT_ID) values.push(`api://${ENTRA_API_CLIENT_ID}`);
  return new Set(values.map((value) => String(value || '').trim().replace(/\/$/, '')).filter(Boolean));
}

function normalizeIssuer(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function validateTokenClaims(payload, openIdConfig) {
  const now = Math.floor(Date.now() / 1000);
  const expectedAudiences = getExpectedEntraAudiences();
  const issuer = normalizeIssuer(payload?.iss);
  const allowedIssuers = new Set([
    normalizeIssuer(openIdConfig?.issuer),
    ENTRA_TENANT_ID ? `https://sts.windows.net/${ENTRA_TENANT_ID}` : '',
  ].filter(Boolean));

  if (!payload || typeof payload !== 'object') {
    const error = new Error('Token JWT sem payload valido');
    error.statusCode = 401;
    throw error;
  }
  if (!payload.exp || Number(payload.exp) <= now - AUTH_CLOCK_SKEW_SECONDS) {
    const error = new Error('Token expirado');
    error.statusCode = 401;
    throw error;
  }
  if (payload.nbf && Number(payload.nbf) > now + AUTH_CLOCK_SKEW_SECONDS) {
    const error = new Error('Token ainda nao esta valido');
    error.statusCode = 401;
    throw error;
  }
  if (ENTRA_TENANT_ID && String(payload.tid || '').trim() !== ENTRA_TENANT_ID) {
    const error = new Error('Token emitido para tenant diferente');
    error.statusCode = 401;
    throw error;
  }
  if (!expectedAudiences.has(String(payload.aud || '').trim().replace(/\/$/, ''))) {
    const error = new Error('Audience invalida no token');
    error.statusCode = 401;
    throw error;
  }
  if (!allowedIssuers.has(issuer)) {
    const error = new Error('Issuer invalido no token');
    error.statusCode = 401;
    throw error;
  }
}

function verifyJwtSignature(token, header, keys) {
  if (String(header?.alg || '').toUpperCase() !== 'RS256') {
    const error = new Error('Algoritmo JWT nao suportado');
    error.statusCode = 401;
    throw error;
  }
  const jwk = (keys || []).find((item) => item?.kid === header?.kid);
  if (!jwk) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  return verifier.verify(publicKey, base64UrlToBuffer(encodedSignature));
}

async function validateEntraBearerToken(token) {
  if (!token) {
    const error = new Error('Bearer token ausente');
    error.statusCode = 401;
    throw error;
  }
  if (!isEntraConfigured()) {
    const error = new Error('Autenticacao Entra ID habilitada, mas variaveis do backend estao incompletas');
    error.statusCode = 500;
    throw error;
  }

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    const error = new Error('Token JWT invalido');
    error.statusCode = 401;
    throw error;
  }

  const header = decodeJwtPart(parts[0], 'header');
  const payload = decodeJwtPart(parts[1], 'payload');
  const openIdConfig = await getEntraOpenIdConfig(false);
  validateTokenClaims(payload, openIdConfig);

  let keys = await getEntraSigningKeys(false);
  let verified = verifyJwtSignature(token, header, keys);
  if (!verified) {
    keys = await getEntraSigningKeys(true);
    verified = verifyJwtSignature(token, header, keys);
  }
  if (!verified) {
    const error = new Error('Assinatura JWT invalida');
    error.statusCode = 401;
    throw error;
  }

  return payload;
}

function isIPv4Loopback(address) {
  const octets = String(address || '').split('.');
  return octets.length === 4 && octets[0] === '127';
}

function normalizeRemoteAddress(address) {
  const raw = String(address || '');
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

function isIPv4Private(address) {
  const octets = String(address || '').split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => Number.isNaN(part))) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || '');
  if (remote === '::1') return true;
  return isIPv4Loopback(normalizeRemoteAddress(remote));
}

function isPrivateNetworkRequest(req) {
  const remote = normalizeRemoteAddress(req.socket?.remoteAddress || '');
  return isIPv4Private(remote);
}

function isLocalOrigin(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.startsWith('http://localhost:') || text.startsWith('http://127.0.0.1:');
}

function isLocalHost(value) {
  const host = String(value || '').trim().toLowerCase().split(':')[0];
  return host === 'localhost' || host === '127.0.0.1';
}

function isTrustedLocalProxyWrite(req) {
  const proxyMarker = String(req.headers['x-siga-local-proxy'] || '').trim();
  if (proxyMarker !== '1') return false;
  if (!isPrivateNetworkRequest(req)) return false;
  return isLocalOrigin(req.headers.origin)
    || isLocalOrigin(req.headers.referer)
    || isLocalHost(req.headers.host);
}

function isAuthorizedWriteRequest(req) {
  if (!ADMIN_TOKEN) return isLoopbackRequest(req) || isTrustedLocalProxyWrite(req);
  return readAdminToken(req) === ADMIN_TOKEN;
}

function routeRequiresAuth(routeKey) {
  if (isEntraAuthMode()) return !OPEN_ROUTES.has(routeKey);
  return WRITE_ROUTES.has(routeKey);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getPublicUrl() {
  return PUBLIC_URL || '';
}

function isEmailNotificationConfigured() {
  return Boolean(SMTP_HOST && SMTP_PORT > 0 && SMTP_FROM_EMAIL);
}

function getRoleLabel(role, isAdmin) {
  if (isAdmin || role === 'admin') return 'Administrador';
  if (role === 'editor') return 'Editor';
  return 'Visualizador';
}

function normalizeRequestStatus(value) {
  const status = String(value || '').trim();
  return ['pendente', 'aprovado', 'rejeitado'].includes(status) ? status : 'pendente';
}

function normalizeEditorRole(value) {
  const role = String(value || '').trim();
  return ['viewer', 'editor'].includes(role) ? role : 'viewer';
}

function sanitizeRequestItem(item) {
  const email = normalizeEmail(item?.email);
  if (!email) return null;
  return {
    email,
    name: String(item?.name || email).trim(),
    motivo: String(item?.motivo || '').trim(),
    status: normalizeRequestStatus(item?.status),
    requested_at: String(item?.requested_at || new Date().toISOString()),
    decision_reason: String(item?.decision_reason || '').trim(),
    decided_at: String(item?.decided_at || '').trim(),
    decided_by: normalizeEmail(item?.decided_by || ''),
    decided_by_name: String(item?.decided_by_name || '').trim(),
  };
}

function sanitizeEditorItem(item) {
  const email = normalizeEmail(item?.email);
  if (!email) return null;
  return {
    email,
    name: String(item?.name || email).trim(),
    is_admin: Boolean(item?.is_admin),
    role: normalizeEditorRole(item?.role),
    added_at: String(item?.added_at || new Date().toISOString()),
  };
}

function sanitizeHistoryItem(item) {
  const action = String(item?.action || '').trim();
  if (!action) return null;
  return {
    action,
    event_type: String(item?.event_type || 'audit').trim(),
    updated_by: normalizeEmail(item?.updated_by || ''),
    updated_by_name: String(item?.updated_by_name || '').trim(),
    target_email: normalizeEmail(item?.target_email || ''),
    target_name: String(item?.target_name || '').trim(),
    details: String(item?.details || '').trim(),
    created_at: String(item?.created_at || new Date().toISOString()),
  };
}

function sanitizeAccessLogItem(item) {
  const email = normalizeEmail(item?.email);
  const action = String(item?.action || '').trim();
  if (!email || !action) return null;
  return {
    email,
    name: String(item?.name || '').trim(),
    action,
    event_type: String(item?.event_type || action).trim(),
    target_email: normalizeEmail(item?.target_email || ''),
    target_name: String(item?.target_name || '').trim(),
    created_at: String(item?.created_at || new Date().toISOString()),
  };
}

function sanitizeLocalAccessState(raw) {
  const next = {
    requests: [],
    editors: [],
    history: [],
    accessLogs: []
  };
  if (!raw || typeof raw !== 'object') return next;

  if (Array.isArray(raw.requests)) {
    next.requests = raw.requests
      .map(sanitizeRequestItem)
      .filter(Boolean);
  }

  if (Array.isArray(raw.editors)) {
    next.editors = raw.editors
      .map(sanitizeEditorItem)
      .filter(Boolean);
  }

  if (Array.isArray(raw.history)) next.history = raw.history.map(sanitizeHistoryItem).filter(Boolean);
  if (Array.isArray(raw.accessLogs)) next.accessLogs = raw.accessLogs.map(sanitizeAccessLogItem).filter(Boolean);
  return next;
}

function getLocalAccessState(record) {
  return sanitizeLocalAccessState(record?.data?.localAccess);
}

function buildAuditActor(updatedBy, updatedByName) {
  return {
    updated_by: normalizeEmail(updatedBy || ''),
    updated_by_name: String(updatedByName || '').trim(),
    created_at: new Date().toISOString(),
  };
}

function prependAuditEntry(list, entry, max = 200) {
  list.unshift(entry);
  if (list.length > max) list.length = max;
}

function appendAuditHistory(state, actor, action, eventType = 'audit', target = {}, details = '') {
  prependAuditEntry(state.history, { ...actor, action, event_type: eventType, target_email: normalizeEmail(target.email || ''), target_name: String(target.name || '').trim(), details: String(details || '').trim() });
}

function appendAccessLog(state, email, name, action, eventType = '', target = {}) {
  prependAuditEntry(state.accessLogs, {
    email: normalizeEmail(email),
    name: String(name || '').trim(),
    action,
    event_type: String(eventType || action).trim(),
    target_email: normalizeEmail(target.email || ''),
    target_name: String(target.name || '').trim(),
    created_at: new Date().toISOString(),
  });
}

function buildEditorProfileLabel(editor) {
  return getRoleLabel(editor?.role, editor?.is_admin);
}

function formatUserLabel(email, name) {
  return name && name !== email ? `${name} <${email}>` : email;
}

function getAuthEmail(auth) {
  return normalizeEmail(auth?.preferred_username || auth?.upn || auth?.email || auth?.unique_name || '');
}

function getAuthName(auth) {
  return String(auth?.name || auth?.preferred_username || auth?.upn || auth?.email || 'Usuario').trim();
}

function buildAccessDecision(record, auth) {
  const email = getAuthEmail(auth);
  const name = getAuthName(auth);
  const state = getLocalAccessState(record);
  const localAccessConfigured = state.editors.length > 0;
  if (!localAccessConfigured) {
    if (BOOTSTRAP_ADMIN_EMAILS.has(email)) {
      return {
        email,
        name,
        authorized: true,
        role: 'admin',
        is_admin: true,
        requestStatus: 'aprovado',
        localAccessConfigured: false,
      };
    }
    if (BOOTSTRAP_EDITOR_EMAILS.has(email)) {
      return {
        email,
        name,
        authorized: true,
        role: 'editor',
        is_admin: false,
        requestStatus: 'aprovado',
        localAccessConfigured: false,
      };
    }
    const request = state.requests.find((item) => normalizeEmail(item.email) === email) || null;
    return {
      email,
      name,
      authorized: false,
      role: request?.status === 'pendente' ? 'pending' : 'none',
      is_admin: false,
      requestStatus: request?.status || null,
      localAccessConfigured: false,
    };
  }

  const editor = state.editors.find((item) => normalizeEmail(item.email) === email) || null;
  if (editor) {
    return {
      email,
      name: editor.name || name,
      authorized: true,
      role: editor.is_admin ? 'admin' : (editor.role || 'viewer'),
      is_admin: Boolean(editor.is_admin),
      requestStatus: 'aprovado',
      localAccessConfigured: true,
    };
  }

  const request = state.requests.find((item) => normalizeEmail(item.email) === email) || null;
  return {
    email,
    name,
    authorized: false,
    role: request?.status === 'pendente' ? 'pending' : 'none',
    is_admin: false,
    requestStatus: request?.status || null,
    localAccessConfigured: true,
  };
}

function applyRequestDecisionAudit(nextRequest, actor) {
  if (nextRequest.status === 'pendente') {
    nextRequest.decided_at = '';
    nextRequest.decided_by = '';
    nextRequest.decided_by_name = '';
    return;
  }
  nextRequest.decided_at = new Date().toISOString();
  nextRequest.decided_by = actor.updated_by;
  nextRequest.decided_by_name = actor.updated_by_name;
}

function syncRequestDecisionMetadata(previousRequest, nextRequest, actor) {
  if (!previousRequest || previousRequest.status !== nextRequest.status) {
    applyRequestDecisionAudit(nextRequest, actor);
    return;
  }
  nextRequest.decided_at = previousRequest.decided_at || nextRequest.decided_at || '';
  nextRequest.decided_by = previousRequest.decided_by || nextRequest.decided_by || '';
  nextRequest.decided_by_name = previousRequest.decided_by_name || nextRequest.decided_by_name || '';
}

function createEditorIndex(state) {
  return new Map(state.editors.map((item) => [normalizeEmail(item.email), item]));
}

function createRequestIndex(state) {
  return new Map(state.requests.map((item) => [normalizeEmail(item.email), item]));
}

function appendEditorAddedAudit(state, actor, editor) {
  const label = formatUserLabel(editor.email, editor.name);
  const role = buildEditorProfileLabel(editor);
  appendAuditHistory(state, actor, `Concedeu acesso a ${label} como ${role}`, 'access_granted', editor, role);
  appendAccessLog(state, editor.email, editor.name, `Recebeu perfil ${role}`, 'access_granted', actor);
}

function appendEditorRemovedAudit(state, actor, editor) {
  const label = formatUserLabel(editor.email, editor.name);
  appendAuditHistory(state, actor, `Removeu o acesso de ${label}`, 'access_removed', editor);
  appendAccessLog(state, editor.email, editor.name, 'Teve o acesso removido', 'access_removed', actor);
}

function appendEditorRoleAudit(state, actor, beforeEditor, afterEditor) {
  const label = formatUserLabel(afterEditor.email, afterEditor.name);
  const beforeRole = buildEditorProfileLabel(beforeEditor);
  const afterRole = buildEditorProfileLabel(afterEditor);
  appendAuditHistory(state, actor, `Alterou o perfil de ${label} de ${beforeRole} para ${afterRole}`, 'role_changed', afterEditor, `${beforeRole} -> ${afterRole}`);
  appendAccessLog(state, afterEditor.email, afterEditor.name, `Teve o perfil alterado para ${afterRole}`, 'role_changed', actor);
}

function appendRequestStatusAudit(state, actor, request) {
  const label = formatUserLabel(request.email, request.name);
  const action = request.status === 'aprovado' ? 'Aprovou' : 'Rejeitou';
  const eventType = request.status === 'aprovado' ? 'access_approved' : 'access_rejected';
  appendAuditHistory(state, actor, `${action} a solicitacao de acesso de ${label}`, eventType, request, request.decision_reason || '');
  appendAccessLog(state, request.email, request.name, `Solicitacao ${request.status}`, eventType, actor);
}

function hasEditorRoleChanged(previousEditor, nextEditor) {
  if (Boolean(previousEditor?.is_admin) !== Boolean(nextEditor?.is_admin)) return true;
  return String(previousEditor?.role || '') !== String(nextEditor?.role || '');
}

function addEditorAuditEntries(previousState, nextState, actor) {
  const previousEditors = createEditorIndex(previousState);
  const nextEditors = createEditorIndex(nextState);
  nextEditors.forEach((editor, email) => {
    const previous = previousEditors.get(email);
    if (!previous) appendEditorAddedAudit(nextState, actor, editor);
    if (previous && hasEditorRoleChanged(previous, editor)) appendEditorRoleAudit(nextState, actor, previous, editor);
  });
  previousEditors.forEach((editor, email) => {
    if (!nextEditors.has(email)) appendEditorRemovedAudit(nextState, actor, editor);
  });
}

function addRequestAuditEntries(previousState, nextState, actor) {
  const previousRequests = createRequestIndex(previousState);
  nextState.requests.forEach((request) => {
    const previous = previousRequests.get(request.email);
    syncRequestDecisionMetadata(previous, request, actor);
    if (previous?.status === request.status) return;
    if (request.status !== 'pendente') appendRequestStatusAudit(nextState, actor, request);
  });
}

function mergeAccessAudit(previousState, nextState, updatedBy, updatedByName) {
  const actor = buildAuditActor(updatedBy, updatedByName);
  nextState.history = previousState.history.slice(0, 200);
  nextState.accessLogs = previousState.accessLogs.slice(0, 200);
  addRequestAuditEntries(previousState, nextState, actor);
  addEditorAuditEntries(previousState, nextState, actor);
  return nextState;
}

function sanitizeIncomingData(parsed, current) {
  const data = parsed && typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : current.data;
  const nextData = data && typeof data === 'object' ? { ...data } : {};
  const previousState = getLocalAccessState(current);
  const nextState = sanitizeLocalAccessState(nextData.localAccess);
  nextData.localAccess = mergeAccessAudit(previousState, nextState, parsed?.updated_by, parsed?.updated_by_name);
  return nextData;
}

function appendAccessRequestAudit(state, email, name) {
  const label = formatUserLabel(email, name);
  appendAuditHistory(state, buildAuditActor(email, name), `Registrou solicitacao de acesso ao sistema para ${label}`, 'access_request', { email, name });
  appendAccessLog(state, email, name, 'Solicitou acesso ao sistema', 'access_request');
}

function getAdminNotificationRecipients(record) {
  const state = getLocalAccessState(record);
  const recipients = [];
  const seen = new Set();
  const addRecipient = (email, name) => {
    const normalized = normalizeEmail(email);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    recipients.push({ email: normalized, name: String(name || normalized).trim() || normalized });
  };

  state.editors
    .filter((item) => item?.is_admin)
    .forEach((item) => addRecipient(item.email, item.name));

  BOOTSTRAP_ADMIN_EMAILS.forEach((email) => addRecipient(email, email));
  return recipients;
}

function getAccessRequestAdminEmail(request, recipient) {
  const requestedAt = request?.requested_at ? new Date(request.requested_at).toLocaleString('pt-BR') : 'agora';
  const publicUrl = getPublicUrl();
  const motivoHtml = request?.motivo
    ? `<p><strong>Motivo informado:</strong><br>${escapeHtml(request.motivo)}</p>`
    : '<p><strong>Motivo informado:</strong> nao informado.</p>';
  return {
    subject: `SIGA: novo pedido de acesso de ${request?.name || request?.email || 'usuario'}`,
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
        <p>Ola, ${escapeHtml(recipient?.name || 'administrador')}.</p>
        <p>Um novo pedido de acesso ao SIGA foi registrado e esta aguardando aprovacao.</p>
        <p><strong>Usuario:</strong> ${escapeHtml(request?.name || request?.email || 'Nao informado')}<br>
        <strong>E-mail:</strong> ${escapeHtml(request?.email || '')}<br>
        <strong>Data/Hora:</strong> ${escapeHtml(requestedAt)}</p>
        ${motivoHtml}
        <p>Para avaliar a solicitacao, acesse o modulo <strong>Gestao do Sistema &gt; Usuarios</strong>${publicUrl ? ` em <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>` : ''}.</p>
      </div>
    `,
  };
}

function getAccessDecisionUserEmail(change) {
  const publicUrl = getPublicUrl();
  if (change?.status === 'aprovado') {
    return {
      subject: 'SIGA: seu acesso foi aprovado',
      html: `
        <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
          <p>Ola, ${escapeHtml(change?.name || change?.email || 'usuario')}.</p>
          <p>Seu acesso ao SIGA foi aprovado.</p>
          <p><strong>Perfil liberado:</strong> ${escapeHtml(getRoleLabel(change?.role, change?.is_admin))}</p>
          <p>Voce ja pode entrar no sistema${publicUrl ? ` em <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a>` : ''} usando sua conta Microsoft Entra.</p>
        </div>
      `,
    };
  }

  return {
    subject: 'SIGA: seu pedido de acesso foi analisado',
    html: `
      <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5;">
        <p>Ola, ${escapeHtml(change?.name || change?.email || 'usuario')}.</p>
        <p>Seu pedido de acesso ao SIGA foi analisado e, neste momento, nao foi aprovado.</p>
        <p>Se necessario, entre em contato com a administracao do sistema para mais detalhes.</p>
      </div>
    `,
  };
}

function canAccessViewRoute(access) {
  return Boolean(access?.authorized);
}

function canAccessWriteRoute(access) {
  if (!access?.localAccessConfigured) return true;
  return Boolean(access?.is_admin || access?.role === 'editor');
}

function createLineReader(socket) {
  const state = {
    socket,
    buffer: '',
    queue: [],
    waiters: [],
  };

  function pushLine(line) {
    if (state.waiters.length) {
      const waiter = state.waiters.shift();
      waiter.resolve(line);
      return;
    }
    state.queue.push(line);
  }

  socket.on('data', (chunk) => {
    state.buffer += chunk.toString('utf8');
    let index = state.buffer.indexOf('\n');
    while (index >= 0) {
      const line = state.buffer.slice(0, index).replace(/\r$/, '');
      state.buffer = state.buffer.slice(index + 1);
      pushLine(line);
      index = state.buffer.indexOf('\n');
    }
  });

  socket.on('error', (error) => {
    while (state.waiters.length) {
      const waiter = state.waiters.shift();
      waiter.reject(error);
    }
  });

  return state;
}

function readLine(reader) {
  if (reader.queue.length) return Promise.resolve(reader.queue.shift());
  return new Promise((resolve, reject) => {
    reader.waiters.push({ resolve, reject });
  });
}

async function readSmtpResponse(reader) {
  const lines = [];
  let expectedPrefix = null;
  while (true) {
    const line = await readLine(reader);
    if (typeof line !== 'string') continue;
    lines.push(line);
    if (/^\d{3}-/.test(line)) {
      expectedPrefix = line.slice(0, 3);
      continue;
    }
    if (/^\d{3} /.test(line)) {
      if (!expectedPrefix || line.startsWith(`${expectedPrefix} `)) return lines;
    }
  }
}

function assertSmtpResponse(lines, expectedCodes, context) {
  const lastLine = String(lines?.[lines.length - 1] || '');
  const code = Number(lastLine.slice(0, 3));
  if (expectedCodes.includes(code)) return;
  const error = new Error(`${context}: ${lastLine || 'resposta SMTP inesperada'}`);
  error.statusCode = 500;
  throw error;
}

function sendSmtpLine(socket, value) {
  return new Promise((resolve, reject) => {
    socket.write(`${value}\r\n`, (error) => (error ? reject(error) : resolve()));
  });
}

async function smtpCommand(connection, command, expectedCodes, context) {
  if (command) await sendSmtpLine(connection.socket, command);
  const lines = await readSmtpResponse(connection.reader);
  assertSmtpResponse(lines, expectedCodes, context);
  return lines;
}

function encodeMimeHeader(value) {
  const text = String(value || '');
  if (!text) return '';
  return /^[\x20-\x7E]+$/.test(text)
    ? text
    : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function formatEmailAddress(email, name) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  const display = String(name || '').trim();
  if (!display) return `<${normalized}>`;
  return `${encodeMimeHeader(display)} <${normalized}>`;
}

function dotStuff(value) {
  return String(value || '').replaceAll(/\r?\n/g, '\r\n').replaceAll(/^\./gm, '..');
}

async function openSmtpConnection() {
  const options = { host: SMTP_HOST, port: SMTP_PORT };
  const socket = SMTP_SECURE
    ? tls.connect({ ...options, servername: SMTP_HOST })
    : net.connect(options);

  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    socket.once('error', (error) => done(reject, error));
    if (SMTP_SECURE) socket.once('secureConnect', () => done(resolve));
    else socket.once('connect', () => done(resolve));
  });

  let connection = { socket, reader: createLineReader(socket) };
  await smtpCommand(connection, '', [220], 'Saudacao SMTP');
  let ehloLines = await smtpCommand(connection, 'EHLO siga.local', [250], 'EHLO');

  const supportsStartTls = ehloLines.some((line) => /STARTTLS/i.test(line));
  if (!SMTP_SECURE && SMTP_STARTTLS && supportsStartTls) {
    await smtpCommand(connection, 'STARTTLS', [220], 'STARTTLS');
    const tlsSocket = tls.connect({ socket, servername: SMTP_HOST });
    await new Promise((resolve, reject) => {
      tlsSocket.once('error', reject);
      tlsSocket.once('secureConnect', resolve);
    });
    connection = { socket: tlsSocket, reader: createLineReader(tlsSocket) };
    ehloLines = await smtpCommand(connection, 'EHLO siga.local', [250], 'EHLO apos STARTTLS');
  }

  if (SMTP_USER) {
    const authPlain = Buffer.from(`\u0000${SMTP_USER}\u0000${SMTP_PASS}`, 'utf8').toString('base64');
    if (ehloLines.some((line) => /AUTH(?:\s|=).*PLAIN/i.test(line))) {
      await smtpCommand(connection, `AUTH PLAIN ${authPlain}`, [235], 'AUTH PLAIN');
    } else {
      await smtpCommand(connection, 'AUTH LOGIN', [334], 'AUTH LOGIN');
      await smtpCommand(connection, Buffer.from(SMTP_USER, 'utf8').toString('base64'), [334], 'AUTH LOGIN usuario');
      await smtpCommand(connection, Buffer.from(SMTP_PASS, 'utf8').toString('base64'), [235], 'AUTH LOGIN senha');
    }
  }

  return connection;
}

async function sendEmail({ toEmail, toName, subject, htmlBody }) {
  if (!toEmail || !subject || !htmlBody) return false;
  if (!isEmailNotificationConfigured()) {
    console.info('[siga] notificacao por email desabilitada: SMTP nao configurado');
    return false;
  }

  let connection = null;
  try {
    connection = await openSmtpConnection();
    await smtpCommand(connection, `MAIL FROM:<${SMTP_FROM_EMAIL}>`, [250], 'MAIL FROM');
    await smtpCommand(connection, `RCPT TO:<${normalizeEmail(toEmail)}>`, [250, 251], 'RCPT TO');
    await smtpCommand(connection, 'DATA', [354], 'DATA');

    const message = [
      `From: ${formatEmailAddress(SMTP_FROM_EMAIL, SMTP_FROM_NAME)}`,
      `To: ${formatEmailAddress(toEmail, toName)}`,
      `Subject: ${encodeMimeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      dotStuff(htmlBody),
    ].join('\r\n');

    await sendSmtpLine(connection.socket, `${message}\r\n.`);
    const lines = await readSmtpResponse(connection.reader);
    assertSmtpResponse(lines, [250], 'Envio SMTP');
    await smtpCommand(connection, 'QUIT', [221], 'QUIT');
    connection.socket.end();
    return true;
  } catch (error) {
    if (connection?.socket && !connection.socket.destroyed) connection.socket.destroy();
    console.warn('[siga] falha ao enviar email', error?.message || error);
    return false;
  }
}

async function notifyAdminsAboutAccessRequest(record, request) {
  const recipients = getAdminNotificationRecipients(record);
  if (!recipients.length) {
    console.info('[siga] nenhum administrador configurado para receber alerta de acesso');
    return false;
  }

  const results = await Promise.all(recipients.map((recipient) => {
    const message = getAccessRequestAdminEmail(request, recipient);
    return sendEmail({
      toEmail: recipient.email,
      toName: recipient.name,
      subject: message.subject,
      htmlBody: message.html,
    });
  }));
  return results.some(Boolean);
}

function detectAccessDecisionEmailChanges(previousRecord, nextRecord) {
  const previousState = getLocalAccessState(previousRecord);
  const nextState = getLocalAccessState(nextRecord);
  const previousRequests = new Map(previousState.requests.map((item) => [normalizeEmail(item.email), item]));
  const nextEditors = new Map(nextState.editors.map((item) => [normalizeEmail(item.email), item]));
  return nextState.requests
    .map((item) => {
      const email = normalizeEmail(item?.email);
      const previous = previousRequests.get(email);
      if (!email) return null;
      if (!['aprovado', 'rejeitado'].includes(item.status)) return null;
      if (previous?.status === item.status) return null;
      const editor = nextEditors.get(email);
      return {
        email,
        name: String(item?.name || editor?.name || email).trim(),
        status: item.status,
        role: editor?.role || 'viewer',
        is_admin: Boolean(editor?.is_admin),
      };
    })
    .filter(Boolean);
}

async function notifyUsersAboutAccessDecisions(previousRecord, nextRecord) {
  const changes = detectAccessDecisionEmailChanges(previousRecord, nextRecord);
  if (!changes.length) return false;
  const results = await Promise.all(changes.map((change) => {
    const message = getAccessDecisionUserEmail(change);
    return sendEmail({
      toEmail: change.email,
      toName: change.name,
      subject: message.subject,
      htmlBody: message.html,
    });
  }));
  return results.some(Boolean);
}

function corsHeadersFor(req) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SIGA-Admin-Token, X-Ai-Token, X-Ai-Provider',
    'Vary': 'Origin'
  };
}

function sendJson(req, res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...corsHeadersFor(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });

  const initial = {
    id: 1,
    data: {},
    updated_at: null,
    updated_by: 'local@admin',
    updated_by_name: 'Administrador Local'
  };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), { encoding: 'utf8', flag: 'wx' });
  } catch (writeError) {
    if (writeError.code !== 'EEXIST') throw writeError;
    // File already exists — that's fine
  }
}

function readRecord() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (parseError) {
    console.warn(`[siga-local-backend] arquivo de dados corrompido em ${DATA_FILE} ??? retornando registro vazio (${parseError.message})`);
    parsed = {};
  }

  return {
    id: 1,
    data: parsed && typeof parsed === 'object' && parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
    updated_at: parsed?.updated_at || null,
    updated_by: parsed?.updated_by || 'local@admin',
    updated_by_name: parsed?.updated_by_name || 'Administrador Local'
  };
}

function writeRecord(record) {
  const tempPath = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tempPath, DATA_FILE);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      // Protect against unexpectedly large payloads.
      if (body.length > MAX_BODY_BYTES) {
        const err = new Error('Payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function normalizeCell(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function sanitizeNodeId(text, fallback) {
  const s = normalizeCell(text);
  if (!s) return fallback;
  const id = s.toLowerCase().replaceAll(/\s+/g, '_').replaceAll(/[^a-z0-9_-]/g, '');
  return id || fallback;
}

function headerScore(row) {
  const keys = row.map(normalizeCell).join(' ').toLowerCase();
  const vocab = ['acao', 'atividade', 'tarefa', 'origem', 'destino', 'proxima', 'ator', 'responsavel', 'raia', 'setor', 'orgao', 'prob'];
  return vocab.reduce((acc, k) => acc + (keys.includes(k) ? 1 : 0), 0);
}

function findHeaderIndex(rows) {
  let bestIdx = 0;
  let bestScore = -1;
  const scan = Math.min(rows.length, 25);
  for (let i = 0; i < scan; i += 1) {
    const score = headerScore(rows[i] || []);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function findColumnIdx(headers, candidates) {
  const lc = headers.map((h) => normalizeCell(h).toLowerCase());
  for (const c of candidates) {
    const idx = lc.findIndex((h) => h.includes(c));
    if (idx >= 0) return idx;
  }
  return -1;
}

function tokenizePt(text) {
  return normalizeCell(text)
    .toLowerCase()
    .replaceAll(/[.,;:!?(){}[\]"']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function startsWithVerbPt(text) {
  const tokens = tokenizePt(text);
  if (!tokens.length) return false;
  const w = tokens[0];

  const infinitive = /(ar|er|ir|or)$/i.test(w);
  const imperativeCommon = [
    'fazer', 'validar', 'analisar', 'aprovar', 'enviar', 'receber', 'registrar', 'conferir',
    'solicitar', 'emitir', 'pagar', 'liberar', 'encerrar', 'abrir', 'atender', 'executar',
  ].includes(w);

  return infinitive || imperativeCommon;
}

function isDecisionPhrase(text) {
  const s = normalizeCell(text);
  if (!s) return false;
  if (s.includes('?')) return true;
  const lc = s.toLowerCase();
  return lc.startsWith('se ') || lc.includes(' aprovado') || lc.includes(' aprovado ') || lc.includes('deve ');
}

function isPastPerfectLike(text) {
  const s = normalizeCell(text).toLowerCase();
  if (!s) return false;
  return /\b(foi|foram|teve|tiveram|houve|recebeu|receberam|finalizou|finalizaram|concluiu|concluiram|encerrado|encerrada|iniciado|iniciada|aprovado|aprovada|negado|negada)\b/.test(s);
}

function inferEventKind(text) {
  const s = normalizeCell(text).toLowerCase();
  if (/\b(inicio|iniciado|iniciada|abertura|recebido|recebida|solicitado|solicitada)\b/.test(s)) return 'start';
  if (/\b(fim|final|finalizado|finalizada|concluido|concluida|encerrado|encerrada|arquivado|arquivada)\b/.test(s)) return 'end';
  return 'intermediate';
}

function isActorPhrase(text) {
  const s = normalizeCell(text);
  if (!s) return false;
  if (isDecisionPhrase(s)) return false;
  if (startsWithVerbPt(s)) return false;

  const lc = s.toLowerCase();
  const actorHints = [
    'equipe', 'setor', 'coordenacao', 'coordenação', 'gerencia', 'gerência', 'diretoria', 'nucleo', 'núcleo',
    'atendimento', 'analista', 'fiscal', 'servidor', 'supervisao', 'supervisão', 'comissao', 'comissão',
    'orgao', 'órgão', 'unidade', 'departamento', 'secretaria', 'gabinete',
  ];

  if (actorHints.some((k) => lc.includes(k))) return true;

  // Noun-like short title (without obvious verb at start).
  const tokens = tokenizePt(s);
  if (!tokens.length) return false;
  const first = tokens[0];
  const articles = ['o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'dos', 'das'];
  if (articles.includes(first) && tokens.length >= 2) return true;

  // Keep actor detection conservative to avoid false positives.
  return tokens.length <= 5 && !isPastPerfectLike(s);
}

function inferNodeTypeFromPhrase(text) {
  const s = normalizeCell(text);
  if (!s) return 'task';
  const lc = s.toLowerCase();

  if (isDecisionPhrase(s)) return 'gateway';
  if (isPastPerfectLike(s)) {
    const k = inferEventKind(s);
    if (k === 'start') return 'start';
    if (k === 'end') return 'end';
    return 'task';
  }

  if (/\b(inicio|start)\b/.test(lc)) return 'start';
  if (/\b(fim|end)\b/.test(lc)) return 'end';
  if (/\b(gateway|decis|aprova|escolha|roteamento)\b/.test(lc)) return 'gateway';
  return 'task';
}

// ── helpers: parseXlsxTopology (S3776 — Cognitive Complexity) ────────────────

/** Converte o valor bruto de uma célula ExcelJS para string. */
function _xlsxCellValue(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && v.richText) return v.richText.map((r) => r.text).join('');
  if (typeof v === 'object' && v.result !== undefined) return String(v.result);
  return String(v);
}

/** Extrai todas as linhas de uma aba XLSX como arrays de strings. */
function _xlsxWorksheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    for (let c = 1; c <= row.cellCount; c++) arr.push(_xlsxCellValue(row.getCell(c)));
    rows.push(arr);
  });
  return rows;
}

/** Garante/retorna um nó pelo label normalizado; cria se não existir. */
function _xlsxEnsureNode(label, nodeByLabel, nodes, usedIds) {
  const key = normalizeCell(label);
  if (!key) return null;
  if (nodeByLabel.has(key)) return nodeByLabel.get(key);
  let id = sanitizeNodeId(key, `n${nodeByLabel.size + 1}`);
  if (usedIds.has(id)) {
    let counter = 2;
    while (usedIds.has(`${id}_${counter}`)) counter++;
    id = `${id}_${counter}`;
  }
  usedIds.add(id);
  const node = {
    id, type: 'task', label: key,
    x: 120 + ((nodeByLabel.size % 6) * 170),
    y: 120 + (Math.floor(nodeByLabel.size / 6) * 110),
    lane: '', executor: '', sector: '', org: '', automated: false,
  };
  nodeByLabel.set(key, node);
  nodes.push(node);
  return node;
}

/** Distribui 100% igualmente entre as arestas de saída de um gateway. */
function _xlsxDistributeProbabilities(outs) {
  const base = Math.floor(100 / outs.length);
  let rem = 100 - (base * outs.length);
  for (const e of outs) {
    e.probability = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem -= 1;
  }
}

/** Normaliza probabilidades dos gateways (distribui se todos eram 100 defaults). */
function _xlsxNormalizeProbabilities(edges) {
  const byFrom = new Map();
  for (const e of edges) {
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }
  for (const outs of byFrom.values()) {
    if (outs.length <= 1) continue;
    if (outs.some((e) => Number(e.probability) !== 100)) continue;
    _xlsxDistributeProbabilities(outs);
  }
}

/** Processa uma linha de dados: cria nó, registra ator e adiciona aresta. */
function _xlsxHandleDataRow(row, i, dataRows, columns, graphState) {
  const { actionIdx, nextIdx, actorIdx, probIdx } = columns;
  const { nodeByLabel, nodes, usedIds, actorByAction, edges, seqCounter } = graphState;
  const cells = row.map(normalizeCell).filter(Boolean);
  let action = actionIdx >= 0 ? normalizeCell(row[actionIdx]) : '';
  let actor  = actorIdx  >= 0 ? normalizeCell(row[actorIdx])  : '';
  if (!action) action = cells.find((c) => startsWithVerbPt(c) || isDecisionPhrase(c) || isPastPerfectLike(c)) || '';
  if (!actor)  actor  = cells.find((c) => isActorPhrase(c)) || '';
  if (!action) return;
  const actionNode = _xlsxEnsureNode(action, nodeByLabel, nodes, usedIds);
  if (actor) actorByAction.set(action, actor);
  const to = nextIdx >= 0 ? normalizeCell(row[nextIdx]) : '';
  if (to) {
    const toNode = _xlsxEnsureNode(to, nodeByLabel, nodes, usedIds);
    const p = probIdx >= 0 ? Number(String(row[probIdx]).replace(',', '.')) : Number.NaN;
    edges.push({ id: `e${edges.length + 1}`, from: actionNode.id, to: toNode.id,
      probability: Number.isFinite(p) && p > 0 ? p : 100, isLoopReturn: false, isErrorPath: false });
    return;
  }
  const seqTo = normalizeCell((dataRows[i + 1] || [])[actionIdx]);
  if (seqTo) {
    seqCounter.n += 1;
    const toNode = _xlsxEnsureNode(seqTo, nodeByLabel, nodes, usedIds);
    edges.push({ id: `es${seqCounter.n}`, from: actionNode.id, to: toNode.id,
      probability: 100, isLoopReturn: false, isErrorPath: false });
  }
}

/** Constrói nós e arestas a partir das linhas de dados. */
function _xlsxBuildGraph(dataRows, actionIdx, nextIdx, actorIdx, probIdx) {
  const nodeByLabel = new Map(), nodes = [], usedIds = new Set();
  const actorByAction = new Map(), edges = [], seqCounter = { n: 0 };
  const columns = { actionIdx, nextIdx, actorIdx, probIdx };
  const graphState = { nodeByLabel, nodes, usedIds, actorByAction, edges, seqCounter };
  for (let i = 0; i < dataRows.length; i += 1)
    _xlsxHandleDataRow(dataRows[i] || [], i, dataRows, columns, graphState);
  const tail = dataRows.slice(Math.max(0, dataRows.length - 20));
  for (const row of tail) {
    const vals = row.map(normalizeCell).filter(Boolean);
    if (vals.length < 2) continue;
    if (nodeByLabel.has(vals[0]) && vals[1]) actorByAction.set(vals[0], vals[1]);
  }
  return { nodes, actorByAction, edges };
}

/** Aplica atores, infere tipos e define start/end padrão. */
function _xlsxApplyActors(nodes, actorByAction) {
  for (const n of nodes) {
    const actor = actorByAction.get(n.label) || '';
    if (actor) { n.lane = actor; n.executor = actor; }
    n.type = inferNodeTypeFromPhrase(n.label);
  }
  if (!nodes.some((n) => n.type === 'start') && nodes.length) nodes[0].type = 'start';
  if (!nodes.some((n) => n.type === 'end') && nodes.length > 1) nodes[nodes.length - 1].type = 'end';
}

async function parseXlsxTopology(base64Data) {
  const buf = Buffer.from(String(base64Data || ''), 'base64');
  if (!buf.length) throw new Error('Arquivo XLSX vazio ou invalido.');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buf);
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error('Planilha sem abas.');
  const sheetName = ws.name;

  const rows = _xlsxWorksheetRows(ws);
  if (!rows.length) throw new Error('Planilha sem dados.');

  const headerIdx = findHeaderIndex(rows);
  const headers   = (rows[headerIdx] || []).map(normalizeCell);
  const dataRows  = rows.slice(headerIdx + 1);
  const actionIdx = findColumnIdx(headers, ['acao', 'atividade', 'tarefa', 'etapa', 'passo']);
  const nextIdx   = findColumnIdx(headers, ['proxima', 'destino', 'next', 'to', 'saida']);
  const actorIdx  = findColumnIdx(headers, ['ator', 'responsavel', 'raia', 'executor', 'owner']);
  const probIdx   = findColumnIdx(headers, ['prob', 'percent', '%']);

  const { nodes, actorByAction, edges } = _xlsxBuildGraph(dataRows, actionIdx, nextIdx, actorIdx, probIdx);
  _xlsxApplyActors(nodes, actorByAction);
  _xlsxNormalizeProbabilities(edges);

  return {
    nodes, edges,
    notes: `XLSX local parse: aba ${sheetName}, linhas ${dataRows.length}, nos ${nodes.length}, arestas ${edges.length}`,
  };
}
async function callGithubModels(parsed) {
  const AI_TOKEN = String(parsed._aiToken || process.env.SIGA_AI_TOKEN || '').trim();
  const AI_API_URL = process.env.SIGA_AI_API_URL || 'https://models.github.ai/inference/chat/completions';
  const AI_MODEL  = process.env.SIGA_AI_MODEL  || 'openai/gpt-4.1-mini';

  if (!AI_TOKEN) {
    const err = new Error('IA GitHub Models nao configurada — defina SIGA_AI_TOKEN no ambiente');
    err.statusCode = 503;
    throw err;
  }

  const input = await normalizeAiInput(parsed);
  const maxTokens = Math.min(Math.max(Number(parsed.maxTokens) || 1800, 256), 16384);
  const userContent = [{ type: 'text', text: input.prompt }];
  if (input.image) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${input.image.mimeType};base64,${input.image.data}` } });
  }

  const aiResp = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_TOKEN}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        { role: 'system', content: 'Você é um assistente para análise de processos da CAGE-RS. Responda em português de forma objetiva e estruturada.' },
        { role: 'user', content: userContent.length === 1 ? input.prompt : userContent }
      ],
      max_tokens: maxTokens
    })
  });

  const aiData = await aiResp.json().catch((err) => {
    console.warn('Falha ao parsear resposta IA (primeira chamada):', err.message);
    return {};
  });
  if (!aiResp.ok) {
    const err = new Error(aiData?.error?.message || 'Erro na API de IA (GitHub Models)');
    err.statusCode = aiResp.status;
    throw err;
  }

  return aiData?.choices?.[0]?.message?.content || '';
}

let _mammoth = null;

function getMammoth() {
  if (_mammoth) return _mammoth;
  try {
    _mammoth = require('mammoth');
    return _mammoth;
  } catch (moduleError) {
    if (moduleError?.code !== 'MODULE_NOT_FOUND') throw moduleError;
    const err = new Error('Dependencia ausente para DOCX: instale "mammoth" (npm install mammoth).');
    err.statusCode = 500;
    throw err;
  }
}

async function extractDocxTextFromBase64(base64Data) {
  const buf = Buffer.from(String(base64Data || ''), 'base64');
  if (!buf.length) {
    const err = new Error('Arquivo DOCX vazio ou invalido.');
    err.statusCode = 400;
    throw err;
  }

  const mammoth = getMammoth();
  let result;
  try {
    result = await mammoth.extractRawText({ buffer: buf });
  } catch (mammothErr) {
    const err = new Error('Arquivo DOCX inválido ou corrompido: ' + (mammothErr?.message || 'erro ao abrir o documento'));
    err.statusCode = 400;
    throw err;
  }
  const text = String(result?.value || '').replaceAll('\r', '').trim();
  if (!text) {
    const err = new Error('Nao foi possivel extrair texto do DOCX. Verifique se o arquivo contém texto legível (não apenas imagens).');
    err.statusCode = 400;
    throw err;
  }
  return text;
}

async function normalizeAiInput(parsed) {
  const basePrompt = typeof parsed?.prompt === 'string' ? parsed.prompt.slice(0, 24000).trim() : '';
  if (!basePrompt) {
    const err = new Error('Campo obrigatório: prompt');
    err.statusCode = 400;
    throw err;
  }

  const img = parsed?.image;
  if (!(img && typeof img === 'object' && img.data && img.mimeType)) {
    return { prompt: basePrompt, image: null };
  }

  const mime = String(img.mimeType || '').toLowerCase();
  if (mime === DOC_MIME) {
    const err = new Error('Arquivo .doc nao suportado pela IA. Converta para .docx ou PDF.');
    err.statusCode = 400;
    throw err;
  }

  if (mime === DOCX_MIME) {
    const docxText = await extractDocxTextFromBase64(img.data);
    const composedPrompt = `${basePrompt}\n\n---\nCONTEUDO DO DOCUMENTO (DOCX):\n${docxText}`.slice(0, 120000);
    return { prompt: composedPrompt, image: null };
  }

  return {
    prompt: basePrompt,
    image: {
      data: String(img.data),
      mimeType: String(img.mimeType)
    }
  };
}


function getAzureApiKey(parsed) {
  return String(parsed?._aiToken || process.env.SIGA_AZURE_API_KEY || '').trim();
}

async function callAzureOpenAI(parsed) {
  const AZURE_API_KEY    = getAzureApiKey(parsed);
  const AZURE_ENDPOINT   = (process.env.SIGA_AZURE_ENDPOINT || 'https://projeto-gesproc-cage.cognitiveservices.azure.com').replace(/\/$/, '');
  const AZURE_DEPLOYMENT = process.env.SIGA_AZURE_DEPLOYMENT || 'gpt-5.1-chat';
  const AZURE_API_VER    = process.env.SIGA_AZURE_API_VERSION || '2024-12-01-preview';

  if (!AZURE_API_KEY) {
    const err = new Error('Azure OpenAI nao configurada — defina SIGA_AZURE_API_KEY no ambiente');
    err.statusCode = 503;
    throw err;
  }

  const input = await normalizeAiInput(parsed);
  const maxTokens = Math.min(Math.max(Number(parsed.maxTokens) || 1800, 256), 16384);
  const userContent = [{ type: 'text', text: input.prompt }];
  if (input.image) {
    userContent.push({ type: 'image_url', image_url: { url: `data:${input.image.mimeType};base64,${input.image.data}` } });
  }

  const url = `${AZURE_ENDPOINT}/openai/deployments/${encodeURIComponent(AZURE_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(AZURE_API_VER)}`;

  const aiResp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': AZURE_API_KEY
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: 'Você é um assistente para análise de processos da CAGE-RS. Responda em português de forma objetiva e estruturada.' },
        { role: 'user', content: userContent.length === 1 ? input.prompt : userContent }
      ],
      max_completion_tokens: maxTokens
    })
  });

  const aiData = await aiResp.json().catch((err) => {
    console.warn('Falha ao parsear resposta IA (segunda chamada):', err.message);
    return {};
  });
  if (!aiResp.ok) {
    const err = new Error(aiData?.error?.message || 'Erro na API Azure OpenAI');
    err.statusCode = aiResp.status;
    err.retryAfter = Number(aiResp.headers.get('retry-after') || 0) || null;
    throw err;
  }

  return aiData?.choices?.[0]?.message?.content || '';
}

function hasGithubProviderConfigured() {
  return Boolean(process.env.SIGA_AI_TOKEN);
}

function hasAzureProviderConfigured() {
  return Boolean(process.env.SIGA_AZURE_API_KEY);
}

function isQuotaOrRateLimitError(error) {
  const status = Number(error?.statusCode || 0);
  const msg = String(error?.message || '').toLowerCase();
  if (status === 429) return true;
  return msg.includes('quota exceeded')
    || msg.includes('rate limit')
    || msg.includes('too many requests')
    || msg.includes('retry in');
}

async function callAiWithFallback(parsed, preferredProvider) {
  const provider = String(preferredProvider || 'azure').toLowerCase();

  if (provider === 'github' || provider === 'github-models') {
    const text = await callGithubModels(parsed);
    return { text, providerUsed: 'github-models' };
  }

  // Default: Azure OpenAI; fallback to GitHub Models on quota/rate-limit
  try {
    const text = await callAzureOpenAI(parsed);
    return { text, providerUsed: 'azure-openai' };
  } catch (error) {
    if (isQuotaOrRateLimitError(error) && hasGithubProviderConfigured()) {
      const text = await callGithubModels(parsed);
      return { text, providerUsed: 'github-models', fallbackFrom: 'azure-openai', fallbackReason: 'quota_or_rate_limit' };
    }
    throw error;
  }
}

function _buildDataRecord(parsed, current) {
  const updatedBy = typeof parsed?.updated_by === 'string' && parsed.updated_by.trim()
    ? parsed.updated_by.trim()
    : 'local@admin';
  const updatedByName = typeof parsed?.updated_by_name === 'string' && parsed.updated_by_name.trim()
    ? parsed.updated_by_name.trim()
    : 'Administrador Local';

  return {
    id: 1,
    data: sanitizeIncomingData(parsed, current),
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
    updated_by_name: updatedByName
  };
}

// ── helpers: _handleRequest (S3776 — Cognitive Complexity) ──────────────────

/** Analisa o body JSON; retorna null e envia 400 se inválido. */
async function _parseRequestBody(req, res) {
  const body = await collectRequestBody(req);
  try {
    return body ? JSON.parse(body) : {};
  } catch (parseError) {
    sendJson(req, res, 400, { ok: false, error: `Body invalido: JSON malformado (${parseError.message})` });
    return null;
  }
}

async function _routeOptions(req, res) {
  res.writeHead(204, corsHeadersFor(req)); res.end();
}

async function _routeGetHealth(req, res) {
  sendJson(req, res, 200, {
    ok: true, service: 'siga-local-backend',
    authMode: AUTH_MODE,
    entraConfigured: isEntraConfigured(),
    aiProvider: process.env.SIGA_AI_PROVIDER || 'ai',
    hasAdminToken: Boolean(ADMIN_TOKEN),
    hasAiConfigured: hasGithubProviderConfigured() || hasAzureProviderConfigured(),
    hasEmailNotificationsConfigured: isEmailNotificationConfigured(),
  });
}

async function _routeGetAccessState(req, res) {
  const access = buildAccessDecision(readRecord(), req.auth);
  sendJson(req, res, 200, { ok: true, access });
}

async function _routePostAccessRequest(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const current = readRecord();
  const state = getLocalAccessState(current);
  const email = getAuthEmail(req.auth);
  const name = getAuthName(req.auth);
  if (!email) { sendJson(req, res, 400, { ok: false, error: 'Nao foi possivel identificar o e-mail do usuario autenticado.' }); return; }

  const motivo = typeof parsed?.motivo === 'string' ? parsed.motivo.trim() : '';
  const existing = state.requests.find((item) => normalizeEmail(item.email) === email);
  const shouldNotifyAdmins = !(existing?.status === 'pendente');
  const payload = {
    email,
    name,
    motivo,
    status: 'pendente',
    requested_at: new Date().toISOString(),
    decided_at: '',
    decided_by: '',
    decided_by_name: ''
  };
  if (existing) Object.assign(existing, payload);
  else state.requests.push(payload);
  if (shouldNotifyAdmins) appendAccessRequestAudit(state, email, name);

  const next = {
    ...current,
    data: {
      ...(current.data && typeof current.data === 'object' ? current.data : {}),
      localAccess: state
    },
    updated_at: new Date().toISOString(),
    updated_by: email,
    updated_by_name: name
  };
  writeRecord(next);
  if (shouldNotifyAdmins) {
    notifyAdminsAboutAccessRequest(next, payload).catch((error) => {
      console.warn('[siga] alerta de pedido de acesso', error?.message || error);
    });
  }
  sendJson(req, res, 200, {
    ok: true,
    access: buildAccessDecision(next, req.auth)
  });
}

async function _routeGetData(req, res) {
  sendJson(req, res, 200, readRecord());
}

async function _routePostData(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const current = readRecord();
  const next = _buildDataRecord(parsed, current);
  writeRecord(next);
  notifyUsersAboutAccessDecisions(current, next).catch((error) => {
    console.warn('[siga] notificacao de decisao de acesso', error?.message || error);
  });
  sendJson(req, res, 200, { ok: true, row: next });
}

async function _routePostAi(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const provider = getAiProviderOverride(req) || String(process.env.SIGA_AI_PROVIDER || 'ai').toLowerCase();
  const headerToken = String(req.headers['x-ai-token'] || '').trim();
  if (headerToken) parsed._aiToken = headerToken;
  const result = await callAiWithFallback(parsed, provider);
  sendJson(req, res, 200, {
    ok: true, text: result.text, providerUsed: result.providerUsed,
    modelUsed: result.modelUsed || null, fallbackFrom: result.fallbackFrom || null,
    fallbackFromModel: result.fallbackFromModel || null, fallbackReason: result.fallbackReason || null,
  });
}

async function _routePostParseXlsx(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const data = typeof parsed?.data === 'string' ? parsed.data : '';
  if (!data) { sendJson(req, res, 400, { ok: false, error: 'Campo obrigatorio: data (base64 do xlsx)' }); return; }
  const parsedGraph = await parseXlsxTopology(data);
  sendJson(req, res, 200, {
    ok: true,
    graph: { nodes: parsedGraph.nodes, edges: parsedGraph.edges },
    notes: parsedGraph.notes,
  });
}

const _ROUTE_MAP = new Map([
  ['GET /health',      _routeGetHealth],
  ['GET /access-state', _routeGetAccessState],
  ['POST /access-request', _routePostAccessRequest],
  ['GET /data',        _routeGetData],
  ['POST /data',       _routePostData],
  ['POST /ai',         _routePostAi],
  ['POST /parse-xlsx', _routePostParseXlsx],
]);

async function _ensureAuthorizedRoute(req, res, routeKey) {
  if (!routeRequiresAuth(routeKey)) return true;
  if (!isEntraAuthMode()) {
    if (isAuthorizedWriteRequest(req)) return true;
    sendJson(req, res, 403, { ok: false, error: 'Forbidden' });
    return false;
  }

  try {
    req.auth = await validateEntraBearerToken(readBearerToken(req));
    if (ACCESS_SELF_SERVICE_ROUTES.has(routeKey)) return true;
    req.access = buildAccessDecision(readRecord(), req.auth);
    if (VIEW_ROUTES.has(routeKey)) {
      if (canAccessViewRoute(req.access)) return true;
      sendJson(req, res, 403, { ok: false, error: 'Acesso ao sistema pendente de aprovacao.' });
      return false;
    }
    if (WRITE_ROUTES.has(routeKey)) {
      if (canAccessWriteRoute(req.access)) return true;
      sendJson(req, res, 403, { ok: false, error: 'Permissao insuficiente para gravar dados.' });
      return false;
    }
    return true;
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 401;
    sendJson(req, res, statusCode, { ok: false, error: error?.message || 'Unauthorized' });
    return false;
  }
}

function getAiProviderOverride(req) {
  return String(req.headers['x-ai-provider'] || '').trim().toLowerCase();
}

async function _handleRequest(req, res, url) {
  if (req.method === 'OPTIONS') { await _routeOptions(req, res); return; }
  const routeKey = `${req.method} ${url.pathname}`;
  const handler = _ROUTE_MAP.get(routeKey);
  if (handler) {
    if (!await _ensureAuthorizedRoute(req, res, routeKey)) return;
    await handler(req, res);
    return;
  }
  sendJson(req, res, 404, { ok: false, error: 'Not found' });
}
const server = http.createServer(async (req, res) => {
  try {
    const requestHost = req.headers.host || `${HOST}:${PORT}`;
    const url = new URL(req.url, `http://${requestHost}`);
    await _handleRequest(req, res, url);
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(req, res, statusCode, { ok: false, error: error?.message || 'Internal server error', provider: error?.provider || null, retryAfter: error?.retryAfter || null });
  }
});

// Verifica dependências opcionais no startup para evitar falhas silenciosas em runtime.
function checkOptionalDeps() {
  const missing = [];
  try {
    require('mammoth');
  } catch (mammothError) {
    if (mammothError?.code !== 'MODULE_NOT_FOUND') {
      throw mammothError;
    }
    missing.push('mammoth (DOCX parser)');
  }
  try {
    require('exceljs');
  } catch (excelError) {
    if (excelError?.code !== 'MODULE_NOT_FOUND') {
      throw excelError;
    }
    missing.push('exceljs (XLSX parser)');
  }
  if (missing.length) {
    console.warn(`[siga-local-backend] AVISO: dependencias ausentes — execute "npm install":`);
    for (const dep of missing) console.warn(`  • ${dep}`);
  }
}

server.listen(PORT, HOST, () => {
  console.info(`[siga-local-backend] running at http://${HOST}:${PORT}`);
  console.info(`[siga-local-backend] data file: ${DATA_FILE}`);
  checkOptionalDeps();
});

