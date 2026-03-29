function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = reject;
    reader.readAsText(file, 'utf-8');
  });
}

function localNameOf(el) {
  return String(el?.localName || el?.nodeName || '').split(':').pop();
}

function attrOf(el, names) {
  for (const n of names) {
    const v = el?.getAttribute?.(n);
    if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  return '';
}

function textOfFirstChildByLocalName(el, childLocalName) {
  if (!el) return '';
  const children = el.querySelectorAll('*');
  for (const c of children) {
    if (localNameOf(c) === childLocalName) {
      const txt = String(c.textContent || '').trim();
      if (txt) return txt;
    }
  }
  return '';
}

function allElements(doc) {
  return Array.from(doc.getElementsByTagName('*'));
}

function isTechnicalId(value) {
  const s = String(value || '').trim();
  if (!s) return false;
  const normalized = s.replaceAll(/[{}]/g, '');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
    || /^[0-9a-f]{24,}$/i.test(s)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
}

function normalizeLookupKey(value) {
  return String(value || '').trim().replaceAll(/[{}]/g, '').toLowerCase();
}

function participantDisplayName(participantEl, fallbackId) {
  const extAttrs = Array.from(participantEl?.querySelectorAll('*') || [])
    .filter((e) => localNameOf(e) === 'ExtendedAttribute');

  const extDisplay = extAttrs
    .map((e) => ({
      key: attrOf(e, ['Name', 'name']),
      value: attrOf(e, ['Value', 'value']),
    }))
    .find((x) => /display|nome|name|ator|actor|responsavel|owner/i.test(String(x.key || '')) && String(x.value || '').trim())
    ?.value;

  const childName = textOfFirstChildByLocalName(participantEl, 'Name')
    || textOfFirstChildByLocalName(participantEl, 'ParticipantName')
    || textOfFirstChildByLocalName(participantEl, 'Description');

  const attrName = attrOf(participantEl, ['Name', 'name']);
  const picked = String(extDisplay || childName || attrName || fallbackId || '').trim();
  return picked;
}

function numberFromAttrs(el, names) {
  const raw = attrOf(el, names);
  if (!raw) return null;
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function extractXpdlParentPoolActors(elements) {
  const actors = [];

  for (const el of elements) {
    const parentPool = attrOf(el, ['ParentPool', 'parentPool']);
    if (!parentPool) continue;

    const id = attrOf(el, ['Id', 'id', 'ID']);
    const name = attrOf(el, ['Name', 'name'])
      || textOfFirstChildByLocalName(el, 'Name')
      || id;
    if (!String(name || '').trim()) continue;

    const ngi = Array.from(el.querySelectorAll('*')).find((c) => localNameOf(c) === 'NodeGraphicsInfo');
    const coords = ngi ? Array.from(ngi.querySelectorAll('*')).find((c) => localNameOf(c) === 'Coordinates') : null;
    const x = coords ? numberFromAttrs(coords, ['XCoordinate', 'x', 'X']) : null;
    const y = coords ? numberFromAttrs(coords, ['YCoordinate', 'y', 'Y']) : null;
    const width = (ngi ? numberFromAttrs(ngi, ['Width', 'width', 'W']) : null)
      ?? numberFromAttrs(el, ['Width', 'width', 'W']);
    const height = (ngi ? numberFromAttrs(ngi, ['Height', 'height', 'H']) : null)
      ?? numberFromAttrs(el, ['Height', 'height', 'H']);

    actors.push({
      id,
      parentPool,
      name: String(name).trim(),
      x,
      y,
      width,
      height,
    });
  }

  return actors;
}

function resolveActorByLaneGeometry(node, parentPoolActors) {
  const x = Number(node?.x);
  const y = Number(node?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !parentPoolActors.length) return '';

  for (const a of parentPoolActors) {
    const hasBox = Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.width) && Number.isFinite(a.height);
    if (!hasBox) continue;

    const left = Number(a.x);
    const top = Number(a.y);
    const right = left + Number(a.width);
    const bottom = top + Number(a.height);
    if (x >= left && x <= right && y >= top && y <= bottom) {
      return a.name;
    }
  }

  const withY = parentPoolActors.filter((a) => Number.isFinite(a.y));
  if (!withY.length) return '';
  withY.sort((a, b) => Math.abs(Number(a.y) - y) - Math.abs(Number(b.y) - y));
  return String(withY[0]?.name || '');
}

function normalizeXpdlActorLabels(nodes, participants) {
  const aliasByRaw = new Map();
  let aliasCount = 0;

  for (const n of nodes) {
    if (n.type !== 'task') continue;

    const raw = String(n.executor || n.lane || '').trim();
    if (!raw) continue;

    let display = String(participants.get(raw) || raw).trim();
    if (!display || isTechnicalId(display)) {
      if (!aliasByRaw.has(raw)) {
        aliasCount += 1;
        aliasByRaw.set(raw, `Ator ${aliasCount}`);
      }
      display = aliasByRaw.get(raw);
    }

    n.lane = display;
    n.executor = display;
  }
}

function normalizeTechnicalActorLabels(nodes, baseLabel = 'Ator') {
  const aliasByRaw = new Map();
  let aliasCount = 0;

  const pickAlias = (raw) => {
    const key = String(raw || '').trim();
    if (!key) return '';
    if (!aliasByRaw.has(key)) {
      aliasCount += 1;
      aliasByRaw.set(key, `${baseLabel} ${aliasCount}`);
    }
    return aliasByRaw.get(key);
  };

  for (const n of nodes || []) {
    if (n.type !== 'task') continue;

    const lane = String(n?.lane || '').trim();
    const exec = String(n?.executor || '').trim();

    if (lane && isTechnicalId(lane)) n.lane = pickAlias(lane);
    if (exec && isTechnicalId(exec)) n.executor = pickAlias(exec);

    if (!String(n.lane || '').trim() && String(n.executor || '').trim()) n.lane = n.executor;
    if (!String(n.executor || '').trim() && String(n.lane || '').trim()) n.executor = n.lane;
  }
}

function inferStartEndByTopology(graph) {
  const nodeMap = new Map((graph.nodes || []).map((n) => [n.id, n]));
  const indeg = new Map((graph.nodes || []).map((n) => [n.id, 0]));
  const outdeg = new Map((graph.nodes || []).map((n) => [n.id, 0]));

  for (const e of graph.edges || []) {
    if (nodeMap.has(e.to)) indeg.set(e.to, Number(indeg.get(e.to) || 0) + 1);
    if (nodeMap.has(e.from)) outdeg.set(e.from, Number(outdeg.get(e.from) || 0) + 1);
  }

  const hasStart = (graph.nodes || []).some((n) => n.type === 'start');
  const hasEnd = (graph.nodes || []).some((n) => n.type === 'end');

  if (!hasStart) {
    const startCandidate = (graph.nodes || []).find((n) => Number(indeg.get(n.id) || 0) === 0);
    if (startCandidate) startCandidate.type = 'start';
  }
  if (!hasEnd) {
    const endCandidate = [...(graph.nodes || [])].reverse().find((n) => Number(outdeg.get(n.id) || 0) === 0);
    if (endCandidate && endCandidate.type !== 'start') endCandidate.type = 'end';
  }
}

function applyMissingLayout(graph) {
  const cols = 6;
  const x0 = 120;
  const y0 = 120;
  const dx = 170;
  const dy = 110;

  (graph.nodes || []).forEach((n, i) => {
    if (Number.isFinite(Number(n.x)) && Number.isFinite(Number(n.y))) return;
    n.x = x0 + ((i % cols) * dx);
    n.y = y0 + (Math.floor(i / cols) * dy);
  });
}

function _resolveNodeType(ln, mappedType, el) {
  if (mappedType === 'timer_candidate') {
    const childNames = Array.from(el.querySelectorAll('*')).map((c) => localNameOf(c));
    return childNames.includes('timerEventDefinition') ? 'timer' : 'task';
  }
  if (mappedType === 'start') {
    const childNames = Array.from(el.querySelectorAll('*')).map((c) => localNameOf(c));
    if (childNames.includes('timerEventDefinition')) return 'timer';
  }
  return mappedType;
}

const _BPMN_TYPE_MAP = {
  startEvent: 'start', endEvent: 'end',
  exclusiveGateway: 'gateway', inclusiveGateway: 'gateway',
  parallelGateway: 'gateway', eventBasedGateway: 'gateway', complexGateway: 'gateway',
  intermediateCatchEvent: 'timer_candidate', intermediateThrowEvent: 'timer_candidate',
  boundaryEvent: 'timer_candidate',
};
const _BPMN_TASK_TAGS = new Set(['task','userTask','manualTask','serviceTask','scriptTask',
  'businessRuleTask','callActivity','subProcess','receiveTask','sendTask']);
const _BPMN_AUTO_TAGS = new Set(['serviceTask','scriptTask','businessRuleTask']);

function _parseBpmnNodes(elements) {
  const nodes = [];
  const nodeById = new Map();
  for (const el of elements) {
    const ln = localNameOf(el);
    const id = attrOf(el, ['id', 'Id', 'ID']);
    if (!id) continue;
    let mappedType = _BPMN_TYPE_MAP[ln] || (_BPMN_TASK_TAGS.has(ln) ? 'task' : '');
    if (!mappedType) continue;
    mappedType = _resolveNodeType(ln, mappedType, el);
    const node = {
      id, type: mappedType,
      label: attrOf(el, ['name', 'Name']) || id,
      x: null, y: null, lane: '', executor: '', sector: '', org: '',
      automated: _BPMN_AUTO_TAGS.has(ln),
    };
    nodes.push(node);
    nodeById.set(id, node);
  }
  return { nodes, nodeById };
}

function _parseBpmnEdges(elements) {
  const edges = [];
  for (const el of elements) {
    if (localNameOf(el) !== 'sequenceFlow') continue;
    const id = attrOf(el, ['id', 'Id', 'ID']) || `e${edges.length + 1}`;
    const from = attrOf(el, ['sourceRef', 'SourceRef', 'from', 'From']);
    const to = attrOf(el, ['targetRef', 'TargetRef', 'to', 'To']);
    if (!from || !to) continue;
    edges.push({ id, from, to, probability: 100, isLoopReturn: false, isErrorPath: false });
  }
  return edges;
}

function _buildBpmnLaneAlias(laneEls) {
  const laneAliasById = new Map();
  let laneCounter = 0;
  for (const laneEl of laneEls) {
    const laneId = attrOf(laneEl, ['id', 'Id']);
    let laneName = attrOf(laneEl, ['name', 'Name']) || laneId || '';
    if (!laneName || isTechnicalId(laneName)) { laneCounter += 1; laneName = `Raia ${laneCounter}`; }
    if (laneId) laneAliasById.set(laneId, laneName);
  }
  return laneAliasById;
}

function _applyBpmnLaneRefs(laneEls, nodeById, laneAliasById) {
  for (const laneEl of laneEls) {
    const laneId = attrOf(laneEl, ['id', 'Id']);
    const laneNameRaw = attrOf(laneEl, ['name', 'Name']) || laneId || '';
    const laneName = laneAliasById.get(laneId) || laneNameRaw || '';
    const refs = Array.from(laneEl.querySelectorAll('*'))
      .filter((e) => localNameOf(e) === 'flowNodeRef')
      .map((e) => String(e.textContent || '').trim())
      .filter(Boolean);
    for (const ref of refs) {
      const n = nodeById.get(ref);
      if (n) { n.lane = laneName; n.executor = laneName; }
    }
  }
}

function _applyBpmnShapeCoords(nodeById, elements) {
  for (const shapeEl of elements.filter((e) => localNameOf(e) === 'BPMNShape')) {
    const node = nodeById.get(attrOf(shapeEl, ['bpmnElement', 'BPMNElement']));
    if (!node) continue;
    const bounds = Array.from(shapeEl.querySelectorAll('*')).find((e) => localNameOf(e) === 'Bounds');
    if (!bounds) continue;
    const x = Number(attrOf(bounds, ['x', 'X']));
    const y = Number(attrOf(bounds, ['y', 'Y']));
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const w = Number(attrOf(bounds, ['width', 'Width'])) || 0;
      const h = Number(attrOf(bounds, ['height', 'Height'])) || 0;
      node.x = x + w / 2;
      node.y = y + h / 2;
    }
  }
}

function parseBpmnXml(doc) {
  const elements = allElements(doc);
  const { nodes, nodeById } = _parseBpmnNodes(elements);
  const edges = _parseBpmnEdges(elements);
  const laneEls = elements.filter((e) => localNameOf(e) === 'lane');
  const laneAliasById = _buildBpmnLaneAlias(laneEls);
  _applyBpmnLaneRefs(laneEls, nodeById, laneAliasById);
  _applyBpmnShapeCoords(nodeById, elements);
  const graph = { nodes, edges };
  normalizeTechnicalActorLabels(nodes, 'Raia');
  inferStartEndByTopology(graph);
  applyMissingLayout(graph);
  return graph;
}

function _isXpdlTimerEvent(allChildren) {
  return allChildren.some((c) => {
    const ln = localNameOf(c);
    if (ln === 'TimerEventDetail' || ln === 'TriggerTimer') return true;
    if (ln === 'IntermediateEvent') {
      const code = attrOf(c, ['EventTypeCode', 'eventTypeCode', 'Trigger', 'trigger', 'Type', 'type']) || '';
      if (/timer/i.test(code)) return true;
      if (Array.from(c.querySelectorAll('*')).some((gc) => localNameOf(gc) === 'TimerEventDetail')) return true;
    }
    return false;
  });
}

function _buildXpdlParticipants(elements, parentPoolActors) {
  const participants = new Map();
  for (const a of parentPoolActors) {
    if (a.id) { participants.set(a.id, a.name); participants.set(normalizeLookupKey(a.id), a.name); }
  }
  for (const el of elements.filter((e) => localNameOf(e) === 'Participant')) {
    const id = attrOf(el, ['Id', 'id', 'ID']);
    const name = participantDisplayName(el, id);
    if (id) { participants.set(id, name); participants.set(normalizeLookupKey(id), name); }
  }
  return participants;
}

function _resolveXpdlNodeType(allChildren) {
  if (allChildren.some((c) => localNameOf(c) === 'Route')) return 'gateway';
  if (allChildren.some((c) => localNameOf(c) === 'StartEvent')) return 'start';
  if (allChildren.some((c) => localNameOf(c) === 'EndEvent')) return 'end';
  if (_isXpdlTimerEvent(allChildren)) return 'timer';
  return 'task';
}

function _resolveXpdlPerformer(el, participants) {
  const performerId = textOfFirstChildByLocalName(el, 'Performer');
  const laneRef = attrOf(el, ['Lane', 'LaneId', 'lane', 'laneId', 'Participant', 'participant']);
  return participants.get(performerId)
    || participants.get(normalizeLookupKey(performerId))
    || participants.get(laneRef)
    || participants.get(normalizeLookupKey(laneRef))
    || '';
}

function _resolveXpdlCoords(el) {
  const ngi = Array.from(el.querySelectorAll('*')).find((c) => localNameOf(c) === 'NodeGraphicsInfo');
  if (!ngi) return null;
  const coords = Array.from(ngi.querySelectorAll('*')).find((c) => localNameOf(c) === 'Coordinates');
  if (!coords) return null;
  const x = Number(attrOf(coords, ['XCoordinate', 'x', 'X']));
  const y = Number(attrOf(coords, ['YCoordinate', 'y', 'Y']));
  return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
}

function _parseXpdlActivities(elements, participants, parentPoolActors) {
  const nodes = [];
  const nodeById = new Map();
  for (const el of elements.filter((e) => localNameOf(e) === 'Activity')) {
    const id = attrOf(el, ['Id', 'id', 'ID']);
    if (!id) continue;
    const allChildren = Array.from(el.querySelectorAll('*'));
    const performerName = _resolveXpdlPerformer(el, participants);
    const coords = _resolveXpdlCoords(el);
    const node = {
      id, type: _resolveXpdlNodeType(allChildren),
      label: attrOf(el, ['Name', 'name']) || id,
      x: coords ? coords.x : null, y: coords ? coords.y : null,
      lane: performerName, executor: performerName, sector: '', org: '', automated: false,
    };
    if (!node.lane && !node.executor) {
      const inferredActor = resolveActorByLaneGeometry(node, parentPoolActors);
      if (inferredActor) { node.lane = inferredActor; node.executor = inferredActor; }
    }
    nodes.push(node);
    nodeById.set(id, node);
  }
  return { nodes, nodeById };
}

function _parseXpdlEdges(elements, nodeById) {
  const edges = [];
  for (const el of elements.filter((e) => localNameOf(e) === 'Transition')) {
    const id = attrOf(el, ['Id', 'id', 'ID']) || `e${edges.length + 1}`;
    const from = attrOf(el, ['From', 'from', 'Source', 'source']);
    const to = attrOf(el, ['To', 'to', 'Target', 'target']);
    if (!from || !to || !nodeById.has(from) || !nodeById.has(to)) continue;
    edges.push({ id, from, to, probability: 100, isLoopReturn: false, isErrorPath: false });
  }
  return edges;
}

function parseXpdlXml(doc) {
  const elements = allElements(doc);
  const parentPoolActors = extractXpdlParentPoolActors(elements);
  const participants = _buildXpdlParticipants(elements, parentPoolActors);
  const { nodes, nodeById } = _parseXpdlActivities(elements, participants, parentPoolActors);
  const edges = _parseXpdlEdges(elements, nodeById);
  const graph = { nodes, edges };
  normalizeXpdlActorLabels(nodes, participants);
  normalizeTechnicalActorLabels(nodes, 'Ator');
  inferStartEndByTopology(graph);
  applyMissingLayout(graph);
  return graph;
}

function parseWorkflowXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(xmlText || ''), 'application/xml');
  const parseErrors = doc.getElementsByTagName('parsererror');
  if (parseErrors.length) {
    throw new Error('Arquivo XML/XPDL invalido. Nao foi possivel fazer parse.');
  }

  const hasXpdl = allElements(doc).some((e) => localNameOf(e) === 'Package' || localNameOf(e) === 'WorkflowProcess');
  const hasBpmn = allElements(doc).some((e) => localNameOf(e) === 'definitions' || localNameOf(e) === 'process');

  if (hasXpdl) return { graph: parseXpdlXml(doc), format: 'XPDL/XML' };
  if (hasBpmn) return { graph: parseBpmnXml(doc), format: 'BPMN/XML' };

  // Try BPMN parser first as fallback, then XPDL parser.
  const bpmnGraph = parseBpmnXml(doc);
  if ((bpmnGraph.nodes || []).length && (bpmnGraph.edges || []).length) {
    return { graph: bpmnGraph, format: 'XML' };
  }

  const xpdlGraph = parseXpdlXml(doc);
  if ((xpdlGraph.nodes || []).length && (xpdlGraph.edges || []).length) {
    return { graph: xpdlGraph, format: 'XML' };
  }

  throw new Error('Nao foi possivel identificar estrutura de fluxo no XML/XPDL.');
}

async function toPngDataUrl(file) {
  if (file.type === 'application/pdf') {
    // PDF rendering simplified: this module expects first page pre-converted.
    // In this isolated version, we send PDF bytes as base64 directly to AI.
    return readFileAsDataUrl(file);
  }
  return readFileAsDataUrl(file);
}

function extractJson(text) {
  const clean = String(text || '').trim();
  const fenced = clean.match(/```json\s*([\s\S]*?)```/i);
  const payload = fenced ? fenced[1] : clean;

  const candidates = [];
  candidates.push(payload);

  // Also try to parse only the first JSON object found in a longer response.
  const firstObj = extractFirstObject(payload);
  if (firstObj) candidates.push(firstObj);

  // Add repaired variants for common model mistakes.
  const repaired = repairJsonLike(firstObj || payload);
  if (repaired) candidates.push(repaired);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }

  throw new Error('Resposta da IA nao veio em JSON valido para topologia BPMN.');
}

function _advanceStringState(ch, escaping) {
  if (escaping) return { escaping: false, inString: true };
  if (ch === '\\') return { escaping: true, inString: true };
  if (ch === '"') return { escaping: false, inString: false };
  return { escaping: false, inString: true };
}

function extractFirstObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return '';

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      ({ escaping, inString } = _advanceStringState(ch, escaping));
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') { depth += 1; continue; }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return '';
}

function repairJsonLike(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  // Normalize smart quotes.
  s = s
    .replaceAll(/[\u201C\u201D]/g, '"')
    .replaceAll(/[\u2018\u2019]/g, "'");

  // Remove JS comments.
  s = s
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/(^|\s)\/\/.*$/gm, '$1');

  // Remove trailing commas before } or ].
  s = s.replaceAll(/,\s*([}\]])/g, '$1');

  // If response has extra text, keep only first object.
  const first = extractFirstObject(s);
  return first || s;
}

function buildPrompt() {
  return [
    'Voce e um extrator de topologia BPMN a partir de imagem.',
    'Retorne APENAS JSON valido (UTF-8), sem markdown, sem comentarios e sem virgulas finais.',
    'Use aspas duplas em todas as chaves e strings.',
    'Retorne APENAS JSON valido no formato:',
    '{"nodes":[{"id":"...","type":"start|task|gateway|end","label":"...","x":100,"y":120,"lane":"","executor":"","sector":"","org":"","automated":false}],"edges":[{"id":"e1","from":"n1","to":"n2","probability":100,"isLoopReturn":false,"isErrorPath":false}]}',
    'Regras:',
    '- Detecte atividades (retangulos arredondados), gateways (losangos), eventos (circulos).',
    '- Extraia texto OCR como label.',
    '- Inferir coordenadas x/y aproximadas para overlay.',
    '- Detectar setas e construir edges.',
    '- Se houver raias (swimlanes), preencha lane e executor em CADA tarefa com o nome da raia/ator.',
    '- Se nao houver raia explicita, inferir ator por contexto textual da tarefa (setor/cargo).',
    '- Se houver bifurcacao, preencha probabilities somando 100.',
    '- Se houver fluxo de retorno, marque isLoopReturn=true.',
    '- Se houver caminho de erro/fim excepcional, marque isErrorPath=true.',
    '- Nao inclua markdown, apenas JSON.',
  ].join('\n');
}

function buildSpreadsheetPrompt() {
  return [
    'Voce e um extrator de topologia de processo a partir de planilha (XLSX).',
    'Leia o conteudo tabular e identifique atividades, decisoes e transicoes.',
    'A planilha pode ter blocos diferentes: fluxo principal no topo e mapeamento de atores nas ultimas linhas.',
    'Retorne APENAS JSON valido no formato:',
    '{"nodes":[{"id":"...","type":"start|task|gateway|end","label":"...","x":100,"y":120,"lane":"","executor":"","sector":"","org":"","automated":false}],"edges":[{"id":"e1","from":"n1","to":"n2","probability":100,"isLoopReturn":false,"isErrorPath":false}]}',
    'Regras:',
    '- Se a frase comecar com verbo, classifique como acao (task).',
    '- Se for nome de equipe/setor/cargo (frase nominal), classifique como ator/raia.',
    '- Se tiver interrogacao, classifique como decisao (gateway).',
    '- Se tiver nome + verbo no preterito perfeito, classifique como evento e inferir inicio/intermediario/fim pelo contexto.',
    '- Se houver colunas de ator/raia/responsavel, preencher lane e executor.',
    '- Se o mapeamento de ator estiver nas ultimas linhas (rodape), vincule esse mapeamento as atividades correspondentes por nome/codigo da acao.',
    '- Se houver coluna de probabilidade por caminho, preencher probability.',
    '- Se nao houver probabilidade, use 100 para fluxo unico e distribuicao proporcional para multiplas saidas do mesmo gateway.',
    '- Nao inclua markdown, apenas JSON.',
  ].join('\n');
}

function buildLanePrompt(baseGraph) {
  return [
    'Voce e um analista BPMN focado em raias e atores.',
    'Dado o grafo abaixo e a imagem do processo, preencha lane/executor/sector/org por no de tarefa.',
    'NAO altere ids, tipos, arestas, x, y, probabilidades.',
    'Retorne APENAS JSON valido no formato:',
    '{"nodes":[{"id":"n1","lane":"...","executor":"...","sector":"...","org":"..."}]}',
    'Regras:',
    '- Use os titulos das raias para preencher lane/executor.',
    '- Se uma tarefa estiver em uma raia, o actor da tarefa deve herdar essa raia.',
    '- Nao invente quando nao houver evidencias: deixe string vazia.',
    '',
    'Grafo atual:',
    JSON.stringify(baseGraph),
  ].join('\n');
}

function buildRepairPrompt(rawText) {
  return [
    'Converta o conteudo abaixo para JSON estritamente valido.',
    'Regras obrigatorias:',
    '- Responda APENAS com JSON valido.',
    '- Sem markdown, sem explicacoes.',
    '- Use exatamente as chaves: nodes, edges.',
    '- Mantenha os dados e corrija apenas formato invalido.',
    '- Se faltar algum campo, complete com default razoavel.',
    '',
    'Conteudo para reparar:',
    rawText,
  ].join('\n');
}

function normalizeExtractedGraph(graph) {
  const g = graph && typeof graph === 'object' ? graph : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];

  return {
    nodes: nodes.map((n, i) => ({
      id: String(n?.id || `n${i + 1}`),
      type: ['start', 'task', 'gateway', 'end'].includes(String(n?.type || 'task')) ? String(n.type) : 'task',
      label: String(n?.label || n?.id || `No ${i + 1}`),
      x: Number.isFinite(Number(n?.x)) ? Number(n.x) : 120 + (i * 120),
      y: Number.isFinite(Number(n?.y)) ? Number(n.y) : 120,
      lane: String(n?.lane || n?.executor || ''),
      executor: String(n?.executor || ''),
      sector: String(n?.sector || ''),
      org: String(n?.org || ''),
      automated: Boolean(n?.automated),
    })),
    edges: edges.map((e, i) => ({
      id: String(e?.id || `e${i + 1}`),
      from: String(e?.from || ''),
      to: String(e?.to || ''),
      probability: Number.isFinite(Number(e?.probability)) ? Number(e.probability) : 100,
      isLoopReturn: Boolean(e?.isLoopReturn),
      isErrorPath: Boolean(e?.isErrorPath),
    })),
  };
}

function needsActorEnrichment(graph) {
  const tasks = (graph?.nodes || []).filter((n) => n.type === 'task');
  if (!tasks.length) return false;

  const missing = tasks.filter((n) => {
    const lane = String(n?.lane || '').trim();
    const exec = String(n?.executor || '').trim();
    return !lane && !exec;
  }).length;

  return (missing / tasks.length) >= 0.7;
}

function mergeActorData(baseGraph, actorPayload) {
  const g = normalizeExtractedGraph(baseGraph);
  const actorById = new Map();
  const nodes = Array.isArray(actorPayload?.nodes) ? actorPayload.nodes : [];

  for (const n of nodes) {
    if (!n?.id) continue;
    actorById.set(String(n.id), {
      lane: String(n?.lane || ''),
      executor: String(n?.executor || ''),
      sector: String(n?.sector || ''),
      org: String(n?.org || ''),
    });
  }

  g.nodes = g.nodes.map((n) => {
    if (n.type !== 'task') return n;
    const patch = actorById.get(n.id);
    if (!patch) return n;
    return {
      ...n,
      lane: patch.lane || n.lane,
      executor: patch.executor || n.executor,
      sector: patch.sector || n.sector,
      org: patch.org || n.org,
    };
  });

  return g;
}

async function readResponseBodySafe(resp) {
  const raw = await resp.text();
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: null };
  }
}

function resolveAiText(raw, json) {
  if (json && typeof json === 'object' && typeof json.text === 'string') return json.text;
  if (typeof json === 'string') return json;
  return String(raw || '');
}

function resolveErrorMessage(status, raw, json, fallback = 'Falha ao chamar IA') {
  if (json && typeof json === 'object') {
    if (typeof json.error === 'string' && json.error.trim()) return json.error.trim();
    if (typeof json.message === 'string' && json.message.trim()) return json.message.trim();
  }

  const cleaned = String(raw || '').trim();
  if (cleaned) {
    const line = cleaned.split('\n').map((s) => s.trim()).find(Boolean) || cleaned;
    return `${fallback} (${status}): ${line.slice(0, 220)}`;
  }

  return `${fallback} (${status})`;
}

function parseRetryAfterSeconds(message, raw, json) {
  const byJson = Number(json?.retryAfter);
  if (Number.isFinite(byJson) && byJson > 0) return byJson;

  const sources = [String(message || ''), String(raw || '')].join('\n');
  const m = sources.match(/retry\s+in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!m) return 0;
  const secs = Number(m[1]);
  return Number.isFinite(secs) && secs > 0 ? secs : 0;
}

function isQuotaOrRateLimitMessage(message) {
  const s = String(message || '').toLowerCase();
  return s.includes('quota exceeded')
    || s.includes('rate limit')
    || s.includes('too many requests')
    || s.includes('retry in')
    || s.includes('429');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function repairJsonViaAi(endpoint, rawText) {
  const repairPayload = {
    prompt: buildRepairPrompt(rawText),
    maxTokens: 6000,
  };

  const resp = await postWithTimeout(endpoint, repairPayload, 30000);
  const { raw, json } = await readResponseBodySafe(resp);
  if (!resp.ok) {
    throw new Error(resolveErrorMessage(resp.status, raw, json, 'Falha no reparo JSON'));
  }

  return resolveAiText(raw, json);
}

async function enrichActorsViaAi(endpoint, baseGraph, image) {
  const payload = {
    prompt: buildLanePrompt(baseGraph),
    image,
    maxTokens: 4000,
  };

  const resp = await postWithTimeout(endpoint, payload, 35000);
  const { raw, json } = await readResponseBodySafe(resp);
  if (!resp.ok) {
    throw new Error(resolveErrorMessage(resp.status, raw, json, 'Falha ao enriquecer atores'));
  }

  const text = resolveAiText(raw, json);
  return extractJson(text);
}

async function tryEnrichActors(endpoint, graph, image) {
  try {
    const actorPayload = await enrichActorsViaAi(endpoint, graph, image);
    return mergeActorData(graph, actorPayload);
  } catch {
    return graph;
  }
}

async function _attemptExtraction(endpoint, payload, base64, mimeType, retriedForQuota) {
  const resp = await postWithTimeout(endpoint, payload, 45000);
  const { raw, json } = await readResponseBodySafe(resp);
  if (!resp.ok) {
    const msg = resolveErrorMessage(resp.status, raw, json, 'Falha na extracao');
    const retrySecs = parseRetryAfterSeconds(msg, raw, json);
    if (!retriedForQuota && isQuotaOrRateLimitMessage(msg) && retrySecs > 0 && retrySecs <= 90) {
      return { done: false, result: null, error: null, retryAfterMs: Math.ceil(retrySecs + 1) * 1000 };
    }
    throw new Error(msg);
  }

  const text = resolveAiText(raw, json);

  let parsedText;
  try {
    parsedText = text;
    extractJson(text);
  } catch (parseErr) {
    parsedText = await repairJsonViaAi(endpoint, text);
  }

  let graph = normalizeExtractedGraph(extractJson(parsedText));

  if (needsActorEnrichment(graph)) {
    graph = await tryEnrichActors(endpoint, graph, { data: base64, mimeType });
  }

  return { done: true, result: { graph, rawText: parsedText, endpointUsed: endpoint }, error: null };
}

async function postWithTimeout(url, payload, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function extractTopologyFromImage(file, aiEndpoint = '/api/ai') {
  const dataUrl = await toPngDataUrl(file);
  const base64 = dataUrl.split(',')[1] || '';
  const mimeType = file.type || 'image/png';

  const payload = {
    prompt: buildPrompt(),
    image: { data: base64, mimeType },
    maxTokens: 6000,
  };

  const endpoints = [
    aiEndpoint,
    '/ai',
    'http://127.0.0.1:3000/ai',
    'http://localhost:3000/ai',
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    let retriedForQuota = false;
    try {
      while (true) {
        const attempt = await _attemptExtraction(endpoint, payload, base64, mimeType, retriedForQuota);
        if (attempt.retryAfterMs) {
          retriedForQuota = true;
          await sleep(attempt.retryAfterMs);
          continue;
        }
        if (attempt.done) {
          return { ...attempt.result, imageDataUrl: dataUrl };
        }
      }
    } catch (endpointError) {
      lastError = endpointError;
    }
  }

  const msg = String(lastError?.message || 'desconhecido');
  if (isQuotaOrRateLimitMessage(msg)) {
    throw new Error(`Cota da IA atingida no provedor atual. ${msg}`);
  }

  throw new Error(`Nao foi possivel acessar o backend de IA. Ultimo erro: ${msg}`);
}

export async function extractTopologyFromSpreadsheetFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(',')[1] || '';
  const fileName = String(file?.name || 'arquivo.xlsx');

  // Deterministic local parser only (no AI quota usage for spreadsheets).
  const localEndpoints = [
    '/parse-xlsx',
    'http://127.0.0.1:3000/parse-xlsx',
    'http://localhost:3000/parse-xlsx',
  ];

  let lastLocalError = null;
  for (const endpoint of localEndpoints) {
    try {
      const resp = await postWithTimeout(endpoint, { data: base64, fileName }, 25000);
      const { raw, json } = await readResponseBodySafe(resp);
      if (!resp.ok) {
        const msg = resolveErrorMessage(resp.status, raw, json, 'Falha no parser local de XLSX');
        lastLocalError = new Error(msg);
        continue;
      }
      const payload = json && typeof json === 'object' ? json : {};
      if (!payload.graph) {
        lastLocalError = new Error('Resposta sem grafo no parser local de XLSX.');
        continue;
      }
      const graph = normalizeExtractedGraph(payload.graph);
      const notes = String(payload.notes || 'Importacao local de XLSX concluida.');
      return { graph, rawText: notes, endpointUsed: endpoint, imageDataUrl: '' };
    } catch (localParserError) {
      lastLocalError = localParserError;
    }
  }

  throw new Error(
    `Nao foi possivel importar planilha pelo parser local (/parse-xlsx). `
    + `A importacao de XLSX/XLS nao usa IA por fallback. `
    + `Inicie o backend local e tente novamente. Ultimo erro: ${String(lastLocalError?.message || 'desconhecido')}`
  );
}

export async function extractTopologyFromWorkflowFile(file) {
  const text = await readFileAsText(file);
  const { graph, format } = parseWorkflowXml(text);
  const normalized = normalizeExtractedGraph(graph);

  return {
    graph: normalized,
    rawText: `Importacao estruturada concluida via ${format}. Nos: ${normalized.nodes.length} | Arestas: ${normalized.edges.length}.`,
    endpointUsed: 'local-xml-parser',
    imageDataUrl: '',
  };
}
