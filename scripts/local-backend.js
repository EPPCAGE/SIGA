try { require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') }); } catch (_) { /* dotenv ausente em producao — vars vem do ambiente */ }
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.SIGA_MAX_BODY_BYTES || 50 * 1024 * 1024);
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

function corsHeadersFor(req) {
  const origin = req.headers.origin || '';
  const allowAny = ALLOWED_ORIGINS.includes('*');
  const allowedOrigin = allowAny
    ? '*'
    : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // File already exists — that's fine
  }
}

function readRecord() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    id: 1,
    data: parsed && typeof parsed === 'object' ? (parsed.data || {}) : {},
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


async function callGithubModels(parsed) {
  const AI_TOKEN = process.env.SIGA_AI_TOKEN || '';
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

  const aiData = await aiResp.json().catch(() => ({}));
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
  } catch (_e) {
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

function buildAiApiUrl(model) {
  const rawUrl = String(process.env.SIGA_AI_API_URL || '').trim();
  if (!rawUrl) {
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  if (rawUrl.includes('{model}')) {
    return rawUrl.replace('{model}', encodeURIComponent(model));
  }

  if (/\/models\/[^:/]+:generateContent/i.test(rawUrl)) {
    return rawUrl.replace(/\/models\/[^:/]+:generateContent/i, `/models/${model}:generateContent`);
  }

  return rawUrl;
}

function aiModelCandidates() {
  const primary = String(process.env.SIGA_AI_MODEL || '').trim();
  const fallbacksRaw = String(process.env.SIGA_AI_FALLBACK_MODELS || '');
  const fallbacks = fallbacksRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return [...new Set([primary, ...fallbacks])];
}

async function callAiOnce(parsed, model) {
  const AI_KEY = process.env.SIGA_AI_API_KEY || '';
  const AI_API_URL = buildAiApiUrl(model);

  if (!AI_KEY) {
    const err = new Error('IA nao configurada — defina SIGA_AI_API_KEY no ambiente');
    err.statusCode = 503;
    err.provider = 'ai';
    err.model = model;
    throw err;
  }

  const input = await normalizeAiInput(parsed);
  const parts = [{ text: input.prompt }];
  if (input.image) {
    parts.push({ inline_data: { mime_type: input.image.mimeType, data: input.image.data } });
  }

  const aiResp = await fetch(`${AI_API_URL}?key=${encodeURIComponent(AI_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: Math.min(Math.max(Number(parsed.maxTokens) || 1800, 128), 65536),
        temperature: 0.2
      }
    })
  });

  const aiData = await aiResp.json().catch(() => ({}));
  if (!aiResp.ok) {
    const err = new Error(aiData?.error?.message || 'Erro na API de IA');
    err.statusCode = aiResp.status;
    err.provider = 'ai';
    err.model = model;
    err.retryAfter = Number(aiResp.headers.get('retry-after') || 0) || null;
    throw err;
  }

  const partsOut = aiData?.candidates?.[0]?.content?.parts || [];
  const text = partsOut
    .map(p => (typeof p?.text === 'string' ? p.text : ''))
    .join('\n')
    .trim();

  return { text, modelUsed: model };
}

async function callAi(parsed) {
  const models = aiModelCandidates();
  const primaryModel = models[0] || '';
  let lastError = null;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const result = await callAiOnce(parsed, model);
      if (i === 0) return result;
      return {
        ...result,
        fallbackFromModel: primaryModel,
        fallbackReason: 'quota_or_rate_limit'
      };
    } catch (error) {
      lastError = error;
      const canTryNext = i < models.length - 1;
      if (!(canTryNext && isQuotaOrRateLimitError(error))) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Erro na API de IA');
}

async function callAzureOpenAI(parsed) {
  const AZURE_API_KEY    = process.env.SIGA_AZURE_API_KEY || '';
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

  const aiData = await aiResp.json().catch(() => ({}));
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

async function _handleAiFallback(error, parsed) {
  if (isQuotaOrRateLimitError(error) && hasAzureProviderConfigured()) {
    const text = await callAzureOpenAI(parsed);
    return { text, providerUsed: 'azure-openai', fallbackFrom: 'ai', fallbackReason: 'quota_or_rate_limit' };
  }
  if (isQuotaOrRateLimitError(error) && hasGithubProviderConfigured()) {
    const text = await callGithubModels(parsed);
    return { text, providerUsed: 'github-models', fallbackFrom: 'ai', fallbackReason: 'quota_or_rate_limit' };
  }
  throw error;
}

async function callAiWithFallback(parsed, preferredProvider) {
  const provider = String(preferredProvider || 'ai').toLowerCase();

  if (provider === 'azure' || provider === 'azure-openai') {
    const text = await callAzureOpenAI(parsed);
    return { text, providerUsed: 'azure-openai' };
  }

  if (provider === 'github' || provider === 'github-models') {
    const text = await callGithubModels(parsed);
    return { text, providerUsed: 'github-models' };
  }

  try {
    const aiResult = await callAi(parsed);
    return {
      text: aiResult.text,
      providerUsed: 'ai',
      modelUsed: aiResult.modelUsed,
      fallbackFromModel: aiResult.fallbackFromModel || null,
      fallbackReason: aiResult.fallbackReason || null
    };
  } catch (error) {
    return _handleAiFallback(error, parsed);
  }
}

function _buildDataRecord(parsed, current) {
  const hasValidData = parsed && typeof parsed.data === 'object' && parsed.data !== null;
  const updatedBy = typeof parsed?.updated_by === 'string' && parsed.updated_by.trim()
    ? parsed.updated_by.trim()
    : 'local@admin';
  const updatedByName = typeof parsed?.updated_by_name === 'string' && parsed.updated_by_name.trim()
    ? parsed.updated_by_name.trim()
    : 'Administrador Local';

  return {
    id: 1,
    data: hasValidData ? parsed.data : current.data,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
    updated_by_name: updatedByName
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeadersFor(req));
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(req, res, 200, {
        ok: true,
        service: 'siga-local-backend',
        dataFile: DATA_FILE,
        aiProvider: process.env.SIGA_AI_PROVIDER || 'ai'
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/data') {
      const record = readRecord();
      sendJson(req, res, 200, record);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/data') {
      const body = await collectRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const current = readRecord();

      const next = _buildDataRecord(parsed, current);

      writeRecord(next);
      sendJson(req, res, 200, { ok: true, row: next });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ai') {
      const body   = await collectRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const provider = String(process.env.SIGA_AI_PROVIDER || 'ai').toLowerCase();

      const result = await callAiWithFallback(parsed, provider);

      sendJson(req, res, 200, {
        ok: true,
        text: result.text,
        providerUsed: result.providerUsed,
        modelUsed: result.modelUsed || null,
        fallbackFrom: result.fallbackFrom || null,
        fallbackFromModel: result.fallbackFromModel || null,
        fallbackReason: result.fallbackReason || null
      });
      return;
    }

    sendJson(req, res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(req, res, statusCode, {
      ok: false,
      error: error?.message || 'Internal server error',
      provider: error?.provider || null,
      retryAfter: error?.retryAfter || null
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[siga-local-backend] running at http://${HOST}:${PORT}`);
  console.log(`[siga-local-backend] data file: ${DATA_FILE}`);
});
