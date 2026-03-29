const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
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

const ADMIN_TOKEN = String(process.env.SIGA_ADMIN_TOKEN || '').trim();

function readAdminToken(req) {
  const bearer = String(req.headers.authorization || '').trim();
  if (bearer.toLowerCase().startsWith('bearer ')) return bearer.slice(7).trim();
  return String(req.headers['x-siga-admin-token'] || '').trim();
}

function isLoopbackRequest(req) {
  const remote = String(req.socket?.remoteAddress || '');
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

function isAuthorizedWriteRequest(req) {
  if (!ADMIN_TOKEN) return isLoopbackRequest(req);
  return readAdminToken(req) === ADMIN_TOKEN;
}

function corsHeadersFor(req) {
  const origin = req.headers.origin || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SIGA-Admin-Token',
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
    aiProvider: process.env.SIGA_AI_PROVIDER || 'ai',
    hasAdminToken: Boolean(ADMIN_TOKEN),
  });
}

async function _routeGetData(req, res) {
  sendJson(req, res, 200, readRecord());
}

async function _routePostData(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const next = _buildDataRecord(parsed, readRecord());
  writeRecord(next);
  sendJson(req, res, 200, { ok: true, row: next });
}

async function _routePostAi(req, res) {
  const parsed = await _parseRequestBody(req, res);
  if (parsed === null) return;
  const provider = String(process.env.SIGA_AI_PROVIDER || 'ai').toLowerCase();
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
  ['GET /data',        _routeGetData],
  ['POST /data',       _routePostData],
  ['POST /ai',         _routePostAi],
  ['POST /parse-xlsx', _routePostParseXlsx],
]);

function _ensureAuthorizedRoute(req, res, routeKey) {
  if (!WRITE_ROUTES.has(routeKey)) return true;
  if (isAuthorizedWriteRequest(req)) return true;
  sendJson(req, res, 403, { ok: false, error: 'Forbidden' });
  return false;
}

async function _handleRequest(req, res, url) {
  if (req.method === 'OPTIONS') { await _routeOptions(req, res); return; }
  const routeKey = `${req.method} ${url.pathname}`;
  const handler = _ROUTE_MAP.get(routeKey);
  if (handler) {
    if (!_ensureAuthorizedRoute(req, res, routeKey)) return;
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

