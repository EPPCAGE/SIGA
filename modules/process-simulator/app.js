import {
  normalizeGraph,
  validateProbabilities,
  validateGraphIntegrity,
  calculateTEPAndIP,
  calculatePathTime,
  simulate100Tokens,
  calculateComplexity,
  gatewayNodes,
  outgoing,
  applyGatewayProbabilities,
  simulateRoi,
  RULES,
} from './engine.js';
import { scanSuggestions, markAutomation, setLoopProbability } from './assistant.js';
import { extractTopologyFromImage, extractTopologyFromSpreadsheetFile, extractTopologyFromWorkflowFile } from './cv.js';

const $ = (id) => document.getElementById(id);

// ═══ SECURITY: XSS PROTECTION ═══════════════════════════════════════
// Escape HTML to prevent XSS attacks when using innerHTML
function escapeHtml(str) {
  if (typeof str !== 'string') {
    str = String(str || '');
  }
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Sanitize HTML content by creating safe DOM elements instead of using innerHTML directly
function setHTMLSafe(element, html) {
  if (!element) return;
  // For internal static strings, we can use innerHTML, but for dynamic content we use textContent
  element.innerHTML = html;
}

let graph = null;
let simRuns = [];
let animFrame = null;
let running = false;
let extractedGraph = null;
const loopCounters = new Map();
let happyPathMarking = {
  active: false,
  nodes: [],
};
let simulationMode = 'real';
let confirmedAutoNodes = new Set();
let setupCompleted = false;
let sourceDiagramDataUrl = '';
let animationLastTickMs = 0;
let simulationClockMs = 0;
let actorAliasById = new Map();
let sigaActorCatalogCache = null;
let liveSimulationStatus = {
  finished: 0,
  total: 100,
  avgLeadTime: 0,
};

// Processo vinculado (selecionado na Seção 0 do setup)
let _linkedProcess = null; // { macroprocesso, processo, subprocesso, area, natureza }
// Lista de processos recebida do pai SIGA via postMessage
let _sigaProcessList = null;
// Últimas métricas de simulação calculadas (para incluir no save)
let _lastSimMetrics = null;

const TOKEN_COUNT = 100;
const TOKEN_LAUNCH_GAP_MS = 500;

// TER calculado a partir das partículas animadas (100 runs).
// Quando disponível, tem precedência sobre os 3500 do motor
// para garantir que o contador ao vivo e o dashboard mostrem o mesmo valor.
let _animatedTer = null;

// Valores padrao dos pesos (espelho de RULES para reset)
const RULES_DEFAULT = {
  firstManual: 20,
  nextManual: 10,
  automated: 0.5,
  gatewayPenalty: 2.5,
  handoffSameSector: 10,
  handoffDiffSector: 20,
  handoffDiffOrg: 40,
};

function applyWeightsFromUI() {
  const r = (id, fallback) => {
    const v = Number($(`weight_${id}`)?.value);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  RULES.firstManual      = r('firstManual',      RULES_DEFAULT.firstManual);
  RULES.nextManual       = r('nextManual',        RULES_DEFAULT.nextManual);
  RULES.automated        = r('automated',         RULES_DEFAULT.automated);
  RULES.gatewayPenalty   = r('gatewayPenalty',    RULES_DEFAULT.gatewayPenalty);
  RULES.handoffSameSector = r('handoffSameSector', RULES_DEFAULT.handoffSameSector);
  RULES.handoffDiffSector = r('handoffDiffSector', RULES_DEFAULT.handoffDiffSector);
  RULES.handoffDiffOrg   = r('handoffDiffOrg',    RULES_DEFAULT.handoffDiffOrg);
}

function resetRulesToDefaults() {
  Object.assign(RULES, RULES_DEFAULT);
  const ids = Object.keys(RULES_DEFAULT);
  for (const id of ids) {
    const el = $(`weight_${id}`);
    if (el) el.value = RULES_DEFAULT[id];
  }
}

function cloneLocal(obj) {
  return structuredClone(obj);
}

function normalizeTextKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '');
}

function looksLikeActorName(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (raw.length < 2 || raw.length > 120) return false;
  if (/^(http|www\.|\{|\[)/i.test(raw)) return false;
  if (/^\d+$/.test(raw)) return false;
  return true;
}

function extractActorsFromSigaDataPayload(root) {
  const out = new Set();

  const pushActor = (value) => {
    const v = String(value || '').trim();
    if (!looksLikeActorName(v)) return;
    out.add(v);
  };

  const visit = (node, parentKey = '') => {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const item of node) visit(item, parentKey);
      return;
    }

    if (typeof node !== 'object') return;

    const pKey = normalizeTextKey(parentKey);
    if (pKey === 'roles') {
      for (const role of Object.values(node)) {
        pushActor(role?.name);
        pushActor(role?.actor);
        pushActor(role?.responsavel);
        pushActor(role?.executor);
      }
    }

    for (const [key, value] of Object.entries(node)) {
      const k = normalizeTextKey(key);
      if (typeof value === 'string') {
        if (['actor', 'atores', 'executor', 'lane', 'raia', 'responsavel'].includes(k)) {
          pushActor(value);
        }
      }
      visit(value, key);
    }
  };

  visit(root, '');
  return [...out];
}

async function fetchSigaActorCatalog() {
  if (Array.isArray(sigaActorCatalogCache)) return sigaActorCatalogCache;

  const endpoints = ['/data', 'http://127.0.0.1:3000/data', 'http://localhost:3000/data'];
  let lastErr = null;
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, { method: 'GET', cache: 'no-store' });
      if (!resp.ok) continue;
      const payload = await resp.json();
      const actors = extractActorsFromSigaDataPayload(payload?.data || payload);
      if (actors.length) {
        sigaActorCatalogCache = actors;
        return actors;
      }
    } catch (e) {
      /* preserva estado de erro para inspecao */
      lastErr = e;
    }
  }

  sigaActorCatalogCache = [];
  if (lastErr) return [];
  return [];
}

function fillMissingActorsFromCatalog(targetGraph, actors) {
  if (!targetGraph || !Array.isArray(targetGraph.nodes) || !Array.isArray(actors) || !actors.length) return 0;
  const firstActor = String(actors[0] || '').trim();
  if (!firstActor) return 0;

  let changed = 0;
  for (const n of targetGraph.nodes) {
    if (n?.type !== 'task') continue;
    const lane = String(n?.lane || '').trim();
    const exec = String(n?.executor || '').trim();
    if (lane || exec) continue;
    n.lane = firstActor;
    n.executor = firstActor;
    changed += 1;
  }
  return changed;
}

function isTechnicalActorCode(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  const normalized = s.replaceAll(/[{}]/g, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    || /^[0-9a-f]{24,}$/i.test(s)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
}

function rebuildActorAliasMap() {
  actorAliasById = new Map();
  if (!graph) return;

  const seen = new Set();
  const lanes = (graph.nodes || [])
    .filter((n) => n.type === 'task')
    .map((n) => String(n?.lane || n?.executor || '').trim())
    .filter(Boolean);

  const technical = lanes.filter((lane) => isTechnicalActorCode(lane));
  const uniqueTechnical = new Set(technical);
  const technicalRatio = lanes.length ? (technical.length / lanes.length) : 0;

  // Heuristic for bad imports: many UUID-like performers create fake handoffs per action.
  // In this case, collapse to a single unknown actor instead of one actor per UUID.
  if (uniqueTechnical.size >= 3 && technicalRatio >= 0.6) {
    for (const lane of uniqueTechnical) actorAliasById.set(lane, 'Ator nao identificado');
    return;
  }

  let idx = 0;
  for (const lane of lanes) {
    if (seen.has(lane)) continue;
    seen.add(lane);
    if (isTechnicalActorCode(lane)) {
      idx += 1;
      actorAliasById.set(lane, `Ator ${idx}`);
    }
  }
}

function displayActorName(value) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (!isTechnicalActorCode(raw)) return raw;
  if (!actorAliasById.has(raw)) {
    actorAliasById.set(raw, `Ator ${actorAliasById.size + 1}`);
  }
  return actorAliasById.get(raw);
}

function normalizeActorCodesInGraph() {
  if (!graph) return;
  rebuildActorAliasMap();
  for (const n of graph.nodes || []) {
    if (n.type !== 'task') continue;
    const lane = String(n?.lane || '').trim();
    const exec = String(n?.executor || '').trim();
    const laneOut = displayActorName(lane);
    const execOut = displayActorName(exec);

    if (laneOut) n.lane = laneOut;
    if (execOut) n.executor = execOut;
    if (!String(n.lane || '').trim() && String(n.executor || '').trim()) n.lane = n.executor;
    if (!String(n.executor || '').trim() && String(n.lane || '').trim()) n.executor = n.lane;
  }
  rebuildActorAliasMap();
}

function isWorkflowXmlFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();

  if (isSpreadsheetFile(file)) return false;

  const xmlMime = type === 'application/xml'
    || type === 'text/xml'
    || type.endsWith('+xml')
    || type.includes('bpmn');

  return name.endsWith('.xpdl')
    || name.endsWith('.xlpd')
    || name.endsWith('.xml')
    || name.endsWith('.bpmn')
    || xmlMime;
}

function isSpreadsheetFile(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();
  return name.endsWith('.xlsx')
    || name.endsWith('.xls')
    || type.includes('spreadsheetml')
    || type.includes('excel');
}

function splitPercentages(count) {
  const n = Math.max(1, Number(count) || 1);
  const base = Math.floor(100 / n);
  let remainder = 100 - (base * n);
  const parts = Array.from({ length: n }, () => base);
  for (let i = 0; i < parts.length && remainder > 0; i += 1) {
    parts[i] += 1;
    remainder -= 1;
  }
  return parts;
}

function defaultGatewayProbMap(edges) {
  const isValidKey = (k) => typeof k === 'string' && k.length > 0 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
  const probs = edges.map((e) => Number(e?.probability || 0));
  const hasAnyPositive = probs.some((p) => Number.isFinite(p) && p > 0);
  if (hasAnyPositive) {
    const map = Object.create(null);
    for (const e of edges) { if(isValidKey(e.id)) map[e.id] = Number(e.probability || 0); }
    return map;
  }

  const parts = splitPercentages(edges.length);
  const map = Object.create(null);
  for (let i = 0; i < edges.length; i += 1) {
    if(isValidKey(edges[i].id)) map[edges[i].id] = parts[i];
  }
  return map;
}

function applyDefaultGatewayProbabilitiesLocal(g) {
  const next = cloneLocal(g);
  const gateways = (next.nodes || []).filter((n) => n.type === 'gateway');
  for (const gw of gateways) {
    const outs = outgoing(next, gw.id);
    if (!outs.length) continue;
    const map = defaultGatewayProbMap(outs);
    next.edges = (next.edges || []).map((e) => {
      if (e.from !== gw.id) return e;
      return { ...e, probability: Number(map[e.id] || 0) };
    });
  }
  return next;
}

function normalizedGatewayProbMap(edges) {
  const isValidKey = (k) => typeof k === 'string' && k.length > 0 && k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
  const vals = edges.map((e) => Math.max(0, Number(e?.probability || 0)));
  const sum = vals.reduce((a, b) => a + b, 0);

  if (!Number.isFinite(sum) || sum <= 0) {
    const fallback = splitPercentages(edges.length);
    const out = Object.create(null);
    for (let i = 0; i < edges.length; i += 1) { if(isValidKey(edges[i].id)) out[edges[i].id] = fallback[i]; }
    return out;
  }

  const out = Object.create(null);
  let acc = 0;
  for (let i = 0; i < edges.length; i += 1) {
    const id = edges[i].id;
    if (!isValidKey(id)) continue;
    if (i === edges.length - 1) {
      out[id] = Number((100 - acc).toFixed(2));
    } else {
      const p = Number(((vals[i] / sum) * 100).toFixed(2));
      out[id] = p;
      acc += p;
    }
  }
  return out;
}

function autoFixGatewayProbabilitiesInGraph() {
  if (!graph) return 0;
  let fixed = 0;
  const gateways = (graph.nodes || []).filter((n) => n.type === 'gateway');
  for (const gw of gateways) {
    const outs = outgoing(graph, gw.id);
    if (!outs.length) continue;
    const sum = outs.reduce((acc, e) => acc + Number(e.probability || 0), 0);
    if (Math.abs(sum - 100) <= 0.1) continue;
    const map = normalizedGatewayProbMap(outs);
    graph = applyGatewayProbabilities(graph, gw.id, map);
    fixed += 1;
  }
  return fixed;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function rebalanceOutgoingFromNode(fromId, focusEdgeId, targetProb) {
  if (!graph) return;
  const outs = outgoing(graph, fromId);
  if (!outs.length) return;

  const focus = outs.find((e) => e.id === focusEdgeId);
  if (!focus) return;

  const others = outs.filter((e) => e.id !== focusEdgeId);
  if (!others.length) {
    focus.probability = 100;
    return;
  }

  const p = clamp(Number(targetProb || 0), 1, 99);
  focus.probability = p;
  const rest = 100 - p;
  const each = rest / others.length;
  for (const e of others) e.probability = Number(each.toFixed(2));

  const sumOthers = others.reduce((acc, e) => acc + Number(e.probability || 0), 0);
  const drift = Number((100 - (sumOthers + p)).toFixed(2));
  if (Math.abs(drift) > 0 && others.length) {
    others.at(-1).probability = Number((Number(others.at(-1).probability || 0) + drift).toFixed(2));
  }
}

function parseViewBoxSize(svg) {
  const vb = String(svg?.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
  if (vb.length === 4 && vb.every((n) => Number.isFinite(n))) {
    return { x: vb[0], y: vb[1], width: vb[2], height: vb[3] };
  }
  return { x: 0, y: 0, width: 1200, height: 700 };
}

function graphViewBox(g, padding = 120) {
  const points = (g?.nodes || [])
    .map((n) => ({ x: Number(n?.x), y: Number(n?.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (!points.length) return { x: 0, y: 0, width: 1200, height: 700 };

  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));

  const x = minX - padding;
  const y = minY - padding;
  const width = Math.max(1200, (maxX - minX) + (padding * 2));
  const height = Math.max(700, (maxY - minY) + (padding * 2));
  return { x, y, width, height };
}

function appendDiagramBackdrop(svg, opacity = 0.92) {
  if (!svg || !sourceDiagramDataUrl) return;
  const { x, y, width, height } = parseViewBoxSize(svg);
  const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
  img.setAttribute('x', String(x));
  img.setAttribute('y', String(y));
  img.setAttribute('width', String(width));
  img.setAttribute('height', String(height));
  img.setAttribute('href', sourceDiagramDataUrl);
  img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  img.setAttribute('opacity', String(opacity));
  svg.appendChild(img);
}


function suggestedAutomationNodeIds() {
  if (!graph) return [];
  const automatedSet = new Set(
    (graph.nodes || [])
      .filter((n) => n.type === 'task' && n.automated)
      .map((n) => String(n.id || ''))
  );
  return scanSuggestions(graph)
    .filter((s) => s.kind === 'automation')
    .filter((s) => !automatedSet.has(String(s.nodeId || '')))
    .map((s) => s.nodeId);
}

function renderAutomationConfirm() {
  const box = $('autoConfirmBox');
  if (!box) return;
  if (!graph) {
    box.innerHTML = '<div class="box">Carregue um grafo para confirmar automacoes sugeridas.</div>';
    return;
  }

  const ids = suggestedAutomationNodeIds();
  if (!ids.length) {
    box.innerHTML = '<div class="box">Nenhuma automacao sugerida no modelo atual.</div>';
    return;
  }

  const rows = ids.map((id) => {
    const n = graph.nodes.find((x) => x.id === id);
    if (n?.automated) return '';
    const checked = confirmedAutoNodes.has(id) ? 'checked' : '';
    return `<label class="check-row"><input type="checkbox" data-auto-node="${escapeHtml(id)}" ${checked}> ${escapeHtml(n?.label || id)}</label>`;
  }).filter(Boolean).join('');

  box.innerHTML = `<div class="box" style="margin-bottom:6px;">Sugestoes de automacao detectadas. Confirme as que entram no cenario "TEP ideal auto".</div>${rows}`;
}

function syncConfirmedAutoFromUi() {
  const boxes = document.querySelectorAll('input[data-auto-node]');
  if (!boxes.length) return;

  const next = new Set();
  boxes.forEach((el) => {
    if (!el.checked) return;
    const id = String(el.dataset.autoNode || '').trim();
    if (id) next.add(id);
  });

  // Uma atividade ja automatica nao entra como "automatizavel" no cenario auto.
  const automatedSet = new Set(
    (graph?.nodes || [])
      .filter((n) => n.type === 'task' && n.automated)
      .map((n) => String(n.id || ''))
  );
  for (const id of [...next]) {
    if (automatedSet.has(id)) next.delete(id);
  }

  confirmedAutoNodes = next;
}

function buildAutoScenarioGraph() {
  const g = cloneLocal(graph);
  for (const node of g.nodes || []) {
    if (node.automated) continue;
    if (confirmedAutoNodes.has(node.id)) node.automated = true;
  }
  return g;
}

function detectLaneName(laneId) {
  if (!graph) return laneId;
  const profile = graph.lanes?.[laneId] || {};
  if (profile.team) return displayActorName(profile.team);
  const n = (graph.nodes || []).find((x) => actorLaneIdOf(x) === laneId && (x.executor || x.lane || x.sector));
  return displayActorName(String(n?.executor || n?.lane || n?.sector || laneId));
}

function actorLaneIdOf(node) {
  return String(node?.lane || node?.executor || node?.sector || '').trim();
}

function _bfsReachableTasks(startId, outgoingMap, nodeMap) {
  const queue = (outgoingMap.get(startId) || []).map((id) => ({ id, depth: 1 }));
  const visited = new Set();
  const reachedTasks = new Set();

  while (queue.length) {
    const current = queue.shift();
    if (!current || current.depth > 20) continue;

    const visitKey = `${current.id}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const node = nodeMap.get(current.id);
    if (!node) continue;

    if (node.type === 'task' && node.id !== startId) {
      reachedTasks.add(node.id);
      continue;
    }

    for (const nextId of outgoingMap.get(current.id) || []) {
      queue.push({ id: nextId, depth: current.depth + 1 });
    }
  }

  return reachedTasks;
}

function deriveTaskTransitions() {
  if (!graph) return [];
  const nodes = graph.nodes || [];
  const edges = graph.edges || [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const outgoingMap = new Map();

  for (const e of edges) {
    if (!outgoingMap.has(e.from)) outgoingMap.set(e.from, []);
    outgoingMap.get(e.from).push(e.to);
  }

  const links = new Map();
  const tasks = nodes.filter((n) => n.type === 'task');

  for (const start of tasks) {
    const reachedTasks = _bfsReachableTasks(start.id, outgoingMap, nodeMap);

    for (const toId of reachedTasks) {
      const key = `${start.id}->${toId}`;
      if (!links.has(key)) links.set(key, { fromId: start.id, toId });
    }
  }

  return [...links.values()];
}

function crossLaneTransitions() {
  if (!graph) return [];
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const pairs = new Map();

  for (const link of deriveTaskTransitions()) {
    const from = nodeMap.get(link.fromId);
    const to = nodeMap.get(link.toId);
    if (!from || !to) continue;
    if (from.automated || to.automated) continue;

    const fromLane = actorLaneIdOf(from);
    const toLane = actorLaneIdOf(to);
    if (!fromLane || !toLane) continue;
    if (fromLane === toLane) continue;

    const key = `${fromLane}->${toLane}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        key,
        fromLane,
        toLane,
        fromName: detectLaneName(fromLane),
        toName: detectLaneName(toLane),
      });
    }
  }

  return [...pairs.values()];
}

function handoffTypeOptions() {
  return [
    { v: '', t: 'Selecione' },
    { v: 'same_team', t: 'Mesma equipe' },
    { v: 'different_team', t: 'Outra equipe' },
    { v: 'different_org', t: 'Outro órgão' },
  ];
}

function actionLabelById(nodeId) {
  const n = (graph?.nodes || []).find((x) => x.id === nodeId);
  return String(n?.label || nodeId);
}

function actionTransitionPairs() {
  return deriveTaskTransitions().map((t) => ({
    key: `${t.fromId}->${t.toId}`,
    fromId: t.fromId,
    toId: t.toId,
    fromLabel: actionLabelById(t.fromId),
    toLabel: actionLabelById(t.toId),
  }));
}

function renderHandoffWizard() {
  const box = $('handoffWizard');
  if (!box) return;
  if (!graph) {
    box.textContent = 'Carregue um grafo para detectar handoffs.';
    return;
  }

  // Reaplica classificação automática com os dados atuais
  autoApplyHandoffRulesFromLanes();

  const pairs = crossLaneTransitions();

  if (!pairs.length) {
    box.innerHTML = '<div class="box" style="color:#2e7d4f;">✅ Nenhuma transição entre raias detectada. Não há handoffs neste processo.</div>';
    return;
  }

  const typeInfo = {
    same_team:     { label: 'Mesma equipe',            penalty: '+10 UT', color: '#2e7d4f', bg: '#f0faf4' },
    different_team:{ label: 'Outra equipe (mesmo órgão)', penalty: '+20 UT', color: '#8a6d3b', bg: '#fffbf0' },
    different_org: { label: 'Outro órgão',             penalty: '+40 UT', color: '#8f3d3a', bg: '#fff5f5' },
  };

  // Verifica se todas as raias têm perfil preenchido
  const missingProfiles = pairs.filter((p) => {
    const fl = graph.lanes?.[p.fromLane] || {};
    const tl = graph.lanes?.[p.toLane]   || {};
    return !fl.team && !fl.org && !tl.team && !tl.org;
  });

  const warning = missingProfiles.length
    ? `<div class="box" style="background:#fffbf0;border-color:#d9a72a;color:#7a5c1e;margin-bottom:8px;">
        ⚠ <strong>${missingProfiles.length} handoff(s)</strong> com perfil de raia incompleto na Seção 2.
        Classificados como "Mesma equipe" por padrão. Complete Equipe e Órgão para maior precisão.
       </div>`
    : `<div class="box" style="background:#f0faf4;border-color:#2e7d4f;color:#1a5c38;margin-bottom:8px;">
        ✅ Todos os handoffs classificados com base nos perfis das raias.
       </div>`;

  const rows = pairs.map((p) => {
    const rule = graph.handoffRules?.[p.key] || 'same_team';
    const info = typeInfo[rule] || typeInfo.same_team;
    return `<div class="handoff-auto-row" style="background:${info.bg};">
      <span class="haw-from">${escapeHtml(p.fromName)}</span>
      <span class="haw-arrow">→</span>
      <span class="haw-to">${escapeHtml(p.toName)}</span>
      <span class="haw-badge" style="color:${info.color};border-color:${info.color}44;">${info.label}</span>
      <span class="haw-penalty" style="color:${info.color};">${info.penalty}</span>
    </div>`;
  }).join('');

  box.innerHTML = `${warning}${rows}`;
}

function syncActorAssignmentsFromWizard() {
  if (!graph) return;
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  document.querySelectorAll('input[data-actor-node]').forEach((el) => {
    const nodeId = el.dataset.actorNode;
    const actor = String(el.value || '').trim();
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== 'task') return;
    node.executor = actor;
    node.lane = actor;
  });
}

function saveHandoffRulesFromWizard() {
  if (!graph) return;
  syncActorAssignmentsFromWizard();
  graph.handoffRules = graph.handoffRules || {};
  graph.handoffActionRules = graph.handoffActionRules || {};
  document.querySelectorAll('select[data-handoff-key]').forEach((el) => {
    const key = el.dataset.handoffKey;
    const val = String(el.value || '');
    if (val) graph.handoffRules[key] = val;
    else delete graph.handoffRules[key];
  });
  document.querySelectorAll('select[data-handoff-action-key]').forEach((el) => {
    const key = el.dataset.handoffActionKey;
    const val = String(el.value || '');
    if (val) graph.handoffActionRules[key] = val;
    else delete graph.handoffActionRules[key];
  });
  $('graphJson').value = JSON.stringify(graph, null, 2);
}

// Classifica automaticamente o tipo de handoff entre duas raias
// baseado nos perfis (equipe/órgão) armazenados em graph.lanes
function autoClassifyHandoff(fromLane, toLane) {
  const fm = graph.lanes?.[fromLane] || {};
  const tm = graph.lanes?.[toLane] || {};
  const fo = String(fm.org || '').trim().toLowerCase();
  const to_ = String(tm.org || '').trim().toLowerCase();
  const ft = String(fm.team || fromLane).trim().toLowerCase();
  const tt = String(tm.team || toLane).trim().toLowerCase();
  if (fo && to_ && fo !== to_) return 'different_org';
  if (ft !== tt) return 'different_team';
  return 'same_team';
}

// Aplica automaticamente as regras de handoff para todos os pares de raias
function autoApplyHandoffRulesFromLanes() {
  if (!graph) return;
  graph.handoffRules = graph.handoffRules || {};
  const pairs = crossLaneTransitions();
  for (const p of pairs) {
    graph.handoffRules[p.key] = autoClassifyHandoff(p.fromLane, p.toLane);
  }
}

// Salva atores + perfis de raia da Seção 2 para o graph
// Atribui complexidade padrão às tarefas que ainda não têm uma definida:
// primeira tarefa manual → 'alta' (20 UT); demais → 'media' (10 UT).
function autoAssignComplexityDefaults() {
  if (!graph) return;
  const tasks = (graph.nodes || []).filter((n) => n.type === 'task' && !n.automated);
  tasks.forEach((t, idx) => {
    if (!t.complexity) t.complexity = idx === 0 ? 'alta' : 'media';
  });
}

function saveSetupTaskMatrixFromForm() {
  if (!graph) return;
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  // Salva atores (data-task-actor)
  document.querySelectorAll('input[data-task-actor]').forEach((el) => {
    const nodeId = el.dataset.taskActor;
    const actor = String(el.value || '').trim();
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== 'task') return;
    node.executor = actor;
    node.lane = actor;
  });
  // Salva complexidade por tarefa (data-task-complexity)
  document.querySelectorAll('select[data-task-complexity]').forEach((el) => {
    const nodeId = el.dataset.taskComplexity;
    const comp = String(el.value || '').trim();
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== 'task') return;
    node.complexity = comp || null;
  });
  // Salva perfis de raia (data-lane-profile)
  graph.lanes = graph.lanes || {};
  document.querySelectorAll('[data-lane-profile]').forEach((row) => {
    const lane = row.dataset.laneProfile;
    const team = String(row.querySelector('[data-lp-team]')?.value || '').trim();
    const org  = String(row.querySelector('[data-lp-org]')?.value  || '').trim();
    graph.lanes[lane] = { ...(graph.lanes[lane] || {}), team, org };
  });
  autoApplyHandoffRulesFromLanes();
  $('graphJson').value = JSON.stringify(graph, null, 2);
}

// Renderiza apenas a sub-seção "Perfil das Raias" (não reconstrói o task matrix)
function renderSetupLaneProfiles() {
  const box = $('setupLaneProfiles');
  if (!box || !graph) return;
  const lanes = uniqueLanes();
  if (!lanes.length) {
    box.innerHTML = '<div style="font-size:12px;color:#5a7a9a;">Nenhuma raia encontrada. Defina os atores acima.</div>';
    return;
  }
  const focused = document.activeElement;
  const focusedLane = focused?.closest('[data-lane-profile]')?.dataset.laneProfile;
  const focusedField = focused?.dataset.lpTeam !== undefined ? 'team'
    : focused?.dataset.lpOrg !== undefined ? 'org' : null;

  const rows = lanes.map((lane) => {
    const profile = graph.lanes?.[lane] || {};
    const displayName = detectLaneName(lane);
    return `<div class="lp-row" data-lane-profile="${escapeHtml(lane)}">
      <span class="lp-raia" title="${escapeHtml(lane)}">${escapeHtml(displayName)}</span>
      <input type="text" data-lp-team placeholder="Equipe (ex: Protocolo)" value="${escapeHtml(profile.team || '')}" />
      <input type="text" data-lp-org  placeholder="Órgão (ex: SEFAZ)"    value="${escapeHtml(profile.org  || '')}" />
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="lp-head">
      <span>Raia / Ator</span>
      <span>Equipe</span>
      <span>Órgão / Unidade</span>
    </div>
    ${rows}`;

  // Restaura foco se estava num campo desta seção
  if (focusedLane && focusedField) {
    const newRow = box.querySelector(`[data-lane-profile="${CSS.escape(focusedLane)}"]`);
    if (newRow) {
      const attr = focusedField === 'team' ? '[data-lp-team]' : '[data-lp-org]';
      newRow.querySelector(attr)?.focus();
    }
  }
}

function syncSetupInputsToMain() {
  const setupPath = $('setupHappyPath');
  const setupLead = $('setupLeadTime');
  const setupTPE  = $('setupProcessingTime');
  if (setupPath && $('happyPath'))              $('happyPath').value              = setupPath.value;
  if (setupLead && $('leadTimeInformed'))       $('leadTimeInformed').value       = setupLead.value;
  if (setupTPE  && $('processingTimeInformed')) $('processingTimeInformed').value = setupTPE.value;
}

function syncMainInputsToSetup() {
  const setupPath = $('setupHappyPath');
  const setupLead = $('setupLeadTime');
  const setupTPE  = $('setupProcessingTime');
  if (setupPath && $('happyPath'))              setupPath.value = $('happyPath').value;
  if (setupLead && $('leadTimeInformed'))       setupLead.value = $('leadTimeInformed').value;
  if (setupTPE  && $('processingTimeInformed')) setupTPE.value  = $('processingTimeInformed').value;
}

function isHandoffReadyLocal() {
  if (!graph) return false;
  const transitions = crossLaneTransitions();
  if (!transitions.length) return true; // Sem transições = sem handoffs = OK

  // Auto-aplica se ainda não aplicado
  autoApplyHandoffRulesFromLanes();

  // Verifica se todas as transições têm uma regra definida
  for (const t of transitions) {
    const v = String(graph?.handoffRules?.[t.key] || '');
    if (!['same_team', 'different_team', 'different_org'].includes(v)) return false;
  }
  return true;
}

function collectSetupStatus() {
  const status = {
    graphOk: false,
    handoffOk: false,
    happyPathOk: false,
    leadTimeOk: false,
    graphIssues: [],
  };

  syncSetupInputsToMain();
  if (!parseEditorGraph()) return status;

  const integ = validateGraphIntegrity(graph);
  const probs = validateProbabilities(graph);
  status.graphOk = !integ.errors.length && !probs.length;
  status.graphIssues = [...integ.errors, ...probs];
  status.handoffOk = isHandoffReadyLocal();

  try {
    parseHappyPathRequired();
    status.happyPathOk = true;
  } catch (e) {
    /* preserva estado de erro para inspecao */
    status.happyPathOk = false;
  }

  try {
    parseLeadTimeInformedRequired();
    status.leadTimeOk = true;
  } catch (e) {
    /* preserva estado de erro para inspecao */
    status.leadTimeOk = false;
  }

  return status;
}

// ─── Seção 0: Escolha do Processo (Arquitetura de Processos) ──────────────────

function requestProcessListFromSiga() {
  try {
    globalThis.parent.postMessage({ type: 'SIMULATOR_REQUEST_PROCESS_LIST' }, globalThis.location.origin);
  } catch (e) { console.warn('[simulator] postMessage para parent (standalone)', e); }
}

// Cache das linhas filtradas para o handler de clique (evita closure stale)
let _sec0Filtered = [];
let _sidebarGwInputHandler = null;
let _sidebarGwClickHandler = null;
let _sidebarGwVersion = '';

// Atualiza APENAS o <tbody> e o contador — nunca toca no <input>, preservando o foco
function _sec0UpdateTable() {
  const list = _sigaProcessList || [];
  const search = ($('sec0Search')?.value || '').toLowerCase().trim();

  _sec0Filtered = list.filter((p) => {
    if (!search) return true;
    const hay = `${p.macroprocesso || ''} ${p.processo || ''} ${p.subprocesso || ''} ${p.area || ''}`.toLowerCase();
    return hay.includes(search);
  });

  const tbody = $('sec0Tbody');
  if (!tbody) return;

  tbody.innerHTML = _sec0Filtered.slice(0, 100).map((p, i) => {
    const isLinked = _linkedProcess
      && _linkedProcess.processo      === p.processo
      && _linkedProcess.macroprocesso === p.macroprocesso
      && (_linkedProcess.subprocesso || '') === (p.subprocesso || '');
    return `<tr class="sec0-row${isLinked ? ' sec0-row-selected' : ''}" data-sec0-idx="${i}">
      <td class="sec0-td-macro">${escapeHtml(p.macroprocesso || '')}</td>
      <td class="sec0-td-proc"><strong>${escapeHtml(p.processo || '')}</strong>${p.subprocesso ? `<br><small class="sec0-sub">${escapeHtml(p.subprocesso)}</small>` : ''}</td>
      <td class="sec0-td-nat">${escapeHtml(p.natureza || '')}</td>
      <td class="sec0-td-area">${escapeHtml(p.area || '')}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="sec0-empty">Nenhum processo encontrado.</td></tr>';

  const counter = $('sec0Counter');
  if (counter) {
    counter.textContent = search
      ? `${_sec0Filtered.length} resultado(s) para "${search}"`
      : `${list.length} processo(s)`;
  }
}

// Reconstrói a ESTRUTURA (badge + campo de busca + tabela shell).
// Chamado apenas quando os dados mudam (_sigaProcessList ou _linkedProcess).
function renderSetupSection0() {
  const box = $('setupSection0');
  if (!box) return;

  const list = _sigaProcessList || [];

  // ── Modo sem lista (standalone) ──────────────────────────────────
  if (!list.length) {
    // Só reconstrói se ainda não estiver no modo manual (evita perder foco)
    if (!box.querySelector('#linkedProcessName')) {
      box.innerHTML = `
        <div id="sec0Badge"></div>
        <div class="sec0-manual-form">
          <strong style="color:#0d2236;">Identifique o processo sendo simulado:</strong>
          <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
            <input id="linkedProcessName"   type="text" placeholder="Nome do processo"
              style="flex:2;min-width:160px;" value="${escapeHtml(_linkedProcess?.processo||'')}" />
            <input id="linkedMacroName"     type="text" placeholder="Macroprocesso"
              style="flex:1;min-width:120px;" value="${escapeHtml(_linkedProcess?.macroprocesso||'')}" />
            <input id="linkedProcessArea"   type="text" placeholder="Área/Setor"
              style="flex:1;min-width:120px;" value="${escapeHtml(_linkedProcess?.area||'')}" />
            <button id="btnLinkProcessManual" type="button">Vincular</button>
          </div>
          <p style="font-size:12px;color:#3d546d;margin:8px 0 0;">
            Lista de processos não disponível (simulador fora do SIGA). Preencha manualmente.
          </p>
        </div>`;

      $('btnLinkProcessManual')?.addEventListener('click', () => {
        _linkedProcess = {
          processo:      String($('linkedProcessName')?.value || '').trim(),
          macroprocesso: String($('linkedMacroName')?.value  || '').trim(),
          area:          String($('linkedProcessArea')?.value || '').trim(),
          natureza: '',
          subprocesso: '',
        };
        _sec0RefreshBadge();
        renderSetupChecklist();
      });
    } else {
      // Já existe — só atualiza o badge
      _sec0RefreshBadge();
    }
    return;
  }

  // ── Modo com lista (dentro do SIGA) ──────────────────────────────
  // Só cria a estrutura uma vez; nas chamadas seguintes apenas atualiza badge + tabela
  if (!box.querySelector('#sec0Search')) {
    box.innerHTML = `
      <div id="sec0Badge"></div>
      <div style="margin:10px 0 8px;display:flex;gap:8px;align-items:center;">
        <input id="sec0Search" type="text" placeholder="🔍 Buscar processo…"
          autocomplete="off" spellcheck="false"
          style="flex:1;background:#ffffff;color:#0d2236;border:1.5px solid rgba(60,110,180,0.45);
                 border-radius:8px;padding:8px 12px;font-size:13px;outline:none;" />
        <span id="sec0Counter" style="font-size:12px;color:#3d546d;white-space:nowrap;font-weight:500;"></span>
      </div>
      <div class="sec0-table-wrap">
        <table class="sec0-table">
          <thead><tr>
            <th>Macroprocesso</th><th>Processo</th><th>Natureza</th><th>Área</th>
          </tr></thead>
          <tbody id="sec0Tbody"></tbody>
        </table>
      </div>`;

    // Wiring feito UMA ÚNICA VEZ — nunca mais destrói o input
    $('sec0Search')?.addEventListener('input', _sec0UpdateTable);

    // Clique nas linhas via event delegation no tbody
    $('sec0Tbody')?.addEventListener('click', (ev) => {
      const tr = ev.target.closest('tr[data-sec0-idx]');
      if (!tr) return;
      const idx = Number(tr.dataset.sec0Idx);
      if (!Number.isFinite(idx) || !_sec0Filtered[idx]) return;
      _linkedProcess = { ..._sec0Filtered[idx] };
      _sec0UpdateTable();   // atualiza highlight sem recriar o input
      _sec0RefreshBadge();
      renderSetupChecklist();
    });
  }

  // Atualiza badge e tabela (dados podem ter chegado agora)
  _sec0RefreshBadge();
  _sec0UpdateTable();
}

// Atualiza apenas o badge de processo vinculado (não toca no input)
function _sec0RefreshBadge() {
  const badge = $('sec0Badge');
  if (!badge) return;
  if (_linkedProcess?.processo) {
    badge.innerHTML = `
      <div class="linked-process-badge">
        ✅ <strong>${escapeHtml(_linkedProcess.processo)}</strong>
        <span>${escapeHtml(_linkedProcess.macroprocesso || '')}</span>
        <button id="btnClearLinkedProcess" type="button">Alterar</button>
      </div>`;
    $('btnClearLinkedProcess')?.addEventListener('click', () => {
      _linkedProcess = null;
      _sec0RefreshBadge();
      _sec0UpdateTable();
      renderSetupChecklist();
    });
  } else {
    badge.innerHTML = '';
  }
}

function renderSetupChecklist() {
  const box = $('setupChecklist');
  if (!box) return;
  const s = collectSetupStatus();
  const line = (ok, text) => `${ok ? 'OK' : 'PENDENTE'} - ${text}`;
  box.textContent = [
    line(s.graphOk, 'Modelo valido (integridade + probabilidades).'),
    line(s.handoffOk, 'Handoffs entre atores mapeados.'),
    line(s.happyPathOk, 'Caminho feliz selecionado por cliques e consistente.'),
    line(true, 'Lead time informado pelo executor e opcional.'),
    ...(!s.graphOk && s.graphIssues.length ? [`Detalhe: ${s.graphIssues[0]}`] : []),
  ].join('\n');
}

function renderSetupTaskMatrix() {
  const box = $('setupTaskMatrix');
  if (!box) return;
  if (!graph) {
    box.textContent = 'Carregue um processo para editar atividades.';
    return;
  }

  const tasks = (graph.nodes || []).filter((n) => n.type === 'task');
  if (!tasks.length) {
    box.textContent = 'Nao ha tarefas no fluxo atual.';
    return;
  }

  // Garante defaults de complexidade antes de renderizar
  autoAssignComplexityDefaults();

  const COMP_LABELS = {
    baixa:   { label: '⬇ Baixa',   ut: 5,  color: '#2e7d4f', bg: '#e8f5ee' },
    media:   { label: '▶ Média',   ut: 10, color: '#8a6d3b', bg: '#fff8e8' },
    alta:    { label: '⬆ Alta',    ut: 20, color: '#c06000', bg: '#fff3e0' },
    extrema: { label: '🔴 Extrema', ut: 40, color: '#8f3d3a', bg: '#fde8e8' },
  };

  const suggestedSet = new Set(suggestedAutomationNodeIds());
  const rows = tasks.map((t, idx) => {
    const actor = actorLaneIdOf(t);
    const autoChecked = t.automated ? 'checked' : '';
    const potentialChecked = (!t.automated && confirmedAutoNodes.has(t.id)) ? 'checked' : '';
    const potentialDisabled = t.automated ? 'disabled' : '';
    const suggestionBadge = suggestedSet.has(t.id)
      ? '<span class="badge auto">sugerida</span>'
      : '<span class="badge" style="background:#6b7c90;">manual</span>';

    // Complexidade: desabilitada para tarefas automatizadas
    const comp = t.complexity || (idx === 0 ? 'alta' : 'media');
    const compSelect = t.automated
      ? `<span class="comp-badge" style="background:#e0e8e0;color:#4a7060;">⚙ Auto — ${RULES.automated} UT</span>`
      : `<select class="comp-select comp-${comp}" data-task-complexity="${escapeHtml(t.id)}" title="Complexidade da atividade">
          ${Object.entries(COMP_LABELS).map(([k, v]) =>
            `<option value="${k}" ${comp === k ? 'selected' : ''}>${v.label} — ${v.ut} UT</option>`
          ).join('')}
        </select>`;

    return `
      <div class="task-matrix-row">
        <div class="task-col task-name"><strong>${idx + 1}. ${escapeHtml(t.label || t.id)}</strong><small>${escapeHtml(t.id)}</small></div>
        <div class="task-col"><input type="text" data-task-actor="${escapeHtml(t.id)}" value="${escapeHtml(actor)}" placeholder="Ator/raia" /></div>
        <div class="task-col task-comp">${compSelect}</div>
        <label class="task-col task-check"><input type="checkbox" data-task-automated="${escapeHtml(t.id)}" ${autoChecked}> <span>Automatica</span></label>
        <label class="task-col task-check"><input type="checkbox" data-task-potential="${escapeHtml(t.id)}" ${potentialChecked} ${potentialDisabled}> <span>Automatizavel</span> ${suggestionBadge}</label>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div class="task-matrix-head">
      <span>Atividade</span>
      <span>Ator/Raia</span>
      <span>Complexidade (UT)</span>
      <span>Status atual</span>
      <span>Cenario auto</span>
    </div>
    <div class="task-matrix-body">${rows}</div>
    <div class="box" style="margin-top:8px;font-size:12px;">
      <strong>Complexidade</strong> define o custo base de cada atividade manual:
      Baixa 5 UT · Média 10 UT · Alta 20 UT · Extrema 40 UT.
      Isso impacta diretamente o T.E.R. e a velocidade das partículas na simulação.
    </div>
    <div class="lp-section">
      <div class="lp-title">Perfil das Raias — Equipe e Órgão</div>
      <div class="box lp-hint">Informe a equipe e o órgão de cada ator para que o sistema classifique os handoffs automaticamente. Raias com o mesmo órgão e equipe = sem atrito extra.</div>
      <div id="setupLaneProfiles"></div>
    </div>`;
  renderSetupLaneProfiles();
}

function renderSetupGatewayEditor() {
  const box = $('setupGatewayEditor');
  if (!box) return;
  if (!graph) {
    box.textContent = 'Carregue um processo para ajustar gateways.';
    return;
  }

  const gateways = (graph.nodes || []).filter((n) => n.type === 'gateway');
  if (!gateways.length) {
    box.textContent = 'Nao ha gateways no fluxo atual.';
    return;
  }

  const html = gateways.map((gw) => {
    const outs = outgoing(graph, gw.id);
    if (!outs.length) return `<div class="box"><strong>${escapeHtml(gw.label || gw.id)}</strong><div>Sem saidas.</div></div>`;
    const sum = outs.reduce((acc, e) => acc + Number(e.probability || 0), 0);
    const rows = outs.map((e) => {
      const targetNode = nodeById(e.to);
      const targetLabel = targetNode?.label || targetNode?.id || e.to;
      // Rótulo do caminho: prioriza label da aresta, depois label do nó destino
      const edgeLabel = e.label ? escapeHtml(e.label) : escapeHtml(targetLabel);
      const pct = Number(e.probability || 0);
      const barColor = pct >= 70 ? '#2e7d4f' : pct >= 30 ? '#8a6d3b' : '#8f3d3a';
      return `
      <label class="field gw-path-row" style="margin-bottom:6px;">
        <span class="gw-path-label">
          <span class="gw-path-arrow">→</span> ${edgeLabel}
          <span class="gw-path-target" style="color:#9fb0c5;font-size:11px;">(${escapeHtml(targetLabel)})</span>
        </span>
        <div style="display:flex;gap:6px;align-items:center;">
          <input type="number" min="0" max="100" step="1" data-setup-gw="${escapeHtml(gw.id)}" data-setup-edge="${escapeHtml(e.id)}" value="${pct}" style="width:80px;" />
          <span style="font-size:12px;color:#9fb0c5;">%</span>
          <div class="gw-prob-bar"><div class="gw-prob-fill" style="width:${pct}%;background:${barColor};"></div></div>
        </div>
      </label>`;
    }).join('');
    return `
      <div class="box" style="margin-bottom:8px;">
        <strong>${escapeHtml(gw.label || gw.id)}</strong>
        <div style="font-size:12px;margin:4px 0 6px;">Soma atual: ${sum.toFixed(2)}%</div>
        ${rows}
      </div>`;
  }).join('');

  box.innerHTML = `${html}
    <div class="row" style="margin-top:8px;">
      <button id="btnSetupApplyGateway" type="button">Aplicar ajustes de gateways</button>
      <button id="btnSetupAutoGateway" type="button">Auto corrigir todos para 100%</button>
    </div>`;
}

function applySetupGatewayEdits() {
  if (!graph) return;
  const byGateway = new Map();
  document.querySelectorAll('input[data-setup-gw][data-setup-edge]').forEach((input) => {
    const gw = String(input.dataset.setupGw || '');
    const edgeId = String(input.dataset.setupEdge || '');
    const val = Math.max(0, Number(input.value || 0));
    if (!byGateway.has(gw)) byGateway.set(gw, {});
    byGateway.get(gw)[edgeId] = val;
  });

  for (const [gwId, probs] of byGateway.entries()) {
    graph = applyGatewayProbabilities(graph, gwId, probs);
  }

  $('graphJson').value = JSON.stringify(graph, null, 2);
  refreshAll();
}

// ═══════════════════════════════════════════════════════════════════
// SIDEBAR GATEWAY PROBABILITY EDITOR
// ═══════════════════════════════════════════════════════════════════

function renderSidebarGatewayEditor() {
  const box = $('sidebarGatewayBox');
  if (!box) return;
  if (!graph) {
    box.innerHTML = '<div class="sgw-empty">Carregue um processo para ver os gateways.</div>';
    _sidebarGwVersion = '';
    return;
  }

  const gateways = (graph.nodes || []).filter((n) => n.type === 'gateway' && outgoing(graph, n.id).length > 0);
  if (!gateways.length) {
    box.innerHTML = '<div class="sgw-empty">Nenhum gateway no fluxo atual.</div>';
    _sidebarGwVersion = '';
    return;
  }

  const currentVersion = gateways.map((g) => g.id + ':' + outgoing(graph, g.id).map((e) => e.id).join(',')).join('|');

  if (box.dataset.gwVersion === currentVersion) {
    _refreshSidebarGwValues();
    return;
  }

  box.dataset.gwVersion = currentVersion;

  if (_sidebarGwInputHandler) box.removeEventListener('input', _sidebarGwInputHandler);
  if (_sidebarGwClickHandler) box.removeEventListener('click', _sidebarGwClickHandler);

  const html = gateways.map((gw) => {
    const outs = outgoing(graph, gw.id);
    const sum = outs.reduce((a, e) => a + Number(e.probability || 0), 0);
    const sumColor = Math.abs(sum - 100) < 0.5 ? '#2e7d4f' : sum > 100 ? '#c0392b' : '#8a6d3b';
    const rows = outs.map((e) => {
      const targetNode = nodeById(e.to);
      const targetLabel = targetNode?.label || targetNode?.id || e.to;
      const edgeLabel = e.label ? escapeHtml(e.label) : escapeHtml(targetLabel);
      const pct = Number(e.probability || 0);
      return `<div class="sgw-row">
        <span class="sgw-label">→ ${edgeLabel}</span>
        <div class="sgw-input-wrap">
          <input type="number" min="0" max="100" step="1" class="sgw-input"
            data-sgw-id="${escapeHtml(gw.id)}" data-sgw-edge="${escapeHtml(e.id)}" value="${pct}" />
          <span class="sgw-pct">%</span>
        </div>
      </div>`;
    }).join('');
    return `<div class="sgw-gateway" data-sgw-gw="${escapeHtml(gw.id)}">
      <div class="sgw-gw-header">
        <span class="sgw-gw-name">◆ ${escapeHtml(gw.label || gw.id)}</span>
        <button class="sgw-auto-btn" data-sgw-auto="${escapeHtml(gw.id)}" type="button">⚖ Auto</button>
      </div>
      ${rows}
      <div class="sgw-sum" data-sgw-sum="${escapeHtml(gw.id)}" style="color:${sumColor};">Soma: ${sum.toFixed(0)}%${Math.abs(sum - 100) > 0.5 ? (sum > 100 ? ' ⚠ excede 100%' : ' ⚠ abaixo de 100%') : ' ✓'}</div>
    </div>`;
  }).join('');

  box.innerHTML = html;

  _sidebarGwInputHandler = _onSidebarGwInput;
  _sidebarGwClickHandler = _onSidebarGwClick;
  box.addEventListener('input', _sidebarGwInputHandler);
  box.addEventListener('click', _sidebarGwClickHandler);
}

function _refreshSidebarGwValues() {
  if (!graph) return;
  const focused = document.activeElement;
  document.querySelectorAll('input[data-sgw-id][data-sgw-edge]').forEach((inp) => {
    if (inp === focused) return;
    const edgeId = inp.dataset.sgwEdge;
    const edge = (graph.edges || []).find((e) => e.id === edgeId);
    if (edge) inp.value = String(Number(edge.probability || 0));
  });
  document.querySelectorAll('[data-sgw-sum]').forEach((el) => {
    const gwId = el.dataset.sgwSum;
    const outs = outgoing(graph, gwId);
    const sum = outs.reduce((a, e) => a + Number(e.probability || 0), 0);
    const sumColor = Math.abs(sum - 100) < 0.5 ? '#2e7d4f' : sum > 100 ? '#c0392b' : '#8a6d3b';
    el.style.color = sumColor;
    el.textContent = `Soma: ${sum.toFixed(0)}%${Math.abs(sum - 100) > 0.5 ? (sum > 100 ? ' ⚠ excede 100%' : ' ⚠ abaixo de 100%') : ' ✓'}`;
  });
}

function _onSidebarGwInput(ev) {
  const inp = ev.target.closest('input[data-sgw-id]');
  if (!inp || !graph) return;

  const gwId = inp.dataset.sgwId;

  // Cap: prevent sum > 100%
  const allInputs = Array.from(document.querySelectorAll(`input[data-sgw-id="${CSS.escape(gwId)}"]`));
  const sumOthers = allInputs
    .filter((i) => i !== inp)
    .reduce((a, i) => a + Math.max(0, Number(i.value || 0)), 0);
  const maxAllowed = Math.max(0, 100 - sumOthers);
  if (Number(inp.value) > maxAllowed) inp.value = String(maxAllowed);

  // Apply to graph silently (no refreshAll — avoids losing focus)
  const probs = {};
  allInputs.forEach((i) => { probs[i.dataset.sgwEdge] = Math.max(0, Number(i.value || 0)); });
  graph = applyGatewayProbabilities(graph, gwId, probs);
  if ($('graphJson')) $('graphJson').value = JSON.stringify(graph, null, 2);

  // Only update sum display — no full re-render
  const sumEl = document.querySelector(`[data-sgw-sum="${CSS.escape(gwId)}"]`);
  if (sumEl) {
    const sum = Object.values(probs).reduce((a, v) => a + v, 0);
    const sumColor = Math.abs(sum - 100) < 0.5 ? '#2e7d4f' : sum > 100 ? '#c0392b' : '#8a6d3b';
    sumEl.style.color = sumColor;
    sumEl.textContent = `Soma: ${sum.toFixed(0)}%${Math.abs(sum - 100) > 0.5 ? (sum > 100 ? ' ⚠ excede 100%' : ' ⚠ abaixo de 100%') : ' ✓'}`;
  }
}

function _onSidebarGwClick(ev) {
  const btn = ev.target.closest('button[data-sgw-auto]');
  if (!btn || !graph) return;
  const gwId = btn.dataset.sgwAuto;
  const outs = outgoing(graph, gwId);
  if (!outs.length) return;
  const autoMap = defaultGatewayProbMap(outs.map((e) => ({ ...e, probability: 0 })));
  const inputs = document.querySelectorAll(`input[data-sgw-id="${CSS.escape(gwId)}"]`);
  const probs = {};
  inputs.forEach((i) => {
    const edgeId = i.dataset.sgwEdge;
    const v = Number(autoMap[edgeId] || 0);
    i.value = String(v);
    probs[edgeId] = v;
  });
  graph = applyGatewayProbabilities(graph, gwId, probs);
  if ($('graphJson')) $('graphJson').value = JSON.stringify(graph, null, 2);
  _refreshSidebarGwValues();
  drawGraph();
}

function renderSetupAutomationEditor() {
  const box = $('setupAutomationEditor');
  if (!box) return;
  box.innerHTML = '<div class="box">As automacoes foram consolidadas na matriz de atividades para evitar repeticao.</div>';
}

function renderSetupLoopEditor() {
  const box = $('setupLoopEditor');
  if (!box) return;
  if (!graph) {
    box.textContent = 'Carregue um processo para configurar loops.';
    return;
  }

  const gateways = (graph.nodes || []).filter((n) => n.type === 'gateway');
  const allNodes = (graph.nodes || []).filter((n) => n.type === 'task' || n.type === 'gateway');

  if (!gateways.length) {
    box.innerHTML = '<div class="box">Nenhum gateway encontrado. Adicione um gateway ao fluxo para configurar loops.</div>';
    return;
  }

  const gwOptions = gateways.map((g) => `<option value="${g.id}">${escapeHtml(g.label || g.id)}</option>`).join('');
  const nodeOptions = allNodes.map((n) => `<option value="${n.id}">${escapeHtml(n.label || n.id)}</option>`).join('');

  const loopEdges = (graph.edges || []).filter((e) => e.isLoopReturn);
  const list = loopEdges.length
    ? loopEdges.map((e) => {
        const from = nodeById(e.from);
        const to   = nodeById(e.to);
        const gwOuts = outgoing(graph, e.from);
        const sum    = gwOuts.reduce((a, x) => a + Number(x.probability || 0), 0);
        return `
        <div class="loop-row">
          <div class="loop-row-info">
            <span class="loop-gw-name">🔀 ${escapeHtml(from?.label || e.from)}</span>
            <span class="loop-arrow">→ retorna para →</span>
            <span class="loop-target-name">📋 ${escapeHtml(to?.label || e.to)}</span>
          </div>
          <div class="loop-row-controls">
            <label style="font-size:12px;">Prob. loop
              <input type="number" min="1" max="99" step="1"
                value="${Number(e.probability || 30)}"
                data-loop-prob-edge="${e.id}"
                style="width:72px;" />%
            </label>
            <span class="loop-sum-hint" style="font-size:11px;color:#9fb0c5;">
              Soma saídas: ${sum.toFixed(0)}%
            </span>
            <button type="button" data-loop-remove-edge="${e.id}">Remover</button>
          </div>
        </div>`;
      }).join('')
    : '<div class="box">Nenhum loop configurado.</div>';

  box.innerHTML = `
    <div class="box" style="margin-bottom:10px;font-size:13px;">
      Defina o <strong>gateway de decisão</strong> onde pode ocorrer o retrabalho e a <strong>ação de retorno</strong>.
      A probabilidade do loop será integrada automaticamente com as probabilidades do gateway selecionado.
    </div>
    <div class="loop-form">
      <label class="field" style="flex:1;min-width:180px;">
        <span>Gateway de origem (decisão de retrabalho)</span>
        <select id="setupLoopFrom">${gwOptions}</select>
      </label>
      <label class="field" style="flex:1;min-width:180px;">
        <span>Ação de retorno (para onde volta)</span>
        <select id="setupLoopTo">${nodeOptions}</select>
      </label>
      <label class="field" style="width:120px;">
        <span>Prob. loop (%)</span>
        <input id="setupLoopProb" type="number" min="1" max="99" step="1" value="30" />
      </label>
      <button id="btnSetupAddLoop" type="button" style="align-self:flex-end;">Adicionar Loop</button>
    </div>
    <div style="margin-top:12px;"><strong>Loops configurados:</strong></div>
    ${list}
    <div class="row" style="margin-top:8px;">
      <button id="btnSetupApplyLoopProb" type="button">Aplicar Probabilidades</button>
    </div>`;
}

function addOrUpdateLoopEdge(fromId, toId, probPercent) {
  if (!graph) return;
  const from = nodeById(fromId);
  const to = nodeById(toId);
  if (!from || !to) return;

  let edge = (graph.edges || []).find((e) => e.from === fromId && e.to === toId);
  if (!edge) {
    const id = `manual_loop_${fromId}_${toId}_${Date.now()}`;
    edge = { id, from: fromId, to: toId, probability: Number(probPercent || 30), isLoopReturn: true, isErrorPath: false };
    graph.edges.push(edge);
  }

  edge.isLoopReturn = true;
  edge.isErrorPath = false;
  rebalanceOutgoingFromNode(fromId, edge.id, probPercent);
}

function removeLoopEdge(edgeId) {
  if (!graph) return;
  const e = (graph.edges || []).find((x) => x.id === edgeId);
  if (!e) return;

  const fromId = e.from;
  const isManual = String(e.id || '').startsWith('manual_loop_');
  if (isManual) {
    graph.edges = (graph.edges || []).filter((x) => x.id !== edgeId);
  } else {
    e.isLoopReturn = false;
  }

  const outs = outgoing(graph, fromId);
  if (outs.length) {
    const map = normalizedGatewayProbMap(outs);
    graph = applyGatewayProbabilities(graph, fromId, map);
  }
}

function applyLoopProbInputs() {
  if (!graph) return;
  document.querySelectorAll('input[data-loop-prob-edge]').forEach((input) => {
    const edgeId = String(input.dataset.loopProbEdge || '');
    const val = clamp(Number(input.value || 30), 1, 99);
    const edge = (graph.edges || []).find((e) => e.id === edgeId);
    if (!edge) return;
    rebalanceOutgoingFromNode(edge.from, edge.id, val);
  });
}

function saveSetupAutomationSelection() {
  if (!graph) return;

  const matrixActorInputs = document.querySelectorAll('input[data-task-actor]');
  const matrixAutoInputs = document.querySelectorAll('input[data-task-automated]');
  const matrixPotentialInputs = document.querySelectorAll('input[data-task-potential]');
  if (matrixActorInputs.length || matrixAutoInputs.length || matrixPotentialInputs.length) {
    const taskMap = new Map((graph.nodes || []).filter((n) => n.type === 'task').map((n) => [String(n.id), n]));

    matrixActorInputs.forEach((i) => {
      const id = String(i.dataset.taskActor || '');
      const n = taskMap.get(id);
      if (!n) return;
      const actor = String(i.value || '').trim();
      n.executor = actor;
      n.lane = actor;
    });

    const selectedAuto = new Set(
      Array.from(matrixAutoInputs)
        .filter((i) => i.checked)
        .map((i) => String(i.dataset.taskAutomated || ''))
        .filter(Boolean)
    );
    for (const n of graph.nodes || []) {
      if (n.type !== 'task') continue;
      n.automated = selectedAuto.has(String(n.id || ''));
    }

    const selectedPotential = new Set(
      Array.from(matrixPotentialInputs)
        .filter((i) => i.checked)
        .map((i) => String(i.dataset.taskPotential || ''))
        .filter(Boolean)
    );

    // Regra de exclusao mutua: automatica e automatizavel nao coexistem na mesma atividade.
    for (const id of [...selectedPotential]) {
      if (selectedAuto.has(id)) selectedPotential.delete(id);
    }
    confirmedAutoNodes = selectedPotential;
    $('graphJson').value = JSON.stringify(graph, null, 2);
    return;
  }

  const selected = new Set(
    Array.from(document.querySelectorAll('input[data-setup-auto-node]:checked'))
      .map((i) => String(i.dataset.setupAutoNode || ''))
      .filter(Boolean)
  );

  for (const n of graph.nodes || []) {
    if (n.type !== 'task') continue;
    n.automated = selected.has(String(n.id || ''));
  }
  $('graphJson').value = JSON.stringify(graph, null, 2);
}

function openSetupModal() {
  syncMainInputsToSetup();
  // Auto-iguala probabilidades de gateways que ainda não têm distribuição válida
  if (graph) autoFixGatewayProbabilitiesInGraph();
  if (graph) autoApplyHandoffRulesFromLanes();
  $('setupModal')?.classList.remove('hidden');
  renderSetupSection0();
  requestProcessListFromSiga();
  renderSetupTaskMatrix();
  renderHandoffWizard();
  renderSetupPathPicker();
  renderSetupGatewayEditor();
  renderSetupLoopEditor();
  renderSetupChecklist();
}

function closeSetupModal() {
  $('setupModal')?.classList.add('hidden');
}

function completeSetup() {
  syncSetupInputsToMain();
  saveSetupAutomationSelection();
  applyLoopProbInputs();
  const fixedGateways = autoFixGatewayProbabilitiesInGraph();
  saveHandoffRulesFromWizard();
  if (fixedGateways > 0) {
    $('graphJson').value = JSON.stringify(graph, null, 2);
  }
  renderSetupChecklist();
  const s = collectSetupStatus();
  const ready = s.graphOk && s.handoffOk && s.happyPathOk;
  if (!ready) {
    const reason = !s.graphOk && s.graphIssues.length
      ? ` Motivo: ${escapeHtml(s.graphIssues[0])}`
      : '';
    $('validationBox').innerHTML = `<span class="badge error">setup</span> Finalize os itens pendentes no popup para iniciar a simulacao.${reason}`;
    return;
  }
  setupCompleted = true;
  if (fixedGateways > 0) {
    $('validationBox').innerHTML = `<span class="badge auto">gateway</span> ${fixedGateways} gateway(s) foram auto-corrigidos para fechar em 100%.`;
  }
  closeSetupModal();
}

function revealDashboard() {
  const section = $('dashboardSection');
  if (!section) return;
  section.classList.remove('hidden');
  // Garante que o dashboard usa o TER das partículas animadas (_animatedTer)
  if (graph) updateDashboard();
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function parseHappyPathRequired() {
  const text = $('happyPath').value;
  if (!String(text || '').trim()) {
    throw new Error('Para cenario ideal, o caminho feliz e obrigatorio.');
  }
  return parseHappyPath(text);
}

function parseLeadTimeInformedRequired() {
  const raw = String($('leadTimeInformed')?.value || '').trim();
  if (!raw) return null;
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) {
    throw new Error('Se informado, o T.P. deve ser maior que zero.');
  }
  // Converter para minutos conforme unidade selecionada
  const unit = String($('tpUnit')?.value || 'min');
  if (unit === 'h') return val * 60;
  if (unit === 'dias') return val * 60 * 8; // 1 dia util = 8h
  return val; // minutos
}

function parseProcessingTimeInformed() {
  const raw = String($('processingTimeInformed')?.value || '').trim();
  if (!raw) return null;
  const val = Number(raw);
  if (!Number.isFinite(val) || val <= 0) return null;
  const unit = String($('tpeUnit')?.value || 'min');
  if (unit === 'h') return val * 60;
  if (unit === 'dias') return val * 60 * 8;
  return val; // minutos
}

function pct(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
  return (part / total) * 100;
}

function phillipEfficiency(actualTime, idealTime) {
  if (!Number.isFinite(actualTime) || !Number.isFinite(idealTime) || actualTime <= 0 || idealTime <= 0) return 0;
  return Math.max(0, Math.min(100, (idealTime / actualTime) * 100));
}

function computeInsightIndices(metrics, base) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const ranking = metrics?.ranking || base?.ranking || [];

  const totalFriction = ranking.reduce((acc, r) => acc + Number(r.total || 0), 0);
  const top3 = ranking.slice(0, 3).reduce((acc, r) => acc + Number(r.total || 0), 0);

  const potentialAuto = suggestedAutomationNodeIds();
  const potentialSet = new Set(potentialAuto);
  const confirmedPotentialCount = [...confirmedAutoNodes].filter((id) => potentialSet.has(id)).length;
  const manualTasks = nodes.filter((n) => n.type === 'task' && !n.automated);

  const taskById = new Map(nodes.map((n) => [n.id, n]));
  const manualTransitions = deriveTaskTransitions().filter((t) => {
    const from = taskById.get(t.fromId);
    const to = taskById.get(t.toId);
    return from?.type === 'task' && to?.type === 'task' && !from.automated && !to.automated;
  });

  const laneTransitions = manualTransitions.filter((t) => {
    const from = taskById.get(t.fromId);
    const to = taskById.get(t.toId);
    const fromLane = actorLaneIdOf(from);
    const toLane = actorLaneIdOf(to);
    return fromLane && toLane && fromLane !== toLane;
  });

  const loopEdges = edges.filter((e) => e.isLoopReturn);
  const avgLoopProb = loopEdges.length
    ? loopEdges.reduce((acc, e) => acc + Number(e.probability || 0), 0) / loopEdges.length
    : 0;

  return {
    estimatedWastePercent: metrics ? pct(metrics.tepReal - metrics.tepIdeal, metrics.tepReal) : null,
    informedWastePercent: (metrics && Number.isFinite(metrics.leadTimeInformed))
      ? pct(metrics.leadTimeInformed - metrics.leadIdeal, metrics.leadTimeInformed)
      : null,
    autoOpportunityPercent: metrics ? pct(metrics.tepIdeal - metrics.tepIdealAuto, metrics.tepIdeal) : null,
    concentrationTop3Percent: pct(top3, totalFriction),
    handoffExposurePercent: pct(laneTransitions.length, manualTransitions.length),
    loopPressurePercent: avgLoopProb,
    autoPotentialPercent: pct(potentialAuto.length, manualTasks.length),
    autoConfirmedPercent: pct(confirmedPotentialCount, Math.max(potentialAuto.length, 1)),
  };
}

function fmtInsight(v) {
  return Number.isFinite(v) ? `${v.toFixed(2)}%` : '--';
}

function semaphoreForPhillip(kind, value) {
  if (!Number.isFinite(value)) return { cls: 'sev-gray', label: 'sem dado' };

  // Escala Phillip: 100% = mundo perfeito (teto). Quanto menor, pior.
  if (value > 80) return { cls: 'sev-green', label: 'eficiencia de fluxo' };
  if (value >= 50) return { cls: 'sev-yellow', label: 'alerta de atrito' };
  if (value >= 30) return { cls: 'sev-orange', label: 'gargalo institucional' };
  return { cls: 'sev-red', label: 'paralisia burocratica' };
}

function semaforoTag(title, kind, value) {
  const s = semaphoreForPhillip(kind, value);
  return `<span class="semaforo ${s.cls}"><strong>${title}</strong>: ${s.label}</span>`;
}

function severityColorFromValue(value) {
  const cls = semaphoreForPhillip('standard', value).cls;
  if (cls === 'sev-green') return '#23b26d';
  if (cls === 'sev-yellow') return '#d1a321';
  if (cls === 'sev-orange') return '#e17a2d';
  if (cls === 'sev-red') return '#d84b54';
  return '#6c7a89';
}

function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function frictionTotalsByType(ranking) {
  const out = { handoff: 0, gateway: 0, loop: 0, timer: 0 };
  for (const item of ranking || []) {
    const type = String(item?.type || '').toLowerCase();
    if (!Object.hasOwn(out, type)) continue;
    out[type] += Number(item?.total || 0);
  }
  return out;
}

function computeDashboardIndices(metrics, base) {
  const ranking = metrics?.ranking || base?.ranking || [];
  const insight = computeInsightIndices(metrics, base);
  const nodes = graph?.nodes || [];
  const tasks = nodes.filter((n) => n.type === 'task');
  const totalTasks = tasks.length;
  const automatedNowCount = tasks.filter((n) => n.automated).length;

  const potentialSet = new Set(suggestedAutomationNodeIds());
  const confirmedPotential = [...confirmedAutoNodes].filter((id) => potentialSet.has(id));
  const projectedAutoCount = Math.min(totalTasks, automatedNowCount + confirmedPotential.length);

  const phStd = Number.isFinite(metrics?.ipRealVsIdeal) ? Number(metrics.ipRealVsIdeal) : Number(base?.ip || 0);
  const phAuto = Number.isFinite(metrics?.ipAutoVsIdeal) ? Number(metrics.ipAutoVsIdeal) : phStd;
  const hasInformed = Number.isFinite(metrics?.ipLeadInformedVsIdeal);
  const phInf = hasInformed ? Number(metrics.ipLeadInformedVsIdeal) : phStd;
  const composite = hasInformed
    ? clampPct((phStd * 0.5) + (phAuto * 0.35) + (phInf * 0.15))
    : clampPct((phStd * 0.6) + (phAuto * 0.4));

  const friction = frictionTotalsByType(ranking);
  const frictionTotal = Math.max(0.0001, friction.handoff + friction.gateway + friction.loop);
  const handoffShare = clampPct((friction.handoff / frictionTotal) * 100);
  const gatewayShare = clampPct((friction.gateway / frictionTotal) * 100);
  const loopShare = clampPct((friction.loop / frictionTotal) * 100);

  const stabilityIndex = clampPct(100 - (
    (Number(insight.loopPressurePercent || 0) * 0.45)
    + (Number(insight.handoffExposurePercent || 0) * 0.35)
    + (Number(insight.concentrationTop3Percent || 0) * 0.2)
  ));

  return {
    phStd: clampPct(phStd),
    phAuto: clampPct(phAuto),
    phInf: clampPct(phInf),
    composite,
    hasInformed,
    friction,
    handoffShare,
    gatewayShare,
    loopShare,
    stabilityIndex,
    insight,
    totalTasks,
    automatedNowCount,
    projectedAutoCount,
    autoCoverageNow: pct(automatedNowCount, totalTasks),
    autoCoverageProjected: pct(projectedAutoCount, totalTasks),
    potentialYield: clampPct(insight.autoOpportunityPercent || 0),
  };
}

function _phillipBadge(value) {
  const s = semaphoreForPhillip('x', value);
  const color = severityColorFromValue(value);
  return `<span class="ph-badge" style="background:${color}22;color:${color};border:1px solid ${color}55;">${s.label}</span>`;
}

function _phBar(value) {
  const pct = clampPct(Number(value || 0));
  const color = severityColorFromValue(value);
  return `<div class="ph-bar"><div class="ph-bar-fill" style="width:${pct.toFixed(1)}%;background:${color};"></div></div>`;
}

function _metricCell(label, value, unit, note) {
  const disp = Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)}<span class="mcell-unit">${unit}</span>` : `<span class="mcell-na">—</span>`;
  return `<div class="mcell">
    <div class="mcell-label">${label}</div>
    <div class="mcell-value">${disp}</div>
    <div class="mcell-note">${note}</div>
  </div>`;
}

function _phillipCell(label, value, note) {
  const color = Number.isFinite(Number(value)) ? severityColorFromValue(value) : '#8898aa';
  const disp = Number.isFinite(Number(value))
    ? `${Number(value).toFixed(1)}<span class="mcell-unit">%</span>`
    : `<span class="mcell-na">—</span>`;
  return `<div class="mcell mcell-phillip">
    <div class="mcell-label">${label}</div>
    <div class="mcell-value" style="color:${color};">${disp}</div>
    ${Number.isFinite(Number(value)) ? _phillipBadge(value) : ''}
    ${Number.isFinite(Number(value)) ? _phBar(value) : ''}
    <div class="mcell-note">${note}</div>
  </div>`;
}

function _fmtUT(v) {
  return Number.isFinite(Number(v)) ? `${Number(v).toFixed(1)} UT` : '—';
}

function _fmtMin(v) {
  if (!Number.isFinite(Number(v))) return '—';
  const mins = Number(v);
  if (mins >= 60) return `${(mins / 60).toFixed(1)} h`;
  return `${mins.toFixed(0)} min`;
}

function _resultCard(icon, title, value, subtitle, definition, auditNote, extraClass = '') {
  return `<div class="result-card ${extraClass}">
    <div class="rc-icon">${icon}</div>
    <div class="rc-title">${title}</div>
    <div class="rc-value">${value}</div>
    <div class="rc-subtitle">${subtitle}</div>
    <div class="rc-definition">${definition}</div>
    <div class="rc-audit">"${auditNote}"</div>
  </div>`;
}

function _ipCard(ip) {
  const color = Number.isFinite(Number(ip)) ? severityColorFromValue(ip) : '#8898aa';
  const s = semaphoreForPhillip('x', ip);
  const pctVal = clampPct(Number(ip || 0));
  const gauge = `<div class="rc-gauge"><div class="rc-gauge-fill" style="width:${pctVal.toFixed(1)}%;background:${color};"></div></div>`;
  const badge = `<span class="ph-badge" style="background:${color}22;color:${color};border:1px solid ${color}55;">${s.label}</span>`;
  return `<div class="result-card rc-ip">
    <div class="rc-icon">📐</div>
    <div class="rc-title">I.P. — Índice de Phillip</div>
    <div class="rc-value" style="color:${color};">${Number.isFinite(Number(ip)) ? `${pctVal.toFixed(1)}%` : '—'}</div>
    ${gauge}${badge}
    <div class="rc-definition">O percentual de aproveitamento do esforço. Mede quanto do T.E.R. é transformado em valor pelo T.O.P.</div>
    <div class="rc-audit">"A nota de saúde do seu fluxo de trabalho."</div>
  </div>`;
}

function _buildGavetaCard(metrics) {
  const hasInformed = Number.isFinite(metrics.leadTimeInformed);
  const gavetaPct = metrics.tempoGaveta !== null && hasInformed && metrics.leadTimeInformed > 0
    ? ((metrics.tempoGaveta / metrics.leadTimeInformed) * 100).toFixed(1)
    : null;
  return _resultCard(
    '🕰️',
    'T.Gaveta — Tempo de Fila / Espera Passiva',
    _fmtMin(metrics.tempoGaveta),
    `${gavetaPct !== null ? gavetaPct + '% do T.P.' : ''} · T.P. − T.P.E.`,
    'Tempo em que o processo fica parado na fila, gaveta ou aguardando decisão — sem nenhuma execução ativa.',
    metrics.tempoGaveta > 0
      ? 'Foco de gestão: reduzir o tempo de gaveta é o maior alavancador de eficiência operacional.'
      : 'Processo sem tempo de gaveta identificado.',
    metrics.tempoGaveta > 0 ? 'rc-gaveta-warn' : ''
  );
}

function _buildAutoCard(metrics, hasAuto, topAutoDisp, subSuffix) {
  if (!hasAuto) return '';
  const gainPct = (metrics.top > 0 ? ((metrics.top - metrics.topAuto) / metrics.top * 100) : 0).toFixed(1);
  return _resultCard('⚙️', 'T.O.P. Auto', topAutoDisp, 'caminho feliz com automações' + subSuffix, 'T.O.P. projetado após confirmação das automações marcadas no cenário To-Be.', `Ganho potencial: ${gainPct}% de redução no T.O.P.`, 'rc-auto');
}

function renderExecutiveKpis(metrics, base) {
  const box = $('kpi');
  if (!box) return;

  const liveLine = `<div class="mblock-live">
    Bolinhas finalizadas: <strong id="liveTokensFinished">${liveSimulationStatus.finished}/${liveSimulationStatus.total}</strong> &nbsp;|
    T.E.R. médio ao vivo: <strong id="liveLeadAvg">${Number(liveSimulationStatus.avgLeadTime || 0).toFixed(1)} UT</strong>
  </div>`;

  if (!metrics) {
    const base_ = base || {};
    const terVal = Number(base_.tepReal || 0);
    box.className = 'kpi kpi-executive';
    box.innerHTML = `
      <div class="results-grid-partial">
        ${_resultCard('⚡', 'T.O.P. — Tempo Ótimo', '—', 'informe o caminho feliz', 'A régua de ouro da eficiência. Tempo sem burocracias, esperas ou erros.', 'Se este processo fosse 100% fluido e sem interrupções, este seria o esforço real.')}
        ${_resultCard('📊', 'T.E.R. — Tempo de Execução Realista', terVal > 0 ? _fmtUT(terVal) : '—', 'com todo o atrito do processo', 'O termômetro da realidade. Média do tempo das 100 partículas com todos os atritos.', 'Este é o custo atual do desenho do processo considerando o atrito administrativo.')}
        ${_ipCard(null)}
      </div>
      ${liveLine}`;
    return;
  }

  const hasAuto = Number.isFinite(metrics.topAuto);
  const hasInformed = Number.isFinite(metrics.leadTimeInformed);

  const hasK = metrics.kFactor !== null;
  const fmtK  = (ut) => hasK ? _fmtMin(ut * metrics.kFactor) : _fmtUT(ut);
  const subSuffix = hasK ? ' · tempo real' : '';

  const kLine = hasK
    ? `<div class="rc-kfactor">Conversão: 1 UT = ${metrics.kFactor.toFixed(2)} min reais — T.O.P., T.E.R. e T.O.P.Auto exibidos em tempo real</div>`
    : '';

  const tpCard = hasInformed
    ? _resultCard('💬', 'T.P. — Tempo de Percepção', _fmtMin(metrics.leadTimeInformed), 'lead time total · declarado pelo executor', 'O tempo de calendário (Lead Time). É o que o cidadão sente na ponta — do insumo ao produto final, incluindo filas e gavetas.', 'Informe também o T.P.E. para calcular o Tempo de Gaveta.')
    : '';

  const hasTPE = Number.isFinite(metrics.processingTimeInformed) && metrics.processingTimeInformed > 0;
  const tpeCard = hasTPE
    ? _resultCard('⚙', 'T.P.E. — Tempo de Processamento Estimado', _fmtMin(metrics.processingTimeInformed), 'sem filas/gaveta · declarado pelo executor', 'Tempo estimado para executar o processo sem tempos de fila ou espera passiva. Base para o cálculo do Tempo de Gaveta.', 'T.P.E. < T.P. — a diferença é o tempo desperdiçado em fila.')
    : '';

  const gavetaCard = metrics.tempoGaveta !== null ? _buildGavetaCard(metrics) : '';

  const topDisp = metrics.top > 0 ? fmtK(metrics.top) : '—';
  const topAutoDisp = metrics.topAuto > 0 ? fmtK(metrics.topAuto) : '—';

  const autoCard = _buildAutoCard(metrics, hasAuto, topAutoDisp, subSuffix);

  const liveUT = Number(liveSimulationStatus.avgLeadTime || 0);
  const liveTerDisp = liveUT > 0
    ? (hasK ? _fmtMin(liveUT * metrics.kFactor) : `${liveUT.toFixed(1)} UT`)
    : '—';
  const liveLineK = `<div class="mblock-live">
    Bolinhas finalizadas: <strong id="liveTokensFinished">${liveSimulationStatus.finished}/${liveSimulationStatus.total}</strong> &nbsp;|
    T.E.R. médio ao vivo: <strong id="liveLeadAvg">${liveTerDisp}</strong>
  </div>`;

  box.className = 'kpi kpi-executive';
  box.innerHTML = `
    <div class="results-grid">
      ${_resultCard('⚡', 'T.O.P. — Tempo Ótimo de Processamento', topDisp, 'caminho feliz, sem atritos' + subSuffix, 'A régua de ouro da eficiência. Representa o tempo estritamente necessário para a execução das tarefas, removendo todas as burocracias, esperas e erros.', 'Se este processo fosse 100% fluido e sem interrupções, este seria o esforço real.')}
      ${_resultCard('📊', 'T.E.R. — Tempo de Execução Realista', fmtK(metrics.ter), 'média das 100 partículas' + subSuffix, 'O termômetro da realidade. É a média do tempo gasto pelas 100 partículas, contabilizando penalidades de handoffs, gateways e a probabilidade de retrabalho (loops).', 'Este é o custo atual do desenho do processo considerando o atrito administrativo.')}
      ${tpCard}
      ${tpeCard}
      ${gavetaCard}
      ${_ipCard(metrics.ipRealVsIdeal)}
      ${_resultCard('🔀', 'Complexidade', String(metrics.complexidade), 'caminhos possíveis no processo', 'Quantidade de trajetos distintos que uma partícula pode percorrer do início ao fim, considerando todos os gateways e eventos de fim.', 'Quanto maior, mais variável é o comportamento do processo em campo.')}
      ${autoCard}
    </div>
    ${kLine}
    ${liveLineK}`;
}

function refreshLiveSimulationStatus(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const finished = list.filter((t) => t.ended).length;
  const total = list.length || TOKEN_COUNT;
  const endedTimes = list
    .filter((t) => t.ended)
    .map((t) => Number(simRuns?.[t.id]?.time || 0))
    .filter((v) => Number.isFinite(v) && v > 0);
  const avgLead = endedTimes.length
    ? endedTimes.reduce((a, b) => a + b, 0) / endedTimes.length
    : 0;

  liveSimulationStatus = { finished, total, avgLeadTime: avgLead };

  const terText = avgLead > 0 ? `${avgLead.toFixed(1)} UT` : '—';

  // Update controls row counters
  const elFinished = $('liveTokensFinished');
  const elLead = $('liveLeadAvg');
  if (elFinished) elFinished.textContent = `${finished}/${total}`;
  if (elLead) elLead.textContent = terText;

  // Update live overlay on canvas
  const panel = $('simLivePanel');
  const elCounter = $('simLiveCounter');
  const elTer = $('simLiveTer');
  if (panel) panel.classList.remove('hidden');
  if (elCounter) elCounter.textContent = `${finished}/${total}`;
  if (elTer) elTer.textContent = terText;

  // When all done, add "complete" style
  if (panel) {
    if (finished >= total) {
      panel.classList.add('slp-done');
    } else {
      panel.classList.remove('slp-done');
    }
  }
}

function renderInsightKpis(metrics, base) {
  const box = $('insightKpi');
  if (!box) return;
  const i = computeInsightIndices(metrics, base);
  const d = computeDashboardIndices(metrics, base);

  const meter = (value, cls = '') => `
    <div class="insight-meter">
      <div class="insight-meter-fill ${cls}" style="width:${clampPct(Number(value || 0)).toFixed(1)}%;"></div>
    </div>`;

  box.innerHTML = `
    <div class="card">
      <div>Desperdicio Estrutural</div>
      <div class="value">${fmtInsight(i.estimatedWastePercent)}</div>
      ${meter(i.estimatedWastePercent, 'tone-warn')}
      <small>Perda do TEP real em relacao ao ideal.</small>
    </div>
    <div class="card">
      <div>Gap da Visao do Executor</div>
      <div class="value">${fmtInsight(i.informedWastePercent)}</div>
      ${meter(i.informedWastePercent, 'tone-risk')}
      <small>Diferenca entre lead informado e lead ideal.</small>
    </div>
    <div class="card">
      <div>Risco de Retrabalho</div>
      <div class="value">${fmtInsight(i.loopPressurePercent)}</div>
      ${meter(i.loopPressurePercent, 'tone-risk')}
      <small>Pressao de retorno por loops no fluxo.</small>
    </div>
    <div class="card">
      <div>Exposicao de Handoff</div>
      <div class="value">${fmtInsight(i.handoffExposurePercent)}</div>
      ${meter(i.handoffExposurePercent, 'tone-info')}
      <small>Trocas manuais entre atores/setores.</small>
    </div>
    <div class="card">
      <div>Automacao Atual</div>
      <div class="value">${d.autoCoverageNow.toFixed(1)}%</div>
      ${meter(d.autoCoverageNow, 'tone-good')}
      <small>${d.automatedNowCount}/${d.totalTasks} tarefas atualmente automaticas.</small>
    </div>
    <div class="card">
      <div>Automacao Projetada</div>
      <div class="value">${d.autoCoverageProjected.toFixed(1)}%</div>
      ${meter(d.autoCoverageProjected, 'tone-good')}
      <small>${d.projectedAutoCount}/${d.totalTasks} tarefas no cenario ideal auto.</small>
    </div>
    <div class="card">
      <div>Concentracao de Atrito</div>
      <div class="value">${fmtInsight(i.concentrationTop3Percent)}</div>
      ${meter(i.concentrationTop3Percent, 'tone-warn')}
      <small>Quanto os 3 maiores atritos dominam o processo.</small>
    </div>
    <div class="card">
      <div>Ganho Potencial de Automacao</div>
      <div class="value">${fmtInsight(i.autoOpportunityPercent)}</div>
      ${meter(i.autoOpportunityPercent, 'tone-good')}
      <small>Reducao de tempo entre ideal e ideal auto.</small>
    </div>`;
}

function renderFrictionChart(metrics) {
  const box = $('frictionRanking');
  if (!box) return;

  const ranking = (metrics?.ranking || []).slice(0, 8);
  if (!ranking.length) { box.innerHTML = '<p style="color:#8898aa;">Sem atritos relevantes detectados.</p>'; return; }

  const friction = frictionTotalsByType(ranking);
  const totalFr = Math.max(0.001, friction.handoff + friction.gateway + friction.loop);

  // Bloco de resumo por tipo (grafico de barras agregado)
  const typeColors = { handoff: '#c0392b', gateway: '#d1a321', loop: '#f39c12', timer: '#f1c40f' };
  const typeLabels = { handoff: 'Esforço de Handoff', gateway: 'Custo de Decisão (Gateways)', loop: 'Custo de Retrabalho (Loops)', timer: 'Espera de Timer (Semáforo)' };
  const typeIcons  = { handoff: '🔁', gateway: '⚖️', loop: '🔄', timer: '⏱' };

  const summaryBars = ['handoff', 'gateway', 'loop', 'timer'].map((t) => {
    const val = friction[t];
    const pctW = ((val / totalFr) * 100).toFixed(1);
    const color = typeColors[t];
    return `<div class="fc-row">
      <div class="fc-label">${typeIcons[t]} ${typeLabels[t]}</div>
      <div class="fc-bar-wrap">
        <div class="fc-bar" style="width:${pctW}%;background:${color};"></div>
      </div>
      <div class="fc-value">${val.toFixed(1)} UT <span class="fc-pct">(${pctW}%)</span></div>
    </div>`;
  }).join('');

  // Detalhe dos top-8 itens individuais
  const maxVal = ranking[0]?.total || 1;
  const detailBars = ranking.map((item) => {
    const pctW = ((item.total / maxVal) * 100).toFixed(1);
    const color = typeColors[item.type] || '#8898aa';
    const key = item.key.replaceAll('->', ' → ');
    return `<div class="fc-row fc-row-sm">
      <div class="fc-label fc-label-sm">${key}</div>
      <div class="fc-bar-wrap">
        <div class="fc-bar" style="width:${pctW}%;background:${color}88;"></div>
      </div>
      <div class="fc-value">${item.total.toFixed(1)} UT</div>
    </div>`;
  }).join('');

  box.innerHTML = `
    <div class="friction-chart">
      <div class="fc-section-title">Decomposição do Atrito — Onde o tempo "foge"</div>
      <div class="fc-summary">${summaryBars}</div>
      <div class="fc-section-title" style="margin-top:12px;">Top ${ranking.length} Itens Individuais</div>
      <div class="fc-details">${detailBars}</div>
    </div>`;
}

function _buildP2Friction(topFriction) {
  if (!topFriction) {
    return 'Nenhum atrito dominante identificado no processo atual. O fluxo apresenta baixa concentração de gargalos.';
  }
  const tipoLabel = topFriction.type === 'handoff' ? 'Handoff'
    : topFriction.type === 'gateway' ? 'Gateway de Decisão' : 'Loop de Retrabalho';
  const keyLabel = topFriction.key.replaceAll('->', ' → ');
  const totalUT = topFriction.total.toFixed(1);
  if (topFriction.type === 'handoff') {
    return `A maior perda de tempo detectada foi no <strong>${tipoLabel} ${keyLabel}</strong>, que acumula <strong>${totalUT} UT</strong> ao fluxo. Recomenda-se unificar estas etapas ou automatizar a transferência de dados para reduzir este impacto.`;
  }
  if (topFriction.type === 'gateway') {
    return `O maior ponto de atrito detectado é o <strong>${tipoLabel} ${keyLabel}</strong>, que acumula <strong>${totalUT} UT</strong> em decisões repetidas. Recomenda-se simplificar os critérios de aprovação ou antecipar as validações no fluxo.`;
  }
  return `O maior consumo de atrito está no <strong>${tipoLabel} na tarefa ${keyLabel}</strong>, acumulando <strong>${totalUT} UT</strong>. Recomenda-se revisar os critérios de entrada e qualidade de dados antes do ponto de retorno.`;
}

function _buildP3Automation(nodes, metrics) {
  const manualTasks = (nodes || []).filter((n) => n.type === 'task' && !n.automated);
  const topManual = manualTasks[0];
  if (!topManual) {
    return 'Todas as tarefas já estão automatizadas ou não há candidatos identificados para automação no cenário atual.';
  }
  const gainUT = (RULES.nextManual - RULES.automated).toFixed(1);
  const gainPct = metrics.top > 0 ? ((gainUT / metrics.top) * 100).toFixed(1) : '0';
  const gainMin = metrics.kFactor !== null
    ? ` (economia de aprox. ${(gainUT * metrics.kFactor).toFixed(0)} min reais por execução)`
    : '';
  return `Caso a atividade <strong>"${escapeHtml(topManual.label)}"</strong> seja automatizada (reduzindo de ${RULES.nextManual} para ${RULES.automated} UT), o T.O.P. cairia em aprox. <strong>${gainPct}%</strong>${gainMin}. Recomenda-se priorizar tarefas repetitivas e de alto volume para maximizar o retorno.`;
}

function _buildP4Gaveta(metrics) {
  if (metrics.tempoGaveta !== null) {
    const tp     = Number(metrics.leadTimeInformed);
    const tpe    = Number(metrics.processingTimeInformed);
    const gaveta = Number(metrics.tempoGaveta);
    const gavetaPct = tp > 0 ? ((gaveta / tp) * 100).toFixed(1) : '0';
    const gavetaFmt = _fmtMin(gaveta);
    return `O executor informou T.P. de <strong>${_fmtMin(tp)}</strong> e T.P.E. de <strong>${_fmtMin(tpe)}</strong>. Isso revela que <strong>${gavetaPct}%</strong> do tempo total (<strong>${gavetaFmt}</strong>) é gasto em espera passiva — filas, gavetas e aguardo de decisão — sem execução ativa. O foco da gestão deve ser a redução do Tempo de Gaveta.`;
  }
  if (Number.isFinite(metrics.leadTimeInformed)) {
    return 'T.P. informado. Informe também o <strong>T.P.E. (Tempo de Processamento Estimado)</strong> para calcular o Tempo de Gaveta e medir o impacto das filas no processo.';
  }
  return 'Informe o <strong>T.P.</strong> (Tempo de Percepção) e o <strong>T.P.E.</strong> (Tempo de Processamento Estimado) para calcular o Tempo de Gaveta e medir o impacto das filas no processo.';
}

function renderAutomaticInterpretation(metrics, base) {
  const box = $('insightInterpretation');
  if (!box) return;

  if (!metrics) {
    box.innerHTML = `<div class="veredito-parcial">
      <p><strong>Leitura parcial:</strong> informe o caminho feliz e o T.P. (Tempo de Percepção) do executor para liberar o diagnóstico completo.</p>
      <p>Enquanto isso, use o gráfico de atrito abaixo para identificar os maiores gargalos do processo atual.</p>
    </div>`;
    return;
  }

  const ip = Number(metrics.ipRealVsIdeal || 0);
  const horasPerdidas = ((100 - ip) / 100 * 10).toFixed(1);

  const p1 = `O processo apresenta um I.P. de <strong>${ip.toFixed(1)}%</strong>. Isso indica que, para cada 10 horas de trabalho, cerca de <strong>${horasPerdidas} horas</strong> são consumidas por atividades que não agregam valor direto, como recontextualização e trocas de setor.`;
  const p2 = _buildP2Friction((metrics.ranking || [])[0]);
  const p3 = _buildP3Automation(graph?.nodes, metrics);
  const p4 = _buildP4Gaveta(metrics);

  const sStandard = semaphoreForPhillip('standard', ip);
  box.innerHTML = `
    <div class="veredito-box">
      <div class="veredito-header">
        <span class="semaforo ${sStandard.cls}">I.P.: ${sStandard.label}</span>
      </div>
      <div class="veredito-body">
        <p class="veredito-p"><span class="veredito-num">1.</span><span>${p1}</span></p>
        <p class="veredito-p"><span class="veredito-num">2.</span><span>${p2}</span></p>
        <p class="veredito-p"><span class="veredito-num">3.</span><span>${p3}</span></p>
        <p class="veredito-p"><span class="veredito-num">4.</span><span>${p4}</span></p>
      </div>
    </div>`;
}

function computeScenarioMetrics() {
  applyWeightsFromUI();

  const base = calculateTEPAndIP(graph, 3500);
  const path = parseHappyPathRequired();
  const leadTimeInformed      = parseLeadTimeInformedRequired();
  const processingTimeInformed = parseProcessingTimeInformed();

  syncConfirmedAutoFromUi();
  const autoGraph = buildAutoScenarioGraph();
  const autoBase = calculateTEPAndIP(autoGraph, 3500);

  // Usa o TER das 100 partículas animadas quando disponível,
  // assim o dashboard e o contador ao vivo mostram o mesmo número.
  const ter = (_animatedTer !== null && _animatedTer > 0) ? _animatedTer : base.tepReal;
  const terAuto = autoBase.tepReal;

  // T.O.P. = caminho feliz sem atrito.
  // Nunca lança exceção — falha no happy path mostra "—" no card sem derrubar os demais.
  let top = 0;
  try {
    const t = calculatePathTime(graph, path, true);
    if (t > 0) top = t;
  } catch (_) { console.warn('[simulator] path inválido, TOP = 0', _); }

  // T.O.P. Auto = cenário com automações.
  // Fallback para top quando não calculável.
  let topAuto = top;
  try {
    const ta = calculatePathTime(autoGraph, path, true);
    if (ta > 0) topAuto = ta;
  } catch (_) { console.warn('[simulator] automação path inválido', _); }

  // Conversao K: 1 UT = quantos minutos reais (usando T.P. como ancora)
  // K = T.P. (min) / T.E.R. (UT)
  const kFactor = (Number.isFinite(leadTimeInformed) && leadTimeInformed > 0 && ter > 0)
    ? leadTimeInformed / ter
    : null;

  // Tempo de Gaveta = T.P. − T.P.E.  (fila + espera passiva)
  // Só calculável quando ambos os campos estão preenchidos pelo executor
  const tempoGaveta = (
    Number.isFinite(leadTimeInformed) && leadTimeInformed > 0 &&
    Number.isFinite(processingTimeInformed) && processingTimeInformed > 0
  ) ? leadTimeInformed - processingTimeInformed : null;

  // Complexidade: numero de caminhos possiveis no processo
  const complexidade = calculateComplexity(graph);

  return {
    ter,
    top,
    topAuto,
    terAuto,
    leadTimeInformed,
    processingTimeInformed,
    kFactor,
    tempoGaveta,
    complexidade,
    // Compatibilidade com codigo legado
    tepReal:    ter,
    tepIdeal:   top,
    tepIdealAuto: topAuto,
    tepRealAuto:  terAuto,
    leadIdeal:  top,
    ipRealVsIdeal:         phillipEfficiency(ter,     top),
    ipRealAutoVsIdealAuto: phillipEfficiency(terAuto, topAuto),
    ipAutoVsIdeal:         phillipEfficiency(topAuto, top),
    ipLeadInformedVsIdeal: Number.isFinite(leadTimeInformed) ? phillipEfficiency(leadTimeInformed, top * (kFactor || 1)) : null,
    ipIdeal: 100,
    ipLeadIdeal: 100,
    ipIdealAuto: 100,
    ranking: base.ranking,
    autoCount: (autoGraph.nodes || []).filter((n) => n.type === 'task' && n.automated).length,
  };
}

function laneIdOf(node) {
  return String(node?.lane || node?.executor || node?.sector || node?.id || 'lane-default');
}

function laneMetaOf(node) {
  const laneId = laneIdOf(node);
  const p = graph?.lanes?.[laneId] || {};
  return {
    laneId,
    team: String(p.team || node?.executor || laneId),
    sector: String(p.sector || node?.sector || ''),
    org: String(p.org || node?.org || ''),
  };
}

function uniqueLanes() {
  if (!graph) return [];
  const ids = new Set();
  for (const n of graph.nodes || []) {
    if (n.type !== 'task') continue;
    ids.add(laneIdOf(n));
  }
  return [...ids];
}

function saveLaneProfilesFromForm() {
  if (!graph) return;
  graph.lanes = graph.lanes || {};
  document.querySelectorAll('[data-lane-row]').forEach((row) => {
    const lane = row.dataset.laneRow;
    const team = row.querySelector('[data-field="team"]').value.trim();
    const sector = row.querySelector('[data-field="sector"]').value.trim();
    const org = row.querySelector('[data-field="org"]').value.trim();
    graph.lanes[lane] = { team, sector, org };
  });
}

function renderHandoffSetup() {
  const box = $('handoffSetup');
  if (!graph) {
    box.textContent = 'Carregue um grafo para configurar as raias.';
    return;
  }
  const lanes = uniqueLanes();
  if (!lanes.length) {
    box.textContent = 'Nao ha atividades manuais para configurar handoff.';
    return;
  }

  const rows = lanes.map((lane) => {
    const profile = graph.lanes?.[lane] || {};
    return `
      <div data-lane-row="${escapeHtml(lane)}" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:6px;align-items:end;">
        <label class="field" style="margin:0;"><span>Raia</span><input value="${escapeHtml(lane)}" disabled></label>
        <label class="field" style="margin:0;"><span>Equipe</span><input data-field="team" value="${escapeHtml(profile.team || '')}" placeholder="Ex: Protocolo"></label>
        <label class="field" style="margin:0;"><span>Setor</span><input data-field="sector" value="${escapeHtml(profile.sector || '')}" placeholder="Ex: Atendimento"></label>
        <label class="field" style="margin:0;"><span>Órgão</span><input data-field="org" value="${escapeHtml(profile.org || '')}" placeholder="Ex: SEFAZ"></label>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div style="font-size:12px;margin-bottom:8px;">
      Regra usada: troca de raia = handoff. Mesma equipe +10 UT, outra equipe (mesmo órgão) +20 UT, outro órgão +40 UT.
    </div>
    ${rows}
    <button id="btnSaveHandoffRows" type="button">Salvar Cadastro de Raias</button>
    <div id="handoffSetupMsg" style="margin-top:6px;font-size:12px;color:#486581;"></div>`;

  $('btnSaveHandoffRows').addEventListener('click', () => {
    saveLaneProfilesFromForm();
    $('graphJson').value = JSON.stringify(graph, null, 2);
    $('handoffSetupMsg').textContent = 'Cadastro salvo.';
    refreshAll();
  });
}

function ensureHandoffReady() {
  if (!graph) return false;
  if (!isHandoffReadyLocal()) {
    $('validationBox').innerHTML = '<span class="badge error">handoff</span> Confirme na seção 2 do popup se cada handoff é de mesma equipe, outra equipe ou outro órgão.';
    renderHandoffSetup();
    return false;
  }
  return true;
}

function loadSample() {
  fetch('./sample-graph.json')
    .then((r) => r.json())
    .then((g) => {
      graph = normalizeGraph(g);
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
      renderHandoffWizard();
      renderSetupChecklist();
    })
    .catch((e) => {
      $('validationBox').textContent = `Erro ao carregar exemplo: ${e.message}`;
    });
}

function parseEditorGraph() {
  try {
    const raw = JSON.parse($('graphJson').value);
    graph = applyDefaultGatewayProbabilitiesLocal(normalizeGraph(raw));
    normalizeActorCodesInGraph();
    autoAssignComplexityDefaults(); // garante defaults de complexidade
    return true;
  } catch (e) {
    /* exibe mensagem de erro na interface */
    $('validationBox').innerHTML = `<span class="badge error">erro</span> JSON invalido: ${e.message}`;
    return false;
  }
}

function validateAndShow() {
  if (!parseEditorGraph()) return false;
  const integ = validateGraphIntegrity(graph);
  const probs = validateProbabilities(graph);

  const lines = [];
  if (!integ.errors.length && !probs.length) lines.push('OK: validacoes criticas passaram.');
  if (integ.errors.length) lines.push(`Erros: ${integ.errors.join(' | ')}`);
  if (probs.length) lines.push(`Probabilidades: ${probs.join(' | ')}`);
  if (integ.warnings.length) lines.push(`Avisos: ${integ.warnings.join(' | ')}`);

  $('validationBox').textContent = lines.join('\n');
  return !integ.errors.length && !probs.length;
}

function parseHappyPath(pathText) {
  const ids = String(pathText || '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 2) throw new Error('Informe ao menos 2 nos no caminho feliz.');

  const nodeMap = new Map((graph?.nodes || []).map((n) => [n.id, n]));
  const first = nodeMap.get(ids[0]);
  const last = nodeMap.get(ids.at(-1));

  const hasStart = (graph?.nodes || []).some((n) => n.type === 'start');
  const hasEnd = (graph?.nodes || []).some((n) => n.type === 'end');
  if (hasStart && first?.type !== 'start') {
    throw new Error('Caminho feliz deve iniciar no no de inicio do processo.');
  }
  if (hasEnd && last?.type !== 'end') {
    throw new Error('Caminho feliz deve terminar no no de fim do processo.');
  }

  for (let i = 0; i < ids.length - 1; i += 1) {
    if (!hasEdge(ids[i], ids[i + 1])) {
      throw new Error(`Caminho feliz invalido: aresta ausente ${ids[i]} -> ${ids[i + 1]}.`);
    }
  }
  return ids;
}

function hasEdge(fromId, toId) {
  return Boolean(graph?.edges?.find((e) => e.from === fromId && e.to === toId));
}

function startCandidateIds() {
  if (!graph) return [];
  const nodes = graph.nodes || [];
  const startNodes = nodes.filter((n) => n.type === 'start').map((n) => n.id);
  if (startNodes.length) return startNodes;

  const incomingCount = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges || []) {
    if (incomingCount.has(e.to)) incomingCount.set(e.to, Number(incomingCount.get(e.to) || 0) + 1);
  }
  return nodes.filter((n) => Number(incomingCount.get(n.id) || 0) === 0).map((n) => n.id);
}

function endCandidateIds() {
  if (!graph) return [];
  const nodes = graph.nodes || [];
  const endNodes = nodes.filter((n) => n.type === 'end');
  if (endNodes.length) {
    const nonErrorEnds = endNodes.filter((n) => String(n.endKind || '').toLowerCase() !== 'error');
    return (nonErrorEnds.length ? nonErrorEnds : endNodes).map((n) => n.id);
  }

  const outgoingCount = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges || []) {
    if (outgoingCount.has(e.from)) outgoingCount.set(e.from, Number(outgoingCount.get(e.from) || 0) + 1);
  }
  return nodes.filter((n) => Number(outgoingCount.get(n.id) || 0) === 0).map((n) => n.id);
}

function edgeHappyPathCost(edge) {
  const baseProb = Number.isFinite(Number(edge?.probability)) ? Number(edge.probability) : 0;
  let cost = 100 - Math.max(0, Math.min(100, baseProb));
  if (edge?.isLoopReturn) cost += 220;
  if (edge?.isErrorPath) cost += 300;

  const toNode = nodeById(edge?.to);
  if (toNode?.type === 'end' && String(toNode.endKind || '').toLowerCase() === 'error') {
    cost += 250;
  }

  return cost;
}

function _dijkstraScores(starts, graphRef) {
  const bestByNode = new Map();
  const prevByNode = new Map();
  const queue = [];

  for (const startId of starts) {
    bestByNode.set(startId, 0);
    queue.push({ id: startId, score: 0 });
  }

  while (queue.length) {
    queue.sort((a, b) => a.score - b.score);
    const current = queue.shift();
    if (!current) break;
    if (current.score > Number(bestByNode.get(current.id) || Infinity)) continue;

    const out = (graphRef.edges || []).filter((e) => e.from === current.id);
    for (const edge of out) {
      const nextId = edge.to;
      const nextScore = current.score + edgeHappyPathCost(edge);
      if (nextScore >= Number(bestByNode.get(nextId) || Infinity)) continue;
      bestByNode.set(nextId, nextScore);
      prevByNode.set(nextId, current.id);
      queue.push({ id: nextId, score: nextScore });
    }
  }

  return { bestByNode, prevByNode };
}

function _reconstructPath(bestEndId, prevByNode) {
  const path = [];
  let cursor = bestEndId;
  const guard = new Set();
  while (cursor && !guard.has(cursor)) {
    guard.add(cursor);
    path.push(cursor);
    cursor = prevByNode.get(cursor);
  }
  return path.reverse();
}

function suggestHappyPathIds() {
  if (!graph || !(graph.nodes || []).length) return [];

  const starts = startCandidateIds();
  const ends = new Set(endCandidateIds());
  if (!starts.length || !ends.size) return [];

  const { bestByNode, prevByNode } = _dijkstraScores(starts, graph);

  let bestEndId = null;
  let bestEndScore = Infinity;
  for (const endId of ends) {
    const s = Number(bestByNode.get(endId));
    if (!Number.isFinite(s)) continue;
    if (s < bestEndScore) {
      bestEndScore = s;
      bestEndId = endId;
    }
  }
  if (!bestEndId) return [];

  return _reconstructPath(bestEndId, prevByNode);
}

function applySuggestedHappyPath() {
  if (!parseEditorGraph()) return;
  const suggested = suggestHappyPathIds();
  if (!suggested.length) {
    setHappyPathHint('Nao foi possivel sugerir caminho feliz automaticamente. Verifique conexoes de inicio e fim.');
    renderSetupChecklist();
    return;
  }

  happyPathMarking.nodes = suggested;
  updateHappyPathInputFromSelection();
  setHappyPathHint(`Sugestao automatica aplicada: ${suggested.join(' > ')}. Revise e ajuste no mapa se necessario.`);
  drawGraph();
  renderSetupPathPicker();
  renderSetupChecklist();
}

function allowedNextNodeIds() {
  if (!graph) return new Set();
  const selected = happyPathMarking.nodes;
  if (!selected.length) return new Set(startCandidateIds());

  const last = selected.at(-1);
  return new Set((graph.edges || []).filter((e) => e.from === last).map((e) => e.to));
}

function nodeName(id) {
  const n = nodeById(id);
  return n?.label || id;
}

function updateHappyPathInputFromSelection() {
  $('happyPath').value = happyPathMarking.nodes.join('>');
  if ($('setupHappyPath')) $('setupHappyPath').value = $('happyPath').value;
}

function renderSetupPathPicker() {
  const box = $('setupPathPicker');
  if (!box) return;
  if (!graph || !(graph.nodes || []).length) {
    box.textContent = 'Carregue um processo para selecionar o caminho por cliques.';
    return;
  }

  const vb = graphViewBox(graph);
  box.innerHTML = `<svg id="setupPathCanvas" viewBox="${vb.x} ${vb.y} ${vb.width} ${vb.height}" aria-label="Mapa para selecao do caminho feliz"></svg>`;
  drawSetupPathCanvas();

  // Zoom com Ctrl+Scroll
  const svg = $('setupPathCanvas');
  if (svg && !svg._zoomBound) {
    svg._zoomBound = true;
    svg.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      const vbParts = String(svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
      if (vbParts.length !== 4 || vbParts.some((n) => !Number.isFinite(n))) return;
      let [x, y, w, h] = vbParts;
      const factor = ev.deltaY < 0 ? 0.85 : 1 / 0.85; // zoom in / out
      // Zoom centrado no ponto do cursor sobre o SVG
      const rect = svg.getBoundingClientRect();
      const mx = ((ev.clientX - rect.left) / rect.width)  * w + x;
      const my = ((ev.clientY - rect.top)  / rect.height) * h + y;
      const nw = Math.max(100, Math.min(8000, w * factor));
      const nh = Math.max(60,  Math.min(6000, h * factor));
      const nx = mx - (mx - x) * (nw / w);
      const ny = my - (my - y) * (nh / h);
      svg.setAttribute('viewBox', `${nx.toFixed(1)} ${ny.toFixed(1)} ${nw.toFixed(1)} ${nh.toFixed(1)}`);
    }, { passive: false });
  }
}

function onSetupPathNodeClick(nodeId) {
  const selected = happyPathMarking.nodes;
  const last = selected.at(-1);
  const allowed = allowedNextNodeIds();

  if (!allowed.has(nodeId)) {
    if (!selected.length) {
      const starts = [...allowed].map((id) => nodeName(id)).join(', ');
      setHappyPathHint(`Comece pelo no inicial do processo: ${starts || 'inicio nao identificado'}.`);
    } else {
      const options = [...allowed].map((id) => nodeName(id)).join(', ');
      setHappyPathHint(`No invalido. Proximos validos apos ${nodeName(last)}: ${options || 'nenhum (fim de fluxo)'}.`);
    }
    return;
  }

  if (!last) {
    selected.push(nodeId);
    updateHappyPathInputFromSelection();
    setHappyPathHint(`Caminho atual: ${selected.join(' > ')}`);
    drawGraph();
    renderSetupPathPicker();
    renderSetupChecklist();
    return;
  }

  if (nodeId === last) return;

  if (!hasEdge(last, nodeId)) {
    setHappyPathHint(`Transicao invalida: nao existe aresta ${last} -> ${nodeId}.`);
    return;
  }

  selected.push(nodeId);
  updateHappyPathInputFromSelection();
  setHappyPathHint(`Caminho atual: ${selected.join(' > ')}`);
  drawGraph();
  renderSetupPathPicker();
  renderSetupChecklist();
}

function _drawSetupEdge(svg, edge, from, to, happyPathNodes) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  line.setAttribute('stroke', '#6b7280');
  line.setAttribute('stroke-width', '2');
  for (let i = 0; i < happyPathNodes.length - 1; i += 1) {
    if (happyPathNodes[i] === edge.from && happyPathNodes[i + 1] === edge.to) {
      line.setAttribute('stroke', '#0b84f3');
      line.setAttribute('stroke-width', '4');
      break;
    }
  }
  line.setAttribute('marker-end', 'url(#setupArrow)');
  svg.appendChild(line);
}

function _drawSetupNodeShape(g, node, selectedIndex, isAllowed) {
  const isSelected = selectedIndex >= 0;
  if (node.type === 'task') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(node.x - 52));
    rect.setAttribute('y', String(node.y - 22));
    rect.setAttribute('width', '104');
    rect.setAttribute('height', '44');
    rect.setAttribute('rx', '10');
    rect.setAttribute('fill', '#edf3fb');
    rect.setAttribute('stroke', isSelected ? '#0b84f3' : '#2a4d69');
    rect.setAttribute('stroke-width', isSelected ? '3' : '2');
    g.appendChild(rect);
  } else if (node.type === 'gateway') {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', `${node.x},${node.y - 28} ${node.x + 34},${node.y} ${node.x},${node.y + 28} ${node.x - 34},${node.y}`);
    poly.setAttribute('fill', '#fff7e8');
    poly.setAttribute('stroke', isSelected ? '#0b84f3' : '#b9770e');
    poly.setAttribute('stroke-width', isSelected ? '3' : '2');
    g.appendChild(poly);
  } else {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(node.x));
    c.setAttribute('cy', String(node.y));
    c.setAttribute('r', '22');
    c.setAttribute('fill', node.type === 'start' ? '#e8f7ef' : '#fdecec');
    c.setAttribute('stroke', isSelected ? '#0b84f3' : (node.type === 'start' ? '#1b8a5a' : '#c0392b'));
    c.setAttribute('stroke-width', isSelected ? '4' : (node.type === 'end' ? '3' : '2'));
    g.appendChild(c);
  }
}

function drawSetupPathCanvas() {
  const svg = $('setupPathCanvas');
  if (!svg || !graph) return;
  svg.innerHTML = '';
  const allowed = allowedNextNodeIds();

  appendDiagramBackdrop(svg, 0.94);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="setupArrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#456" />
    </marker>`;
  svg.appendChild(defs);

  for (const edge of graph.edges || []) {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) continue;
    _drawSetupEdge(svg, edge, from, to, happyPathMarking.nodes);
  }

  for (const node of graph.nodes || []) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.setupNode = node.id;

    const selectedIndex = happyPathMarking.nodes.indexOf(node.id);
    const isSelected = selectedIndex >= 0;
    const isAllowed = allowed.has(node.id);
    g.style.cursor = isAllowed ? 'pointer' : 'not-allowed';
    g.style.opacity = isAllowed || isSelected ? '1' : '0.36';
    g.addEventListener('click', () => onSetupPathNodeClick(node.id));

    _drawSetupNodeShape(g, node, selectedIndex, isAllowed);

    const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    txt.textContent = isSelected ? `${node.label} (${selectedIndex + 1})` : node.label;
    txt.setAttribute('x', String(node.x));
    txt.setAttribute('y', String(node.y + 4));
    txt.setAttribute('font-size', '11');
    txt.setAttribute('font-weight', isSelected ? '700' : '500');
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#102a43');
    g.appendChild(txt);

    svg.appendChild(g);
  }
}

function setHappyPathHint(msg) {
  const el = $('happyPathHint');
  if (el) el.textContent = msg;
}

function toggleHappyPathMarking() {
  happyPathMarking.active = !happyPathMarking.active;
  const btn = $('btnMarkHappyPath');
  if (btn) btn.textContent = happyPathMarking.active ? 'Marcacao Ativa (clique nos nos)' : 'Marcar no Mapa';
  setHappyPathHint(
    happyPathMarking.active
      ? 'Marcacao ativa: clique nos nos em sequencia (inicio -> ... -> fim).'
      : 'Dica: ative "Marcar no Mapa" e clique nos nos em sequencia para montar o caminho feliz.'
  );
  drawGraph();
}

function clearHappyPathMarking() {
  happyPathMarking.nodes = [];
  updateHappyPathInputFromSelection();
  setHappyPathHint('Marcacao limpa. Clique novamente em "Marcar no Mapa" para recomecar.');
  drawGraph();
  renderSetupPathPicker();
  renderSetupChecklist();
}

function undoHappyPathMarking() {
  if (!happyPathMarking.nodes.length) return;
  happyPathMarking.nodes.pop();
  updateHappyPathInputFromSelection();
  setHappyPathHint(
    happyPathMarking.nodes.length
      ? `Caminho atual: ${happyPathMarking.nodes.join(' > ')}`
      : 'Marcacao limpa. Clique no mapa para recomecar.'
  );
  drawGraph();
  renderSetupPathPicker();
  renderSetupChecklist();
}

function onNodeClickedForHappyPath(nodeId) {
  if (!happyPathMarking.active) return;

  const selected = happyPathMarking.nodes;
  const last = selected.at(-1);
  const allowed = allowedNextNodeIds();

  if (!allowed.has(nodeId)) {
    if (!selected.length) {
      const starts = [...allowed].map((id) => nodeName(id)).join(', ');
      setHappyPathHint(`Comece pelo no inicial do processo: ${starts || 'inicio nao identificado'}.`);
    } else {
      const options = [...allowed].map((id) => nodeName(id)).join(', ');
      setHappyPathHint(`No invalido. Proximos validos apos ${nodeName(last)}: ${options || 'nenhum (fim de fluxo)'}.`);
    }
    return;
  }

  if (!last) {
    selected.push(nodeId);
    updateHappyPathInputFromSelection();
    setHappyPathHint(`Caminho atual: ${selected.join(' > ')}`);
    drawGraph();
    renderSetupPathPicker();
    return;
  }

  if (nodeId === last) return;

  if (!hasEdge(last, nodeId)) {
    setHappyPathHint(`Transicao invalida: nao existe aresta ${last} -> ${nodeId}.`);
    return;
  }

  selected.push(nodeId);
  updateHappyPathInputFromSelection();
  setHappyPathHint(`Caminho atual: ${selected.join(' > ')}`);
  drawGraph();
  renderSetupPathPicker();
}

function nodeById(id) {
  return graph.nodes.find((n) => n.id === id);
}

function _drawEdgeWithLabel(svg, edge, from, to) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', String(from.x));
  line.setAttribute('y1', String(from.y));
  line.setAttribute('x2', String(to.x));
  line.setAttribute('y2', String(to.y));
  line.setAttribute('stroke', edge.isLoopReturn ? '#f39c12' : edge.isErrorPath ? '#c0392b' : '#5d6d7e');
  line.setAttribute('stroke-width', '2.2');
  if (happyPathMarking.active) {
    for (let i = 0; i < happyPathMarking.nodes.length - 1; i += 1) {
      if (happyPathMarking.nodes[i] === edge.from && happyPathMarking.nodes[i + 1] === edge.to) {
        line.setAttribute('stroke', '#0b84f3');
        line.setAttribute('stroke-width', '4');
        break;
      }
    }
  }
  line.setAttribute('marker-end', 'url(#arrow)');
  svg.appendChild(line);

  if (edge.probability !== undefined) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.textContent = `${edge.probability}%`;
    t.setAttribute('x', String((from.x + to.x) / 2));
    t.setAttribute('y', String((from.y + to.y) / 2 - 6));
    t.setAttribute('fill', '#223');
    t.setAttribute('font-size', '12');
    svg.appendChild(t);
  }
}

function _drawNodeShape(g, node, isSelected) {
  if (node.type === 'task') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(node.x - 55));
    rect.setAttribute('y', String(node.y - 24));
    rect.setAttribute('width', '110');
    rect.setAttribute('height', '48');
    rect.setAttribute('rx', '10');
    rect.setAttribute('fill', node.automated ? '#e8f7ef' : '#edf3fb');
    rect.setAttribute('stroke', node.automated ? '#1b8a5a' : '#2a4d69');
    if (isSelected) {
      rect.setAttribute('stroke', '#0b84f3');
      rect.setAttribute('stroke-width', '3');
    }
    g.appendChild(rect);
  } else if (node.type === 'timer') {
    const cOuter = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cOuter.setAttribute('cx', String(node.x));
    cOuter.setAttribute('cy', String(node.y));
    cOuter.setAttribute('r', '26');
    cOuter.setAttribute('fill', '#fef9e7');
    cOuter.setAttribute('stroke', isSelected ? '#0b84f3' : '#d4ac0d');
    cOuter.setAttribute('stroke-width', isSelected ? '4' : '2.5');
    g.appendChild(cOuter);
    const cInner = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    cInner.setAttribute('cx', String(node.x));
    cInner.setAttribute('cy', String(node.y));
    cInner.setAttribute('r', '20');
    cInner.setAttribute('fill', 'none');
    cInner.setAttribute('stroke', isSelected ? '#0b84f3' : '#d4ac0d');
    cInner.setAttribute('stroke-width', '1.5');
    g.appendChild(cInner);
    const clock = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    clock.textContent = '⏱';
    clock.setAttribute('x', String(node.x));
    clock.setAttribute('y', String(node.y - 8));
    clock.setAttribute('font-size', '14');
    clock.setAttribute('text-anchor', 'middle');
    g.appendChild(clock);
    const utLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    utLabel.textContent = node.timerUT > 0 ? `${node.timerUT} UT` : '? UT';
    utLabel.setAttribute('x', String(node.x));
    utLabel.setAttribute('y', String(node.y + 10));
    utLabel.setAttribute('font-size', '9');
    utLabel.setAttribute('text-anchor', 'middle');
    utLabel.setAttribute('fill', '#b7950b');
    g.appendChild(utLabel);
  } else if (node.type === 'gateway') {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', `${node.x},${node.y - 30} ${node.x + 38},${node.y} ${node.x},${node.y + 30} ${node.x - 38},${node.y}`);
    poly.setAttribute('fill', '#fff7e8');
    poly.setAttribute('stroke', '#b9770e');
    poly.style.cursor = 'pointer';
    poly.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!happyPathMarking.active) openGatewayEditor(node.id);
    });
    if (isSelected) {
      poly.setAttribute('stroke', '#0b84f3');
      poly.setAttribute('stroke-width', '3');
    }
    g.appendChild(poly);
  } else {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(node.x));
    c.setAttribute('cy', String(node.y));
    c.setAttribute('r', '24');
    c.setAttribute('fill', node.type === 'start' ? '#e8f7ef' : '#fdecec');
    c.setAttribute('stroke', node.type === 'start' ? '#1b8a5a' : '#c0392b');
    c.setAttribute('stroke-width', node.type === 'end' ? '3' : '2');
    if (isSelected) {
      c.setAttribute('stroke', '#0b84f3');
      c.setAttribute('stroke-width', '4');
    }
    g.appendChild(c);
  }
}

function _drawNodeText(g, node, isSelected, selectedIndex) {
  const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  txt.textContent = node.label;
  txt.setAttribute('x', String(node.x));
  txt.setAttribute('y', String(node.y + 4));
  txt.setAttribute('font-size', '11');
  txt.setAttribute('text-anchor', 'middle');
  txt.setAttribute('fill', '#102a43');
  if (isSelected) {
    txt.textContent = `${node.label} (${selectedIndex + 1})`;
    txt.setAttribute('font-weight', '700');
  }
  g.appendChild(txt);

  const lc = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  lc.setAttribute('id', `loopCount-${node.id}`);
  lc.setAttribute('x', String(node.x));
  lc.setAttribute('y', String(node.y - 34));
  lc.setAttribute('text-anchor', 'middle');
  lc.setAttribute('font-size', '10');
  lc.setAttribute('fill', '#b9770e');
  lc.textContent = '';
  g.appendChild(lc);
}

function drawGraph() {
  const svg = $('simCanvas');
  svg.innerHTML = '';
  if (!graph) return;
  const vb = graphViewBox(graph);
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
  const allowed = allowedNextNodeIds();

  appendDiagramBackdrop(svg, 0.9);

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#456" />
    </marker>`;
  svg.appendChild(defs);

  for (const edge of graph.edges) {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) continue;
    _drawEdgeWithLabel(svg, edge, from, to);
  }

  for (const node of graph.nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.node = node.id;
    const selectedIndex = happyPathMarking.nodes.indexOf(node.id);
    const isSelected = selectedIndex >= 0;
    const canPick = !happyPathMarking.active || allowed.has(node.id) || isSelected;
    g.style.cursor = happyPathMarking.active ? (canPick ? 'pointer' : 'not-allowed') : 'default';
    g.style.opacity = canPick ? '1' : '0.42';
    g.addEventListener('click', () => onNodeClickedForHappyPath(node.id));

    _drawNodeShape(g, node, isSelected);
    _drawNodeText(g, node, isSelected, selectedIndex);

    svg.appendChild(g);
  }
}

function openGatewayEditor(gatewayId) {
  // Gateway clicked on canvas — highlight its section in the sidebar accordion
  const acc = $('accordionGatewayProbs');
  if (acc && !acc.open) acc.open = true;
  // Scroll the gateway's section into view in the sidebar
  const gwEl = document.querySelector(`.sgw-gateway[data-sgw-gw="${CSS.escape(gatewayId)}"]`);
  if (gwEl) {
    gwEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    gwEl.classList.add('sgw-gateway-highlight');
    setTimeout(() => gwEl.classList.remove('sgw-gateway-highlight'), 1500);
  }
}

function updateDashboard() {
  if (!graph) return;
  const sel = $('roiGateway');
  const gateways = gatewayNodes(graph);
  sel.innerHTML = gateways.map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.label || g.id)}</option>`).join('');

  let metrics;
  try {
    metrics = computeScenarioMetrics();
  } catch (e) {
    /* exibe mensagem de erro na interface */
    const base = calculateTEPAndIP(graph, 3500);
    renderExecutiveKpis(null, base);
    $('calibrationResult').textContent = e.message;
    $('frictionRanking').innerHTML = '';
    for (const item of base.ranking.slice(0, 8)) {
      const li = document.createElement('li');
      li.textContent = `${item.type} - ${item.key}: ${item.total.toFixed(1)} min acumulados`;
      $('frictionRanking').appendChild(li);
    }
    renderInsightKpis(null, base);
    renderAutomaticInterpretation(null, base);
    renderHypothesisTargets();
    return;
  }

  renderExecutiveKpis(metrics, null);

  $('calibrationResult').textContent = [
    `Estimado: TEP ideal = 100%; TEP real proporcional = ${metrics.ipRealVsIdeal.toFixed(2)}%.`,
    `Informado executor: ${Number.isFinite(metrics.ipLeadInformedVsIdeal) ? `Lead time ideal = 100%; lead informado proporcional = ${metrics.ipLeadInformedVsIdeal.toFixed(2)}%.` : 'Lead time informado nao preenchido (opcional); calculos usam o tempo padrao do motor (primeira atividade 10 min, demais 5 min, etc).'},`,
    `Automacao: ideal auto vs ideal = ${metrics.ipAutoVsIdeal.toFixed(2)}%.`,
    `Semaforos -> padrao: ${semaphoreForPhillip('standard', metrics.ipRealVsIdeal).label}; informado: ${semaphoreForPhillip('informed', metrics.ipLeadInformedVsIdeal).label}; automacao: ${semaphoreForPhillip('automation', metrics.ipAutoVsIdeal).label}.`,
    `Lead time ideal e calculado no caminho feliz informado, sem punicoes (handoff/gateway/loop).`,
    `Automacoes confirmadas para cenario auto: ${metrics.autoCount}.`,
  ].join('\n');

  renderFrictionChart(metrics);

  renderInsightKpis(metrics, null);
  renderAutomaticInterpretation(metrics, null);
  renderHypothesisTargets();
}

function applyCalibration() {
  if (!validateAndShow()) return;

  try {
    const metrics = computeScenarioMetrics();

    $('calibrationResult').textContent = [
      `Estimado -> TEP real: ${metrics.tepReal.toFixed(2)} min | TEP ideal: ${metrics.tepIdeal.toFixed(2)} min (100%)`,
      `Estimado -> TEP real proporcional: ${metrics.ipRealVsIdeal.toFixed(2)}%`,
      `Informado executor -> Lead time informado: ${Number.isFinite(metrics.leadTimeInformed) ? `${metrics.leadTimeInformed.toFixed(2)} min` : '-- (opcional nao informado)'}`,
      `Informado executor -> Lead time ideal (100%): ${metrics.leadIdeal.toFixed(2)} min`,
      `Informado executor -> Proporcional: ${Number.isFinite(metrics.ipLeadInformedVsIdeal) ? `${metrics.ipLeadInformedVsIdeal.toFixed(2)}%` : '-- (opcional nao informado)'}`,
      `TEP ideal auto: ${metrics.tepIdealAuto.toFixed(2)} min (100% na escala auto)`,
      `Comparativo ideal auto vs ideal: ${metrics.ipAutoVsIdeal.toFixed(2)}%`,
      `Semaforos -> padrao: ${semaphoreForPhillip('standard', metrics.ipRealVsIdeal).label}; informado: ${semaphoreForPhillip('informed', metrics.ipLeadInformedVsIdeal).label}; automacao: ${semaphoreForPhillip('automation', metrics.ipAutoVsIdeal).label}.`,
      `Automacoes confirmadas: ${metrics.autoCount}`,
    ].join('\n');

    updateDashboard();
  } catch (e) {
    /* exibe mensagem de erro na interface */
    $('calibrationResult').textContent = `Falha na calibracao: ${e.message}`;
    updateDashboard();
  }
}

function buildTokenSchedule() {
  if (simulationMode === 'real') {
    simRuns = simulate100Tokens(graph);
  } else {
    const happyPath = parseHappyPathRequired();
    simRuns = Array.from({ length: TOKEN_COUNT }, () => ({
      path: [...happyPath],
      reachedEnd: true,
      time: 0,
      friction: { handoffs: new Map(), gateways: new Map(), loops: new Map() },
    }));
  }

  if (simRuns.length > TOKEN_COUNT) {
    simRuns = simRuns.slice(0, TOKEN_COUNT);
  }
  if (simRuns.length < TOKEN_COUNT && simRuns.length > 0) {
    const basePath = simRuns[0].path || [];
    while (simRuns.length < TOKEN_COUNT) {
      simRuns.push({
        path: [...basePath],
        reachedEnd: true,
        time: 0,
        friction: { handoffs: new Map(), gateways: new Map(), loops: new Map() },
      });
    }
  }

  loopCounters.clear();
  return simRuns.map((run, idx) => ({
    id: idx,
    path: run.path,
    step: 0,
    progress: 0,
    color: '#1f6fb2',
    ended: false,
    launched: false,
    launchAtMs: idx * TOKEN_LAUNCH_GAP_MS,
    speedFactor: 1,
    nodeVisits: (() => {
      const first = run.path?.[0];
      return first ? { [first]: 1 } : {};
    })(),
  }));
}

function edgeBetween(a, b) {
  return graph.edges.find((e) => e.from === a && e.to === b);
}

function _calcCrossLanePenalty(from, to) {
  const a = laneMetaOf(from);
  const b = laneMetaOf(to);
  if (a.laneId === b.laneId) return 0;
  if (a.org && b.org && a.org !== b.org) return 40;
  if (a.sector && b.sector && a.sector !== b.sector) return 20;
  return 10;
}

function edgeDurationMinutes(fromId, toId) {
  const from = nodeById(fromId);
  const to = nodeById(toId);
  const edge = edgeBetween(fromId, toId);
  if (!from || !to || !edge) return 1;

  let mins = 0;
  const isIdealMode = simulationMode !== 'real';

  let toAutomated = to.automated;
  if (simulationMode === 'ideal_auto' && confirmedAutoNodes.has(to.id)) {
    toAutomated = true;
  }

  if (to.type === 'timer') mins += Number(to.timerUT || 0);
  if (to.type === 'task') mins += toAutomated ? 0.5 : 10;
  if (!isIdealMode && to.type === 'gateway') mins += 2.5;
  if (!isIdealMode && from.type === 'task' && to.type === 'task' && !from.automated && !toAutomated) {
    mins += _calcCrossLanePenalty(from, to);
  }
  if (!isIdealMode && edge.isLoopReturn) mins *= 2;
  return Math.max(mins, 0.25);
}

function drawTokens(tokens) {
  const svg = $('simCanvas');
  svg.querySelectorAll('.token').forEach((n) => n.remove());

  for (const t of tokens) {
    if (t.ended || !t.launched) continue;
    const fromId = t.path[t.step];
    const toId = t.path[t.step + 1];
    if (!toId) continue;

    const from = nodeById(fromId);
    const to = nodeById(toId);
    if (!from || !to) continue;

    const x = from.x + (to.x - from.x) * t.progress;
    const y = from.y + (to.y - from.y) * t.progress;

    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', String(x));
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '5');
    c.setAttribute('fill', t.color);
    c.setAttribute('class', 'token');
    svg.appendChild(c);
  }
}

function _classifyToken(t, edge, to, fromNode) {
  const toId = to?.id;
  const toVisits = Number(t.nodeVisits?.[toId] || 0);
  const toAutomated = Boolean(
    to?.automated
    || (simulationMode === 'ideal_auto' && confirmedAutoNodes.has(toId))
  );
  const isLoopRepeatPass = Boolean(edge?.isLoopReturn && toVisits >= 1);
  const fromMeta = fromNode ? laneMetaOf(fromNode) : null;
  const toMeta = to ? laneMetaOf(to) : null;
  const isCriticalHandoff = Boolean(
    !isLoopRepeatPass
    && fromMeta?.org && toMeta?.org
    && fromMeta.org !== toMeta.org
  );

  if (edge?.isErrorPath || (to?.type === 'end' && to?.endKind === 'error')) {
    return { color: '#c0392b', speedFactor: 1 };
  }
  if (isCriticalHandoff) {
    return { color: '#c0392b', speedFactor: 1 };
  }
  if (isLoopRepeatPass) {
    return { color: '#f39c12', speedFactor: 3.0 };
  }
  if (to?.type === 'timer') {
    return { color: '#f1c40f', speedFactor: 0.3 };
  }
  if (to?.type === 'task' && toAutomated) {
    return { color: '#8e44ad', speedFactor: 1 };
  }
  return { color: '#1f6fb2', speedFactor: 1 };
}

function _finalizeTokenStep(t, edge, toId, loopCounters) {
  if (t.progress < 1) return false;
  t.step += 1;
  t.progress = 0;

  t.nodeVisits = t.nodeVisits || {};
  t.nodeVisits[toId] = Number(t.nodeVisits[toId] || 0) + 1;

  if (edge?.isLoopReturn) {
    const current = loopCounters.get(toId) || 0;
    loopCounters.set(toId, current + 1);
    const el = document.getElementById(`loopCount-${toId}`);
    if (el) el.textContent = `Execucoes acumuladas: ${current + 1}`;
  }

  if (!t.path[t.step + 1]) t.ended = true;
  return true;
}

function _animateToken(t, simulationClockMs, dt) {
  if (t.ended) return;
  if (!t.launched) {
    if (simulationClockMs >= t.launchAtMs) t.launched = true;
    else return;
  }
  const fromId = t.path[t.step];
  const toId = t.path[t.step + 1];
  if (!toId) { t.ended = true; return; }
  const edge = edgeBetween(fromId, toId);
  const dur = edgeDurationMinutes(fromId, toId);
  t.progress += (1 / Math.max(dur, 0.1)) * dt * t.speedFactor;
  const { color, speedFactor } = _classifyToken(t, edge, nodeById(toId), nodeById(fromId));
  t.color = color;
  t.speedFactor = speedFactor;
  if (dur > 20) t.speedFactor *= 0.5;
  _finalizeTokenStep(t, edge, toId, loopCounters);
}

function animate(frameTimeMs = performance.now()) {
  if (!running) return;
  if (!animationLastTickMs) animationLastTickMs = frameTimeMs;
  const deltaMs = Math.max(1, frameTimeMs - animationLastTickMs);
  animationLastTickMs = frameTimeMs;
  const speedGlobal = Math.max(0.1, Number($('speed')?.value || 1));
  simulationClockMs += deltaMs * speedGlobal;
  const dt = (deltaMs / 1000) * 0.9 * speedGlobal;

  for (const t of globalThis.__tokens) _animateToken(t, simulationClockMs, dt);

  drawTokens(globalThis.__tokens);
  refreshLiveSimulationStatus(globalThis.__tokens);

  if (globalThis.__tokens.some((t) => !t.ended)) {
    animFrame = requestAnimationFrame(animate);
  } else {
    running = false;
    animationLastTickMs = 0;
    simulationClockMs = 0;
    refreshLiveSimulationStatus(globalThis.__tokens);
    _animatedTer = liveSimulationStatus.avgLeadTime > 0 ? liveSimulationStatus.avgLeadTime : null;
    updateDashboard();
    $('btnViewDashboard')?.classList.remove('hidden');
  }
}

function playSimulation() {
  const setupStatus = collectSetupStatus();
  const readyNow = setupStatus.graphOk && setupStatus.handoffOk && setupStatus.happyPathOk && setupStatus.leadTimeOk;
  if (!setupCompleted || !readyNow) {
    setupCompleted = false;
    openSetupModal();
    $('validationBox').innerHTML = '<span class="badge error">setup</span> Conclua o popup de preparacao antes de simular.';
    return;
  }
  if (!validateAndShow()) return;
  if (!ensureHandoffReady()) return;
  simulationMode = $('simMode')?.value || 'real';
  syncConfirmedAutoFromUi();
  _animatedTer = null; // limpa TER anterior; será recalculado ao fim desta rodada

  if (simulationMode !== 'real') {
    try {
      parseHappyPathRequired();
    } catch (e) {
      /* exibe mensagem de erro na interface */
      $('validationBox').innerHTML = `<span class="badge error">ideal</span> ${e.message}`;
      return;
    }
  }

  drawGraph();
  globalThis.__tokens = buildTokenSchedule();
  const panel = $('simLivePanel');
  if (panel) { panel.classList.remove('hidden', 'slp-done'); }
  refreshLiveSimulationStatus(globalThis.__tokens);
  running = true;
  animationLastTickMs = 0;
  simulationClockMs = 0;
  cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(animate);
}

function stopSimulation() {
  running = false;
  $('simLivePanel')?.classList.add('hidden');
  cancelAnimationFrame(animFrame);
  animationLastTickMs = 0;
  simulationClockMs = 0;
  refreshLiveSimulationStatus(globalThis.__tokens || []);
}

function renderSuggestions() {
  if (!graph) return;
  const data = scanSuggestions(graph);
  $('suggestions').innerHTML = '';

  if (!data.length) {
    $('suggestions').innerHTML = '<div class="box">Nenhuma sugestao encontrada.</div>';
    return;
  }

  for (const s of data) {
    const row = document.createElement('div');
    row.className = 'box';

    const kindBadge = s.kind === 'loop'
      ? '<span class="badge loop">loop</span>'
      : '<span class="badge auto">automacao</span>';

    row.innerHTML = `<strong>${s.message}</strong> ${kindBadge}`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = s.kind === 'loop' ? 'Aplicar Loop 30%' : 'Marcar Automatizada';
    btn.onclick = () => {
      if (s.kind === 'loop') {
        graph = setLoopProbability(graph, s.nodeId, 30);
      } else {
        graph = markAutomation(graph, s.nodeId, true);
      }
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
    };

    row.appendChild(document.createElement('br'));
    row.appendChild(btn);
    $('suggestions').appendChild(row);
  }
}

function hypothesisTargets(type) {
  if (!graph) return [];
  if (type === 'gateway') {
    return (graph.nodes || [])
      .filter((n) => n.type === 'gateway')
      .map((n) => ({ value: n.id, label: `${n.label || n.id} (${n.id})` }));
  }
  if (type === 'loop') {
    return (graph.edges || [])
      .filter((e) => e.isLoopReturn)
      .map((e) => ({ value: e.id, label: `${e.id}: ${e.from} -> ${e.to}` }));
  }
  if (type === 'handoff') {
    return crossLaneTransitions().map((t) => ({ value: t.key, label: `${t.fromName} -> ${t.toName}` }));
  }
  return [];
}

function renderHypothesisTargets() {
  const type = $('hypothesisType')?.value || 'gateway';
  const sel = $('hypothesisTarget');
  const help = $('hypothesisHelp');
  if (!sel || !help) return;

  const items = hypothesisTargets(type);
  if (!items.length) {
    sel.innerHTML = '<option value="">Sem alvos disponiveis</option>';
    help.textContent = 'Nao ha itens disponiveis para este tipo no processo atual.';
    return;
  }

  sel.innerHTML = items.map((it) => `<option value="${escapeHtml(it.value)}">${escapeHtml(it.label)}</option>`).join('');

  if (type === 'gateway') help.textContent = 'Hipotese: retirar etapa de aprovacao (gateway).';
  else if (type === 'loop') help.textContent = 'Hipotese: remover retorno de retrabalho (loop).';
  else help.textContent = 'Hipotese: reduzir atrito de handoff para mesma equipe.';
}

function _applyGatewayHypothesis(projectedGraph, target) {
  const node = (projectedGraph.nodes || []).find((n) => n.id === target);
  if (node) {
    node.type = 'task';
    node.automated = true;
    node.label = `${node.label || node.id} (removido)`;
  }
}

function _applyLoopHypothesis(projectedGraph, target) {
  const edge = (projectedGraph.edges || []).find((e) => e.id === target);
  if (edge) {
    const fromId = edge.from;
    edge.isLoopReturn = false;
    const siblings = (projectedGraph.edges || []).filter((e) => e.from === fromId && e.id !== edge.id);
    const removedProb = Number(edge.probability || 0);
    edge.probability = 0;
    if (siblings.length && removedProb > 0) {
      const add = removedProb / siblings.length;
      for (const s of siblings) s.probability = Number(s.probability || 0) + add;
    }
  }
}

function _applyHandoffHypothesis(projectedGraph, target) {
  projectedGraph.handoffRules = projectedGraph.handoffRules || {};
  projectedGraph.handoffRules[target] = 'same_team';
}

function runHypothesisSimulation() {
  if (!validateAndShow()) return;
  const type = $('hypothesisType')?.value || 'gateway';
  const target = $('hypothesisTarget')?.value || '';
  const out = $('hypothesisResult');
  if (!out) return;
  if (!target) {
    out.textContent = 'Selecione um alvo para simular.';
    return;
  }

  const baseline = calculateTEPAndIP(graph, 2500);
  const projectedGraph = cloneLocal(graph);

  if (type === 'gateway') {
    _applyGatewayHypothesis(projectedGraph, target);
  } else if (type === 'loop') {
    _applyLoopHypothesis(projectedGraph, target);
  } else if (type === 'handoff') {
    _applyHandoffHypothesis(projectedGraph, target);
  }

  const projected = calculateTEPAndIP(projectedGraph, 2500);
  const gainMin = baseline.tepReal - projected.tepReal;
  const gainPct = baseline.tepReal > 0 ? (gainMin / baseline.tepReal) * 100 : 0;

  out.textContent = [
    `TEP real atual: ${baseline.tepReal.toFixed(2)} min`,
    `TEP real projetado: ${projected.tepReal.toFixed(2)} min`,
    `Ganho estimado: ${gainMin.toFixed(2)} min (${gainPct.toFixed(2)}%)`,
  ].join('\n');
}

function runRoi() {
  if (!validateAndShow()) return;
  const gatewayId = $('roiGateway').value;
  const current = Number($('roiCurrent').value || 30);
  const target = Number($('roiTarget').value || 10);
  const roi = simulateRoi(graph, gatewayId, current, target);

  $('roiResult').textContent = `${roi.note}\nIP atual: ${roi.base.ip.toFixed(2)}%\nIP projetado: ${roi.projected.ip.toFixed(2)}%\nDelta: ${roi.delta.toFixed(2)} p.p.`;
}

function _formatLeadTimeInformedLine(metrics) {
  if (Number.isFinite(metrics.leadTimeInformed)) {
    return `Lead time informado: ${metrics.leadTimeInformed.toFixed(2)} min | Proporcao: ${metrics.ipLeadInformedVsIdeal.toFixed(2)}%`;
  }
  return 'Lead time informado: nao informado (opcional)';
}

function _buildReportText(metrics) {
  const top = metrics.ranking.slice(0, 5).map((r, i) => `${i + 1}. ${r.type} - ${r.key} (${r.total.toFixed(1)} min)`).join('\n');
  return [
    'RELATORIO AUTOMATICO - SIMULADOR DE PROCESSOS',
    'BLOCO ESTIMADO',
    `TEP ideal: ${metrics.tepIdeal.toFixed(2)} min | Base: ${metrics.ipIdeal.toFixed(2)}%`,
    `TEP real: ${metrics.tepReal.toFixed(2)} min | Proporcao: ${metrics.ipRealVsIdeal.toFixed(2)}%`,
    '',
    'BLOCO INFORMADO PELO EXECUTOR',
    `Lead time ideal (caminho feliz sem punicoes): ${metrics.leadIdeal.toFixed(2)} min | Base: ${metrics.ipLeadIdeal.toFixed(2)}%`,
    _formatLeadTimeInformedLine(metrics),
    '',
    'BLOCO IDEAL AUTO',
    `TEP ideal auto: ${metrics.tepIdealAuto.toFixed(2)} min | Indice(auto): ${metrics.ipIdealAuto.toFixed(2)}%`,
    `Comparativo ideal auto vs ideal: ${metrics.ipAutoVsIdeal.toFixed(2)}%`,
    `Automacoes confirmadas: ${metrics.autoCount}`,
    '',
    'Ranking de Atrito:',
    top || 'Sem atritos relevantes.',
    '',
    'Observacao: Validar loops e handoffs para ganho de eficiencia.',
  ].join('\n');
}

function generateReport() {
  if (!validateAndShow()) return;
  let metrics;
  try {
    metrics = computeScenarioMetrics();
    _lastSimMetrics = metrics;
  } catch (e) {
    /* exibe mensagem de erro na interface */
    $('reportBox').textContent = `Falha no relatorio: ${e.message}`;
    return;
  }

  $('reportBox').textContent = _buildReportText(metrics);
}

function formatExtractionSource(endpointUsed, file) {
  const endpoint = String(endpointUsed || '').toLowerCase();
  const localXlsx = endpoint.includes('/parse-xlsx') || endpoint.includes('parse-xlsx');
  const spreadsheet = isSpreadsheetFile(file);

  if (spreadsheet && localXlsx) {
    return 'Fonte: parser local de planilha (/parse-xlsx). IA: nao utilizada.';
  }
  if (spreadsheet) {
    return `Fonte: ${endpointUsed || 'desconhecida'}.`;
  }
  return `Fonte: ${endpointUsed || 'desconhecida'}.`;
}

async function runVisionExtract() {
  const btn = $('btnExtractVision');
  const fileInput = $('fileInput');
  const out = $('cvOutput');
  if (!fileInput || !out) return;

  const file = fileInput.files?.[0];
  if (!file) {
    out.textContent = 'Selecione um arquivo BPMN antes de extrair.';
    fileInput.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Extraindo...';
  }

  out.textContent = `Processando arquivo: ${file.name}`;
  try {
    let extraction;
    if (isSpreadsheetFile(file)) {
      extraction = await extractTopologyFromSpreadsheetFile(file, '/api/ai');
    } else if (isWorkflowXmlFile(file)) {
      extraction = await extractTopologyFromWorkflowFile(file);
    } else {
      extraction = await extractTopologyFromImage(file, '/api/ai');
    }

    const { graph: g, rawText, endpointUsed, imageDataUrl } = extraction;
    extractedGraph = normalizeGraph(g);

    const tasks = (extractedGraph.nodes || []).filter((n) => n.type === 'task');
    const unidentifiedTasks = tasks.filter((n) => !String(n?.lane || n?.executor || '').trim());
    let fallbackNote = '';
    if (unidentifiedTasks.length) {
      const catalog = await fetchSigaActorCatalog();
      const filled = fillMissingActorsFromCatalog(extractedGraph, catalog);
      if (filled > 0) {
        fallbackNote = `\n\nFallback atores SIGA: ${filled} tarefa(s) sem ator receberam '${catalog[0]}'.`;
      }
    }

    sourceDiagramDataUrl = String(imageDataUrl || '');
    const sourceLine = formatExtractionSource(endpointUsed, file);
    out.textContent = `${sourceLine}\n\nExtracao concluida via ${endpointUsed}.\n\n${rawText}${fallbackNote}`;
    renderHandoffWizard();
    renderSetupChecklist();
    drawGraph();
    renderSetupPathPicker();
  } catch (e) {
    /* exibe mensagem de erro na interface */
    out.textContent = `Falha na extracao: ${e.message}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Extrair/Importar Topologia';
    }
  }
}

function renderTimerSetup() {
  const box = $('timerSetup');
  if (!box) return;
  const timers = (graph?.nodes || []).filter((n) => n.type === 'timer');
  if (!timers.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <h3>⏱ Eventos Timer — Defina as UTs de Espera</h3>
    <div class="box" style="font-size:12px;margin-bottom:8px;">
      O fluxo contém <strong>${timers.length}</strong> evento(s) timer (semáforo vermelho).
      Informe quantas <strong>UT</strong> cada timer deve aguardar antes de liberar o fluxo.
      <br>Exemplo: aguardar aprovação externa = 40 UT, aguardar prazo regulatório = 80 UT.
    </div>
    ${timers.map((n) => `
      <label class="field" style="display:grid;grid-template-columns:1fr 100px;gap:8px;align-items:center;">
        <span>⏱ <strong>${n.label}</strong></span>
        <input type="number" min="0" step="0.5" value="${n.timerUT || 0}"
               data-timer-id="${n.id}" placeholder="UT" />
      </label>`).join('')}
    <button id="btnSaveTimers" type="button" style="margin-top:6px;">Salvar UTs dos Timers</button>
    <div id="timerSaveMsg" style="font-size:12px;color:#23b26d;margin-top:4px;"></div>`;

  $('btnSaveTimers').addEventListener('click', () => {
    box.querySelectorAll('[data-timer-id]').forEach((input) => {
      const nId = input.dataset.timerId;
      const node = (graph?.nodes || []).find((n) => n.id === nId);
      if (node) node.timerUT = Math.max(0, Number(input.value) || 0);
    });
    $('graphJson').value = JSON.stringify(graph, null, 2);
    $('timerSaveMsg').textContent = 'UTs salvas. O simulador usará esses valores.';
    drawGraph();
  });
}

function applyExtracted() {
  if (!extractedGraph) {
    $('cvOutput').textContent = 'Nenhuma topologia extraida para aplicar.';
    return;
  }
  graph = normalizeGraph(extractedGraph);
  normalizeActorCodesInGraph();
  autoAssignComplexityDefaults();
  $('graphJson').value = JSON.stringify(graph, null, 2);
  refreshAll();
  renderTimerSetup();
  renderHandoffWizard();
}

function refreshAll() {
  drawGraph();
  validateAndShow();
  renderSetupTaskMatrix();
  renderHandoffSetup();
  renderHandoffWizard();
  renderSetupPathPicker();
  renderSetupGatewayEditor();
  renderSetupAutomationEditor();
  renderSetupLoopEditor();
  renderTimerSetup();
  renderAutomationConfirm();
  updateDashboard();
  renderSuggestions();
  renderSetupChecklist();
  renderHypothesisTargets();
  renderSidebarGatewayEditor();
}

// ═══════════════════════════════════════════════════════════════════
// BPMN 2.0 EDITOR INTEGRADO
// ═══════════════════════════════════════════════════════════════════

let _bpmnModeler = null;

const DEFAULT_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" name="Processo" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" name="Início"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="_BPMNShape_StartEvent_2" bpmnElement="StartEvent_1">
        <dc:Bounds x="172" y="102" width="36" height="36"/>
        <bpmndi:BPMNLabel><dc:Bounds x="165" y="145" width="50" height="14"/></bpmndi:BPMNLabel>
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

function initBpmnModeler() {
  if (_bpmnModeler) return;
  const BpmnJS = globalThis.BpmnJS;
  if (!BpmnJS) {
    console.error('[SimBPMN] BpmnJS não encontrado. Verifique o CDN.');
    return;
  }
  const container = $('bpmnContainer');
  if (!container) { console.error('[SimBPMN] #bpmnContainer não encontrado.'); return; }
  _bpmnModeler = new BpmnJS({ container, keyboard: { bindTo: globalThis } });
}

async function loadDefaultBpmn() {
  if (!_bpmnModeler) return;
  try {
    await _bpmnModeler.importXML(DEFAULT_BPMN);
    _bpmnModeler.get('canvas').zoom('fit-viewport');
  } catch (e) {
    /* erro nao-fatal — registra aviso */
    console.warn('[SimBPMN] Erro ao carregar diagrama padrão:', e.message);
  }
}

// Mostra o overlay de escolha de entrada (chamado na inicialização)
function showEntryChoice() {
  const overlay = $('entryChoiceOverlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideEntryChoice() {
  const overlay = $('entryChoiceOverlay');
  if (overlay) overlay.classList.add('hidden');
}

// Abre o painel do editor BPMN 2.0
function showBpmnEditor() {
  hideEntryChoice();
  const panel = $('bpmnEditorPanel');
  if (panel) panel.classList.remove('hidden');
  initBpmnModeler();
  loadDefaultBpmn();
}

// Fecha o editor BPMN e volta para o overlay de entrada
function hideBpmnEditor() {
  const panel = $('bpmnEditorPanel');
  if (panel) panel.classList.add('hidden');
}

// Modo importação: fecha overlay e abre o setup modal na seção 1 (arquivo)
function startImportMode() {
  hideEntryChoice();
  openSetupModal();
  // Rola até a seção 1 para deixar o fileInput em evidência
  setTimeout(() => {
    const fileInput = $('fileInput');
    if (fileInput) fileInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 200);
}

// Extrai a topologia do editor BPMN e aplica ao simulador
async function applyFromBpmnEditor() {
  const btn = $('btnBpmnApply');
  if (!_bpmnModeler) {
    alert('Editor BPMN não inicializado.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Processando…'; }
  try {
    const { xml } = await _bpmnModeler.saveXML({ format: true });
    // Cria um File virtual para reusar o pipeline de extração de cv.js
    const file = new File([xml], 'diagrama.bpmn', { type: 'application/xml' });
    const extraction = await extractTopologyFromWorkflowFile(file);
    const { graph: g } = extraction;
    if (!g || !g.nodes || g.nodes.length === 0) {
      alert('Nenhuma topologia extraída do diagrama.\nAdicione atividades ao processo antes de aplicar.');
      return;
    }
    extractedGraph = normalizeGraph(g);
    // Fecha o editor e abre o setup modal para preencher os detalhes (Seção 2 em diante)
    hideBpmnEditor();
    applyExtracted();
    openSetupModal();
    const out = $('cvOutput');
    if (out) out.textContent = `Topologia extraída do Editor BPMN: ${g.nodes.length} nó(s), ${(g.edges || []).length} aresta(s).`;
  } catch (e) {
    /* notifica o usuario do erro */
    console.error('[SimBPMN] applyFromBpmnEditor:', e);
    alert('Erro ao extrair topologia: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Aplicar ao Simulador'; }
  }
}

// Exporta o BPMN como arquivo .bpmn
async function exportBpmnFile() {
  if (!_bpmnModeler) return;
  try {
    const { xml } = await _bpmnModeler.saveXML({ format: true });
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'processo.bpmn';
    a.click();
  } catch (e) {
    /* notifica o usuario do erro */
    alert('Erro ao exportar: ' + e.message);
  }
}

function wireEvents() {
  $('btnLoadSample')?.addEventListener('click', loadSample);
  $('btnValidate')?.addEventListener('click', () => {
    validateAndShow();
    drawGraph();
    updateDashboard();
    renderSetupChecklist();
  });
  $('btnScanSuggestions')?.addEventListener('click', () => {
    if (parseEditorGraph()) renderSuggestions();
    renderAutomationConfirm();
    renderSetupChecklist();
  });
  $('btnMarkHappyPath')?.addEventListener('click', () => {
    if (parseEditorGraph()) toggleHappyPathMarking();
    renderSetupChecklist();
  });
  $('btnSuggestHappyPath')?.addEventListener('click', applySuggestedHappyPath);
  $('btnClearHappyPath')?.addEventListener('click', clearHappyPathMarking);
  $('btnUndoSetupPath')?.addEventListener('click', undoHappyPathMarking);
  $('btnSuggestSetupPath')?.addEventListener('click', applySuggestedHappyPath);
  $('btnSetupHandoff')?.addEventListener('click', () => {
    if (parseEditorGraph()) renderHandoffSetup();
    renderSetupChecklist();
  });
  $('btnEditSetup')?.addEventListener('click', () => {
    if (parseEditorGraph()) openSetupModal();
    else openSetupModal();
  });
  $('simMode')?.addEventListener('change', () => {
    simulationMode = $('simMode').value;
  });
  $('autoConfirmBox')?.addEventListener('change', () => {
    syncConfirmedAutoFromUi();
    updateDashboard();
  });
  $('happyPath')?.addEventListener('input', renderSetupChecklist);
  // NOTA: leadTimeInformed usa 'change' (ao sair do campo), NÃO 'input',
  // para evitar bloquear a digitação com cálculos síncronos pesados.
  $('setupHappyPath')?.addEventListener('input', () => {
    syncSetupInputsToMain();
    renderSetupChecklist();
  });
  $('setupLeadTime')?.addEventListener('input', () => {
    syncSetupInputsToMain();
    renderSetupChecklist();
  });
  // handoffWizard agora é apenas exibição — sem interação do usuário
  // (handoffs são classificados automaticamente com base nos perfis das raias)
  $('setupGatewayEditor')?.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!target || !target.id) return;
    if (target.id === 'btnSetupApplyGateway') {
      applySetupGatewayEdits();
      return;
    }
    if (target.id === 'btnSetupAutoGateway') {
      autoFixGatewayProbabilitiesInGraph();
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
    }
  });
  $('setupAutomationEditor')?.addEventListener('change', () => {
    saveSetupAutomationSelection();
    refreshAll();
  });
  $('setupTaskMatrix')?.addEventListener('change', (ev) => {
    const t = ev.target;
    // Select de complexidade: salva e atualiza dashboard
    if (t.matches('select[data-task-complexity]')) {
      saveSetupTaskMatrixFromForm();
      renderSetupChecklist();
      if (graph) updateDashboard();
      return;
    }
    // Checkbox de automação: trata interdependência e faz refresh completo
    if (t.matches('input[data-task-automated], input[data-task-potential]')) {
      document.querySelectorAll('input[data-task-automated]').forEach((autoEl) => {
        const id = String(autoEl.dataset.taskAutomated || '');
        if (!id) return;
        const potentialEl = document.querySelector(`input[data-task-potential="${CSS.escape(id)}"]`);
        if (!potentialEl) return;
        if (autoEl.checked) {
          potentialEl.checked = false;
          potentialEl.disabled = true;
        } else {
          potentialEl.disabled = false;
        }
      });
      saveSetupAutomationSelection();
      refreshAll();
    }
  });

  // Ator/raia: salva e atualiza perfis + handoffs sem recriar o task matrix
  $('setupTaskMatrix')?.addEventListener('blur', (ev) => {
    const t = ev.target;
    if (t.matches('input[data-task-actor]')) {
      saveSetupTaskMatrixFromForm();
      renderSetupLaneProfiles();
      renderHandoffWizard();
      renderSetupChecklist();
    }
  }, true); // capture=true para capturar blur

  // Perfis de raia (equipe/órgão): auto-aplica handoffs em tempo real
  $('setupTaskMatrix')?.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-lp-team], [data-lp-org]')) {
      saveSetupTaskMatrixFromForm();
      renderHandoffWizard();
      renderSetupChecklist();
    }
  });
  $('setupLoopEditor')?.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t) return;

    if (t.id === 'btnSetupAddLoop') {
      const fromId = String($('setupLoopFrom')?.value || '');
      const toId = String($('setupLoopTo')?.value || '');
      const p = Number($('setupLoopProb')?.value || 30);
      if (!fromId || !toId || fromId === toId) return;
      addOrUpdateLoopEdge(fromId, toId, p);
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
      return;
    }

    const removeId = String(t.getAttribute?.('data-loop-remove-edge') || '');
    if (removeId) {
      removeLoopEdge(removeId);
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
      return;
    }

    if (t.id === 'btnSetupApplyLoopProb') {
      applyLoopProbInputs();
      $('graphJson').value = JSON.stringify(graph, null, 2);
      refreshAll();
    }
  });
  $('btnClearSetupPath')?.addEventListener('click', clearHappyPathMarking);
  $('hypothesisType')?.addEventListener('change', renderHypothesisTargets);
  $('btnRunHypothesis')?.addEventListener('click', runHypothesisSimulation);
  $('btnPlay')?.addEventListener('click', playSimulation);
  $('btnStop')?.addEventListener('click', stopSimulation);
  $('btnViewDashboard')?.addEventListener('click', revealDashboard);
  $('btnReadyToSimulate')?.addEventListener('click', completeSetup);
  $('btnApplyCalibration')?.addEventListener('click', applyCalibration);
  $('btnResetRules')?.addEventListener('click', () => { resetRulesToDefaults(); applyCalibration(); });
  $('btnSimulateRoi')?.addEventListener('click', runRoi);

  // ── T.P. e T.P.E.: recalcular automaticamente ao alterar valor ou unidade ──
  $('leadTimeInformed')?.addEventListener('change',       () => { if (graph) updateDashboard(); });
  $('tpUnit')?.addEventListener('change',                 () => { if (graph) updateDashboard(); });
  $('processingTimeInformed')?.addEventListener('change', () => { if (graph) updateDashboard(); });
  $('tpeUnit')?.addEventListener('change',                () => { if (graph) updateDashboard(); });
  $('setupProcessingTime')?.addEventListener('change',    () => {
    syncSetupInputsToMain();
    if (graph) updateDashboard();
  });
  $('btnReport')?.addEventListener('click', generateReport);
  const btnExtract = $('btnExtractVision');
  if (btnExtract) {
    btnExtract.addEventListener('click', runVisionExtract);
    // Fallback defensivo para cenarios onde addEventListener falha silenciosamente.
    btnExtract.onclick = runVisionExtract;
  }

  const btnApply = $('btnApplyExtracted');
  if (btnApply) {
    btnApply.addEventListener('click', applyExtracted);
    btnApply.onclick = applyExtracted;
  }

  // ── Entry Choice ─────────────────────────────────────────────────
  $('btnChoiceDrawBpmn')?.addEventListener('click', showBpmnEditor);
  $('btnChoiceImport')?.addEventListener('click', startImportMode);
  $('btnChoiceSkip')?.addEventListener('click', () => {
    hideEntryChoice();
    // carrega o exemplo padrão e vai direto para o workspace
    loadSample();
  });

  // ── BPMN Editor Toolbar ──────────────────────────────────────────
  $('btnBpmnApply')?.addEventListener('click', applyFromBpmnEditor);
  $('btnBpmnBack')?.addEventListener('click', () => { hideBpmnEditor(); showEntryChoice(); });
  $('btnBpmnFit')?.addEventListener('click', () => {
    try { _bpmnModeler?.get('canvas').zoom('fit-viewport'); } catch (e) { console.warn('[simulator]', e); }
  });
  $('btnBpmnUndo')?.addEventListener('click', () => {
    try { _bpmnModeler?.get('commandStack').undo(); } catch (e) { console.warn('[simulator]', e); }
  });
  $('btnBpmnRedo')?.addEventListener('click', () => {
    try { _bpmnModeler?.get('commandStack').redo(); } catch (e) { console.warn('[simulator]', e); }
  /* tratamento de erro */
  });
  $('btnBpmnExport')?.addEventListener('click', exportBpmnFile);
}

function wireGlobalFallbackClicks() {
  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.id) return;

    if (t.id === 'btnExtractVision') {
      const out = $('cvOutput');
      if (out && !out.textContent.trim()) {
        out.textContent = 'Clique detectado em Extrair Topologia via IA.';
      }
    }
  });
}

// ─── SIGA Bridge (postMessage) ─────────────────────────────────
// Allows the parent SIGA frame to push a saved graph into the simulator
// and receive back the current graph when the user saves.

let _sigaPopKey = null; // key of the POP opened from SIGA (e.g. "d" or "pop_abc123")

function saveToSIGA() {
  if (!graph) { alert('Nenhum grafo carregado para salvar.'); return; }
  const btn = $('btnSaveToSiga');
  if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
  try {
    // Tenta capturar métricas atuais; falha silenciosamente se não for possível
    let simResults = _lastSimMetrics;
    if (!simResults) {
      try { simResults = computeScenarioMetrics(); _lastSimMetrics = simResults; } catch (_) { console.warn('[simulator]', _); }
    }
    // Payload simplificado para serialização (remove estruturas grandes como ranking completo)
    const simSummary = simResults ? {
      ter:       simResults.ter,
      top:       simResults.top,
      topAuto:   simResults.topAuto,
      terAuto:   simResults.terAuto,
      ip:        simResults.ipRealVsIdeal,
      ipAuto:    simResults.ipAutoVsIdeal,
      kFactor:   simResults.kFactor,
      tempoGaveta: simResults.tempoGaveta,
      complexidade: simResults.complexidade,
      savedAt:   new Date().toISOString(),
    } : null;

    globalThis.parent.postMessage(
      {
        type: 'SIMULATOR_SAVE',
        payload: {
          graph:         cloneLocal(graph),
          popKey:        _sigaPopKey,
          linkedProcess: _linkedProcess || null,
          simResults:    simSummary,
        },
      },
      globalThis.location.origin
    );
    if (btn) {
      btn.textContent = '✅ Salvo no SIGA';
      setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Salvar no SIGA'; }, 2000);
    }
  } catch (e) {
    /* erro nao-fatal — registra aviso */
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar no SIGA'; }
    console.warn('[Simulator] saveToSIGA falhou:', e);
  }
}

function _handleMsgLoadGraph(ev, msg) {
  const { graph: g, popName, popKey } = msg.payload || {};
  _sigaPopKey = popKey || null;
  const titleEl = document.querySelector('.topbar h1');
  if (titleEl && popName) titleEl.textContent = `Simulador — ${popName}`;
  const saveBtn = $('btnSaveToSiga');
  if (saveBtn) saveBtn.style.display = popKey ? 'inline-flex' : 'none';
  if (g && g.nodes && g.edges) {
    graph = normalizeGraph(g);
    normalizeActorCodesInGraph();
    $('graphJson').value = JSON.stringify(graph, null, 2);
    refreshAll();
    revealDashboard();
  }
  ev.source?.postMessage({ type: 'SIMULATOR_READY', popKey }, globalThis.location.origin);
}

function _handleMsgProcessList(msg) {
  const { list } = msg.payload || {};
  if (Array.isArray(list) && list.length) {
    _sigaProcessList = list;
    if (!$('setupModal')?.classList.contains('hidden')) renderSetupSection0();
  }
}

function _dispatchSimulatorMessage(ev, msg) {
  if (msg.type === 'SIGA_LOAD_GRAPH') { _handleMsgLoadGraph(ev, msg); return; }
  if (msg.type === 'SIGA_REQUEST_GRAPH' && graph) {
    ev.source?.postMessage({ type: 'SIMULATOR_SAVE', payload: { graph: cloneLocal(graph), popKey: _sigaPopKey } }, globalThis.location.origin);
  }
  if (msg.type === 'SIGA_PROCESS_LIST') _handleMsgProcessList(msg);
}

globalThis.addEventListener('message', (ev) => {
  if (ev.origin !== globalThis.location.origin) return;
  try {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    _dispatchSimulatorMessage(ev, msg);
  } catch (e) {
    console.warn('[Simulator] message handler error:', e);
  }
});

// ── Wire save button ────────────────────────────────────────
$('btnSaveToSiga')?.addEventListener('click', saveToSIGA);

try {
  wireEvents();
  wireGlobalFallbackClicks();
  $('btnViewDashboard')?.classList.remove('hidden');
  loadSample();          // carrega exemplo no background (JSON visível mas tela coberta)
  showEntryChoice();     // primeiro passo: overlay de escolha de entrada
} catch (e) {
  /* exibe mensagem de erro na interface */
  const out = $('cvOutput');
  if (out) out.textContent = `Falha ao inicializar interface: ${e.message}`;
  const v = $('validationBox');
  if (v) v.textContent = `Falha ao inicializar interface: ${e.message}`;
}
