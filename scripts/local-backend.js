const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = Number(process.env.SIGA_MAX_BODY_BYTES || 50 * 1024 * 1024);
const DATA_FILE = process.env.SIGA_DATA_FILE
  ? path.resolve(process.env.SIGA_DATA_FILE)
  : path.resolve(__dirname, '..', 'backups', 'local-data.json');

const ALLOWED_ORIGIN = process.env.SIGA_ALLOWED_ORIGIN || 'http://localhost:8080';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      id: 1,
      data: {},
      updated_at: null,
      updated_by: 'local@admin',
      updated_by_name: 'Administrador Local'
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'siga-local-backend',
        dataFile: DATA_FILE
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/data') {
      const record = readRecord();
      sendJson(res, 200, record);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/data') {
      const body = await collectRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const current = readRecord();

      const next = {
        id: 1,
        data:
          parsed && typeof parsed.data === 'object' && parsed.data !== null
            ? parsed.data
            : current.data,
        updated_at: new Date().toISOString(),
        updated_by:
          typeof parsed?.updated_by === 'string' && parsed.updated_by.trim()
            ? parsed.updated_by.trim()
            : 'local@admin',
        updated_by_name:
          typeof parsed?.updated_by_name === 'string' && parsed.updated_by_name.trim()
            ? parsed.updated_by_name.trim()
            : 'Administrador Local'
      };

      writeRecord(next);
      sendJson(res, 200, { ok: true, row: next });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/ai') {
      const AI_TOKEN = process.env.SIGA_AI_TOKEN || '';
      const AI_API_URL = process.env.SIGA_AI_API_URL || 'https://models.github.ai/inference/chat/completions';
      const AI_MODEL  = process.env.SIGA_AI_MODEL  || 'openai/gpt-4.1-mini';

      if (!AI_TOKEN) {
        sendJson(res, 503, { ok: false, error: 'IA não configurada — defina SIGA_AI_TOKEN no ambiente' });
        return;
      }

      const body   = await collectRequestBody(req);
      const parsed = body ? JSON.parse(body) : {};
      const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.slice(0, 24000) : '';
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: 'Campo obrigatório: prompt' });
        return;
      }

      const maxTokens  = Math.min(Math.max(Number(parsed.maxTokens) || 1800, 256), 16384);
      const userContent = [{ type: 'text', text: prompt }];
      const img = parsed.image;
      if (img && typeof img === 'object' && img.data && img.mimeType) {
        userContent.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } });
      }

      const aiResp = await fetch(AI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AI_TOKEN}` },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: 'system', content: 'Você é um assistente para análise de processos da CAGE-RS. Responda em português de forma objetiva e estruturada.' },
            { role: 'user',   content: userContent.length === 1 ? prompt : userContent }
          ],
          max_tokens: maxTokens
        })
      });

      const aiData = await aiResp.json();
      if (!aiResp.ok) {
        sendJson(res, aiResp.status, { ok: false, error: aiData?.error?.message || 'Erro na API de IA' });
        return;
      }

      const text = aiData?.choices?.[0]?.message?.content || '';
      sendJson(res, 200, { ok: true, text });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    sendJson(res, statusCode, {
      ok: false,
      error: error?.message || 'Internal server error'
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[siga-local-backend] running at http://${HOST}:${PORT}`);
  console.log(`[siga-local-backend] data file: ${DATA_FILE}`);
});
