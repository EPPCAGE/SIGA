import {
  normalizeGraph,
  validateProbabilities,
  validateGraphIntegrity,
  calculateTEPAndIP,
  calculatePathTime,
  simulate100Tokens,
  gatewayNodes,
  outgoing,
  applyGatewayProbabilities,
  simulateRoi,
} from './engine.js';
import { scanSuggestions, markAutomation, setLoopProbability } from './assistant.js';
import { extractTopologyFromImage, extractTopologyFromSpreadsheetFile, extractTopologyFromWorkflowFile } from './cv.js';

const $ = (id) => document.getElementById(id);

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

const TOKEN_COUNT = 100;
const TOKEN_LAUNCH_GAP_MS = 500;

function cloneLocal(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeTextKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
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
  const normalized = s.replace(/[{}]/g, '');
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
  const probs = edges.map((e) => Number(e?.probability || 0));
  const hasAnyPositive = probs.some((p) => Number.isFinite(p) && p > 0);
  if (hasAnyPositive) {
    const map = {};
    for (const e of edges) map[e.id] = Number(e.probability || 0);
    return map;
  }

  const parts = splitPercentages(edges.length);
  const map = {};
  for (let i = 0; i < edges.length; i += 1) {
    map[edges[i].id] = parts[i];
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
  const vals = edges.map((e) => Math.max(0, Number(e?.probability || 0)));
  const sum = vals.reduce((a, b) => a + b, 0);

  if (!Number.isFinite(sum) || sum <= 0) {
    const fallback = splitPercentages(edges.length);
    const out = {};
    for (let i = 0; i < edges.length; i += 1) out[edges[i].id] = fallback[i];
    return out;
  }

  const out = {};
  let acc = 0;
  for (let i = 0; i < edges.length; i += 1) {
    const id = edges[i].id;
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
    others[others.length - 1].probability = Number((Number(others[others.length - 1].probability || 0) + drift).toFixed(2));
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

function escapeHtml(text) {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
    return `<label class="check-row"><input type="checkbox" data-auto-node="${id}" ${checked}> ${n?.label || id}</label>`;
  }).filter(Boolean).join('');

  box.innerHTML = `<div class="box" style="margin-bottom:6px;">Sugestoes de automacao detectadas. Confirme as que entram no cenario "TEP ideal auto".</div>${rows}`;
}

function syncConfirmedAutoFromUi() {
  const boxes = document.querySelectorAll('input[data-auto-node]');
  if (!boxes.length) return;

  const next = new Set();
  boxes.forEach((el) => {
    if (!el.checked) return;
    const id = String(el.getAttribute('data-auto-node') || '').trim();
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
    const queue = (outgoingMap.get(start.id) || []).map((id) => ({ id, depth: 1 }));
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

      if (node.type === 'task' && node.id !== start.id) {
        reachedTasks.add(node.id);
        continue;
      }

      for (const nextId of outgoingMap.get(current.id) || []) {
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
    }

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
    { v: 'different_org', t: 'Outro orgao' },
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
    box.textContent = 'Carregue um grafo para a IA reconhecer as raias.';
    return;
  }

  graph.handoffRules = graph.handoffRules || {};
  graph.handoffActionRules = graph.handoffActionRules || {};
  const pairs = crossLaneTransitions();
  const actionPairs = actionTransitionPairs();

  const options = handoffTypeOptions();

  const relations = pairs.map((p) => {
    const current = graph.handoffRules?.[p.key] || '';
    const opts = options
      .map((o) => `<option value="${o.v}" ${o.v === current ? 'selected' : ''}>${o.t}</option>`)
      .join('');
    return `
      <div class="handoff-rel-row">
        <div><strong>${p.fromName}</strong> -> <strong>${p.toName}</strong></div>
        <select data-handoff-key="${p.key}">${opts}</select>
      </div>`;
  }).join('');

  const emptyMsg = pairs.length
    ? ''
    : '<div class="box" style="margin-top:8px;">Nao foram encontradas transicoes entre atores. Revise os atores na matriz de atividades para gerar handoffs automaticamente.</div>';

  const actionPairOpts = ['<option value="">Selecione origem -> destino</option>']
    .concat(actionPairs.map((p) => `<option value="${p.key}">${escapeHtml(p.fromLabel)} -> ${escapeHtml(p.toLabel)}</option>`))
    .join('');

  const actionRulesRows = Object.entries(graph.handoffActionRules || {}).map(([k, v]) => {
    const [fromId, toId] = String(k).split('->');
    const opts = options
      .map((o) => `<option value="${o.v}" ${o.v === String(v || '') ? 'selected' : ''}>${o.t}</option>`)
      .join('');
    return `
      <div class="handoff-rel-row" style="grid-template-columns:1.4fr 1fr auto;">
        <div><strong>${escapeHtml(actionLabelById(fromId))}</strong> -> <strong>${escapeHtml(actionLabelById(toId))}</strong></div>
        <select data-handoff-action-key="${escapeHtml(k)}">${opts}</select>
        <button type="button" data-remove-action-handoff="${escapeHtml(k)}">Remover</button>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div class="box" style="margin-bottom:8px;">As transicoes abaixo sao calculadas a partir dos atores definidos na matriz de atividades.</div>
    ${emptyMsg}
    ${relations}
    <div class="box" style="margin-top:10px;">Handoff manual por acao (origem -> destino):</div>
    <div class="handoff-rel-row" style="grid-template-columns:1.4fr 1fr auto;">
      <select id="manualHandoffActionPair">${actionPairOpts}</select>
      <select id="manualHandoffType">${options.map((o) => `<option value="${o.v}">${o.t}</option>`).join('')}</select>
      <button id="addManualHandoffBtn" type="button">Adicionar</button>
    </div>
    ${actionRulesRows || '<div class="box">Nenhum handoff manual por acao cadastrado.</div>'}`;

  const addBtn = $('addManualHandoffBtn');
  if (addBtn) {
    addBtn.onclick = () => {
      const pair = String($('manualHandoffActionPair')?.value || '');
      const type = String($('manualHandoffType')?.value || '');
      if (!pair || !type) return;
      graph.handoffActionRules = graph.handoffActionRules || {};
      graph.handoffActionRules[pair] = type;
      $('graphJson').value = JSON.stringify(graph, null, 2);
      renderHandoffWizard();
      renderSetupChecklist();
    };
  }

  box.querySelectorAll('[data-remove-action-handoff]').forEach((el) => {
    el.addEventListener('click', () => {
      const key = el.getAttribute('data-remove-action-handoff');
      if (!key) return;
      graph.handoffActionRules = graph.handoffActionRules || {};
      delete graph.handoffActionRules[key];
      $('graphJson').value = JSON.stringify(graph, null, 2);
      renderHandoffWizard();
      renderSetupChecklist();
    });
  });
}

function syncActorAssignmentsFromWizard() {
  if (!graph) return;
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  document.querySelectorAll('input[data-actor-node]').forEach((el) => {
    const nodeId = el.getAttribute('data-actor-node');
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
    const key = el.getAttribute('data-handoff-key');
    const val = String(el.value || '');
    if (val) graph.handoffRules[key] = val;
    else delete graph.handoffRules[key];
  });
  document.querySelectorAll('select[data-handoff-action-key]').forEach((el) => {
    const key = el.getAttribute('data-handoff-action-key');
    const val = String(el.value || '');
    if (val) graph.handoffActionRules[key] = val;
    else delete graph.handoffActionRules[key];
  });
  $('graphJson').value = JSON.stringify(graph, null, 2);
}

function syncSetupInputsToMain() {
  const setupPath = $('setupHappyPath');
  const setupLead = $('setupLeadTime');
  if (setupPath && $('happyPath')) $('happyPath').value = setupPath.value;
  if (setupLead && $('leadTimeInformed')) $('leadTimeInformed').value = setupLead.value;
}

function syncMainInputsToSetup() {
  const setupPath = $('setupHappyPath');
  const setupLead = $('setupLeadTime');
  if (setupPath && $('happyPath')) setupPath.value = $('happyPath').value;
  if (setupLead && $('leadTimeInformed')) setupLead.value = $('leadTimeInformed').value;
}

function isHandoffReadyLocal() {
  const transitions = crossLaneTransitions();
  const hasManualActionRules = Object.keys(graph?.handoffActionRules || {}).length > 0;
  if (hasManualActionRules) return true;
  if (!transitions.length) return true;

  let rulesReady = true;
  for (const t of transitions) {
    const v = String(graph?.handoffRules?.[t.key] || '');
    if (!['same_team', 'different_team', 'different_org'].includes(v)) {
      rulesReady = false;
      break;
    }
  }
  if (rulesReady) return true;

  const lanes = uniqueLanes();
  for (const lane of lanes) {
    const p = graph?.lanes?.[lane] || {};
    if (!String(p.sector || '').trim() || !String(p.org || '').trim()) {
      return false;
    }
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
    status.happyPathOk = false;
  }

  try {
    parseLeadTimeInformedRequired();
    status.leadTimeOk = true;
  } catch (e) {
    status.leadTimeOk = false;
  }

  return status;
}

function renderSetupChecklist() {
  const box = $('setupChecklist');
  if (!box) return;
  syncSetupInputsToMain();
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

  const suggestedSet = new Set(suggestedAutomationNodeIds());
  const rows = tasks.map((t, idx) => {
    const actor = actorLaneIdOf(t);
    const autoChecked = t.automated ? 'checked' : '';
    const potentialChecked = (!t.automated && confirmedAutoNodes.has(t.id)) ? 'checked' : '';
    const potentialDisabled = t.automated ? 'disabled' : '';
    const suggestionBadge = suggestedSet.has(t.id)
      ? '<span class="badge auto">sugerida</span>'
      : '<span class="badge" style="background:#6b7c90;">manual</span>';

    return `
      <div class="task-matrix-row">
        <div class="task-col task-name"><strong>${idx + 1}. ${escapeHtml(t.label || t.id)}</strong><small>${escapeHtml(t.id)}</small></div>
        <div class="task-col"><input type="text" data-task-actor="${escapeHtml(t.id)}" value="${escapeHtml(actor)}" placeholder="Ator/raia" /></div>
        <label class="task-col task-check"><input type="checkbox" data-task-automated="${escapeHtml(t.id)}" ${autoChecked}> <span>Automatica</span></label>
        <label class="task-col task-check"><input type="checkbox" data-task-potential="${escapeHtml(t.id)}" ${potentialChecked} ${potentialDisabled}> <span>Automatizavel</span> ${suggestionBadge}</label>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div class="task-matrix-head">
      <span>Atividade</span>
      <span>Ator/Raia</span>
      <span>Status atual</span>
      <span>Cenario auto (TEP ideal auto)</span>
    </div>
    <div class="task-matrix-body">${rows}</div>
    <div class="box" style="margin-top:8px;">Use "Automatica" para o estado real do processo e "Automatizavel" para confirmar o potencial usado no indice de Phillip com TEP ideal auto.</div>`;
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
    if (!outs.length) return `<div class="box"><strong>${gw.label || gw.id}</strong><div>Sem saidas.</div></div>`;
    const sum = outs.reduce((acc, e) => acc + Number(e.probability || 0), 0);
    const rows = outs.map((e) => `
      <label class="field" style="margin-bottom:4px;">
        <span>${e.id} (${e.from} -> ${e.to})</span>
        <input type="number" min="0" max="100" step="0.01" data-setup-gw="${gw.id}" data-setup-edge="${e.id}" value="${Number(e.probability || 0)}" />
      </label>`).join('');
    return `
      <div class="box" style="margin-bottom:8px;">
        <strong>${gw.label || gw.id}</strong>
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
    const gw = String(input.getAttribute('data-setup-gw') || '');
    const edgeId = String(input.getAttribute('data-setup-edge') || '');
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

  const tasks = (graph.nodes || []).filter((n) => n.type === 'task');
  if (tasks.length < 2) {
    box.textContent = 'Sao necessarias ao menos duas atividades para configurar loops.';
    return;
  }

  const options = tasks.map((t) => `<option value="${t.id}">${t.label || t.id}</option>`).join('');
  const loopEdges = (graph.edges || []).filter((e) => e.isLoopReturn);
  const list = loopEdges.length
    ? loopEdges.map((e) => {
      const from = nodeById(e.from);
      const to = nodeById(e.to);
      return `<div class="check-row" style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;">
        <span>${from?.label || e.from} -> ${to?.label || e.to}</span>
        <input type="number" min="1" max="99" step="1" value="${Number(e.probability || 30)}" data-loop-prob-edge="${e.id}" style="width:84px;" />
        <button type="button" data-loop-remove-edge="${e.id}">Remover</button>
      </div>`;
    }).join('')
    : '<div class="box">Nenhum loop configurado.</div>';

  box.innerHTML = `
    <div class="row" style="align-items:end;">
      <label class="field" style="flex:1;min-width:180px;">
        <span>Acao origem (onde ocorre a decisao de retrabalho)</span>
        <select id="setupLoopFrom">${options}</select>
      </label>
      <label class="field" style="flex:1;min-width:180px;">
        <span>Acao de retorno (para onde volta)</span>
        <select id="setupLoopTo">${options}</select>
      </label>
      <label class="field" style="width:120px;">
        <span>Prob. loop (%)</span>
        <input id="setupLoopProb" type="number" min="1" max="99" step="1" value="30" />
      </label>
      <button id="btnSetupAddLoop" type="button">Adicionar Loop</button>
    </div>
    <div class="box" style="margin-top:8px;">Loops atuais:</div>
    ${list}
    <div class="row" style="margin-top:8px;">
      <button id="btnSetupApplyLoopProb" type="button">Aplicar Probabilidades de Loop</button>
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
    const edgeId = String(input.getAttribute('data-loop-prob-edge') || '');
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
      const id = String(i.getAttribute('data-task-actor') || '');
      const n = taskMap.get(id);
      if (!n) return;
      const actor = String(i.value || '').trim();
      n.executor = actor;
      n.lane = actor;
    });

    const selectedAuto = new Set(
      Array.from(matrixAutoInputs)
        .filter((i) => i.checked)
        .map((i) => String(i.getAttribute('data-task-automated') || ''))
        .filter(Boolean)
    );
    for (const n of graph.nodes || []) {
      if (n.type !== 'task') continue;
      n.automated = selectedAuto.has(String(n.id || ''));
    }

    const selectedPotential = new Set(
      Array.from(matrixPotentialInputs)
        .filter((i) => i.checked)
        .map((i) => String(i.getAttribute('data-task-potential') || ''))
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
      .map((i) => String(i.getAttribute('data-setup-auto-node') || ''))
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
  $('setupModal')?.classList.remove('hidden');
  renderSetupTaskMatrix();
  renderHandoffWizard();
  renderSetupPathPicker();
  renderSetupGatewayEditor();
  renderSetupAutomationEditor();
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
      ? ` Motivo: ${s.graphIssues[0]}`
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
    throw new Error('Se informado, o lead time do executor deve ser maior que zero.');
  }
  return val;
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
  const out = { handoff: 0, gateway: 0, loop: 0 };
  for (const item of ranking || []) {
    const type = String(item?.type || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(out, type)) continue;
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

function renderExecutiveKpis(metrics, base) {
  const box = $('kpi');
  if (!box) return;

  // Live tokens display update
  const liveLine = `<div class="mblock-live">
    Tokens finalizados: <strong id="liveTokensFinished">${liveSimulationStatus.finished}</strong> &nbsp;|
    Lead time médio: <strong id="liveLeadAvg">${Number(liveSimulationStatus.avgLeadTime || 0).toFixed(2)} min</strong>
  </div>`;

  if (!metrics) {
    // Base only — no happy path yet
    const base_ = base || {};
    const tepReal = Number(base_.tepReal || 0);
    box.className = 'kpi kpi-executive';
    box.innerHTML = `
      <div class="sim-metrics">
        <div class="mblock">
          <div class="mblock-head"><span class="mblock-icon">📊</span><span class="mblock-title">Estimado</span><small class="mblock-sub">informe o caminho feliz para calcular TEP ideal e Índice de Phillip</small></div>
          <div class="mblock-cells">
            ${_metricCell('TEP Ideal', null, ' min', 'informe o caminho feliz')}
            ${_metricCell('TEP Real', tepReal || null, ' min', 'com todo o atrito do processo')}
            ${_phillipCell('Índice de Phillip', null, 'informe o caminho feliz')}
          </div>
        </div>
        ${liveLine}
      </div>`;
    return;
  }

  const hasAuto = Number.isFinite(metrics.tepIdealAuto) && Number.isFinite(metrics.tepRealAuto);
  const hasInformed = Number.isFinite(metrics.leadTimeInformed);

  box.className = 'kpi kpi-executive';
  box.innerHTML = `
    <div class="sim-metrics">
      <div class="mblock">
        <div class="mblock-head"><span class="mblock-icon">📊</span><span class="mblock-title">Estimado</span><small class="mblock-sub">cenário base — processo com todo o atrito, sem automações</small></div>
        <div class="mblock-cells">
          ${_metricCell('TEP Ideal', metrics.tepIdeal, ' min', 'caminho feliz, sem punições')}
          ${_metricCell('TEP Real', metrics.tepReal, ' min', 'com handoffs, gateways e loops')}
          ${_phillipCell('Índice de Phillip', metrics.ipRealVsIdeal, 'ideal ÷ real × 100')}
        </div>
      </div>

      ${hasAuto ? `<div class="mblock mblock-auto">
        <div class="mblock-head"><span class="mblock-icon">⚙️</span><span class="mblock-title">Auto</span><small class="mblock-sub">cenário com automações confirmadas aplicadas</small></div>
        <div class="mblock-cells">
          ${_metricCell('TEP Ideal Auto', metrics.tepIdealAuto, ' min', 'caminho feliz, só automações')}
          ${_metricCell('TEP Real Auto', metrics.tepRealAuto, ' min', 'com handoffs/gateways/loops restantes')}
          ${_phillipCell('Índice de Phillip Auto', metrics.ipRealAutoVsIdealAuto, 'ideal auto ÷ real auto × 100')}
        </div>
      </div>` : ''}

      ${hasInformed ? `<div class="mblock mblock-informed">
        <div class="mblock-head"><span class="mblock-icon">💬</span><span class="mblock-title">Informado</span><small class="mblock-sub">visão do executor — lead time real declarado</small></div>
        <div class="mblock-cells">
          ${_metricCell('Lead Time Ideal', metrics.leadIdeal, ' min', 'proporcional ao caminho feliz')}
          ${_metricCell('Lead Time Real', metrics.leadTimeInformed, ' min', 'tempo declarado pelo executor')}
          ${_phillipCell('Índice de Phillip', metrics.ipLeadInformedVsIdeal, 'ideal ÷ informado × 100')}
        </div>
      </div>` : ''}

      ${liveLine}
    </div>`;
}

function refreshLiveSimulationStatus(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const finished = list.filter((t) => t.ended).length;
  const endedTimes = list
    .filter((t) => t.ended)
    .map((t) => Number(simRuns?.[t.id]?.time || 0))
    .filter((v) => Number.isFinite(v) && v > 0);
  const avgLead = endedTimes.length
    ? endedTimes.reduce((a, b) => a + b, 0) / endedTimes.length
    : 0;

  liveSimulationStatus = {
    finished,
    total: list.length || TOKEN_COUNT,
    avgLeadTime: avgLead,
  };

  const elFinished = $('liveTokensFinished');
  const elLead = $('liveLeadAvg');
  if (elFinished) elFinished.textContent = `${finished}/${liveSimulationStatus.total}`;
  if (elLead) elLead.textContent = `${avgLead.toFixed(2)} min`;
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

function renderAutomaticInterpretation(metrics, base) {
  const box = $('insightInterpretation');
  if (!box) return;

  if (!metrics) {
    box.innerHTML = [
      '<strong>Leitura parcial:</strong> falta caminho feliz para interpretar os indices de Phillip informado e automacao.',
      'Acao sugerida: informe o caminho feliz e o lead time do executor para liberar diagnostico completo.',
      'Enquanto isso, use o ranking de atrito para identificar gargalos dominantes no processo atual.',
    ].join('<br>');
    return;
  }

  const i = computeInsightIndices(metrics, base);
  const sStandard = semaphoreForPhillip('standard', metrics.ipRealVsIdeal);
  const hasInformed = Number.isFinite(metrics.ipLeadInformedVsIdeal);
  const sInformed = semaphoreForPhillip('informed', metrics.ipLeadInformedVsIdeal);
  const sAuto = semaphoreForPhillip('automation', metrics.ipAutoVsIdeal);

  const lines = [];
  lines.push(`<span class="semaforo ${sStandard.cls}">Phillip padrao: ${sStandard.label}</span> <span class="semaforo ${sInformed.cls}">Phillip informado: ${sInformed.label}</span> <span class="semaforo ${sAuto.cls}">Phillip automacao: ${sAuto.label}</span>`);

  if (sStandard.cls === 'sev-red') {
    lines.push('Paralisia burocratica no cenario estimado: o processo consome tempo majoritariamente em atrito. Redesenho estrutural imediato e recomendado.');
  } else if (sStandard.cls === 'sev-orange') {
    lines.push('Gargalo institucional no cenario estimado: mais da metade do tempo tende a ficar em esperas, handoffs e retrabalho. Reengenharia To-Be deve ser prioritaria.');
  } else if (sStandard.cls === 'sev-yellow') {
    lines.push('Alerta de atrito no cenario estimado: o fluxo funciona, mas ha gordura sistemica relevante. Revise transicoes entre setores e pontos de decisao.');
  } else {
    lines.push('Eficiencia de fluxo no cenario estimado: o processo esta proximo do estado da arte, com baixo desperdicio estrutural.');
  }

  if (!hasInformed) {
    lines.push('Indice informado pelo executor nao foi calculado porque o lead time informado e opcional e nao foi preenchido.');
  } else if (sInformed.cls === 'sev-red') {
    lines.push('Na visao do executor ha paralisia burocratica: o tempo praticado esta muito distante do ideal. O desenho atual provavelmente nao reflete todas as filas e excecoes reais.');
  } else if (sInformed.cls === 'sev-orange') {
    lines.push('Na visao do executor ha gargalo institucional: o processo aparenta depender excessivamente de handoffs e retrabalho. Intervencao do escritorio de processos e recomendada.');
  } else if (sInformed.cls === 'sev-yellow') {
    lines.push('Na visao do executor ha alerta de atrito: o lead time praticado esta acima do ideal. Priorize reducao de esperas entre etapas e padronizacao de handoffs.');
  } else {
    lines.push('Na visao do executor ha eficiencia de fluxo: o lead time informado esta aderente ao ideal do caminho feliz.');
  }

  if (sAuto.cls === 'sev-red') {
    lines.push('Na frente de automacao, a leitura e de paralisia burocratica: a configuracao atual nao reduz atrito de forma relevante. Redesenho e automacao de alto impacto sao urgentes.');
  } else if (sAuto.cls === 'sev-orange') {
    lines.push('Na frente de automacao ha gargalo institucional: os ganhos projetados ainda sao baixos para o nivel de atrito do fluxo. Repriorize tarefas com maior volume e recorrencia.');
  } else if (sAuto.cls === 'sev-yellow') {
    lines.push('Na frente de automacao ha alerta de atrito: ganho projetado moderado. Existe oportunidade de ampliar o escopo para tarefas repetitivas e pontos de fila.');
  } else {
    lines.push('Na frente de automacao ha eficiencia de fluxo: ganho consistente e aderente ao estado da arte. Bom candidato para business case executivo.');
  }

  if (i.concentrationTop3Percent >= 60) {
    lines.push(`Os 3 maiores atritos concentram ${i.concentrationTop3Percent.toFixed(1)}% do problema. Estrategia recomendada: foco em poucos pontos para obter maior retorno no curto prazo.`);
  }

  if (i.handoffExposurePercent >= 35) {
    lines.push(`Exposicao de handoff em ${i.handoffExposurePercent.toFixed(1)}% das transicoes manuais. Avalie consolidacao de etapas por raia/setor para reduzir perda por transferencia.`);
  }

  if (i.loopPressurePercent >= 20) {
    lines.push(`Pressao de retrabalho elevada (loops medios em ${i.loopPressurePercent.toFixed(1)}%). Recomendado revisar criterios de entrada e qualidade de dados antes dos gateways.`);
  }

  if (i.autoPotentialPercent >= 30 && i.autoConfirmedPercent < 50) {
    lines.push(`Existe potencial de automacao (${i.autoPotentialPercent.toFixed(1)}%), mas baixa confirmacao (${i.autoConfirmedPercent.toFixed(1)}%). Alinhar com executores pode destravar ganhos adicionais.`);
  }

  box.innerHTML = `<div class="insight-list">${lines.map((l) => `<p>${l}</p>`).join('')}</div>`;
}

function computeScenarioMetrics() {
  const base = calculateTEPAndIP(graph, 3500);
  const path = parseHappyPathRequired();
  const leadTimeInformed = parseLeadTimeInformedRequired();

  syncConfirmedAutoFromUi();
  const autoGraph = buildAutoScenarioGraph();
  const autoBase = calculateTEPAndIP(autoGraph, 3500);

  const tepReal = base.tepReal;
  const tepIdeal = calculatePathTime(graph, path, true);
  const tepIdealAuto = calculatePathTime(autoGraph, path, true);
  const tepRealAuto = autoBase.tepReal;
  const leadIdeal = calculatePathTime(graph, path, true);

  if (tepIdeal <= 0 || tepIdealAuto <= 0 || leadIdeal <= 0) {
    throw new Error('Nao foi possivel calcular os cenarios ideais a partir do caminho feliz.');
  }

  return {
    tepReal,
    tepIdeal,
    tepIdealAuto,
    tepRealAuto,
    leadTimeInformed,
    leadIdeal,
    ipRealVsIdeal:         phillipEfficiency(tepReal,        tepIdeal),
    ipRealAutoVsIdealAuto: phillipEfficiency(tepRealAuto,    tepIdealAuto),
    ipAutoVsIdeal:         phillipEfficiency(tepIdealAuto,   tepIdeal),
    ipLeadInformedVsIdeal: Number.isFinite(leadTimeInformed) ? phillipEfficiency(leadTimeInformed, leadIdeal) : null,
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
    const lane = row.getAttribute('data-lane-row');
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
      <div data-lane-row="${lane}" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:6px;align-items:end;">
        <label class="field" style="margin:0;"><span>Raia</span><input value="${lane}" disabled></label>
        <label class="field" style="margin:0;"><span>Equipe</span><input data-field="team" value="${profile.team || ''}" placeholder="Ex: Protocolo"></label>
        <label class="field" style="margin:0;"><span>Setor</span><input data-field="sector" value="${profile.sector || ''}" placeholder="Ex: Atendimento"></label>
        <label class="field" style="margin:0;"><span>Orgao</span><input data-field="org" value="${profile.org || ''}" placeholder="Ex: SEFAZ"></label>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div style="font-size:12px;margin-bottom:8px;">
      Regra usada: troca de raia => handoff. Mesmo setor +10, setores diferentes +15, orgaos diferentes +20.
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
    $('validationBox').innerHTML = '<span class="badge error">handoff</span> Confirme na secao 2 do popup se cada handoff e de mesma equipe, outra equipe ou outro orgao.';
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
    return true;
  } catch (e) {
    $('validationBox').innerHTML = `<span class=\"badge error\">erro</span> JSON invalido: ${e.message}`;
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
  const last = nodeMap.get(ids[ids.length - 1]);

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

function suggestHappyPathIds() {
  if (!graph || !(graph.nodes || []).length) return [];

  const starts = startCandidateIds();
  const ends = new Set(endCandidateIds());
  if (!starts.length || !ends.size) return [];

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

    const out = (graph.edges || []).filter((e) => e.from === current.id);
    for (const edge of out) {
      const nextId = edge.to;
      const nextScore = current.score + edgeHappyPathCost(edge);
      if (nextScore >= Number(bestByNode.get(nextId) || Infinity)) continue;
      bestByNode.set(nextId, nextScore);
      prevByNode.set(nextId, current.id);
      queue.push({ id: nextId, score: nextScore });
    }
  }

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

  const last = selected[selected.length - 1];
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
}

function onSetupPathNodeClick(nodeId) {
  const selected = happyPathMarking.nodes;
  const last = selected[selected.length - 1];
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

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke', '#6b7280');
    line.setAttribute('stroke-width', '2');
    for (let i = 0; i < happyPathMarking.nodes.length - 1; i += 1) {
      if (happyPathMarking.nodes[i] === edge.from && happyPathMarking.nodes[i + 1] === edge.to) {
        line.setAttribute('stroke', '#0b84f3');
        line.setAttribute('stroke-width', '4');
        break;
      }
    }
    line.setAttribute('marker-end', 'url(#setupArrow)');
    svg.appendChild(line);
  }

  for (const node of graph.nodes || []) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-setup-node', node.id);

    const selectedIndex = happyPathMarking.nodes.indexOf(node.id);
    const isSelected = selectedIndex >= 0;
    const isAllowed = allowed.has(node.id);
    g.style.cursor = isAllowed ? 'pointer' : 'not-allowed';
    g.style.opacity = isAllowed || isSelected ? '1' : '0.36';
    g.addEventListener('click', () => onSetupPathNodeClick(node.id));

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
  const last = selected[selected.length - 1];
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

  for (const node of graph.nodes) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-node', node.id);
    const selectedIndex = happyPathMarking.nodes.indexOf(node.id);
    const isSelected = selectedIndex >= 0;
    const canPick = !happyPathMarking.active || allowed.has(node.id) || isSelected;
    g.style.cursor = happyPathMarking.active ? (canPick ? 'pointer' : 'not-allowed') : 'default';
    g.style.opacity = canPick ? '1' : '0.42';
    g.addEventListener('click', () => onNodeClickedForHappyPath(node.id));

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

    svg.appendChild(g);
  }
}

function openGatewayEditor(gatewayId) {
  const box = $('gatewayEditor');
  const outs = outgoing(graph, gatewayId);
  if (!outs.length) {
    box.classList.remove('hidden');
    box.textContent = 'Gateway sem saidas.';
    return;
  }

  box.classList.remove('hidden');
  box.innerHTML = `<h4>Probabilidades - ${gatewayId}</h4>`;

  const defaultMap = defaultGatewayProbMap(outs);

  const form = document.createElement('div');
  for (const e of outs) {
    const row = document.createElement('label');
    row.className = 'field';
    row.innerHTML = `<span>${e.id} (${e.from} -> ${e.to})</span><input type="number" min="0" max="100" step="1" data-edge="${e.id}" value="${Number(defaultMap[e.id] || 0)}">`;
    form.appendChild(row);
  }

  const info = document.createElement('div');
  info.className = 'box';
  info.textContent = `Padrao automatico para ${outs.length} caminhos: ${splitPercentages(outs.length).join('% | ')}%.`;

  const btnAuto = document.createElement('button');
  btnAuto.type = 'button';
  btnAuto.textContent = 'Auto distribuir';
  btnAuto.onclick = () => {
    const autoMap = defaultGatewayProbMap(outs.map((e) => ({ ...e, probability: 0 })));
    form.querySelectorAll('input[data-edge]').forEach((i) => {
      i.value = String(Number(autoMap[i.dataset.edge] || 0));
    });
  };

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Aplicar';
  btn.onclick = () => {
    const probs = {};
    form.querySelectorAll('input[data-edge]').forEach((i) => {
      probs[i.dataset.edge] = Number(i.value || 0);
    });
    graph = applyGatewayProbabilities(graph, gatewayId, probs);
    $('graphJson').value = JSON.stringify(graph, null, 2);
    refreshAll();
  };

  box.appendChild(form);
  box.appendChild(info);
  box.appendChild(btnAuto);
  box.appendChild(btn);
}

function updateDashboard() {
  if (!graph) return;
  const sel = $('roiGateway');
  const gateways = gatewayNodes(graph);
  sel.innerHTML = gateways.map((g) => `<option value="${g.id}">${g.label || g.id}</option>`).join('');

  let metrics;
  try {
    metrics = computeScenarioMetrics();
  } catch (e) {
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

  $('frictionRanking').innerHTML = '';
  for (const item of metrics.ranking.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = `${item.type} - ${item.key}: ${item.total.toFixed(1)} min acumulados`;
    $('frictionRanking').appendChild(li);
  }

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

  // Correlacao direta com o tipo da atividade destino: automatizada=1 min, manual=5 min.
  if (to.type === 'task') mins += toAutomated ? 1 : 5;
  if (!isIdealMode && to.type === 'gateway') mins += 5;
  if (!isIdealMode && from.type === 'task' && to.type === 'task' && !from.automated && !toAutomated) {
    const a = laneMetaOf(from);
    const b = laneMetaOf(to);
    if (a.laneId !== b.laneId) {
      if (a.org && b.org && a.org !== b.org) mins += 20;
      else if (a.sector && b.sector && a.sector !== b.sector) mins += 15;
      else mins += 10;
    }
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

function animate(frameTimeMs = performance.now()) {
  if (!running) return;

  if (!animationLastTickMs) animationLastTickMs = frameTimeMs;
  const deltaMs = Math.max(1, frameTimeMs - animationLastTickMs);
  animationLastTickMs = frameTimeMs;

  const speedGlobal = Math.max(0.1, Number($('speed')?.value || 1));
  simulationClockMs += deltaMs * speedGlobal;
  const dt = (deltaMs / 1000) * 0.9 * speedGlobal;

  for (const t of window.__tokens) {
    if (t.ended) continue;

    if (!t.launched) {
      if (simulationClockMs >= t.launchAtMs) {
        t.launched = true;
      } else {
        continue;
      }
    }

    const fromId = t.path[t.step];
    const toId = t.path[t.step + 1];
    if (!toId) {
      t.ended = true;
      continue;
    }

    const edge = edgeBetween(fromId, toId);
    const to = nodeById(toId);
    const dur = edgeDurationMinutes(fromId, toId);
    const toVisits = Number(t.nodeVisits?.[toId] || 0);

    t.progress += (1 / Math.max(dur, 0.1)) * dt * t.speedFactor;

    const toAutomated = Boolean(
      to?.automated
      || (simulationMode === 'ideal_auto' && confirmedAutoNodes.has(toId))
    );
    const isLoopRepeatPass = Boolean(edge?.isLoopReturn && toVisits >= 1);

    if (edge?.isErrorPath || (to?.type === 'end' && to?.endKind === 'error')) {
      t.color = '#c0392b';
      t.speedFactor = 1;
    } else if (isLoopRepeatPass) {
      t.color = '#f39c12';
      t.speedFactor = 0.6;
    } else if (to?.type === 'task' && toAutomated) {
      t.color = '#23b26d';
      t.speedFactor = 1;
    } else {
      t.color = '#1f6fb2';
      t.speedFactor = 1;
    }

    if (t.progress >= 1) {
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
    }
  }

  drawTokens(window.__tokens);
  refreshLiveSimulationStatus(window.__tokens);

  if (window.__tokens.some((t) => !t.ended)) {
    animFrame = requestAnimationFrame(animate);
  } else {
    running = false;
    animationLastTickMs = 0;
    simulationClockMs = 0;
    refreshLiveSimulationStatus(window.__tokens);
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

  if (simulationMode !== 'real') {
    try {
      parseHappyPathRequired();
    } catch (e) {
      $('validationBox').innerHTML = `<span class="badge error">ideal</span> ${e.message}`;
      return;
    }
  }

  drawGraph();
  window.__tokens = buildTokenSchedule();
  refreshLiveSimulationStatus(window.__tokens);
  running = true;
  animationLastTickMs = 0;
  simulationClockMs = 0;
  cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(animate);
}

function stopSimulation() {
  running = false;
  cancelAnimationFrame(animFrame);
  animationLastTickMs = 0;
  simulationClockMs = 0;
  refreshLiveSimulationStatus(window.__tokens || []);
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

  sel.innerHTML = items.map((it) => `<option value="${it.value}">${it.label}</option>`).join('');

  if (type === 'gateway') help.textContent = 'Hipotese: retirar etapa de aprovacao (gateway).';
  else if (type === 'loop') help.textContent = 'Hipotese: remover retorno de retrabalho (loop).';
  else help.textContent = 'Hipotese: reduzir atrito de handoff para mesma equipe.';
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
    const node = (projectedGraph.nodes || []).find((n) => n.id === target);
    if (node) {
      node.type = 'task';
      node.automated = true;
      node.label = `${node.label || node.id} (removido)`;
    }
  } else if (type === 'loop') {
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
  } else if (type === 'handoff') {
    projectedGraph.handoffRules = projectedGraph.handoffRules || {};
    projectedGraph.handoffRules[target] = 'same_team';
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

function generateReport() {
  if (!validateAndShow()) return;
  let metrics;
  try {
    metrics = computeScenarioMetrics();
  } catch (e) {
    $('reportBox').textContent = `Falha no relatorio: ${e.message}`;
    return;
  }

  const top = metrics.ranking.slice(0, 5).map((r, i) => `${i + 1}. ${r.type} - ${r.key} (${r.total.toFixed(1)} min)`).join('\n');

  const text = [
    'RELATORIO AUTOMATICO - SIMULADOR DE PROCESSOS',
    'BLOCO ESTIMADO',
    `TEP ideal: ${metrics.tepIdeal.toFixed(2)} min | Base: ${metrics.ipIdeal.toFixed(2)}%`,
    `TEP real: ${metrics.tepReal.toFixed(2)} min | Proporcao: ${metrics.ipRealVsIdeal.toFixed(2)}%`,
    '',
    'BLOCO INFORMADO PELO EXECUTOR',
    `Lead time ideal (caminho feliz sem punicoes): ${metrics.leadIdeal.toFixed(2)} min | Base: ${metrics.ipLeadIdeal.toFixed(2)}%`,
    `Lead time informado: ${Number.isFinite(metrics.leadTimeInformed) ? `${metrics.leadTimeInformed.toFixed(2)} min | Proporcao: ${metrics.ipLeadInformedVsIdeal.toFixed(2)}%` : 'nao informado (opcional)'}`,
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

  $('reportBox').textContent = text;
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
    out.textContent = `Falha na extracao: ${e.message}`;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Extrair/Importar Topologia';
    }
  }
}

function applyExtracted() {
  if (!extractedGraph) {
    $('cvOutput').textContent = 'Nenhuma topologia extraida para aplicar.';
    return;
  }
  graph = normalizeGraph(extractedGraph);
  normalizeActorCodesInGraph();
  $('graphJson').value = JSON.stringify(graph, null, 2);
  refreshAll();
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
  renderAutomationConfirm();
  updateDashboard();
  renderSuggestions();
  renderSetupChecklist();
  renderHypothesisTargets();
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
  $('leadTimeInformed')?.addEventListener('input', renderSetupChecklist);
  $('setupHappyPath')?.addEventListener('input', () => {
    syncSetupInputsToMain();
    renderSetupChecklist();
  });
  $('setupLeadTime')?.addEventListener('input', () => {
    syncSetupInputsToMain();
    renderSetupChecklist();
  });
  $('handoffWizard')?.addEventListener('change', () => {
    saveHandoffRulesFromWizard();
    renderSetupChecklist();
  });
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
  $('setupTaskMatrix')?.addEventListener('change', () => {
    document.querySelectorAll('input[data-task-automated]').forEach((autoEl) => {
      const id = String(autoEl.getAttribute('data-task-automated') || '');
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
  $('btnSimulateRoi')?.addEventListener('click', runRoi);
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
    window.parent.postMessage(
      { type: 'SIMULATOR_SAVE', payload: { graph: cloneLocal(graph), popKey: _sigaPopKey } },
      '*'
    );
    if (btn) {
      btn.textContent = '✅ Salvo no SIGA';
      setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Salvar no SIGA'; }, 2000);
    }
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar no SIGA'; }
    console.warn('[Simulator] saveToSIGA falhou:', e);
  }
}

window.addEventListener('message', (ev) => {
  try {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;

    // ── Parent sends a saved graph to load ──────────────────
    if (msg.type === 'SIGA_LOAD_GRAPH') {
      const { graph: g, popName, popKey } = msg.payload || {};
      _sigaPopKey = popKey || null;

      // Update topbar label
      const titleEl = document.querySelector('.topbar h1');
      if (titleEl && popName) titleEl.textContent = `Simulador — ${popName}`;

      // Show / hide the "Salvar no SIGA" button
      const saveBtn = $('btnSaveToSiga');
      if (saveBtn) saveBtn.style.display = popKey ? 'inline-flex' : 'none';

      if (g && g.nodes && g.edges) {
        graph = normalizeGraph(g);
        normalizeActorCodesInGraph();
        $('graphJson').value = JSON.stringify(graph, null, 2);
        refreshAll();
        revealDashboard();
      }
      // Acknowledge readiness
      ev.source?.postMessage({ type: 'SIMULATOR_READY', popKey }, '*');
      return;
    }

    // ── Parent requests current graph (e.g. before navigating away) ──
    if (msg.type === 'SIGA_REQUEST_GRAPH') {
      if (graph) {
        ev.source?.postMessage(
          { type: 'SIMULATOR_SAVE', payload: { graph: cloneLocal(graph), popKey: _sigaPopKey } },
          '*'
        );
      }
    }
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
  loadSample();
  openSetupModal();
} catch (e) {
  const out = $('cvOutput');
  if (out) out.textContent = `Falha ao inicializar interface: ${e.message}`;
  const v = $('validationBox');
  if (v) v.textContent = `Falha ao inicializar interface: ${e.message}`;
}
