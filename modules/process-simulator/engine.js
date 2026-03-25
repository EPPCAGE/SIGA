const RULES = {
  firstManual: 20,
  nextManual: 10,
  automated: 0.5,
  gatewayPenalty: 2.5,
  handoffSameSector: 10,
  handoffDiffSector: 20,
  handoffDiffOrg: 40,
};

// Mapa de complexidade por atividade manual (UT base por tarefa).
// Quando node.complexity estiver definido, este valor substitui
// firstManual/nextManual para aquela tarefa específica.
const COMPLEXITY_UT = { baixa: 5, media: 10, alta: 20, extrema: 40 };

// Retorna o tempo base de uma tarefa manual respeitando sua complexidade.
function manualTaskTime(node, state) {
  if (node.complexity && COMPLEXITY_UT[node.complexity] !== undefined) {
    state.manualCount += 1;
    return COMPLEXITY_UT[node.complexity];
  }
  // Fallback ao padrão global
  if (state.manualCount === 0) { state.manualCount += 1; return RULES.firstManual; }
  state.manualCount += 1;
  return RULES.nextManual;
}

const LOOP_EXIT_PROB_AFTER_FIRST_PASS = 90;

function parseProbability(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value ?? '').trim();
  if (!text) return 0;
  const normalized = text.replaceAll('%', '').replace(',', '.').trim();
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function deepClone(value) {
  return structuredClone(value);
}

function buildMaps(graph) {
  const nodeMap = new Map();
  const outMap = new Map();
  const inMap = new Map();

  for (const node of graph.nodes || []) {
    nodeMap.set(node.id, node);
    outMap.set(node.id, []);
    inMap.set(node.id, []);
  }

  for (const edge of graph.edges || []) {
    if (!outMap.has(edge.from)) outMap.set(edge.from, []);
    if (!inMap.has(edge.to)) inMap.set(edge.to, []);
    outMap.get(edge.from).push(edge);
    inMap.get(edge.to).push(edge);
  }

  return { nodeMap, outMap, inMap };
}

function startAndEndNodes(graph) {
  const starts = (graph.nodes || []).filter((n) => n.type === 'start');
  const ends = (graph.nodes || []).filter((n) => n.type === 'end');
  return { starts, ends };
}

export function validateProbabilities(graph) {
  const errors = [];
  const { outMap, nodeMap } = buildMaps(graph);

  for (const [nodeId, edges] of outMap.entries()) {
    const node = nodeMap.get(nodeId);
    if (!node || node.type !== 'gateway') continue;
    if (!edges.length) {
      errors.push(`Gateway ${node.label || node.id} sem saidas.`);
      continue;
    }
    const sum = edges.reduce((acc, e) => acc + parseProbability(e.probability), 0);
    if (Math.abs(sum - 100) > 0.1) {
      errors.push(`Gateway ${node.label || node.id} com soma de probabilidades ${sum}% (deve ser 100%).`);
    }
  }

  return errors;
}

function validateNodeConnectivity(graph, nodeMap, outMap, inMap, errors, warnings) {
  for (const node of graph.nodes || []) {
    if (!nodeMap.has(node.id)) { errors.push(`No invalido: ${node.id}`); continue; }
    const noIncoming = node.type !== 'start' && (inMap.get(node.id) || []).length === 0;
    const noOutgoing = node.type !== 'end' && (outMap.get(node.id) || []).length === 0;
    if (noIncoming) warnings.push(`No ${node.label || node.id} nao possui entrada (ponta solta).`);
    if (noOutgoing) warnings.push(`No ${node.label || node.id} nao possui saida (ponta solta).`);
  }
}

function validateEdgeRefs(graph, nodeMap, errors) {
  for (const edge of graph.edges || []) {
    const missingRef = !nodeMap.has(edge.from) || !nodeMap.has(edge.to);
    if (missingRef) errors.push(`Aresta ${edge.id || `${edge.from}->${edge.to}`} referencia no inexistente.`);
  }
}

function buildReachableSet(startId, outMap) {
  const reachable = new Set();
  const q = [startId];
  while (q.length) {
    const id = q.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of outMap.get(id) || []) q.push(e.to);
  }
  return reachable;
}

function validateReachability(graph, starts, ends, outMap, errors, warnings) {
  const canCheck = starts.length === 1 && ends.length > 0;
  if (!canCheck) return;

  const reachable = buildReachableSet(starts[0].id, outMap);
  const hasPathToEnd = ends.some((e) => reachable.has(e.id));
  if (!hasPathToEnd) errors.push('Nao existe caminho do inicio ate um fim (fluxo interrompido).');

  for (const node of graph.nodes || []) {
    if (!reachable.has(node.id)) warnings.push(`No ${node.label || node.id} esta desconectado do inicio.`);
  }
}

export function validateGraphIntegrity(graph) {
  const errors = [];
  const warnings = [];
  const { starts, ends } = startAndEndNodes(graph);
  const { nodeMap, outMap, inMap } = buildMaps(graph);

  if (starts.length !== 1) errors.push(`Esperado 1 evento de inicio, encontrado ${starts.length}.`);
  if (ends.length < 1) errors.push('Nenhum evento de fim encontrado.');

  validateNodeConnectivity(graph, nodeMap, outMap, inMap, errors, warnings);
  validateEdgeRefs(graph, nodeMap, errors);
  validateReachability(graph, starts, ends, outMap, errors, warnings);

  return { errors, warnings };
}

function isManualTask(node) {
  return node && node.type === 'task' && !node.automated;
}

function laneIdOf(node) {
  return String(node?.lane || node?.executor || node?.sector || node?.id || 'lane-default');
}

function laneMetaOf(graph, node) {
  const laneId = laneIdOf(node);
  const profile = graph?.lanes?.[laneId] || {};
  return {
    laneId,
    team: String(profile.team || node?.executor || laneId),
    sector: String(profile.sector || node?.sector || ''),
    org: String(profile.org || node?.org || ''),
  };
}

function nodeBaseTime(node, state, useIdeal) {
  if (!node) return 0;
  if (node.type === 'gateway') return useIdeal ? 0 : RULES.gatewayPenalty;
  // Evento Timer: aguarda N UT definidas pelo usuario. Nao conta no T.O.P. (useIdeal).
  if (node.type === 'timer') return useIdeal ? 0 : Number(node.timerUT || 0);
  if (node.type !== 'task') return 0;
  if (node.automated) return RULES.automated;
  // Usa complexidade por nó quando definida; senão cai no padrão global.
  return manualTaskTime(node, state);
}

function handoffPenalty(graph, prevNode, currentNode, useIdeal) {
  if (useIdeal) return 0;
  if (!prevNode || !currentNode) return 0;
  if (!isManualTask(prevNode) || !isManualTask(currentNode)) return 0;

  const actionOverrideKey = `${prevNode.id}->${currentNode.id}`;
  const actionOverride = String(graph?.handoffActionRules?.[actionOverrideKey] || '').toLowerCase();
  if (actionOverride === 'same_team') return RULES.handoffSameSector;
  if (actionOverride === 'different_team') return RULES.handoffDiffSector;
  if (actionOverride === 'different_org') return RULES.handoffDiffOrg;

  const prev = laneMetaOf(graph, prevNode);
  const curr = laneMetaOf(graph, currentNode);

  // Handoff existe quando troca de raia.
  if (prev.laneId === curr.laneId) return 0;

  const overrideKey = `${prev.laneId}->${curr.laneId}`;
  const override = String(graph?.handoffRules?.[overrideKey] || '').toLowerCase();
  if (override === 'same_team') return RULES.handoffSameSector;
  if (override === 'different_team') return RULES.handoffDiffSector;
  if (override === 'different_org') return RULES.handoffDiffOrg;

  if (prev.org && curr.org && prev.org !== curr.org) return RULES.handoffDiffOrg;
  if (prev.sector && curr.sector && prev.sector !== curr.sector) return RULES.handoffDiffSector;
  return RULES.handoffSameSector;
}

function pickEdge(edges) {
  if (!edges.length) return null;
  if (edges.length === 1) return edges[0];

  const total = edges.reduce((a, e) => a + Number(e.probability || 0), 0);
  if (!total) return edges[0];

  const roll = Math.random() * total;
  let acc = 0;
  for (const e of edges) {
    acc += Number(e.probability || 0);
    if (roll <= acc) return e;
  }
  return edges.at(-1);
}

function distributeWeights(group, base, target) {
  if (base > 0) {
    return group.map((e) => ({ edge: e, w: (parseProbability(e.probability) / base) * target }));
  }
  const each = target / group.length;
  return group.map((e) => ({ edge: e, w: each }));
}

function pickWeighted(weighted, edges) {
  const total = weighted.reduce((a, i) => a + i.w, 0);
  if (!total) return pickEdge(edges);

  const roll = Math.random() * total;
  let acc = 0;
  for (const item of weighted) {
    acc += item.w;
    if (roll <= acc) return item.edge;
  }
  return weighted.at(-1).edge;
}

function pickEdgeWithLoopExitBoost(edges, visitCountOnCurrentNode) {
  if (!edges.length) return null;
  if (edges.length === 1) return edges[0];

  const hasLoopOut = edges.some((e) => e.isLoopReturn);
  const shouldBoostExit = hasLoopOut && visitCountOnCurrentNode >= 2;
  if (!shouldBoostExit) return pickEdge(edges);

  const loopEdges = edges.filter((e) => e.isLoopReturn);
  const passEdges = edges.filter((e) => !e.isLoopReturn);
  if (!loopEdges.length || !passEdges.length) return pickEdge(edges);

  const passTarget = LOOP_EXIT_PROB_AFTER_FIRST_PASS;
  const loopTarget = Math.max(0, 100 - passTarget);

  const passBase = passEdges.reduce((a, e) => a + parseProbability(e.probability), 0);
  const loopBase = loopEdges.reduce((a, e) => a + parseProbability(e.probability), 0);

  const weighted = [
    ...distributeWeights(passEdges, passBase, passTarget),
    ...distributeWeights(loopEdges, loopBase, loopTarget),
  ];

  return pickWeighted(weighted, edges);
}

function accumulateGatewayFriction(node, useIdeal, friction) {
  if (node.type !== 'gateway' || useIdeal) return;
  friction.gateways.set(node.id, (friction.gateways.get(node.id) || 0) + RULES.gatewayPenalty);
}

function accumulateTimerFriction(node, useIdeal, friction) {
  if (node.type !== 'timer' || useIdeal) return;
  const tUT = Number(node.timerUT || 0);
  if (tUT > 0) friction.timers.set(node.id, (friction.timers.get(node.id) || 0) + tUT);
}

function accumulateHandoffFriction(graph, current, next, useIdeal, time, friction) {
  const hPenalty = handoffPenalty(graph, current, next, useIdeal);
  if (hPenalty > 0) {
    const key = `${current.id}->${next.id}`;
    friction.handoffs.set(key, (friction.handoffs.get(key) || 0) + hPenalty);
  }
  return time + hPenalty;
}

function accumulateLoopFriction(next, visitedCounts, useIdeal, time, friction) {
  const revisiting = visitedCounts.has(next.id);
  if (useIdeal || !revisiting || next.type !== 'task') return time;
  const loopState = { manualCount: 0 }; // estado fictício para respeitar complexity
  const taskTime = next.automated ? RULES.automated : manualTaskTime(next, loopState);
  friction.loops.set(next.id, (friction.loops.get(next.id) || 0) + taskTime);
  return time + taskTime;
}

function runSinglePath(graph, opts = {}) {
  const { useIdeal = false, maxSteps = 400 } = opts;
  const { nodeMap, outMap } = buildMaps(graph);
  const start = (graph.nodes || []).find((n) => n.type === 'start');
  if (!start) throw new Error('Grafo sem no de inicio.');

  let current = start;
  let time = 0;
  let steps = 0;
  const visitedCounts = new Map();
  const path = [start.id];

  const friction = {
    handoffs: new Map(),
    gateways: new Map(),
    loops: new Map(),
    timers: new Map(),
  };

  const state = { manualCount: 0 };

  while (current && steps < maxSteps) {
    steps += 1;
    visitedCounts.set(current.id, (visitedCounts.get(current.id) || 0) + 1);
    const currentVisitCount = visitedCounts.get(current.id) || 1;

    time += nodeBaseTime(current, state, useIdeal);
    accumulateGatewayFriction(current, useIdeal, friction);
    accumulateTimerFriction(current, useIdeal, friction);

    const out = outMap.get(current.id) || [];
    if (!out.length) break;

    const edge = pickEdgeWithLoopExitBoost(out, currentVisitCount);
    const next = nodeMap.get(edge.to);
    if (!next) break;

    time = accumulateHandoffFriction(graph, current, next, useIdeal, time, friction);
    // Loop rule: ao revisitar uma tarefa, a pontuacao e somada como se fosse a primeira vez (dobra na pratica).
    time = accumulateLoopFriction(next, visitedCounts, useIdeal, time, friction);

    current = next;
    path.push(current.id);

    if (current.type === 'end') break;
  }

  return {
    time,
    path,
    reachedEnd: current && current.type === 'end',
    finalNode: current,
    friction,
  };
}

function mergeFriction(target, source) {
  for (const [k, v] of source.handoffs.entries()) target.handoffs.set(k, (target.handoffs.get(k) || 0) + v);
  for (const [k, v] of source.gateways.entries()) target.gateways.set(k, (target.gateways.get(k) || 0) + v);
  for (const [k, v] of source.loops.entries()) target.loops.set(k, (target.loops.get(k) || 0) + v);
  for (const [k, v] of (source.timers || new Map()).entries()) target.timers.set(k, (target.timers.get(k) || 0) + v);
}

function edgeFor(graph, fromId, toId) {
  return (graph.edges || []).find((e) => e.from === fromId && e.to === toId);
}

export function calculatePathTime(graph, pathNodeIds, useIdeal = false) {
  const { nodeMap } = buildMaps(graph);
  const state = { manualCount: 0 };
  let total = 0;

  for (let i = 0; i < pathNodeIds.length; i += 1) {
    const id = pathNodeIds[i];
    const node = nodeMap.get(id);
    if (!node) {
      throw new Error(`No inexistente no caminho feliz: ${id}`);
    }
    total += nodeBaseTime(node, state, useIdeal);
  }

  for (let i = 0; i < pathNodeIds.length - 1; i += 1) {
    const fromId = pathNodeIds[i];
    const toId = pathNodeIds[i + 1];
    const from = nodeMap.get(fromId);
    const to = nodeMap.get(toId);
    const edge = edgeFor(graph, fromId, toId);
    if (!edge) {
      throw new Error(`Aresta inexistente no caminho feliz: ${fromId} -> ${toId}`);
    }

    total += handoffPenalty(graph, from, to, useIdeal);

    // Regra de loop para caminho especificado: revisita pontua como primeira vez (dobra na pratica).
    if (!useIdeal && edge.isLoopReturn && to?.type === 'task') {
      const loopState = { manualCount: 0 };
      total += to.automated ? RULES.automated : manualTaskTime(to, loopState);
    }
  }

  return total;
}

export function calculateCalibratedMetrics(baseMetrics, graph, happyPathNodeIds, happyPathRealMinutes) {
  const informedReal = Number(happyPathRealMinutes);
  if (!Number.isFinite(informedReal) || informedReal <= 0) {
    throw new Error('Tempo real informado para caminho feliz deve ser maior que zero.');
  }

  const modelHappyReal = calculatePathTime(graph, happyPathNodeIds, false);
  const modelHappyIdeal = calculatePathTime(graph, happyPathNodeIds, true);

  if (!Number.isFinite(modelHappyReal) || modelHappyReal <= 0) {
    throw new Error('Nao foi possivel calcular o tempo do caminho feliz no modelo TEP.');
  }

  const factor = informedReal / modelHappyReal;

  const tr = baseMetrics.tepReal * factor;
  const tri = baseMetrics.tepIdeal * factor;
  const triOverTrPercent = tr > 0 ? (tri / tr) * 100 : 0;

  const rankingScaled = (baseMetrics.ranking || []).map((r) => ({
    ...r,
    totalCalibrated: r.total * factor,
  }));

  return {
    factor,
    informedReal,
    modelHappyReal,
    modelHappyIdeal,
    tr,
    tri,
    triOverTrPercent,
    rankingScaled,
  };
}

export function calculateTEPAndIP(graph, runs = 3000) {
  const real = [];
  const ideal = [];

  const aggFriction = {
    handoffs: new Map(),
    gateways: new Map(),
    loops: new Map(),
    timers: new Map(),
  };

  for (let i = 0; i < runs; i += 1) {
    const rr = runSinglePath(graph, { useIdeal: false });
    const ii = runSinglePath(graph, { useIdeal: true });
    if (rr.reachedEnd) real.push(rr.time);
    if (ii.reachedEnd) ideal.push(ii.time);
    mergeFriction(aggFriction, rr.friction);
  }

  const tepReal = real.length ? real.reduce((a, b) => a + b, 0) / real.length : 0;
  const tepIdeal = ideal.length ? ideal.reduce((a, b) => a + b, 0) / ideal.length : 0;
  const ip = tepReal > 0 ? (tepIdeal / tepReal) * 100 : 0;

  const ranking = [];
  for (const [k, v] of aggFriction.handoffs.entries()) ranking.push({ type: 'handoff', key: k, total: v });
  for (const [k, v] of aggFriction.gateways.entries()) ranking.push({ type: 'gateway', key: k, total: v });
  for (const [k, v] of aggFriction.loops.entries()) ranking.push({ type: 'loop', key: k, total: v });
  for (const [k, v] of aggFriction.timers.entries()) ranking.push({ type: 'timer', key: k, total: v });
  ranking.sort((a, b) => b.total - a.total);

  return {
    tepReal,
    tepIdeal,
    ip,
    samples: { realCount: real.length, idealCount: ideal.length },
    ranking,
  };
}

export function simulate100Tokens(graph) {
  const runs = [];
  for (let i = 0; i < 100; i += 1) {
    runs.push(runSinglePath(graph, { useIdeal: false }));
  }
  return runs;
}

export function cloneGraph(graph) {
  return deepClone(graph);
}

export function normalizeGraph(raw) {
  const g = deepClone(raw || {});
  g.nodes = Array.isArray(g.nodes) ? g.nodes : [];
  g.edges = Array.isArray(g.edges) ? g.edges : [];
  g.lanes = g.lanes && typeof g.lanes === 'object' ? g.lanes : {};
  g.handoffRules = g.handoffRules && typeof g.handoffRules === 'object' ? g.handoffRules : {};
  g.handoffActionRules = g.handoffActionRules && typeof g.handoffActionRules === 'object' ? g.handoffActionRules : {};

  for (const node of g.nodes) {
    node.id = String(node.id || '');
    node.label = String(node.label || node.id || '');
    node.type = node.type || 'task';
    node.x = Number(node.x || 0);
    node.y = Number(node.y || 0);
    node.executor = node.executor || '';
    node.sector = node.sector || '';
    node.org = node.org || '';
    node.lane = String(node.lane || node.executor || node.sector || node.id);
    node.automated = Boolean(node.automated);
    if (node.type === 'timer') node.timerUT = Number(node.timerUT || 0);
  }

  for (const edge of g.edges) {
    edge.id = String(edge.id || `${edge.from}->${edge.to}`);
    edge.from = String(edge.from || '');
    edge.to = String(edge.to || '');
    if (edge.probability !== undefined) edge.probability = parseProbability(edge.probability);
    edge.isLoopReturn = Boolean(edge.isLoopReturn);
    edge.isErrorPath = Boolean(edge.isErrorPath);
  }

  return g;
}

export function calculateComplexity(graph) {
  // Conta quantos caminhos possiveis existem do inicio ate qualquer fim.
  // Arestas de loop (isLoopReturn) sao ignoradas para evitar contagem infinita.
  const { nodeMap, outMap } = buildMaps(graph);
  const start = (graph.nodes || []).find((n) => n.type === 'start');
  if (!start) return 0;

  const cleanOutMap = new Map();
  for (const [id, edges] of outMap.entries()) {
    cleanOutMap.set(id, (edges || []).filter((e) => !e.isLoopReturn));
  }

  const memo = new Map();
  const inStack = new Set();

  function countPaths(nodeId) {
    if (memo.has(nodeId)) return memo.get(nodeId);
    if (inStack.has(nodeId)) return 0;
    const node = nodeMap.get(nodeId);
    if (!node) { memo.set(nodeId, 0); return 0; }
    if (node.type === 'end') { memo.set(nodeId, 1); return 1; }

    inStack.add(nodeId);
    const outs = cleanOutMap.get(nodeId) || [];
    const total = outs.reduce((acc, e) => acc + countPaths(e.to), 0);
    inStack.delete(nodeId);
    memo.set(nodeId, Math.max(total, 0));
    return memo.get(nodeId);
  }

  return countPaths(start.id);
}

export function gatewayNodes(graph) {
  return (graph.nodes || []).filter((n) => n.type === 'gateway');
}

export function outgoing(graph, nodeId) {
  return (graph.edges || []).filter((e) => e.from === nodeId);
}

export function applyGatewayProbabilities(graph, gatewayId, probsByEdgeId) {
  const g = cloneGraph(graph);
  for (const edge of g.edges) {
    if (edge.from !== gatewayId) continue;
    if (Object.hasOwn(probsByEdgeId, edge.id)) {
      edge.probability = Number(probsByEdgeId[edge.id]);
    }
  }
  return g;
}

export function simulateRoi(graph, gatewayId, currentProb, targetProb) {
  const base = calculateTEPAndIP(graph, 2500);
  const g = cloneGraph(graph);
  const outs = outgoing(g, gatewayId);
  if (outs.length < 2) {
    return { base, projected: base, delta: 0, note: 'Gateway sem bifurcacao suficiente para simulacao de ROI.' };
  }

  const loopEdge = outs.find((e) => e.isLoopReturn) || outs[0];
  const otherEdges = outs.filter((e) => e.id !== loopEdge.id);

  loopEdge.probability = Number(targetProb);
  const remaining = 100 - Number(targetProb);
  const each = otherEdges.length ? remaining / otherEdges.length : 0;
  for (const e of otherEdges) e.probability = each;

  const projected = calculateTEPAndIP(g, 2500);
  return {
    base,
    projected,
    delta: projected.ip - base.ip,
    note: `Loop ${loopEdge.id}: ${currentProb}% -> ${targetProb}%`,
  };
}

export { RULES, COMPLEXITY_UT };
