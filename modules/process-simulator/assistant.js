const LOOP_VERBS = ['revisar', 'analisar', 'validar', 'conferir', 'auditar', 'aprovar'];
const AUTO_VERBS = ['consultar', 'extrair', 'emitir', 'gerar', 'enviar', 'notificar', 'integrar'];

function includesAny(text, words) {
  const t = String(text || '').toLowerCase();
  return words.some((w) => t.includes(w));
}

export function scanSuggestions(graph) {
  const suggestions = [];
  for (const node of graph.nodes || []) {
    if (node.type !== 'task') continue;
    const text = String(node.label || '');

    if (includesAny(text, LOOP_VERBS)) {
      suggestions.push({
        kind: 'loop',
        nodeId: node.id,
        message: `"${node.label}": este ponto pode gerar retrabalho. Defina probabilidade de retorno?`,
      });
    }

    if (includesAny(text, AUTO_VERBS) && !node.automated) {
      suggestions.push({
        kind: 'automation',
        nodeId: node.id,
        message: `"${node.label}": atividade passivel de RPA/IA. Simular automacao?`,
      });
    }
  }
  return suggestions;
}

export function markAutomation(graph, nodeId, automated = true) {
  const next = structuredClone(graph);
  const node = next.nodes.find((n) => n.id === nodeId);
  if (node) node.automated = Boolean(automated);
  return next;
}

export function setLoopProbability(graph, taskNodeId, probabilityReturn = 30) {
  const next = structuredClone(graph);
  const edgesFromTask = next.edges.filter((e) => e.from === taskNodeId);
  if (!edgesFromTask.length) return next;

  // Garante que probabilityReturn é um número válido entre 0 e 100
  let loopProb = Number(probabilityReturn);
  if (Number.isNaN(loopProb) || loopProb < 0) loopProb = 0;
  if (loopProb > 100) loopProb = 100;

  let loop = edgesFromTask.find((e) => e.isLoopReturn);
  if (!loop) {
    loop = edgesFromTask[0];
    loop.isLoopReturn = true;
  }

  loop.probability = loopProb;
  const others = edgesFromTask.filter((e) => e.id !== loop.id);
  const remaining = 100 - loop.probability;
  const each = others.length ? remaining / others.length : 0;
  for (const e of others) e.probability = each;

  // Garante que a soma das probabilidades é 100 (ajuste de arredondamento)
  const totalProb = edgesFromTask.reduce((sum, e) => sum + e.probability, 0);
  if (totalProb !== 100 && edgesFromTask.length > 0) {
    // Ajusta o último edge para compensar diferença de arredondamento
    const diff = 100 - totalProb;
    edgesFromTask[edgesFromTask.length - 1].probability += diff;
  }

  return next;
}
