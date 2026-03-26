function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload  = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
async function npopExtractWithGemini() {
  const popFile  = _npopFile;
  const bpmnFile = window._npopBpmnFile || null;

  if(!popFile) { showToast('Selecione o documento POP antes de extrair.', 'warn'); return; }

  const npopStep = document.getElementById('npop-s2');
  const msg  = document.getElementById('npop-extract-msg');
  const pbar = document.getElementById('npop-pbar');
  npopStep.style.display = 'block';
  document.getElementById('npop-s1').style.display = 'none';
  document.getElementById('npop-s3').style.display = 'none';

  pbar.style.width = '10%';
  msg.textContent = 'Lendo o documento POP...';

  try {
    // ── Chamada 1: POP → metadados + executores + etapas (sem flow) ──
    // Causa raiz corrigida: o proxy so anexava image/*; PDF/DOCX eram ignorados.
    // Agora extraimos o texto do PDF e passamos no prompt.
    const popTextRaw = await _npopExtractSourceText(popFile);
    if(!popTextRaw) {
      throw new Error('Não foi possível ler texto do PDF enviado. Verifique se o arquivo não está protegido/escaneado sem OCR.');
    }
    const popText = popTextRaw.slice(0, 16000);
    pbar.style.width = '25%';
    msg.textContent = 'Extraindo metadados e etapas do POP...';

    const promptPop =
`# EXTRAÇÃO DE POP — SIGA/CAGE-RS
Analise o documento e extraia as informações abaixo. Leia o documento INTEIRO antes de estruturar. Nunca invente dados ausentes. Retorne APENAS JSON puro, sem markdown.

# 1. METADADOS BÁSICOS
nome, macro, processo, subprocesso, unidade, elaborado, revisado, aprovado, versao, data_emissao, desc (objetivo do processo), input (entradas/insumos), output (saídas/produtos), fornecedores (quem fornece insumos), clientes (quem recebe o resultado).

# 2. EXECUTORES
executores[] — uma entrada por executor (NUNCA concatene nomes com ";").
Cada executor: "name" (nome exato), "title" (cargo/função), "duties" (responsabilidades gerais, array de strings).
O campo "actor" de cada action em steps[] deve usar EXATAMENTE o "name" do executor responsável.

# 3. ETAPAS DE EXECUÇÃO (steps[]) — FOCO PRINCIPAL
⚠️ Inclua APENAS as fases de execução operacional do processo — o que os executores realmente fazem.
NÃO inclua: FAQ, Formulários, Anexos, Glossário, Indicadores, Normas, Objetivo, Escopo ou qualquer seção informacional.
Identifique a seção de "Execução", "Procedimento" ou "Descrição das Atividades".
Cada fase/agrupamento lógico dessa seção = uma step (macro-etapa). NUNCA mescle fases distintas. NUNCA omita uma fase de execução.

Para cada step:
- "title": nome da fase/etapa (ex: "Recebimento da Solicitação")
- "responsible": nome do executor principal (igual a executores[].name)
- "note": observação geral da etapa, se houver (null se não houver)
- "actions": lista de ações desta etapa — UMA por linha/bullet/item

Para cada action:
- "type": "atividade" | "decisao" | "evento" | "observacao"
  · atividade = ação executável · decisao = ponto de escolha com caminhos — NUNCA classifique pergunta/condição como atividade
  · evento = marco de início/fim · observacao = nota, OBS:, texto explicativo que não é ação
- "text": texto exato do documento — não resuma, não parafraseie
- "actor": nome exato do executor (só para "atividade"; "" para os demais tipos)
- "natureza": "aprovacao" | "revisao" | ""
- "sistemas": nome do sistema mencionado (só para "atividade"; "" se não houver)
- "branches": para "decisao": [{"label":"Sim","actions":[...]},{"label":"Não","actions":[...]}]

# FORMATO JSON (sem flow[])
{"nome":"","macro":"","processo":"","subprocesso":"","unidade":"","elaborado":"","revisado":"","aprovado":"","versao":"","data_emissao":"","desc":"","input":"","output":"","fornecedores":"","clientes":"","executores":[{"name":"","title":"","duties":[]}],"steps":[{"title":"","responsible":"","note":null,"actions":[{"type":"atividade","text":"","actor":"","natureza":"","sistemas":"","branches":[]}]}]}

VALIDAÇÃO:
✓ steps[] contém APENAS fases de execução operacional
✓ Cada linha de ação = uma action separada (nunca agrupe)
✓ Decisões usam "branches" — nunca são classificadas como "atividade"

# TEXTO DO POP (FONTE)
${popText}`;

    pbar.style.width = '50%';
    msg.textContent = 'Processando resposta do POP...';

    const text = await callGeminiProxy(promptPop, null, { maxTokens: 8000 });
    const extracted = parseAiJson(text);

    // Se o modelo devolver nome genérico (eco do prompt), usa nome do arquivo.
    const modelName = extracted.nome || extracted.titulo || extracted.processo || '';
    if(_npopLooksGenericName(modelName)) {
      const byFile = _npopFileBaseName(popFile.name);
      if(byFile) {
        extracted.processo = byFile;
        if(!extracted.nome) extracted.nome = byFile;
      }
    }

    // ── Chamada 2 (opcional): BPMN → flow[] ──
    if(bpmnFile) {
      pbar.style.width = '65%';
      msg.textContent = 'Extraindo fluxo do diagrama BPMN...';

      const base64Bpmn   = await blobToBase64(bpmnFile);
      const mimeTypeBpmn = bpmnFile.type || 'image/png';

      const promptBpmn =
`# EXTRAÇÃO DE FLUXO — DIAGRAMA BPMN/FLUXOGRAMA
Analise esta imagem de diagrama de processo e extraia o fluxo completo. Retorne APENAS JSON puro, sem markdown.

Mapeie TODOS os nós visíveis no diagrama:
- "id": identificador único por nó (n1, n2, n3, ...)
- "type": "start" | "task" | "decision" | "end"
- "name": texto exato do nó (nome da atividade ou pergunta da decisão)
- "actor": nome do ator ou raia responsável pelo nó (se identificável; "" se não)
- "next": lista de destinos — [{"id":"n2","label":""}] — com label obrigatório nas setas de decisão

Inclua todos os caminhos de decisão, loops e exceções visíveis. Obrigatório: pelo menos um "start" e um "end".

FORMATO: {"flow":[{"id":"n1","type":"start","name":"Início","actor":"","next":[{"id":"n2","label":""}]}]}`;

      pbar.style.width = '85%';
      msg.textContent = 'Processando fluxo do BPMN...';

      const bpmnText = await callGeminiProxy(promptBpmn, { data: base64Bpmn, mimeType: mimeTypeBpmn }, { maxTokens: 4000 });
      const bpmnResult = parseAiJson(bpmnText);
      if(bpmnResult.flow) extracted.flow = bpmnResult.flow;
    }

    pbar.style.width = '100%';

    // Preenche os campos do formulário manual com os dados extraídos
    document.getElementById('npop-s2').style.display = 'none';
    document.getElementById('npop-s1').style.display = 'block';
    selectNpopMethod('manual');

    setTimeout(() => {
      try {
        // Macroprocesso (primeiro para popular a datalist de processo)
        if(extracted.macro) {
          document.getElementById('nf-macro').value = extracted.macro;
          if(typeof npopUpdateProcessoList === 'function') npopUpdateProcessoList();
        }
        // Nome do processo → campo nf-processo
        const nome = extracted.nome || extracted.titulo || extracted.processo || '';
        if(nome) document.getElementById('nf-processo').value = nome;
        // Subprocesso
        if(extracted.subprocesso) {
          document.getElementById('nf-subprocesso').value = extracted.subprocesso;
          if(typeof npopUpdateSubprocessoList === 'function') npopUpdateSubprocessoList();
          if(typeof npopAutoFill === 'function') npopAutoFill();
        }
        // Objetivo / descrição
        const desc = extracted.desc || extracted.objetivo || '';
        if(desc) document.getElementById('nf-desc').value = desc;
        // Entradas / saídas
        const inp = extracted.input || extracted.entradas || '';
        if(inp) document.getElementById('nf-input').value = inp;
        const out = extracted.output || extracted.saidas || '';
        if(out) document.getElementById('nf-output').value = out;
        // Fornecedores / clientes
        if(extracted.fornecedores) document.getElementById('nf-fornecedores').value = extracted.fornecedores;
        if(extracted.clientes)     document.getElementById('nf-clientes').value     = extracted.clientes;
        // Equipe de mapeamento — vem de elaborado/elaborador/unidade
        const equipe = extracted.elaborado || extracted.elaborador || '';
        if(equipe) document.getElementById('nf-equipe').value = equipe;
        // Unidade (readonly mas pode ser preenchido via IA)
        if(extracted.unidade) {
          const unEl = document.getElementById('nf-unidade');
          if(unEl) { unEl.readOnly = false; unEl.value = extracted.unidade; unEl.readOnly = true; }
        }
      } catch(fieldErr) {
        /* intentional */
      }

      window._npopExtractedEtapas = extracted.steps || extracted.etapas || [];
      window._npopExtractedFull   = extracted;
      const bpmnMsg = bpmnFile ? ' Fluxo extraído do BPMN.' : '';
      showToast('✅ Extração concluída!' + bpmnMsg + ' Revise os campos e clique em Criar Mapeamento.', 'success');
    }, 300);

  } catch(err) {
    /* exibe mensagem de erro na interface */
    document.getElementById('npop-s2').style.display = 'none';
    document.getElementById('npop-s3').style.display = 'block';
    document.getElementById('npop-extract-result').innerHTML = `
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:20px;text-align:center;">
        <div style="font-size:24px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:700;color:#dc2626;margin-bottom:4px;">Erro na extração</div>
        <div style="font-size:13px;color:#64748b;">${err.message}</div>
        <button class="btn btn-outline" onclick="selectNpopMethod('ia')" style="margin-top:12px;font-size:13px;">Tentar novamente</button>
      </div>`;
  }
}

// ═══════════════════════════════════════════════════════════
// SAVE/LOAD CLOUD — REPO_DOCS e DROPS integrados ao payload
// ═══════════════════════════════════════════════════════════
// (integrado diretamente em saveToCloud e loadFromCloud abaixo)

// Patch showHome to hide repo/drops
const _origShowHome2 = showHome;
showHome = function() {
  document.getElementById('repo-module').style.display  = 'none';
  document.getElementById('drops-module').style.display = 'none';
  _origShowHome2.apply(this, arguments);
};


// ══ Auto-status atrasado ════════════════════
// Atualiza status para 'atrasado' se dataPrevista foi ultrapassada
// e o status atual não é 'concluido' nem 'suspenso'
function checkAutoStatusAtrasado(p) {
  const m = DATA[p]?.meta;
  if(!m || !m.dataPrevista) return false;
  if(['concluido','suspenso'].includes(m.statusMap)) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const prev  = new Date(m.dataPrevista + 'T00:00:00');
  if(isNaN(prev)) return false;
  if(prev < today && m.statusMap !== 'atrasado') {
    m.statusMap = 'atrasado';
    return true; // mudou
  }
  return false;
}

function checkAllAutoStatus() {
  let changed = false;
  Object.keys(DATA).filter(k => k !== 'pat').forEach(k => {
    if(DATA[k]?.meta) changed = checkAutoStatusAtrasado(k) || changed;
  });
  return changed;
}

// ══ Controle de Revisões ════════════════════
let _revPop = 'd';

function openRevModal(p) {
  if(!isEditor) { showToast('🔒 Apenas editores podem registrar revisões.','warn'); return; }
  _revPop = p;
  const revs = DATA[p]?.revisions || [];
  const lastNum = revs.length ? (Number(revs[revs.length-1]?.num) || 0) + 1 : 1;
  document.getElementById('rm-num').value    = lastNum;
  document.getElementById('rm-date').value   = new Date().toLocaleDateString('pt-BR');
  document.getElementById('rm-desc').value   = '';
  document.getElementById('rm-author').value = '';
  document.getElementById('rev-modal').classList.add('open');
}

function saveRevision() {
  const num    = document.getElementById('rm-num').value.trim();
  const date   = document.getElementById('rm-date').value.trim();
  const desc   = document.getElementById('rm-desc').value.trim();
  const author = document.getElementById('rm-author').value.trim();
  if(!desc) { showToast('Informe a descrição da revisão.','warn'); return; }
  if(!DATA[_revPop].revisions) DATA[_revPop].revisions = [];
  DATA[_revPop].revisions.push({ num, date, desc, author });
  document.getElementById('rev-modal').classList.remove('open');
  renderRevisions(_revPop);
  markChanged(true, true);
  showToast('✅ Revisão registrada!','success');
}

// ══ Status Modal ════════════════════════════
function openStatusModal(p) {
  if(!isEditor) { showToast('🔒 Apenas editores podem editar.','warn'); return; }
  const m = DATA[p]?.meta || {};
  document.getElementById('status-modal-pop').value = p;
  // Capa
  document.getElementById('status-modal-icon').value       = m.bannerIcon || '';
  document.getElementById('status-modal-banner-sub').value = m.bannerSub  || '';
  // Identificação — popular macro
  const macroSel = document.getElementById('status-modal-macro');
  if(macroSel) {
    const macros = [...new Set((arqGetData ? arqGetData() : CAGE_PROCESSOS).map(r => r.macroprocesso).filter(Boolean))].sort();
    macroSel.innerHTML = '<option value="">Selecione o macroprocesso...</option>'
      + macros.map(m2 => `<option value="${m2}">${m2}</option>`).join('');
    macroSel.value = m.macro || '';
  }
  statusModalUpdateProcessoList();
  document.getElementById('status-modal-processo').value = m.processo || '';
  statusModalUpdateSubList();
  document.getElementById('status-modal-sub').value = m.sub || m.name || '';
  // Unidade (readonly), Gerente (editável)
  const unEl = document.getElementById('status-modal-unidade'); if(unEl) unEl.value = m.unidade || '';
  const geEl = document.getElementById('status-modal-gerente'); if(geEl) geEl.value = m.gerente || '';
  // Objetivo Estratégico
  const objs = Array.isArray(m.objEstrategicos) ? m.objEstrategicos : [];
  const objHEl = document.getElementById('status-modal-obj-estrategico'); if(objHEl) objHEl.value = JSON.stringify(objs);
  const tagsEl = document.getElementById('status-modal-obj-tags');
  if(tagsEl) tagsEl.innerHTML = objs.length
    ? objs.map(o=>`<span style="display:inline-block;background:#e8f0fe;color:#1a56db;font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid #c5d8f5;">${o}</span>`).join('')
    : '<span style="color:#94a3b8;font-size:12px;">Nenhum objetivo estratégico associado</span>';
  // Equipe responsável (select filtrado)
  npopUpdateEquipeSelect(m.unidade || '', 'status-modal-equipe-resp');
  const erSel = document.getElementById('status-modal-equipe-resp'); if(erSel) erSel.value = m.equipeResponsavel || '';
  // Tipo de trabalho
  const tipoSel = document.getElementById('status-modal-tipo');
  if(tipoSel) {
    const tipos = getConfig('tipoTrabalho');
    tipoSel.innerHTML = '<option value="">Selecione...</option>' + tipos.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    tipoSel.value = m.tipo || '';
  }
  document.getElementById('status-modal-dificuldade').value = m.dificuldade || '';
  // Status e Datas
  document.getElementById('status-modal-status').value   = m.statusMap    || '';
  document.getElementById('status-modal-inicio').value   = m.dataInicio   || '';
  document.getElementById('status-modal-prevista').value = m.dataPrevista || '';
  document.getElementById('status-modal-efetiva').value  = m.dataEfetiva  || '';
  // Pessoas
  document.getElementById('status-modal-solicitante').value = m.solicitante || '';
  populatePatrocinadoresSelect('status-modal-patrocinador', m.patrocinador || '');
  document.getElementById('status-modal-equipe').value = m.equipe || '';
  // Processo
  document.getElementById('status-modal-desc').value       = m.desc        || '';
  document.getElementById('status-modal-input').value      = m.input       || '';
  document.getElementById('status-modal-output').value     = m.output      || '';
  document.getElementById('status-modal-resultados').value = m.resultados  || '';
  document.getElementById('status-modal-fornecedores').value = m.fornecedores || '';
  document.getElementById('status-modal-clientes').value    = m.clientes    || '';
  document.getElementById('status-modal-sistemas').value    = m.sistemas    || '';
  // Atores
  npopRenderAtores(Array.isArray(m.atores) ? m.atores : [], false);
  // Vínculo com PAT
  const sel = document.getElementById('status-modal-pat-vinc');
  if(sel) {
    if(!DATA.pat) DATA.pat = [];
    const slbl = { planejado:'Planejado', andamento:'Em Andamento', concluido:'Concluído', atrasado:'Atrasado', cancelado:'Cancelado' };
    sel.innerHTML = '<option value="">— Nenhum vínculo —</option>'
      + DATA.pat.map(item => {
          const info = [item.unidade, slbl[item.status]||item.status].filter(Boolean).join(' · ');
          return `<option value="${item.id}">${item.titulo||'Item sem título'}${info?'  ['+info+']':''}</option>`;
        }).join('');
    sel.value = m.patVinc || '';
  }
  openModal('status-map-modal');
}

function saveStatusModal() {
  const p = document.getElementById('status-modal-pop').value;
  if(!DATA[p]) return;
  if(!DATA[p].meta) DATA[p].meta = {};
  const m = DATA[p].meta;
  // Capa
  const newIcon   = document.getElementById('status-modal-icon').value.trim();
  const newSub    = document.getElementById('status-modal-banner-sub').value.trim();
  if(newIcon) m.bannerIcon = newIcon; else delete m.bannerIcon;
  if(newSub)  m.bannerSub  = newSub;  else delete m.bannerSub;
  // Identificação
  const newName = document.getElementById('status-modal-nome').value.trim();
  if(newName) m.name = newName;
  m.macro             = document.getElementById('status-modal-macro').value;
  m.processo          = document.getElementById('status-modal-processo').value.trim();
  m.sub               = document.getElementById('status-modal-sub').value.trim();
  m.unidade           = document.getElementById('status-modal-unidade').value.trim();
  m.gerente           = document.getElementById('status-modal-gerente').value.trim();
  m.objEstrategicos   = _tryParseJson(document.getElementById('status-modal-obj-estrategico')?.value, []);
  m.equipeResponsavel = (document.getElementById('status-modal-equipe-resp')?.value || '').trim();
  m.tipo              = document.getElementById('status-modal-tipo').value;
  m.dificuldade       = document.getElementById('status-modal-dificuldade').value;
  // Status e Datas
  m.statusMap    = document.getElementById('status-modal-status').value;
  m.dataInicio   = document.getElementById('status-modal-inicio').value;
  m.dataPrevista = document.getElementById('status-modal-prevista').value;
  m.dataEfetiva  = document.getElementById('status-modal-efetiva').value;
  // Pessoas
  m.solicitante  = document.getElementById('status-modal-solicitante').value.trim();
  m.patrocinador = document.getElementById('status-modal-patrocinador').value.trim();
  m.equipe       = document.getElementById('status-modal-equipe').value.trim();
  m.atores       = (document.getElementById('status-modal-atores')?.value || '').split(',').map(s=>s.trim()).filter(Boolean);
  // Processo
  m.desc         = document.getElementById('status-modal-desc').value.trim();
  m.input        = document.getElementById('status-modal-input').value.trim();
  m.output       = document.getElementById('status-modal-output').value.trim();
  m.resultados   = document.getElementById('status-modal-resultados').value.trim();
  m.fornecedores = document.getElementById('status-modal-fornecedores').value.trim();
  m.clientes     = document.getElementById('status-modal-clientes').value.trim();
  m.sistemas     = document.getElementById('status-modal-sistemas').value.trim();
  // Atualizar SIPOC
  if(!DATA[p].sipoc) DATA[p].sipoc = {};
  DATA[p].sipoc.fornecedores = _splitLines(m.fornecedores);
  DATA[p].sipoc.entradas     = _splitLines(m.input);
  DATA[p].sipoc.processo     = m.sub || m.processo || m.name || '';
  DATA[p].sipoc.saidas       = _splitLines(m.output);
  DATA[p].sipoc.clientes     = _splitLines(m.clientes);
  // PAT link
  const newPatVinc = document.getElementById('status-modal-pat-vinc')?.value || '';
  const oldPatVinc = m.patVinc || '';
  m.patVinc = newPatVinc;
  // Update popVinc on PAT items
  if(!DATA.pat) DATA.pat = [];
  if(oldPatVinc && oldPatVinc !== newPatVinc) {
    const old = DATA.pat.find(i => i.id === oldPatVinc);
    if(old && old.popVinc === p) old.popVinc = '';
  }
  if(newPatVinc) {
    const nw = DATA.pat.find(i => i.id === newPatVinc);
    if(nw) nw.popVinc = p;
  }
  // Sync capa (banner) visível no DOM
  const _popEl = document.getElementById('pop-' + p);
  if(_popEl) {
    const bannerTitle = _popEl.querySelector('.pop-banner-title');
    const bannerSub   = _popEl.querySelector('.pop-banner-sub');
    const bannerIcon  = _popEl.querySelector('.pop-banner-icon');
    if(bannerTitle && newName) bannerTitle.textContent = newName;
    if(bannerSub) {
      bannerSub.textContent = newSub || [m.macro, m.processo, newName].filter(Boolean).join(' · ');
    }
    if(bannerIcon && newIcon) bannerIcon.textContent = newIcon;
  }
  closeModal('status-map-modal');
  renderFicha(p);
  renderSipoc(p);
  // Sincronizar com Arquitetura: concluido → mapeado=true
  if(DATA[p]?.meta?.statusMap === 'concluido') {
    if(typeof arqSyncFromPops === 'function') arqSyncFromPops();
  }
  markChanged(true, true);
  showToast('✅ Status atualizado!', 'success');
}

function statusModalUpdateProcessoList() {
  const data  = arqGetData ? arqGetData() : [];
  const macro = document.getElementById('status-modal-macro')?.value || '';
  const procList = document.getElementById('status-modal-processo-list');
  if(!procList) return;
  const procs = [...new Set(
    data.filter(r => !macro || r.macroprocesso === macro).map(r => r.processo).filter(Boolean)
  )].sort();
  procList.innerHTML = procs.map(p2 => `<option value="${escapeHtml(p2)}">`).join('');
  // Reset subprocesso list too
  statusModalUpdateSubList();
}

function statusModalUpdateSubList() {
  const data  = arqGetData ? arqGetData() : [];
  const macro = document.getElementById('status-modal-macro')?.value || '';
  const proc  = document.getElementById('status-modal-processo')?.value || '';
  const subList = document.getElementById('status-modal-sub-list');
  if(!subList) return;
  const subs = [...new Set(
    data.filter(r =>
      (!macro || r.macroprocesso === macro) &&
      (!proc  || r.processo === proc)
    ).map(r => r.subprocesso).filter(Boolean)
  )].sort();
  subList.innerHTML = subs.map(s => `<option value="${escapeHtml(s)}">`).join('');
  statusModalAutoFill();
}

// Auto-fill do modal de edição ao mudar processo/subprocesso
function statusModalAutoFill() {
  const data  = arqGetData ? arqGetData() : CAGE_PROCESSOS;
  const macro = document.getElementById('status-modal-macro')?.value  || '';
  const proc  = document.getElementById('status-modal-processo')?.value || '';
  const sub   = document.getElementById('status-modal-sub')?.value    || '';

  let match = sub
    ? data.find(r => r.subprocesso===sub && (!proc||r.processo===proc) && (!macro||r.macroprocesso===macro))
    : null;
  if(!match && proc) {
    match = data.find(r => r.processo===proc && (!macro||r.macroprocesso===macro) && !r.subprocesso)
         || data.find(r => r.processo===proc && (!macro||r.macroprocesso===macro));
  }
  if(!match) { npopUpdateEquipeSelect('', 'status-modal-equipe-resp'); return; }

  // Unidade (somente leitura)
  const unEl = document.getElementById('status-modal-unidade'); if(unEl) unEl.value = match.area || '';
  // Gerente (editável)
  const geEl = document.getElementById('status-modal-gerente'); if(geEl) geEl.value = match.gerente || '';
  // Objetivo Estratégico tags
  const objs = match.objEstrategicos || [];
  const objHEl = document.getElementById('status-modal-obj-estrategico'); if(objHEl) objHEl.value = JSON.stringify(objs);
  const tagsEl = document.getElementById('status-modal-obj-tags');
  if(tagsEl) tagsEl.innerHTML = objs.length
    ? objs.map(o=>`<span style="display:inline-block;background:#e8f0fe;color:#1a56db;font-size:11px;padding:2px 9px;border-radius:10px;border:1px solid #c5d8f5;">${o}</span>`).join('')
    : '<span style="color:#94a3b8;font-size:12px;">Nenhum objetivo estratégico associado</span>';
  // Equipe filtrada
  npopUpdateEquipeSelect(match.area || '', 'status-modal-equipe-resp');
}

// ═══════════════════════════════════════════════════════════════════
// COCKPIT DE GESTÃO
// ═══════════════════════════════════════════════════════════════════
(function() {

  let _donutChart = null;

  window.showCockpitModule = function() {
    hideAllModules(); // já oculta nav-tabs e pop-switcher-bar
    // Ocultar home-page diretamente — NÃO chamar hideHome() porque ela
    // re-exibe nav-tabs e pop-switcher-bar (a barra "PROCESSO: Tratar Denúncias")
    const home = document.getElementById('home-page');
    if (home) home.style.display = 'none';
    document.body.classList.add('cockpit-active'); // CSS !important esconde nav-tabs e pop-switcher-bar permanentemente
    document.getElementById('cockpit-module').style.display = 'block';
    _renderCockpit();
  };

  function _allPops() {
    // Apenas mapeamentos criados pelo usuário (chave pop_*). As chaves 'd' e 'r'
    // são estruturas legadas fixas no código e não representam mapeamentos reais.
    return Object.keys(DATA).filter(k => k.startsWith('pop_') && typeof DATA[k] === 'object' && DATA[k]?.meta);
  }

  function _statusColor(st) {
    const map = { planejado:'#3b82f6', em_andamento:'#00a86b', atrasado:'#ef4444', concluido:'#8b5cf6', suspenso:'#94a3b8' };
    return map[st] || '#94a3b8';
  }

  function _statusLabel(st) {
    const map = { planejado:'Planejado', em_andamento:'Em Andamento', atrasado:'Atrasado', concluido:'Concluído', suspenso:'Suspenso' };
    return map[st] || st || '—';
  }

  function _calcStatus(meta) {
    if (meta.dataEfetiva) return 'concluido';
    if (!meta.dataInicio) return meta.statusMap || 'planejado';
    const today = new Date(); today.setHours(0,0,0,0);
    const di = new Date(meta.dataInicio);
    if (today < di) return 'planejado';
    if (meta.dataPrevista) { const dp = new Date(meta.dataPrevista); if (today > dp) return 'atrasado'; }
    return 'em_andamento';
  }

  function _renderCockpit() {
    const pops = _allPops();
    _renderStats(pops);
    _renderKpis(pops);
    _renderDonut(pops);
    _renderRankings(pops);
    _renderHoras(pops);
    _renderCoverage();
    _renderDistChart(pops, 'macro');
    _renderPopSelector(pops);
  }

  function _renderCoverage() {
    const el = document.getElementById('cockpit-coverage-list');
    if (!el) return;
    const arqData = (typeof arqGetData === 'function') ? arqGetData() : [];
    if (!arqData.length) { el.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:16px;">Sem dados de arquitetura de processos.</div>'; return; }

    // Group by macroprocesso
    const macroMap = {};
    arqData.forEach(r => {
      const m = r.macroprocesso || '(sem macroprocesso)';
      if (!macroMap[m]) macroMap[m] = { total: 0, mapeados: 0 };
      macroMap[m].total++;
      if (r.mapeado) macroMap[m].mapeados++;
    });

    const totalGeral = arqData.length;
    const mapeadosGeral = arqData.filter(r => r.mapeado).length;
    const pctGeral = totalGeral ? Math.round(mapeadosGeral / totalGeral * 100) : 0;

    const entries = Object.entries(macroMap).sort((a, b) => {
      const pa = a[1].total ? a[1].mapeados / a[1].total : 0;
      const pb = b[1].total ? b[1].mapeados / b[1].total : 0;
      return pb - pa;
    });

    const col = pct => pct === 100 ? '#15803d' : pct >= 60 ? '#f59e0b' : '#ef4444';

    el.innerHTML =
      // Resumo geral
      `<div style="display:flex;align-items:center;gap:14px;padding:10px 14px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;margin-bottom:4px;">
        <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.05em;">Total geral</div>
        <div style="flex:1;background:#e2e8f0;border-radius:4px;height:8px;overflow:hidden;">
          <div style="height:100%;background:#15803d;border-radius:4px;width:${pctGeral}%;transition:width .4s;"></div>
        </div>
        <div style="font-size:12px;font-weight:700;color:#15803d;min-width:36px;text-align:right;">${pctGeral}%</div>
        <div style="font-size:11px;color:#64748b;min-width:60px;text-align:right;">${mapeadosGeral}/${totalGeral}</div>
      </div>` +
      entries.map(([macro, d]) => {
        const pct = d.total ? Math.round(d.mapeados / d.total * 100) : 0;
        const c = col(pct);
        return `<div style="display:flex;align-items:center;gap:14px;padding:7px 14px;border-radius:8px;background:#f8fafc;border:1px solid #f1f5f9;">
          <div style="flex:0 0 220px;font-size:12px;font-weight:600;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${macro}">${macro}</div>
          <div style="flex:1;background:#e2e8f0;border-radius:4px;height:7px;overflow:hidden;">
            <div style="height:100%;background:${c};border-radius:4px;width:${pct}%;transition:width .4s;"></div>
          </div>
          <div style="font-size:12px;font-weight:700;color:${c};min-width:36px;text-align:right;">${pct}%</div>
          <div style="font-size:11px;color:#94a3b8;min-width:52px;text-align:right;">${d.mapeados}/${d.total}</div>
        </div>`;
      }).join('');
  }

  function _renderStats(pops) {
    const el = document.getElementById('cockpit-stats-row');
    if (!el) return;
    const data = (typeof arqGetData === 'function') ? arqGetData() : [];
    const macros = new Set(data.map(r => r.macroprocesso)).size;
    const procs  = new Set(data.map(r => r.macroprocesso + '|' + r.processo)).size;
    const subprocN = data.filter(r => r.subprocesso && r.subprocesso.trim()).length;
    const procsMapeados = data.filter(r => r.mapeado === true).length;
    const allPopKeys = ['d', 'r', ...pops];
    const faqN = allPopKeys.reduce((s, k) => s + (DATA[k]?.faqs?.length || 0), 0);
    const riscosN = allPopKeys.reduce((s, k) => s + (DATA[k]?.risks?.length || 0), 0);
    const indicadoresN = DATA.indicadoresCage?.indicadores?.length || 0;
    const auditConcluidasN = (DATA.audits?.plans || []).filter(p => p.status === 'concluida').length;
    const stats = [
      { label:'Macroprocessos',      val: macros,           color:'#1B3022' },
      { label:'Processos',           val: procs,            color:'#8b5cf6' },
      { label:'Subprocessos',        val: subprocN,         color:'#0369a1' },
      { label:'Proc. mapeados',      val: procsMapeados,    color:'#00a86b' },
      { label:'FAQs cadastradas',    val: faqN,             color:'#d97706' },
      { label:'Riscos mapeados',     val: riscosN,          color:'#dc2626' },
      { label:'Indicadores',         val: indicadoresN,     color:'#7c3aed' },
      { label:'Auditorias concluídas', val: auditConcluidasN, color:'#15803d' },
    ];
    el.innerHTML = stats.map(s => `
      <div style="background:#fff;border-radius:12px;border:1px solid #e2e8f0;padding:12px 14px;box-shadow:0 2px 6px rgba(0,0,0,.04);">
        <div style="font-size:22px;font-weight:800;color:${s.color};font-family:'JetBrains Mono',monospace;line-height:1.1;">${s.val}</div>
        <div style="font-size:10px;color:#64748b;font-weight:600;margin-top:3px;">${s.label}</div>
      </div>`).join('');
  }

  function _renderHoras(_pops) {
    const el = document.getElementById('cockpit-horas-row');
    if (!el) return;
    // Usar mesmo padrão do EPP dashboard: lê DATA diretamente
    const allPopKeys = ['d', 'r', ...Object.keys(DATA).filter(k => k.startsWith('pop_'))];
    const horasList = allPopKeys.map(k => {
      const meta = DATA[k]?.meta || {};
      const vPre = parseFloat(meta.volPre)   || 0;
      const vPos = parseFloat(meta.volPos)   || 0;
      const cPre = parseFloat(meta.cicloPre) || 0;
      const cPos = parseFloat(meta.cicloPos) || 0;
      const mensal = (vPre * cPre) - (vPos * cPos);
      return { key: k, nome: meta.name || k, mensal, anual: mensal * 12 };
    }).filter(h => h.mensal > 0);
    const totalAnual  = horasList.reduce((s, h) => s + h.anual, 0);
    const totalMensal = horasList.reduce((s, h) => s + h.mensal, 0);
    // Últimos 12 meses = totalAnual (já é base anual)
    const cards = [
      { label:'Horas economizadas / ano', value: totalAnual > 0 ? Math.round(totalAnual).toLocaleString('pt-BR') + ' h' : '—', sub:'Base anualizada de todos os processos redesenhados', color:'#00a86b', icon:'⏱' },
      { label:'Horas economizadas / mês', value: totalMensal > 0 ? Math.round(totalMensal).toLocaleString('pt-BR') + ' h' : '—', sub:'Soma mensal da diferença Vol × Ciclo (antes − depois)', color:'#0ea5e9', icon:'📅' },
      { label:'Processos com ganho',      value: horasList.length,  sub:'Com métricas de volume e ciclo preenchidas', color:'#8b5cf6', icon:'✅' },
    ];
    el.innerHTML = cards.map(c => `
      <div style="background:#f8fafc;border-radius:12px;border:1px solid #e2e8f0;border-left:4px solid ${c.color};padding:16px 18px;">
        <div style="font-size:20px;margin-bottom:4px;">${c.icon}</div>
        <div style="font-size:24px;font-weight:900;color:${c.color};font-family:'JetBrains Mono',monospace;">${c.value}</div>
        <div style="font-size:11px;font-weight:700;color:#334155;margin-top:2px;">${c.label}</div>
        <div style="font-size:10px;color:#94a3b8;margin-top:3px;">${c.sub}</div>
      </div>`).join('');
  }

  let _distChart = null;
  window.cockpitDistBy = function(dim) {
    const pops = _allPops();
    // update button styles
    document.querySelectorAll('#cockpit-dist-filters button').forEach(b => {
      const active = b.dataset.dist === dim;
      b.style.background = active ? '#0ea5e9' : '#f8fafc';
      b.style.color       = active ? '#fff'    : '#334155';
      b.style.borderColor = active ? '#0ea5e9' : '#e2e8f0';
    });
    _renderDistChart(pops, dim);
  };

  function _renderDistChart(pops, dim) {
    const canvas = document.getElementById('cockpit-dist-chart');
    if (!canvas || !window.Chart) return;

    // Sem POPs: mostrar estado vazio, preservando o canvas para reuso posterior
    let _distNoData = document.getElementById('cockpit-dist-nodata');
    if (!pops.length) {
      if (_distChart) { _distChart.destroy(); _distChart = null; }
      canvas.style.display = 'none';
      if (!_distNoData) {
        _distNoData = document.createElement('div');
        _distNoData.id = 'cockpit-dist-nodata';
        _distNoData.style.cssText = 'height:260px;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px;text-align:center;';
        _distNoData.textContent = 'Nenhum mapeamento cadastrado para exibir distribuição.';
        canvas.parentElement.appendChild(_distNoData);
      }
      _distNoData.style.display = 'flex';
      return;
    }
    // Restaurar canvas e ocultar mensagem de sem dados
    canvas.style.display = '';
    if (_distNoData) _distNoData.style.display = 'none';

    // Group pops by dimension
    const counts = {};
    pops.forEach(k => {
      const meta = DATA[k]?.meta || {};
      let keys = [];
      if (dim === 'macro')        keys = [meta.macro || '(sem macroprocesso)'];
      else if (dim === 'patrocinador') keys = [meta.patrocinador || '(sem patrocinador)'];
      else if (dim === 'area')    keys = [meta.unidade || meta.area || '(sem área)'];
      else if (dim === 'obj')     keys = (meta.objEstrategicos?.length) ? meta.objEstrategicos : ['(sem objetivo)'];
      keys.forEach(key => { counts[key] = (counts[key] || 0) + 1; });
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const fullLabels = sorted.map(e => e[0]);
    const values = sorted.map(e => e[1]);
    const trunc = s => s.length > 24 ? s.slice(0, 22) + '…' : s;
    const axisLabels = fullLabels.map(trunc);
    const horiz = fullLabels.length > 5;
    const palette = ['#0ea5e9','#8b5cf6','#00a86b','#f59e0b','#ef4444','#0369a1','#7c3aed','#15803d','#d97706','#dc2626','#94a3b8','#334155'];
    const colors  = fullLabels.map((_, i) => palette[i % palette.length]);
    if (_distChart) { _distChart.destroy(); _distChart = null; }
    _distChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: axisLabels,
        datasets: [{ data: values, backgroundColor: colors, borderRadius: 6, borderSkipped: false }]
      },
      options: {
        indexAxis: horiz ? 'y' : 'x',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: ctx => fullLabels[ctx[0].dataIndex],
              label: ctx => ` ${ctx.parsed[horiz ? 'x' : 'y']} POP(s)`
            }
          }
        },
        scales: {
          x: { grid: { display: !horiz }, ticks: { font: { size: 11 } } },
          y: { grid: { display: horiz  }, ticks: { font: { size: 11 } }, beginAtZero: !horiz }
        }
      }
    });
  }

  function _renderRankings(pops) {
    const el = document.getElementById('cockpit-ranking-list');
    if (!el) return;
    const ranked = pops
      .map(k => {
        const res = (typeof matComputeFinal === 'function') ? matComputeFinal(k) : null;
        return { k, name: DATA[k].meta?.name || k, score: res?.final ?? null, level: res?.level, color: res?.levelColor, icon: res?.levelIcon };
      })
      .filter(x => x.score != null)
      .sort((a,b) => b.score - a.score)
      .slice(0, 6);
    if (!ranked.length) {
      el.innerHTML = '<div style="color:#94a3b8;font-size:13px;padding:12px 0;">Nenhum processo com maturidade avaliada ainda.</div>';
      return;
    }
    const medals = ['🥇','🥈','🥉'];
    el.innerHTML = ranked.map((x,i) => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;background:#f8fafc;border:1px solid #f1f5f9;">
        <span style="font-size:16px;width:24px;text-align:center;flex-shrink:0;">${medals[i] || `<span style="font-size:12px;color:#94a3b8;font-weight:700;">${i+1}</span>`}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:700;color:#1B3022;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${x.name}</div>
          <div style="font-size:10px;color:${x.color || '#94a3b8'};">${x.icon || ''} ${x.level || ''}</div>
        </div>
        <span style="font-size:13px;font-weight:800;color:${x.color || '#8b5cf6'};min-width:42px;text-align:right;flex-shrink:0;">${x.score}/100</span>
      </div>`).join('');
  }

  function _renderKpis(pops) {
    const total     = pops.length;
    const concluido = pops.filter(k => _calcStatus(DATA[k].meta) === 'concluido').length;
    const emAnd     = pops.filter(k => _calcStatus(DATA[k].meta) === 'em_andamento').length;
    const atrasado  = pops.filter(k => _calcStatus(DATA[k].meta) === 'atrasado').length;
    const totalSteps = pops.reduce((s,k) => s + (DATA[k].steps?.length || 0), 0);

    const kpis = [
      { label:'Total de POPs',       value: total,        color:'#0ea5e9', icon:'📋' },
      { label:'Em Andamento',       value: emAnd,        color:'#00a86b', icon:'🔄' },
      { label:'Concluídos',         value: concluido,    color:'#8b5cf6', icon:'✅' },
      { label:'Atrasados',          value: atrasado,     color:'#ef4444', icon:'⚠️' },
      { label:'Total de Etapas',    value: totalSteps,   color:'#f59e0b', icon:'⚙️' },
    ];
    const el = document.getElementById('cockpit-kpi-row');
    if (!el) return;
    el.innerHTML = kpis.map(k => `
      <div style="background:#fff;border-radius:14px;border:1px solid #e2e8f0;padding:18px 20px;box-shadow:0 2px 8px rgba(0,0,0,.04);border-left:4px solid ${k.color};">
        <div style="font-size:22px;margin-bottom:4px;">${k.icon}</div>
        <div style="font-size:28px;font-weight:900;color:${k.color};font-family:'JetBrains Mono',monospace;">${k.value}</div>
        <div style="font-size:11px;color:#64748b;font-weight:600;margin-top:2px;">${k.label}</div>
      </div>`).join('');
  }

  function _renderDonut(pops) {
    const counts = { planejado:0, em_andamento:0, atrasado:0, concluido:0, suspenso:0 };
    pops.forEach(k => { const st = _calcStatus(DATA[k].meta); if (counts[st] !== undefined) counts[st]++; });
    const labels = ['Planejado','Em Andamento','Atrasado','Concluído','Suspenso'];
    const values = [counts.planejado, counts.em_andamento, counts.atrasado, counts.concluido, counts.suspenso];
    const colors = ['#3b82f6','#00a86b','#ef4444','#8b5cf6','#94a3b8'];
    const total  = pops.length;

    const totalEl = document.getElementById('cockpit-donut-total');
    if (totalEl) totalEl.textContent = total;

    const canvas = document.getElementById('cockpit-donut-chart');
    if (!canvas || !window.Chart) return;

    // Limpar gráfico anterior
    if (_donutChart) { _donutChart.destroy(); _donutChart = null; }

    // Sem mapeamentos: mostrar estado vazio em vez de gráfico em branco
    if (total === 0) {
      const legend = document.getElementById('cockpit-donut-legend');
      if (legend) legend.innerHTML = '<div style="color:#94a3b8;font-size:12px;line-height:1.6;">Nenhum mapeamento cadastrado.<br>Crie POPs para visualizar o painel.</div>';
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 16;
        ctx.beginPath();
        ctx.arc(70, 70, 54, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }

    _donutChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverBorderColor: '#fff' }]
      },
      options: {
        cutout: '72%',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}` } } },
        animation: { duration: 500 }
      }
    });

    const legend = document.getElementById('cockpit-donut-legend');
    if (legend) {
      legend.innerHTML = labels.map((l,i) => values[i] > 0 ? `
        <div style="display:flex;align-items:center;gap:8px;">
          <div style="width:10px;height:10px;border-radius:3px;background:${colors[i]};flex-shrink:0;"></div>
          <span style="font-size:12px;color:#374151;">${l}</span>
          <span style="font-size:12px;font-weight:700;color:#1B3022;margin-left:auto;">${values[i]}</span>
        </div>` : '').join('');
    }
  }

  function _renderTimeline(pops) {
    const label = document.getElementById('cockpit-timeline-label');
    const grid  = document.getElementById('cockpit-timeline-grid');
    const legEl = document.getElementById('cockpit-timeline-legend');
    if (!grid) return;

    const now = new Date();
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1);
    const qEnd   = new Date(qStart.getFullYear(), qStart.getMonth()+3, 0);
    const qNum   = Math.floor(now.getMonth()/3)+1;
    if (label) label.textContent = `${qNum}º Trimestre ${now.getFullYear()}`;

    // Filter pops active in this quarter
    const activePops = pops.filter(k => {
      const m = DATA[k].meta;
      if (!m.dataInicio) return false;
      const di = new Date(m.dataInicio);
      const dp = m.dataPrevista ? new Date(m.dataPrevista) : new Date(di.getTime() + 90*86400000);
      return di <= qEnd && dp >= qStart;
    });

    if (!activePops.length) {
      grid.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:20px;">Nenhum mapeamento ativo neste trimestre.</div>';
      return;
    }

    const qTotalDays = Math.round((qEnd - qStart) / 86400000) + 1;
    const todayPct = Math.min(100, Math.max(0, Math.round((now - qStart) / (qEnd - qStart) * 100)));

    let html = `<div style="position:relative;">`;
    // Today marker
    html += `<div style="position:absolute;top:0;bottom:0;left:${todayPct}%;width:2px;background:#ef4444;opacity:.6;z-index:1;"></div>`;

    activePops.slice(0,12).forEach(k => {
      const m   = DATA[k].meta;
      const st  = _calcStatus(m);
      const col = _statusColor(st);
      const di  = new Date(m.dataInicio);
      const dp  = m.dataPrevista ? new Date(m.dataPrevista) : new Date(di.getTime() + 90*86400000);
      const startPct = Math.min(100, Math.max(0, Math.round((di - qStart) / (qEnd - qStart) * 100)));
      const endPct   = Math.min(100, Math.max(startPct+2, Math.round((dp - qStart) / (qEnd - qStart) * 100)));
      const widthPct = endPct - startPct;
      const name = (m.name || k).length > 28 ? (m.name || k).slice(0,28)+'…' : (m.name || k);
      html += `<div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;">
        <div style="width:160px;font-size:11px;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0;">${name}</div>
        <div style="flex:1;position:relative;height:22px;background:#f1f5f9;border-radius:4px;overflow:hidden;">
          <div style="position:absolute;left:${startPct}%;width:${widthPct}%;height:100%;background:${col};border-radius:4px;opacity:.85;" title="${_statusLabel(st)}"></div>
        </div>
      </div>`;
    });
    html += '</div>';
    grid.innerHTML = html;

    if (legEl) {
      legEl.innerHTML = [['planejado','#3b82f6'],['em_andamento','#00a86b'],['atrasado','#ef4444'],['concluido','#8b5cf6']].map(([st,c]) =>
        `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:#374151;">
          <span style="width:10px;height:10px;border-radius:2px;background:${c};display:inline-block;"></span>${_statusLabel(st)}</span>`
      ).join('');
    }
  }

  function _renderPopSelector(pops) {
    const sel = document.getElementById('cockpit-pop-selector');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Selecione um processo —</option>' +
      pops.sort((a,b) => (DATA[a].meta?.name||a).localeCompare(DATA[b].meta?.name||b))
          .map(k => `<option value="${k}">${DATA[k].meta?.name || k}</option>`).join('');
  }

  window.cockpitLoadPop = function() {
    const k      = document.getElementById('cockpit-pop-selector')?.value;
    const detail = document.getElementById('cockpit-pop-detail');
    const empty  = document.getElementById('cockpit-pop-empty');
    if (!k || !DATA[k]) {
      if (detail) detail.style.display = 'none';
      if (empty)  empty.style.display  = '';
      return;
    }
    if (detail) detail.style.display = '';
    if (empty)  empty.style.display  = 'none';

    const m     = DATA[k].meta || {};
    const st    = _calcStatus(m);
    const stCol = _statusColor(st);
    const steps = DATA[k].steps || [];
    const inds  = DATA[k].indicators || [];
    const risks = DATA[k].risks || [];
    const mat   = DATA[k].maturity || {};

    // ── Header row ──
    const hdrEl = document.getElementById('cockpit-pop-header');
    if (hdrEl) {
      const fmt = d => new Date(d+'T12:00:00Z').toLocaleDateString('pt-BR');
      hdrEl.innerHTML = `
        <div style="flex:1;min-width:200px;">
          <div style="font-size:19px;font-weight:800;color:#1B3022;line-height:1.2;">${m.name || k}</div>
          <div style="font-size:12px;color:#64748b;margin-top:4px;">${[m.macro, m.processo, m.unidade].filter(Boolean).join(' · ')}</div>
          ${m.gerente ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">👤 ${m.gerente}</div>` : ''}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <span style="background:${stCol}18;color:${stCol};border:1.5px solid ${stCol}40;border-radius:20px;padding:5px 16px;font-size:12px;font-weight:700;">${_statusLabel(st)}</span>
          ${m.dataInicio ? `<span style="font-size:12px;color:#64748b;background:#f1f5f9;padding:4px 10px;border-radius:8px;">📅 ${fmt(m.dataInicio)}</span>` : ''}
          ${m.dataPrevista ? `<span style="font-size:12px;color:#64748b;background:#f1f5f9;padding:4px 10px;border-radius:8px;">🏁 ${fmt(m.dataPrevista)}</span>` : ''}
        </div>`;
    }

    // ── Mini KPIs ──
    const kpisEl = document.getElementById('cockpit-pop-kpis');
    if (kpisEl) {
      const stars = n => n != null ? [1,2,3,4,5].map(i=>`<span style="font-size:11px;color:${i<=n?'#8b5cf6':'#e2e8f0'};">★</span>`).join('') : '—';
      kpisEl.innerHTML = [
        { label:'Etapas',       value: steps.length,  color:'#f59e0b', icon:'⚙️' },
        { label:'Indicadores',  value: inds.length,   color:'#0ea5e9', icon:'📊' },
        { label:'Riscos',       value: risks.length,  color:'#ef4444', icon:'⚠️' },
        { label:'Maturidade',   value: mat.score != null ? `${mat.score}/5` : '—', color:'#8b5cf6', icon:'📈',
          extra: mat.score != null ? `<div style="margin-top:4px;">${stars(mat.score)}</div>` : '' },
      ].map(d => `
        <div style="background:#f8fafc;border-radius:12px;padding:14px;border-left:3px solid ${d.color};text-align:center;">
          <div style="font-size:18px;margin-bottom:4px;">${d.icon}</div>
          <div style="font-size:22px;font-weight:800;color:${d.color};font-family:'JetBrains Mono',monospace;">${d.value}</div>
          ${d.extra || ''}
          <div style="font-size:10px;color:#64748b;font-weight:600;margin-top:4px;">${d.label}</div>
        </div>`).join('');
    }

    // ── Visual flow map ──
    const flowEl = document.getElementById('cockpit-pop-flow');
    if (flowEl) {
      if (!steps.length) {
        flowEl.innerHTML = '<div style="color:#94a3b8;font-size:13px;text-align:center;padding:20px;background:#f8fafc;border-radius:10px;">Nenhuma etapa mapeada ainda para este processo.</div>';
      } else {
        const palette = ['#0ea5e9','#00a86b','#8b5cf6','#f59e0b','#ef4444','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];
        const cards = steps.map((s, i) => {
          const col  = palette[i % palette.length];
          const acts = s.actions || [];
          const actsHtml = acts.slice(0,3).map(a => {
            const txt = (a.text || '').slice(0,50);
            const icon = a.type === 'decisao' ? '◆' : '•';
            return `<div style="font-size:10px;color:#475569;margin-top:3px;padding-left:6px;border-left:2px solid ${col}50;line-height:1.3;">${icon} ${txt}${(a.text||'').length>50?'…':''}</div>`;
          }).join('');
          const more = acts.length > 3 ? `<div style="font-size:10px;color:#94a3b8;margin-top:3px;">+${acts.length-3} atividades</div>` : '';
          const arrow = i < steps.length-1
            ? `<div style="display:flex;align-items:center;padding:0 6px;flex-shrink:0;"><svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 9h10M10 5l4 4-4 4" stroke="#94a3b8" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`
            : '';
          return `
            <div style="display:flex;align-items:stretch;gap:0;flex-shrink:0;">
              <div style="width:180px;background:#fff;border:1.5px solid ${col}55;border-top:3px solid ${col};border-radius:10px;padding:12px;box-shadow:0 2px 8px rgba(0,0,0,.05);">
                <div style="font-size:9px;font-weight:800;color:${col};letter-spacing:.07em;text-transform:uppercase;margin-bottom:5px;">Etapa ${i+1}</div>
                <div style="font-size:12px;font-weight:700;color:#1B3022;line-height:1.3;margin-bottom:4px;">${s.title || '—'}</div>
                ${s.responsible ? `<div style="font-size:10px;color:#64748b;margin-bottom:4px;">👤 ${s.responsible}</div>` : ''}
                ${actsHtml}${more}
              </div>
              ${arrow}
            </div>`;
        }).join('');

        flowEl.innerHTML = `<div style="display:flex;align-items:flex-start;gap:0;min-width:max-content;padding:4px 2px;">${cards}</div>`; // NOSONAR — cards é HTML interno, não dados do usuário
      }
    }

    // ── Indicators ──
    const indsEl = document.getElementById('cockpit-pop-inds');
    if (indsEl) {
      if (inds.length) {
        indsEl.innerHTML = `
          <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px;border-top:1px solid #f1f5f9;padding-top:16px;">📊 Indicadores</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;">
            ${inds.map(ind => `
              <div style="background:#f8fafc;border-radius:10px;padding:12px;border:1px solid #e2e8f0;">
                <div style="font-size:13px;font-weight:700;color:#1B3022;margin-bottom:4px;">${ind.icon||'📊'} ${ind.title||'—'}</div>
                ${ind.meta ? `<div style="font-size:11px;color:#0ea5e9;font-weight:600;">Meta: ${ind.meta}</div>` : ''}
                ${ind.periodicidade ? `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">${ind.periodicidade}</div>` : ''}
              </div>`).join('')}
          </div>`;
      } else {
        indsEl.innerHTML = '';
      }
    }
  };

})();


// ═══════════════════════════════════════════════════════════════════
// FLOW DESIGNER — Mermaid + Gemini AI + BPMN 2.0 (bpmn-js)
// ═══════════════════════════════════════════════════════════════════
(function() {
  let _direction   = 'LR';
  let _currentMode = 'mermaid'; // 'mermaid' | 'bpmn'
  let _renderedSvg = null; // cached SVG for export
  let _fdZoomLevel = 1.0;
  let _fdBaseW = 0, _fdBaseH = 0; // dimensões naturais do SVG após renderização

  window.fdApplyZoom = function() {
    const output = document.getElementById('fd-mermaid-output');
    const svgEl  = output?.querySelector('svg');
    if(!svgEl) return;

    // Capturar dimensões naturais uma única vez (antes de qualquer override)
    if(!_fdBaseW || !_fdBaseH) {
      const vb = svgEl.getAttribute('viewBox');
      if(vb) {
        const parts = vb.trim().split(/[\s,]+/).map(Number);
        _fdBaseW = parts[2] || 0;
        _fdBaseH = parts[3] || 0;
      }
      if(!_fdBaseW) {
        const r = svgEl.getBoundingClientRect();
        _fdBaseW = r.width  || 800;
        _fdBaseH = r.height || 600;
      }
    }

    if(_fdZoomLevel === 1) {
      svgEl.style.width    = '';
      svgEl.style.height   = '';
      svgEl.style.maxWidth = '100%';
    } else {
      svgEl.style.maxWidth = 'none';
      svgEl.style.width    = (_fdBaseW * _fdZoomLevel) + 'px';
      svgEl.style.height   = (_fdBaseH * _fdZoomLevel) + 'px';
    }

    const lbl = document.getElementById('fd-zoom-label');
    if(lbl) lbl.textContent = Math.round(_fdZoomLevel * 100) + '%';
  };

  // delta=0 resets to 100%
  window.fdZoom = function(delta) {
    if(delta === 0) _fdZoomLevel = 1.0;
    else _fdZoomLevel = Math.max(0.2, Math.min(3, _fdZoomLevel + delta));
    fdApplyZoom();
  };

  // ── Mode switching ────────────────────────────────────────────
  window.fdSetMode = function(mode) {
    _currentMode = mode;
    document.getElementById('fd-text-mode').style.display  = mode === 'mermaid' ? 'flex'  : 'none';
    document.getElementById('fd-bpmn-mode').style.display  = mode === 'bpmn'    ? 'block' : 'none';
    document.getElementById('fd-btn-mermaid').classList.toggle('active', mode === 'mermaid');
    document.getElementById('fd-btn-bpmn').classList.toggle('active', mode === 'bpmn');
    if (mode === 'bpmn') { _initModeler(); _loadDiagram(); }
  };

  // ── Show tab (entry point) ────────────────────────────────────
  window.showFlowDesigner = function(tab) {
    _navPush();
    hideHome();
    hideAllModules();
    const nav = document.querySelector('.nav-tabs');
    const sw  = document.getElementById('pop-switcher-bar');
    if(nav) nav.style.display = '';
    if(sw)  sw.style.display  = '';
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    if (tab) tab.classList.add('active');
    document.getElementById('fd-module').style.display = 'block';
    // Initialize mermaid once
    if (window.mermaid) {
      try { mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' }); } catch(e) { console.warn('[siga]', e); }
    }
    fdSetMode('mermaid');
    _fdLoad();
  };

  // ── Load saved diagram ────────────────────────────────────────
  function _fdLoad() {
    const p  = popPrefix(currentPop);
    const fd = DATA[p]?.flowDiagram;
    const code = fd?.mermaid || fd?.text || '';
    if (code) {
      document.getElementById('fd-text-input').value = code;
      fdRenderMermaid();
    }
  }

  // ── Render Mermaid code ───────────────────────────────────────
  window.fdRenderMermaid = async function() {
    const code = document.getElementById('fd-text-input').value.trim();
    if (!code) { showToast('Insira código Mermaid para renderizar.', 'warn'); return; }
    const output  = document.getElementById('fd-mermaid-output');
    const loading = document.getElementById('fd-mermaid-loading');
    if (!output) return;
    if (loading) loading.style.display = 'none';
    output.innerHTML = '<div style="color:#64748b;font-size:13px;padding:20px;">Renderizando…</div>';
    try {
      if (!window.mermaid) throw new Error('Mermaid não carregado');
      const id  = 'fdm-' + Date.now();
      const { svg } = await mermaid.render(id, code);
      _renderedSvg  = svg;
      _fdBaseW = 0; _fdBaseH = 0; // resetar cache para o novo SVG
      output.innerHTML = svg;
      const svgEl = output.querySelector('svg');
      if (svgEl) { svgEl.style.maxWidth = '100%'; svgEl.style.height = 'auto'; }
      fdApplyZoom();
    } catch(e) {
      /* exibe mensagem de erro na interface */
      output.innerHTML = `<div style="color:#ef4444;font-size:13px;padding:20px;font-family:'JetBrains Mono',monospace;">Erro no código Mermaid:<br><br>${escapeHtml(e.message)}</div>`;
    }
  };

  // ── Generate with Gemini AI ───────────────────────────────────
  window.fdGenerateWithAI = async function() {
    const p = popPrefix(currentPop);
    if (!p || !DATA[p]) { showToast('Nenhum processo selecionado.', 'warn'); return; }
    const steps = DATA[p].steps || [];
    const meta  = DATA[p].meta  || {};
    const dir   = _direction;

    const stepsText = steps.length
      ? steps.map((s, i) => {
          let line = `${i+1}. ${s.title || s.subtitle || 'Passo ' + (i+1)}`;
          if (s.responsible) line += ` [${s.responsible}]`;
          if (s.decision) line += ' (decisão/bifurcação)';
          if (s.actions?.length) line += ' → ' + s.actions.slice(0,3).join(', ');
          return line;
        }).join('\n')
      : 'Sem passos definidos. Crie um fluxo genérico de mapeamento de processos.';

    const prompt = `Você é um especialista em BPM. Gere um diagrama de fluxo em sintaxe Mermaid (flowchart ${dir}) para o processo abaixo.

Processo: "${meta.name || currentPop}"
Unidade: "${meta.unidade || meta.area || ''}"
Objetivo: "${meta.desc || ''}"

Passos:
${stepsText}

Regras obrigatórias:
- Use "flowchart ${dir}" na primeira linha
- Início: A([Início]) e Fim: Z([Fim]) com nós arredondados
- Decisões: use losangos C{Pergunta?}
- Atividades: retângulos B[Atividade]
- Indique responsável em cada nó quando disponível: B["Atividade\\n[Responsável]"]
- Crie conexões lógicas com labels Sim/Não nas bifurcações
- Mantenha o diagrama limpo e legível
- Retorne APENAS o código Mermaid puro, sem blocos markdown, sem explicações.`;

    const btn = document.querySelector('button[onclick="fdGenerateWithAI()"]');
    const origText = btn?.innerHTML;
    if (btn) { btn.innerHTML = '⏳ Gerando…'; btn.disabled = true; }

    try {
      const result = await callGemini(prompt);
      let code = (result || '').trim();
      code = code.replace(/^```(?:mermaid)?\s*/i, '').replace(/\s*```$/i, '').trim();
      if (code && code.startsWith('flowchart')) {
        document.getElementById('fd-text-input').value = code;
        await fdRenderMermaid();
        showToast('Diagrama gerado com IA!', 'success');
      } else {
        showToast('IA não retornou código válido. Tente novamente.', 'warn');
      }
    } catch(e) {
      /* notifica o usuario do erro */
      showToast('Erro ao chamar IA: ' + escapeHtml(e.message || String(e)), 'warn');
    } finally {
      if (btn) { btn.innerHTML = origText; btn.disabled = false; }
    }
  };

  // ── Direction toggle ──────────────────────────────────────────
  window.fdToggleDirection = function(isLR) {
    _direction = isLR ? 'LR' : 'TD';
    const textarea = document.getElementById('fd-text-input');
    if (!textarea) return;
    const newCode = textarea.value.replace(/^(flowchart\s+)(LR|TD|TB|RL)/m, `$1${_direction}`);
    if (newCode !== textarea.value) {
      textarea.value = newCode;
      fdRenderMermaid();
    }
  };

  // ── Left panel toggle ─────────────────────────────────────────
  window.fdToggleLeftPanel = function() {
    const panel  = document.getElementById('fd-left-panel');
    const colBtn = document.getElementById('fd-collapse-btn');
    const expBtn = document.getElementById('fd-expand-btn');
    const collapsed = panel.classList.toggle('collapsed');
    if (colBtn) colBtn.style.display = collapsed ? 'none' : '';
    if (expBtn) expBtn.style.display = collapsed ? '' : 'none';
  };

  // ── Save ──────────────────────────────────────────────────────
  window.fdSave = function() {
    const code = document.getElementById('fd-text-input').value.trim();
    const p    = popPrefix(currentPop);
    if (!p || !DATA[p]) return;
    if (!DATA[p].flowDiagram) DATA[p].flowDiagram = {};
    DATA[p].flowDiagram.mermaid = code;
    DATA[p].flowDiagram.text    = code;
    markChanged(true, true);
    saveToCloud();
    showToast('Fluxo salvo!', 'success');
    try { renderFlowPreview(p); } catch(e) { console.warn('[siga]', e); }
  };

  // ── Export SVG ────────────────────────────────────────────────
  window.fdExportSVG = function() {
    if (!_renderedSvg) { showToast('Renderize o diagrama primeiro.', 'warn'); return; }
    const blob = new Blob([_renderedSvg], { type: 'image/svg+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (DATA[popPrefix(currentPop)]?.meta?.name || 'fluxo') + '.svg';
    a.click();
  };

  // ── Export PNG ────────────────────────────────────────────────
  window.fdExportPNG = function() {
    const svgEl = document.querySelector('#fd-mermaid-output svg');
    if (!svgEl) { showToast('Renderize o diagrama primeiro.', 'warn'); return; }
    const svgData = new XMLSerializer().serializeToString(svgEl);
    const bb = svgEl.getBoundingClientRect();
    const vb = svgEl.viewBox?.baseVal;
    const w  = (vb?.width  || bb.width  || 1200);
    const h  = (vb?.height || bb.height || 800);
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width  = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const a = document.createElement('a');
      a.download = (DATA[popPrefix(currentPop)]?.meta?.name || 'fluxo') + '.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);
  };

  // ── Build from flow JSON (called after POP import) ────────────
  window.fdBuildFromFlowJSON = function(flowArr) {
    if (!Array.isArray(flowArr) || !flowArr.length) return;
    const p = popPrefix(currentPop);
    if (!DATA[p]) DATA[p] = {};
    if (!DATA[p].flowDiagram) DATA[p].flowDiagram = {};
    const code = _flowJsonToMermaid(flowArr);
    DATA[p].flowDiagram.mermaid = code;
    DATA[p].flowDiagram.flow    = flowArr;
    const ta = document.getElementById('fd-text-input');
    if (ta) ta.value = code;
    fdRenderMermaid();
  };

  function _flowJsonToMermaid(flowArr) {
    const dir = _direction || 'LR';
    const lines = [`flowchart ${dir}`];
    flowArr.forEach(n => {
      const lbl = (n.name || n.id).replace(/"/g, "'");
      if (n.type === 'start' || n.type === 'end') lines.push(`  ${n.id}(["${lbl}"])`);
      else if (n.type === 'decision') lines.push(`  ${n.id}{"${lbl}"}`);
      else lines.push(`  ${n.id}["${lbl}"]`);
    });
    flowArr.forEach(n => {
      (n.next || []).forEach(nx => {
        lines.push(nx.label ? `  ${n.id} -->|"${nx.label}"| ${nx.id}` : `  ${n.id} --> ${nx.id}`);
      });
    });
    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════════════════════
  // BPMN 2.0 (bpmn-js)
  // ═══════════════════════════════════════════════════════════════
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

  let _modeler    = null;
  let _currentPop = null;

  // ── Initialize bpmn-js modeler (lazy, once) ────────────────────
  function _initModeler() {
    if (_modeler) return;
    const container = document.getElementById('fd-bpmn-container');
    if (!container) { return; }
    _modeler = new BpmnJS({
      container,
      keyboard: { bindTo: window },
    });
  }

  // ── Load diagram for current POP ──────────────────────────────
  async function _loadDiagram() {
    if (!_modeler) return;
    const p  = popPrefix(currentPop);
    _currentPop = p;
    const fd = DATA[p]?.flowDiagram;
    const xml = fd?.bpmnXml || DEFAULT_BPMN;

    try {
      await _modeler.importXML(xml);
      _modeler.get('canvas').zoom('fit-viewport');
    } catch(e) {
      /* tenta fallback alternativo */
      try {
        await _modeler.importXML(DEFAULT_BPMN);
        _modeler.get('canvas').zoom('fit-viewport');
      } catch(e2) { console.warn('[siga]', e2); }
    }

    // Update title in toolbar
    const titleEl = document.getElementById('fd-bpmn-pop-name');
    if (titleEl) titleEl.textContent = DATA[p]?.meta?.name || p;
  }

  // ── Save BPMN to DATA + cloud ─────────────────────────────────
  window.fdSaveBpmn = async function() {
    if (!_modeler) { showToast('Editor não inicializado.', 'warn'); return; }
    try {
      const { xml } = await _modeler.saveXML({ format: true });
      const p = _currentPop || popPrefix(currentPop);
      if (!DATA[p]) return;
      if (!DATA[p].flowDiagram) DATA[p].flowDiagram = {};
      DATA[p].flowDiagram.bpmnXml = xml;
      markChanged(true, true);
      saveToCloud();
      showToast('✅ Diagrama BPMN salvo!', 'success');
    } catch(e) {
      /* notifica o usuario do erro */
      showToast('Erro ao salvar: ' + e.message, 'warn');
    }
  };

  // ── Fit viewport ───────────────────────────────────────────────
  window.fdFitView = function() {
    try { _modeler?.get('canvas').zoom('fit-viewport'); } catch(e) { console.warn('[siga]', e); }
  };

  // ── Undo / Redo ────────────────────────────────────────────────
  window.fdUndo = function() {
    try { _modeler?.get('commandStack').undo(); } catch(e) { console.warn('[siga]', e); }
  };
  window.fdRedo = function() {
    try { _modeler?.get('commandStack').redo(); } catch(e) { console.warn('[siga]', e); }
  };

  // ── Export BPMN SVG ───────────────────────────────────────────
  window.fdExportBpmnSVG = async function() {
    if (!_modeler) return;
    try {
      const { svg } = await _modeler.saveSVG();
      const blob = new Blob([svg], { type: 'image/svg+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (_currentPop ? (DATA[_currentPop]?.meta?.name || _currentPop) : 'fluxo') + '.svg';
      a.click();
    } catch(e) { showToast('Erro ao exportar SVG: ' + e.message, 'warn'); }
  };

  // ── Export BPMN PNG ────────────────────────────────────────────
  window.fdExportBpmnPNG = async function() {
    if (!_modeler) return;
    try {
      const { svg } = await _modeler.saveSVG();
      // Parse dimensions from SVG
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svg, 'image/svg+xml');
      const svgEl  = svgDoc.querySelector('svg');
      const vb = svgEl?.getAttribute('viewBox')?.split(' ').map(Number) || [0, 0, 800, 600];
      const w = vb[2] || 800, h = vb[3] || 600;
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width  = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const img = new Image();
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      img.onload = () => {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const a = document.createElement('a');
        a.download = (_currentPop ? (DATA[_currentPop]?.meta?.name || _currentPop) : 'fluxo') + '.png';
        a.href = canvas.toDataURL('image/png');
        a.click();
      };
      img.src = url;
    } catch(e) { showToast('Erro ao exportar PNG: ' + e.message, 'warn'); }
  };

  // ── Export BPMN XML file ───────────────────────────────────────
  window.fdExportBPMN = async function() {
    if (!_modeler) return;
    try {
      const { xml } = await _modeler.saveXML({ format: true });
      const blob = new Blob([xml], { type: 'application/xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (_currentPop ? (DATA[_currentPop]?.meta?.name || _currentPop) : 'fluxo') + '.bpmn';
      a.click();
    } catch(e) { showToast('Erro ao exportar BPMN: ' + e.message, 'warn'); }
  };

  // ── Keyboard shortcut Ctrl+S ──────────────────────────────────
  document.addEventListener('keydown', e => {
    const fd = document.getElementById('fd-module');
    if (!fd || fd.style.display === 'none') return;
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (_currentMode === 'bpmn') fdSaveBpmn(); else fdSave();
    }
  });

})(); // end Flow Designer IIFE


// ══════════════════════════════════════════════════════════════════
// MÓDULO: INDICADORES CAGE
// ══════════════════════════════════════════════════════════════════

(function() {
  // ─── State ───────────────────────────────────────────────────────
  let _tab = 'indicadores';
  let _editId = null;   // ID do indicador sendo editado (null = novo)
  let _chartEvo = null;  // Chart.js instance - evolução
  let _chartYoy = null;  // Chart.js instance - year-over-year
  let _chartAbs = null;  // Chart.js instance - número absoluto

  // ─── Data init ────────────────────────────────────────────────────
  function ensureData() {
    if(!DATA.indicadoresCage) DATA.indicadoresCage = { indicadores: [], resultados: [], overrides: {} };
    if(!Array.isArray(DATA.indicadoresCage.indicadores)) DATA.indicadoresCage.indicadores = [];
    if(!Array.isArray(DATA.indicadoresCage.resultados))  DATA.indicadoresCage.resultados  = [];
    if(!DATA.indicadoresCage.overrides || typeof DATA.indicadoresCage.overrides !== 'object') DATA.indicadoresCage.overrides = {};
    if(DATA.indicadoresCage.sisplanUrl      === undefined) DATA.indicadoresCage.sisplanUrl      = '';
    if(DATA.indicadoresCage.sisplanAutoSync === undefined) DATA.indicadoresCage.sisplanAutoSync = false;
  }

  // ─── Module show/hide ─────────────────────────────────────────────
  window.showIndCageModule = function(show=true) {
    hideAllModules();
    if(!show) return;
    if(typeof hideHome === 'function') hideHome();
    ensureData();
    document.getElementById('indicadores-cage-module').style.display = 'block';
    document.getElementById('indcage-panel').style.display = 'block';
    indcageTab(_tab, document.querySelector('[data-indcage-tab="'+_tab+'"]'));
  };

  // ─── Tab switching ────────────────────────────────────────────────
  window.indcageTab = function(tab, btn) {
    _tab = tab;
    document.querySelectorAll('.indcage-tab').forEach(b => b.classList.remove('active'));
    if(btn) btn.classList.add('active');
    document.querySelectorAll('.indcage-section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById('indcage-sec-' + tab);
    if(sec) sec.classList.add('active');
    if(tab === 'indicadores') indcageRenderIndicadores();
    if(tab === 'resultados')  { indcageRenderResultados(); indcageLoadUrlConfig(); }
    if(tab === 'relatorio')   indcageRenderRelatorioTab();
  };

  // ─── Helpers ──────────────────────────────────────────────────────
  function nivelLabel(v) {
    const map = { atividade:'Atividade', processo:'Processo/Projeto',
      macroprocesso:'Macroprocesso/Proj Estratégico', acao:'Ação', etapa:'Etapa' };
    return map[v] || v || '—';
  }
  function nivelClass(v) {
    return 'nivel-' + (v || 'processo');
  }

  // Coleta todos indicadores: autônomos + de POPs (vinculados)
  function getAllIndicators() {
    ensureData();
    const list = [];
    // Autônomos
    DATA.indicadoresCage.indicadores.forEach(ind => {
      list.push({ ...ind, _source: 'cage' });
    });
    // De POPs — pegar de DATA.d, DATA.r e pop_*
    const popKeys = Object.keys(DATA).filter(k => k === 'd' || k === 'r' || k.startsWith('pop_'));
    popKeys.forEach(pk => {
      const pop = DATA[pk];
      if(!pop || !Array.isArray(pop.indicators)) return;
      const popName = pop.meta?.name || pk;
      pop.indicators.forEach((ind, idx) => {
        // só incluir se ainda não foi "absorvido" como indicador autônomo por codigo
        list.push({
          id: 'pop_' + pk + '_' + idx,
          codigo: ind.codigo || '',
          enunciado: ind.title || '',
          sisplan: ind.sisplan || '',
          nivel: ind.nivel || 'processo',
          divisao: ind.divisao || pop.meta?.divisao || '',
          pop: pk,
          meta: ind.meta || '',
          periodicidade: ind.periodicidade || '',
          responsavel: ind.responsavel || '',
          formula: ind.formula || '',
          fonte: ind.fonte || '',
          _source: 'pop',
          _popName: popName
        });
      });
    });
    return list;
  }

  window.getAllIndicators = getAllIndicators;

  // ─── Render: Lista de Indicadores ────────────────────────────────
  window.indcageRenderIndicadores = function() {
    ensureData();
    const search  = (document.getElementById('indcage-search')?.value || '').toLowerCase();
    const divisao = document.getElementById('indcage-filter-divisao')?.value || '';

    const all = getAllIndicators();

    // Popular divisões no filtro
    const divs = [...new Set(all.map(i => i.divisao).filter(Boolean))].sort();
    const divSel = document.getElementById('indcage-filter-divisao');
    if(divSel) {
      divSel.innerHTML = '<option value="">Todas as divisões</option>'
        + divs.map(d => `<option value="${d}">${d}</option>`).join('');
      if(divisao) divSel.value = divisao;
    }

    const filtered = all.filter(ind => {
      if(search && !((ind.codigo||'') + ' ' + (ind.enunciado||'')).toLowerCase().includes(search)) return false;
      if(divisao && ind.divisao !== divisao) return false;
      return true;
    });

    const grid = document.getElementById('indcage-grid');
    if(!grid) return;

    if(filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:#94a3b8;">
        <div style="font-size:48px;margin-bottom:12px;">📊</div>
        <div style="font-size:15px;font-weight:600;color:#1B3022;">Nenhum indicador encontrado</div>
        <div style="font-size:13px;margin-top:4px;">Ajuste os filtros ou adicione novos indicadores.</div>
      </div>`;
      return;
    }

    grid.innerHTML = filtered.map(ind => {
      const isCage = ind._source === 'cage';
      const editBtn = isCage
        ? `<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="indcageOpenModal('${ind.id}')">✏️ Editar</button>
           <button class="btn" style="font-size:11px;padding:4px 10px;background:#fee2e2;color:#b91c1c;border-color:#fecaca;" onclick="indcageDelete('${ind.id}')">✕</button>`
        : `<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="indcageGoToPop('${ind.pop}')">🔗 Ver POP</button>`;
      const sisplan = ind.sisplan ? `<div class="indcage-card-sisplan">SISPLAN: ${ind.sisplan}</div>` : '';
      const popLink = isCage && ind.pop ? `<div class="indcage-card-pop">🔗 ${DATA[ind.pop]?.meta?.name || ind.pop}</div>` : (ind._source === 'pop' ? `<div class="indcage-card-pop">📋 ${ind._popName}</div>` : '');
      const meta = ind.meta ? `<span>🎯 Meta: <strong>${ind.meta}</strong></span>` : '';
      return `
      <div class="indcage-card">
        <div class="indcage-card-header">
          <div style="flex:1">
            ${ind.codigo ? `<div class="indcage-card-codigo">${ind.codigo}</div>` : ''}
            <div class="indcage-card-titulo">${ind.enunciado || '<em style="color:#94a3b8">Sem enunciado</em>'}</div>
            <span class="indcage-card-nivel ${nivelClass(ind.nivel)}">${nivelLabel(ind.nivel)}</span>
            ${sisplan}
            ${popLink}
          </div>
        </div>
        ${meta ? `<div class="indcage-card-meta">${meta} ${ind.periodicidade ? `· 🔁 ${ind.periodicidade}` : ''} ${ind.divisao ? `· 🏢 ${ind.divisao}` : ''}</div>` : ''}
        ${ind.responsavel ? `<div style="font-size:11px;color:#64748b;margin-top:6px;">👤 ${ind.responsavel}</div>` : ''}
        <div class="indcage-card-actions">${editBtn}</div>
      </div>`;
    }).join('');
  };

  // ─── Modal: Abrir ─────────────────────────────────────────────────
  window.indcageOpenModal = function(id) {
    ensureData();
    _editId = id;
    const ind = id ? DATA.indicadoresCage.indicadores.find(i => i.id === id) : null;
    document.getElementById('indcage-modal-title').textContent = ind ? 'Editar Indicador' : 'Novo Indicador CAGE';
    document.getElementById('ic-codigo').value       = ind?.codigo || '';
    document.getElementById('ic-sisplan').value      = ind?.sisplan || '';
    document.getElementById('ic-enunciado').value    = ind?.enunciado || '';
    document.getElementById('ic-nivel').value        = ind?.nivel || 'processo';
    document.getElementById('ic-divisao').value      = ind?.divisao || '';
    document.getElementById('ic-meta').value         = ind?.meta || '';
    document.getElementById('ic-periodicidade').value= ind?.periodicidade || 'mensal';
    document.getElementById('ic-responsavel').value  = ind?.responsavel || '';
    document.getElementById('ic-formula').value      = ind?.formula || '';
    document.getElementById('ic-fonte').value        = ind?.fonte || '';

    // Popular select de POPs
    const popSel = document.getElementById('ic-pop');
    const popKeys = Object.keys(DATA).filter(k => k === 'd' || k === 'r' || k.startsWith('pop_'));
    popSel.innerHTML = '<option value="">— Nenhum vínculo —</option>'
      + popKeys.map(k => `<option value="${k}" ${ind?.pop===k?'selected':''}>${DATA[k]?.meta?.name || k}</option>`).join('');

    document.getElementById('indcage-modal').classList.add('open');
  };

  window.indcageCloseModal = function() {
    document.getElementById('indcage-modal').classList.remove('open');
    _editId = null;
  };

  window.indcageSaveModal = function() {
    ensureData();
    const enunciado = document.getElementById('ic-enunciado').value.trim();
    if(!enunciado) { showToast('Informe o enunciado do indicador.', 'warn'); return; }
    const data = {
      codigo:       document.getElementById('ic-codigo').value.trim(),
      sisplan:      document.getElementById('ic-sisplan').value.trim(),
      enunciado,
      nivel:        document.getElementById('ic-nivel').value,
      divisao:      document.getElementById('ic-divisao').value.trim(),
      pop:          document.getElementById('ic-pop').value,
      meta:         document.getElementById('ic-meta').value.trim(),
      periodicidade:document.getElementById('ic-periodicidade').value,
      responsavel:  document.getElementById('ic-responsavel').value.trim(),
      formula:      document.getElementById('ic-formula').value.trim(),
      fonte:        document.getElementById('ic-fonte').value.trim(),
    };
    if(_editId) {
      const idx = DATA.indicadoresCage.indicadores.findIndex(i => i.id === _editId);
      if(idx !== -1) Object.assign(DATA.indicadoresCage.indicadores[idx], data);
    } else {
      data.id = 'ic_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
      DATA.indicadoresCage.indicadores.push(data);
    }
    indcageCloseModal();
    indcageRenderIndicadores();
    markChanged(true, true);
    showToast('✅ Indicador salvo!', 'success');
  };

  window.indcageDelete = function(id) {
    if(!confirm('Remover este indicador?')) return;
    ensureData();
    DATA.indicadoresCage.indicadores = DATA.indicadoresCage.indicadores.filter(i => i.id !== id);
    indcageRenderIndicadores();
    markChanged(true, true);
    showToast('Indicador removido.', 'success');
  };

  window.indcageClearImportados = function() {
    ensureData();
    const importados = DATA.indicadoresCage.indicadores.filter(i =>
      (i.fonte || '').toLowerCase().includes('importado sisplan')
    );
    if(importados.length === 0) {
      showToast('Nenhum indicador importado do SISPLAN encontrado.', 'warn');
      return;
    }
    if(!confirm(`Remover ${importados.length} indicador(es) com fonte "Importado SISPLAN"?\n\nIndicadores cadastrados manualmente e vinculados a mapeamentos NÃO serão afetados.`)) return;
    DATA.indicadoresCage.indicadores = DATA.indicadoresCage.indicadores.filter(i =>
      !(i.fonte || '').toLowerCase().includes('importado sisplan')
    );
    indcageRenderIndicadores();
    markChanged(true, true);
    saveToCloud();
    showToast(`🗑 ${importados.length} indicador(es) SISPLAN removidos.`, 'success');
  };

  window.indcageGoToPop = function(popKey) {
    if(typeof switchPop === 'function' && (popKey === 'd' || popKey === 'r')) {
      switchPop(popKey);
    }
  };

  // ─── Importar Excel ───────────────────────────────────────────────
  window.indcageImportExcel = function(input) {
    const file = input?.files?.[0];
    if(!file) return;
    const status = document.getElementById('indcage-import-status');
    if(status) status.textContent = '⏳ Lendo arquivo…';

    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        ensureData();
        const wb = isCsv
          ? XLSX.read(e.target.result, { type: 'string', cellDates: true })
          : XLSX.read(e.target.result, { type: 'array',  cellDates: true });
        _indcageProcessWb(wb, status);
        input.value = '';
      } catch(err) {
        /* notifica o usuario do erro */
        if(status) status.textContent = '❌ Erro ao importar';
        showToast('Erro ao importar planilha: ' + err.message, 'warn');
      }
    };
    if(isCsv) reader.readAsText(file, 'UTF-8');
    else       reader.readAsArrayBuffer(file);
  };

  // ─── Processamento interno de workbook (reutilizado por import e sync URL) ─
  function _indcageProcessWb(wb, statusEl) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if(rows.length < 2) { showToast('Planilha vazia ou sem dados.', 'warn'); return; }

    let headerIdx = 0;
    for(let i = 0; i < Math.min(5, rows.length); i++) {
      if(rows[i].filter(c => String(c).trim()).length >= 5) { headerIdx = i; break; }
    }
    const headers = rows[headerIdx].map(h => _normalizeHeader(String(h)));

    const col = {};
    headers.forEach((h, i) => {
      if(h.includes('divis'))                                                                                                             col.divisao       = i;
      if(col.codigo === undefined && (h.includes('digo') || (h.includes('cod') && !h.includes('per')) || (h.includes('indicador') && !h.includes('enunciado') && !h.includes('ciclo') && !h.includes('divis') && !h.includes('period')))) col.codigo = i;
      if(h.includes('tipo') || h.includes('nivel') || h.includes('nvel'))                                                               col.tipoNivel     = i;
      if(h.includes('enunciado'))                                                                                                         col.enunciado     = i;
      if(h.includes('descri'))                                                                                                            col.descricao     = i;
      if(h.includes('periodicidad'))                                                                                                      col.periodicidade = i;
      else if(h.includes('period') || h.includes('aval'))                                                                               col.periodo       = i;
      if(h.includes('ciclo'))                                                                                                             col.ciclo         = i;
      if(h.includes('ppe'))                                                                                                               col.ppe           = i;
      if(h.includes('justificativa'))                                                                                                     col.justificativa = i;
      if(h.includes('ndice') || h.includes('indice'))                                                                                    col.pctIndice     = i;
      if(h.includes('meta') && col.meta === undefined)                                                                                   col.meta          = i;
      if(h.includes('realizado') && !h.includes('acum') && !h.includes('cumul') && !h.includes('%') && col.realizado  === undefined)    col.realizado     = i;
      if(h.includes('realizado') && !h.includes('acum') && !h.includes('cumul') &&  h.includes('%') && col.pctRealizado === undefined)  col.pctRealizado  = i;
      if((h.includes('acum') || h.includes('cumul')) && !h.includes('%') && col.realizadoAcum === undefined)                            col.realizadoAcum = i;
      if((h.includes('acum') || h.includes('cumul')) &&  h.includes('%') && col.pctRealizAcum === undefined)                            col.pctRealizAcum = i;
    });
    const analiseIdxs = [];
    headers.forEach((h, i) => { if(h.includes('anali') || h.includes('anlise') || h.includes('nalis') || h.includes('alise')) analiseIdxs.push(i); });
    if(analiseIdxs.length >= 1) col.analise  = analiseIdxs[0];
    if(analiseIdxs.length >= 2) col.analise2 = analiseIdxs[1];
    if(col.pctRealizado === undefined && col.realizado !== undefined) {
      for(let i = col.realizado+1; i < headers.length; i++) {
        if(headers[i].includes('%') || headers[i].includes('perc')) { col.pctRealizado = i; break; }
      }
    }

    const importedAt = new Date().toISOString();
    const newRows = [];
    for(let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const enunciado = col.enunciado !== undefined ? String(r[col.enunciado]).trim() : '';
      const codigo    = col.codigo    !== undefined ? String(r[col.codigo]).trim()    : '';
      if(!enunciado && !codigo) continue;
      const periodo = col.periodo !== undefined ? _parsePeriodo(r[col.periodo]) : '';
      newRows.push({
        divisao:        col.divisao        !== undefined ? String(r[col.divisao]).trim()        : '',
        codigo,
        tipoNivel:      col.tipoNivel      !== undefined ? String(r[col.tipoNivel]).trim()      : '',
        enunciado,
        descricao:      col.descricao      !== undefined ? String(r[col.descricao]).trim()      : '',
        periodicidade:  col.periodicidade  !== undefined ? String(r[col.periodicidade]).trim()  : '',
        periodo,
        ciclo:          col.ciclo          !== undefined ? String(r[col.ciclo]).trim()          : '',
        ppe:            col.ppe            !== undefined ? String(r[col.ppe]).trim()            : '',
        justificativa:  col.justificativa  !== undefined ? String(r[col.justificativa]).trim()  : '',
        analise:        col.analise        !== undefined ? String(r[col.analise]).trim()        : '',
        pctIndice:      col.pctIndice      !== undefined ? _parseNum(r[col.pctIndice])          : null,
        meta:           col.meta           !== undefined ? _parseNum(r[col.meta])               : null,
        realizado:      col.realizado      !== undefined ? _parseNum(r[col.realizado])          : null,
        pctRealizado:   col.pctRealizado   !== undefined ? _parseNum(r[col.pctRealizado])       : null,
        analise2:       col.analise2       !== undefined ? String(r[col.analise2]).trim()       : '',
        realizadoAcum:  col.realizadoAcum  !== undefined ? _parseNum(r[col.realizadoAcum])     : null,
        pctRealizAcum:  col.pctRealizAcum  !== undefined ? _parseNum(r[col.pctRealizAcum])     : null,
        _importedAt:    importedAt
      });
    }

    const existing = DATA.indicadoresCage.resultados;
    newRows.forEach(nr => {
      const key = (nr.codigo + '||' + nr.periodo + '||' + nr.divisao).toLowerCase();
      const idx = existing.findIndex(er => (er.codigo+'||'+er.periodo+'||'+er.divisao).toLowerCase() === key);
      if(idx !== -1) existing[idx] = nr; else existing.push(nr);
    });

    newRows.forEach(nr => {
      if(!nr.codigo) return;
      const exists = getAllIndicators().some(i => i.codigo === nr.codigo);
      if(!exists) {
        DATA.indicadoresCage.indicadores.push({
          id: 'ic_auto_' + Date.now() + '_' + Math.random().toString(36).slice(2,5),
          codigo: nr.codigo,
          enunciado: nr.enunciado,
          descricao: nr.descricao || '',
          sisplan: '',
          nivel: _guessNivel(nr.tipoNivel),
          divisao: nr.divisao,
          pop: '',
          meta: nr.meta !== null ? String(nr.meta) : '',
          periodicidade: nr.periodicidade || 'mensal',
          responsavel: '',
          formula: '',
          fonte: 'Importado SISPLAN'
        });
      }
    });

    markChanged(true, true);
    saveToCloud();
    if(statusEl) statusEl.textContent = `✅ ${newRows.length} registros importados`;
    showToast(`📥 ${newRows.length} resultados importados com sucesso!`, 'success');
    indcageRenderResultados();
  };

  // ─── Sincronização via URL ────────────────────────────────────────────────
  window.indcageSaveUrl = function() {
    ensureData();
    DATA.indicadoresCage.sisplanUrl      = document.getElementById('indcage-sync-url')?.value.trim()  || '';
    DATA.indicadoresCage.sisplanAutoSync = document.getElementById('indcage-sync-auto')?.checked || false;
    markChanged(true, true);
  };

  window.indcageLoadUrlConfig = function() {
    ensureData();
    const urlEl  = document.getElementById('indcage-sync-url');
    const autoEl = document.getElementById('indcage-sync-auto');
    if(urlEl)  urlEl.value   = DATA.indicadoresCage.sisplanUrl      || '';
    if(autoEl) autoEl.checked = DATA.indicadoresCage.sisplanAutoSync || false;
    // Auto-sync se habilitado e URL configurada
    if(DATA.indicadoresCage.sisplanAutoSync && DATA.indicadoresCage.sisplanUrl) {
      indcageSyncFromUrl(true);
    } else if(DATA.indicadoresCage.sisplanLastSync) {
      const syncEl = document.getElementById('indcage-sync-status');
      if(syncEl) syncEl.textContent = `Última sincronização: ${new Date(DATA.indicadoresCage.sisplanLastSync).toLocaleString('pt-BR')}`;
    }
  };

  window.indcageSyncFromUrl = async function(silent = false) {
    ensureData();
    const urlInput = document.getElementById('indcage-sync-url');
    const url = (urlInput?.value.trim() || DATA.indicadoresCage.sisplanUrl || '').trim();
    const syncStatus = document.getElementById('indcage-sync-status');
    const importStatus = document.getElementById('indcage-import-status');

    if(!url) {
      if(!silent) showToast('Cole a URL da planilha no campo acima.', 'warn');
      return;
    }

    if(syncStatus) syncStatus.textContent = '⏳ Buscando planilha…';
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if(!resp.ok) throw new Error(`Servidor retornou HTTP ${resp.status}`);
      const text = await resp.text(); // decodifica UTF-8 corretamente
      if(syncStatus) syncStatus.textContent = '⏳ Processando…';
      ensureData();
      const wb = XLSX.read(text, { type: 'string', cellDates: true });
      _indcageProcessWb(wb, importStatus);
      DATA.indicadoresCage.sisplanLastSync = new Date().toISOString();
      if(syncStatus) syncStatus.textContent = `✅ Sincronizado em ${new Date().toLocaleString('pt-BR')}`;
    } catch(err) {
      /* notifica o usuario do erro */
      const msg = (err.message.includes('fetch') || err.message.includes('Network'))
        ? 'Não foi possível acessar a URL. Verifique se a planilha está publicada publicamente (sem login).'
        : err.message;
      if(syncStatus) syncStatus.textContent = `❌ ${msg}`;
      if(!silent) showToast('Erro na sincronização: ' + msg, 'warn');
    }
  };

  function _normalizeHeader(h) {
    return h.replace(/[\u{1F000}-\u{1FFFF}]|[\u2600-\u27BF]|[️⃣]/gu, '')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z%\s]/gi, '')
            .toLowerCase().trim().replace(/\s+/g,' ');
  }

  function _parseNum(v) {
    if(v === null || v === undefined || v === '') return null;
    if(typeof v === 'number') return v;
    const s = String(v).replace(',','.').replace(/[^0-9.\-]/g,'');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function _parsePeriodo(v) {
    if(!v) return '';
    if(typeof v === 'object' && v instanceof Date) {
      // Excel date object
      const y = v.getFullYear();
      const m = String(v.getMonth()+1).padStart(2,'0');
      return y + '-' + m;
    }
    const s = String(v).trim();
    // Formats: "Jan/2024", "01/2024", "2024-01", "Janeiro 2024"
    const meses = { jan:1,fev:2,mar:3,abr:4,mai:5,jun:6,jul:7,ago:8,set:9,out:10,nov:11,dez:12,
      january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    // Try "Mmm/YYYY" or "MMMM/YYYY"
    const m1 = s.match(/^([a-záàâãçéê]+)[\/\s\-](\d{4})$/i);
    if(m1) {
      const mKey = m1[1].toLowerCase().slice(0,3);
      const mNum = meses[mKey];
      if(mNum) return m1[2] + '-' + String(mNum).padStart(2,'0');
    }
    // Try "MM/YYYY"
    const m2 = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
    if(m2) return m2[2] + '-' + m2[1].padStart(2,'0');
    // Try "YYYY-MM"
    const m3 = s.match(/^(\d{4})[\/\-](\d{1,2})$/);
    if(m3) return m3[1] + '-' + m3[2].padStart(2,'0');
    return s;
  }

  function _guessNivel(tipoNivel) {
    const s = (tipoNivel||'').toLowerCase();
    if(s.includes('macro') || s.includes('estrat')) return 'macroprocesso';
    if(s.includes('atividade')) return 'atividade';
    if(s.includes('etapa')) return 'etapa';
    if(s.includes('acao') || s.includes('ação')) return 'acao';
    return 'processo';
  }

  // ─── Limpar resultados ────────────────────────────────────────────
  window.indcageClearResultados = function() {
    if(!confirm('Remover todos os resultados importados? Os indicadores cadastrados serão mantidos.')) return;
    ensureData();
    DATA.indicadoresCage.resultados = [];
    markChanged(true, true);
    indcageRenderResultados();
    showToast('Resultados removidos.', 'success');
  };

  // ─── Render: Resultados ───────────────────────────────────────────
  window.indcageRenderResultados = function() {
    ensureData();
    const resultados = DATA.indicadoresCage.resultados;

    // Populate filter selects
    const allCodigos        = [...new Set(resultados.map(r => r.codigo).filter(Boolean))].sort();
    const allDivisoes       = [...new Set(resultados.map(r => r.divisao).filter(Boolean))].sort();
    const allAnos           = [...new Set(resultados.map(r => r.periodo?.slice(0,4)).filter(Boolean))].sort().reverse();
    const allPeriodos       = [...new Set(resultados.map(r => r.periodo).filter(Boolean))].sort().reverse();
    const allCiclos         = [...new Set(resultados.map(r => r.ciclo).filter(Boolean))].sort();
    const allPeriodicidades = [...new Set(resultados.map(r => r.periodicidade).filter(Boolean))].sort();
    const allPPEs           = [...new Set(resultados.map(r => r.ppe).filter(Boolean))].sort();

    const fInd    = document.getElementById('indcage-res-filter-ind');
    const fDiv    = document.getElementById('indcage-res-filter-div');
    const fAno    = document.getElementById('indcage-res-filter-ano');
    const fPer    = document.getElementById('indcage-res-filter-periodo');
    const fCiclo  = document.getElementById('indcage-res-filter-ciclo');
    const fPerio  = document.getElementById('indcage-res-filter-periodicidade');
    const fPPE    = document.getElementById('indcage-res-filter-ppe');

    _repopSelect(fInd, allCodigos, 'Todos', v => {
      const lbl = getAllIndicators().find(i => i.codigo === v)?.enunciado;
      return lbl ? v + ' — ' + lbl : v;
    });
    _repopSelect(fDiv,    allDivisoes,       'Todas');
    _repopSelect(fAno,    allAnos,           'Todos os anos');
    _repopSelect(fPer,    allPeriodos,       'Todos os períodos', v => _periodoLabel(v));
    _repopSelect(fCiclo,  allCiclos,         'Todos os ciclos');
    _repopSelect(fPerio,  allPeriodicidades, 'Todas');
    _repopSelect(fPPE,    allPPEs,           'Todos');

    const selInd    = fInd?.value    || '';
    const selDiv    = fDiv?.value    || '';
    const selAno    = fAno?.value    || '';
    const selPer    = fPer?.value    || '';
    const selCiclo  = fCiclo?.value  || '';
    const selPerio  = fPerio?.value  || '';
    const selPPE    = fPPE?.value    || '';
    const selSearch = (document.getElementById('indcage-res-search')?.value || '').toLowerCase().trim();

    let filtered = resultados.filter(r => {
      if(selInd   && r.codigo        !== selInd)   return false;
      if(selDiv   && r.divisao       !== selDiv)   return false;
      if(selAno   && !(r.periodo||'').startsWith(selAno)) return false;
      if(selPer   && r.periodo       !== selPer)   return false;
      if(selCiclo && r.ciclo         !== selCiclo) return false;
      if(selPerio && r.periodicidade !== selPerio) return false;
      if(selPPE   && r.ppe           !== selPPE)   return false;
      if(selSearch) {
        const haystack = [r.codigo, r.enunciado, r.descricao, r.divisao, r.analise].filter(Boolean).join(' ').toLowerCase();
        if(!haystack.includes(selSearch)) return false;
      }
      return true;
    });

    // Painel de dados básicos do indicador selecionado
    const infoPanel = document.getElementById('indcage-ind-info');
    const infoBody  = document.getElementById('indcage-ind-info-body');
    if(selInd && infoPanel && infoBody) {
      const sample = resultados.filter(r => r.codigo === selInd).sort((a,b) => (b.periodo||'').localeCompare(a.periodo||''))[0];
      if(sample) {
        const fields = [
          { label: '☑️ Indicador',       value: sample.codigo },
          { label: '🔤 Enunciado',        value: sample.enunciado },
          { label: '🔡 Descrição',        value: sample.descricao },
          { label: '🧰️ Divisão',         value: sample.divisao },
          { label: '⌛ Periodicidade',    value: sample.periodicidade },
          { label: '📅 Ciclo Indicador', value: sample.ciclo },
          { label: '💰 PPE?',            value: sample.ppe },
        ].filter(f => f.value);
        infoBody.innerHTML = fields.map(f => `
          <div style="display:flex;flex-direction:column;gap:2px;">
            <div style="font-size:10px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.4px;">${f.label}</div>
            <div style="font-size:13px;color:#1B3022;font-weight:500;">${f.value}</div>
          </div>`).join('');
        infoPanel.style.display = 'block';
      } else {
        infoPanel.style.display = 'none';
      }
    } else if(infoPanel) {
      infoPanel.style.display = 'none';
    }

    // Painel de configurações do indicador
    _renderCfgPanel(selInd);

    // Sort by periodo desc
    filtered = filtered.slice().sort((a,b) => (b.periodo||'').localeCompare(a.periodo||''));

    // KPIs do último período visível
    _renderKpis(filtered, selPer, selInd);

    // Charts (só quando um indicador específico está selecionado)
    const chartsArea = document.getElementById('indcage-charts-area');
    if(selInd && resultados.length > 0) {
      if(chartsArea) chartsArea.style.display = 'grid';
      _renderCharts(selInd, selDiv);
    } else {
      if(chartsArea) chartsArea.style.display = 'none';
      _destroyCharts();
    }

    // Empty state
    const emptyState = document.getElementById('indcage-empty-state');
    const tableWrap  = document.getElementById('indcage-table-wrap');
    if(resultados.length === 0) {
      if(emptyState) emptyState.style.display = 'block';
      if(tableWrap)  tableWrap.style.display  = 'none';
    } else {
      if(emptyState) emptyState.style.display = 'none';
      if(tableWrap)  tableWrap.style.display  = 'block';
    }

    // Table
    const tbody = document.getElementById('indcage-table-body');
    const count = document.getElementById('indcage-table-count');
    if(count) count.textContent = filtered.length + ' registro(s)';
    if(!tbody) return;
    if(filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="12" style="text-align:center;color:#94a3b8;padding:24px;">Nenhum resultado para os filtros selecionados.</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map(r => {
      const cfg = _getOverride(r.codigo);
      const pct = r.pctRealizado;
      const pctClass   = _pctClass(pct, cfg);
      const pctAcClass = _pctClass(r.pctRealizAcum, cfg);
      const unidade = cfg.unidade ? cfg.unidade : '%';
      const isPerc = cfg.tipo === 'percentual' || cfg.tipo === 'prazo' || cfg.tipo === 'auto';
      const fmtVal = v => v !== null && v !== undefined ? _fmtNumDec(v, cfg.casasDecimais) : '—';
      const ppeBadge = r.ppe ? `<span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${r.ppe.toLowerCase()==='sim'||r.ppe.toLowerCase()==='s'||r.ppe==='1'?'#dcfce7':'#f1f5f9'};color:${r.ppe.toLowerCase()==='sim'||r.ppe.toLowerCase()==='s'||r.ppe==='1'?'#166534':'#64748b'};">${r.ppe}</span>` : '—';
      return `<tr>
        <td>${r.divisao || '—'}</td>
        <td style="font-family:'JetBrains Mono',monospace;font-size:11px;">${r.codigo || '—'}</td>
        <td style="max-width:220px;">${r.enunciado || '—'}</td>
        <td style="max-width:180px;font-size:11px;color:#475569;">${r.descricao || '—'}</td>
        <td style="font-size:11px;color:#475569;">${r.periodicidade || '—'}</td>
        <td style="white-space:nowrap;font-weight:600;">${_periodoLabel(r.periodo)}</td>
        <td style="font-size:11px;color:#475569;">${r.ciclo || '—'}</td>
        <td style="text-align:center;">${ppeBadge}</td>
        <td style="text-align:center;">${r.pctIndice !== null ? `<span class="indcage-pct-pill pct-cinza">${_fmtNum(r.pctIndice)}%</span>` : '—'}</td>
        <td style="text-align:right;">${fmtVal(r.meta)}${r.meta !== null ? ' <span style="font-size:9px;color:#94a3b8;">'+unidade+'</span>' : ''}</td>
        <td style="text-align:right;">${fmtVal(r.realizado)}${r.realizado !== null ? ' <span style="font-size:9px;color:#94a3b8;">'+unidade+'</span>' : ''}</td>
        <td style="max-width:200px;font-size:11px;color:#475569;">${r.analise || '—'}</td>
      </tr>`;
    }).join('');
  };

  function _repopSelect(sel, values, allLabel, labelFn) {
    if(!sel) return;
    const cur = sel.value;
    sel.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>`
      + values.map(v => {
          const lbl = labelFn ? labelFn(v) : v;
          return `<option value="${v}" ${v===cur?'selected':''}>${lbl}</option>`;
        }).join('');
  }

  function _renderKpis(filtered, selPer, selInd) {
    const kpiRow = document.getElementById('indcage-kpi-row');
    if(!kpiRow) return;
    if(filtered.length === 0) { kpiRow.innerHTML = ''; return; }

    const periodo = selPer ? _periodoLabel(selPer) : (filtered[0]?.periodo ? _periodoLabel(filtered[0].periodo) : '—');

    // Sem indicador específico: KPIs de contagem
    // (somar % de indicadores misturados com unidades diferentes não faz sentido)
    if(!selInd) {
      const uniqInds = new Set(filtered.map(r => r.codigo).filter(Boolean)).size;
      const uniqPers = new Set(filtered.map(r => r.periodo).filter(Boolean)).size;
      const comDados = filtered.filter(r => r.realizado !== null).length;
      const semDados = filtered.length - comDados;
      kpiRow.innerHTML = `
        <div class="indcage-kpi"><div class="indcage-kpi-value" style="font-size:26px;">${uniqInds}</div><div class="indcage-kpi-label">Indicadores</div><div class="indcage-kpi-sub">${filtered.length} linha(s)</div></div>
        <div class="indcage-kpi"><div class="indcage-kpi-value" style="font-size:26px;">${uniqPers}</div><div class="indcage-kpi-label">Períodos distintos</div><div class="indcage-kpi-sub">${periodo}</div></div>
        <div class="indcage-kpi"><div class="indcage-kpi-value" style="font-size:26px;">${comDados}</div><div class="indcage-kpi-label">Com realizado informado</div><div class="indcage-kpi-sub">${semDados} sem dado</div></div>
      `;
      return;
    }

    // Com indicador específico selecionado: mostrar médias e totais
    const avg = (arr, key) => {
      const vals = arr.map(r => r[key]).filter(v => v !== null);
      if(!vals.length) return null;
      return vals.reduce((a,b)=>a+b,0) / vals.length;
    };
    const pctReal        = avg(filtered, 'pctRealizado');
    const pctInd         = avg(filtered, 'pctIndice');
    const pctAcum        = avg(filtered, 'pctRealizAcum');
    const realizadoTotal = filtered.reduce((s,r) => s + (r.realizado ?? 0), 0);
    const metaTotal      = filtered.reduce((s,r) => s + (r.meta      ?? 0), 0);

    const cfg = _getOverride(selInd);
    function kpiClass(v) {
      if(v===null) return '';
      return _pctClass(v, cfg).replace('pct-', '');
    }
    const unidade      = cfg?.unidade || '';
    const sentidoLabel = cfg.sentido === 'menor' ? '↓ menor melhor' : '↑ maior melhor';

    kpiRow.innerHTML = `
      <div class="indcage-kpi"><div class="indcage-kpi-value ${kpiClass(pctReal)}">${pctReal!==null?_fmtNum(pctReal)+'%':'—'}</div><div class="indcage-kpi-label">% Realizado (média)</div><div class="indcage-kpi-sub">${periodo}</div></div>
      <div class="indcage-kpi"><div class="indcage-kpi-value ${kpiClass(pctInd)}">${pctInd!==null?_fmtNum(pctInd)+'%':'—'}</div><div class="indcage-kpi-label">% Índice (média)</div><div class="indcage-kpi-sub">${periodo}</div></div>
      <div class="indcage-kpi"><div class="indcage-kpi-value ${kpiClass(pctAcum)}">${pctAcum!==null?_fmtNum(pctAcum)+'%':'—'}</div><div class="indcage-kpi-label">% Realiz. Acumulado</div><div class="indcage-kpi-sub">${periodo}</div></div>
      <div class="indcage-kpi"><div class="indcage-kpi-value" style="font-size:22px;">${_fmtNum(realizadoTotal)}${unidade?' <span style="font-size:14px;color:#94a3b8;">'+unidade+'</span>':''}</div><div class="indcage-kpi-label">Total Realizado</div><div class="indcage-kpi-sub">vs Meta: ${_fmtNum(metaTotal)}${unidade?' '+unidade:''} · ${sentidoLabel}</div></div>
    `;
  }

  // ─── Configuração / override por indicador ────────────────────────
  function _getOverride(codigo) {
    ensureData();
    const saved = DATA.indicadoresCage.overrides[codigo] || {};
    const ind = getAllIndicators().find(i => i.codigo === codigo);
    const enunciadoPrazo = /^(prazo|tempo)\b/i.test(ind?.enunciado || '');
    let tipo = (saved.tipo && saved.tipo !== 'auto') ? saved.tipo : (enunciadoPrazo ? 'prazo' : 'percentual');
    const isPrazoTipo = tipo === 'prazo';
    const defaultSentido = isPrazoTipo ? 'menor' : 'maior';
    const sentido = saved.sentido || defaultSentido;
    const menorMelhor = sentido === 'menor';
    // Thresholds
    const defaultVerde   = menorMelhor ? 100 : 100;
    const defaultAmarelo = menorMelhor ? 120 : 80;
    return {
      tipo,
      sentido,
      unidade:       saved.unidade       !== undefined ? saved.unidade       : (isPrazoTipo ? 'dias' : tipo === 'moeda' ? 'R$' : tipo === 'percentual' ? '%' : ''),
      casasDecimais: saved.casasDecimais !== undefined ? saved.casasDecimais : 1,
      faixaVerde:    saved.faixaVerde    !== undefined ? Number(saved.faixaVerde)    : defaultVerde,
      faixaAmarelo:  saved.faixaAmarelo  !== undefined ? Number(saved.faixaAmarelo)  : defaultAmarelo,
      metaRef:       saved.metaRef       !== undefined && saved.metaRef !== null && saved.metaRef !== '' ? Number(saved.metaRef) : null,
      comentario:    saved.comentario    || '',
    };
  }

  function _pctClass(pct, cfg) {
    if(pct === null || pct === undefined) return 'pct-cinza';
    if(cfg.sentido === 'menor') {
      return pct <= cfg.faixaVerde ? 'pct-verde' : pct <= cfg.faixaAmarelo ? 'pct-amarelo' : 'pct-vermelho';
    } else {
      return pct >= cfg.faixaVerde ? 'pct-verde' : pct >= cfg.faixaAmarelo ? 'pct-amarelo' : 'pct-vermelho';
    }
  }

  // ─── Charts ───────────────────────────────────────────────────────
  function _isPrazoInd(codigo) {
    const cfg = _getOverride(codigo);
    return cfg.sentido === 'menor';
  }

  function _destroyCharts() {
    if(_chartEvo) { _chartEvo.destroy(); _chartEvo = null; }
    if(_chartYoy) { _chartYoy.destroy(); _chartYoy = null; }
    if(_chartAbs) { _chartAbs.destroy(); _chartAbs = null; }
  }

  function _renderCharts(codigo, divisao) {
    ensureData();
    _destroyCharts();
    const cfg = _getOverride(codigo);
    const isPrazo = cfg.sentido === 'menor';
    const all = DATA.indicadoresCage.resultados
      .filter(r => r.codigo === codigo && (!divisao || r.divisao === divisao))
      .sort((a,b) => (a.periodo||'').localeCompare(b.periodo||''));

    if(all.length === 0) return;

    // Detectar se o indicador possui dados percentuais (0% em todos os períodos = sem dados percentuais)
    const hasPercentage = cfg.tipo !== 'numero' && cfg.tipo !== 'moeda' &&
      all.some(r => r.pctRealizado !== null && r.pctRealizado !== undefined && r.pctRealizado !== 0);

    const cardEvo = document.getElementById('indcage-chart-card-evo');
    const cardYoy = document.getElementById('indcage-chart-card-yoy');
    const cardAbs = document.getElementById('indcage-chart-card-abs');

    if(hasPercentage) {
      // ── Exibir gráficos percentuais, ocultar gráfico absoluto ──
      if(cardEvo) cardEvo.style.display = '';
      if(cardAbs) cardAbs.style.display = 'none';

      // ── Chart 1: Evolução (últimos 18 meses) ──────────────────────
      const last18 = all.slice(-18);
      const labels = last18.map(r => _periodoLabel(r.periodo));
      const realizado = last18.map(r => r.pctRealizado);
      const metaRefPct = (cfg.metaRef !== null && cfg.metaRef !== undefined) ? cfg.metaRef : 100;
      const pctIndice = last18.map(() => metaRefPct);
      const pctMetaLabel = (cfg.metaRef !== null && cfg.metaRef !== undefined) ? '% Índice (meta configurada)' : '% Índice (meta)';

      const ctxEvo = document.getElementById('indcage-chart-evolucao');
      if(ctxEvo) {
        _chartEvo = new Chart(ctxEvo, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label:'% Realizado', data: realizado, backgroundColor: realizado.map(v => { if(v===null) return '#cbd5e1'; const cls=_pctClass(v,cfg); return cls==='pct-verde'?'rgba(22,163,74,.7)':cls==='pct-amarelo'?'rgba(234,179,8,.7)':'rgba(220,38,38,.7)'; }), borderRadius:4, order:2 },
              { label: pctMetaLabel, data: pctIndice, type:'line', borderColor:'#1B3022', backgroundColor:'rgba(27,48,34,.08)', borderWidth:2, pointRadius:3, tension:.3, fill:false, order:1 }
            ]
          },
          options: {
            responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ labels:{ font:{ size:11 } } }, tooltip:{ callbacks:{ label: ctx => ctx.dataset.label+': '+(ctx.raw!==null?_fmtNum(ctx.raw)+'%':'—') } } },
            scales:{ y:{ beginAtZero:true, ticks:{ callback: v => v+'%', font:{size:10} }, grid:{color:'rgba(0,0,0,.05)'} }, x:{ ticks:{font:{size:9}, maxRotation:45} } }
          }
        });
      }

      // ── Chart 2: Year-over-year comparison ────────────────────────
      const byYearMonth = {};
      all.forEach(r => {
        if(!r.periodo) return;
        const [yr, mo] = r.periodo.split('-');
        if(!yr || !mo) return;
        if(!byYearMonth[yr]) byYearMonth[yr] = {};
        byYearMonth[yr][mo] = r.pctRealizado;
      });
      const years = Object.keys(byYearMonth).sort().slice(-3);

      // Ocultar comparativo quando há dados de apenas um ano
      if(cardYoy) cardYoy.style.display = years.length >= 2 ? '' : 'none';

      const months = [...new Set(all.map(r => r.periodo?.slice(5,7)).filter(Boolean))].sort();
      const monthLabels = months.map(m => { const d=new Date(2000,parseInt(m)-1,1); return d.toLocaleString('pt-BR',{month:'short'}); });
      const palette = ['#1B3022','#00a86b','#e8a020'];
      const yoyDatasets = years.map((yr, yi) => ({
        label: yr,
        data: months.map(m => byYearMonth[yr]?.[m] ?? null),
        backgroundColor: palette[yi] + 'cc',
        borderColor: palette[yi],
        borderWidth: 1.5,
        borderRadius: 4
      }));

      const ctxYoy = document.getElementById('indcage-chart-yoy');
      if(ctxYoy) {
        _chartYoy = new Chart(ctxYoy, {
          type: 'bar',
          data: { labels: monthLabels, datasets: yoyDatasets },
          options: {
            responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ labels:{ font:{size:11} } }, tooltip:{ callbacks:{ label: ctx => ctx.dataset.label+': '+(ctx.raw!==null?_fmtNum(ctx.raw)+'%':'—') } } },
            scales:{ y:{ beginAtZero:true, ticks:{ callback: v=>v+'%', font:{size:10} }, grid:{color:'rgba(0,0,0,.05)'} }, x:{ ticks:{font:{size:10}} } }
          }
        });
      }

    } else {
      // ── Sem dados percentuais: exibir gráfico de número absoluto ──
      if(cardEvo) cardEvo.style.display = 'none';
      if(cardYoy) cardYoy.style.display = 'none';
      if(cardAbs) cardAbs.style.display = '';

      const last18 = all.slice(-18);
      const labels = last18.map(r => _periodoLabel(r.periodo));
      const realizadoAbs = last18.map(r => r.realizado !== undefined ? r.realizado : null);
      let metaAbs = last18.map(r => r.meta !== undefined ? r.meta : null);

      // Se não há metas definidas, usar a média dos últimos 12 meses com resultados como meta
      const hasMeta = metaAbs.some(m => m !== null && m !== undefined && m !== 0);
      let metaLabel = 'Meta';
      if(!hasMeta) {
        const last12ComResultado = all.slice(-12).filter(r => r.realizado !== null && r.realizado !== undefined && r.realizado !== 0);
        if(last12ComResultado.length > 0) {
          const media12m = last12ComResultado.reduce((s, r) => s + r.realizado, 0) / last12ComResultado.length;
          metaAbs = last18.map(() => media12m);
          metaLabel = 'Meta (média 12m)';
        }
      }

      // metaRef override: se usuário definiu meta manual, usá-la
      if(cfg.metaRef !== null) {
        metaAbs = last18.map(() => cfg.metaRef);
        metaLabel = 'Meta (configurada)';
      }

      const bgColors = realizadoAbs.map((v, i) => {
        if(v === null) return '#cbd5e1';
        const m = metaAbs[i];
        if(m === null || m === 0) return 'rgba(27,48,34,.7)';
        const ratio = v / m * 100;
        const cls = _pctClass(ratio, cfg);
        return cls === 'pct-verde' ? 'rgba(22,163,74,.7)' : cls === 'pct-amarelo' ? 'rgba(234,179,8,.7)' : 'rgba(220,38,38,.7)';
      });

      const ctxAbs = document.getElementById('indcage-chart-absoluto');
      if(ctxAbs) {
        _chartAbs = new Chart(ctxAbs, {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label:'Realizado', data: realizadoAbs, backgroundColor: bgColors, borderRadius:4, order:2 },
              { label: metaLabel, data: metaAbs, type:'line', borderColor:'#1B3022', backgroundColor:'rgba(27,48,34,.08)', borderWidth:2, pointRadius:3, tension:.3, fill:false, order:1 }
            ]
          },
          options: {
            responsive:true, maintainAspectRatio:false,
            plugins:{ legend:{ labels:{ font:{ size:11 } } }, tooltip:{ callbacks:{ label: ctx => ctx.dataset.label+': '+(ctx.raw!==null?_fmtNum(ctx.raw):'—') } } },
            scales:{ y:{ beginAtZero:true, ticks:{ callback: v => _fmtNum(v), font:{size:10} }, grid:{color:'rgba(0,0,0,.05)'} }, x:{ ticks:{font:{size:9}, maxRotation:45} } }
          }
        });
      }
    }
  }

  // ─── Painel de configurações do indicador ─────────────────────────
  let _cfgCurrentCodigo = null;

  function _renderCfgPanel(codigo) {
    const panel = document.getElementById('indcage-cfg-panel');
    if(!panel) return;
    if(!codigo) { panel.style.display = 'none'; _cfgCurrentCodigo = null; return; }
    _cfgCurrentCodigo = codigo;
    panel.style.display = '';

    const cfg = _getOverride(codigo);

    // Sentido
    const rMaior = document.getElementById('cfg-sentido-maior');
    const rMenor = document.getElementById('cfg-sentido-menor');
    if(rMaior) rMaior.checked = cfg.sentido === 'maior';
    if(rMenor) rMenor.checked = cfg.sentido === 'menor';

    // Tipo
    const selTipo = document.getElementById('cfg-tipo');
    if(selTipo) {
      const saved = (DATA.indicadoresCage.overrides[codigo] || {}).tipo;
      selTipo.value = saved || 'auto';
    }

    // Unidade
    const inpUnidade = document.getElementById('cfg-unidade');
    if(inpUnidade) inpUnidade.value = cfg.unidade;

    // Casas decimais
    const selDec = document.getElementById('cfg-decimais');
    if(selDec) selDec.value = String(cfg.casasDecimais);

    // Faixas
    const inpVerde = document.getElementById('cfg-faixa-verde');
    const inpAmarelo = document.getElementById('cfg-faixa-amarelo');
    if(inpVerde) inpVerde.value = cfg.faixaVerde;
    if(inpAmarelo) inpAmarelo.value = cfg.faixaAmarelo;

    // Hints dos limites
    _updateFaixaHints(cfg.sentido);

    // Meta ref
    const inpMetaRef = document.getElementById('cfg-meta-ref');
    if(inpMetaRef) inpMetaRef.value = cfg.metaRef !== null ? cfg.metaRef : '';

    // Comentário
    const ta = document.getElementById('cfg-comentario');
    if(ta) ta.value = cfg.comentario;

    // Indicar se há override salvo
    const saved = DATA.indicadoresCage.overrides[codigo];
    const chevron = document.getElementById('indcage-cfg-chevron');
    const titleEl = panel.querySelector('.indcage-cfg-title');
    if(titleEl) {
      titleEl.textContent = saved
        ? '⚙️ Configurações do Indicador ✔ (personalizadas)'
        : '⚙️ Configurações do Indicador';
    }

    // Listener para sentido → atualiza hints
    document.querySelectorAll('input[name="cfg-sentido"]').forEach(el => {
      el.onchange = () => _updateFaixaHints(el.value);
    });
  }

  function _updateFaixaHints(sentido) {
    const hVerde = document.getElementById('cfg-faixa-verde-hint');
    const hAmarelo = document.getElementById('cfg-faixa-amarelo-hint');
    if(sentido === 'menor') {
      if(hVerde)   hVerde.textContent   = 'Para "menor melhor": ≤ este valor = verde';
      if(hAmarelo) hAmarelo.textContent = 'Para "menor melhor": ≤ este valor e > verde = amarelo';
    } else {
      if(hVerde)   hVerde.textContent   = 'Para "maior melhor": ≥ este valor = verde';
      if(hAmarelo) hAmarelo.textContent = 'Para "maior melhor": ≥ este valor e < verde = amarelo';
    }
  }

  window.indcageCfgToggle = function() {
    const body = document.getElementById('indcage-cfg-body');
    const chevron = document.getElementById('indcage-cfg-chevron');
    if(!body) return;
    const open = body.classList.toggle('open');
    if(chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
  };

  window.indcageSaveOverride = function() {
    if(!_cfgCurrentCodigo) return;
    ensureData();

    const sentido = document.querySelector('input[name="cfg-sentido"]:checked')?.value || 'maior';
    const tipo    = document.getElementById('cfg-tipo')?.value || 'auto';
    const unidade = document.getElementById('cfg-unidade')?.value.trim() || '';
    const decimais = Number(document.getElementById('cfg-decimais')?.value || 1);
    const fVerde   = document.getElementById('cfg-faixa-verde')?.value;
    const fAmarelo = document.getElementById('cfg-faixa-amarelo')?.value;
    const metaRef  = document.getElementById('cfg-meta-ref')?.value;
    const comentario = document.getElementById('cfg-comentario')?.value.trim() || '';

    DATA.indicadoresCage.overrides[_cfgCurrentCodigo] = {
      sentido,
      tipo,
      unidade,
      casasDecimais: decimais,
      faixaVerde:    fVerde !== '' && fVerde !== undefined ? Number(fVerde) : undefined,
      faixaAmarelo:  fAmarelo !== '' && fAmarelo !== undefined ? Number(fAmarelo) : undefined,
      metaRef:       metaRef !== '' && metaRef !== undefined ? Number(metaRef) : null,
      comentario,
      _savedAt: new Date().toISOString()
    };

    if(typeof markChanged === "function") markChanged(true, true);

    const msg = document.getElementById('cfg-saved-msg');
    if(msg) { msg.style.display = 'inline'; setTimeout(() => { msg.style.display = 'none'; }, 2500); }

    // Re-renderizar resultados para aplicar imediatamente
    indcageRenderResultados();
  };

  window.indcageResetOverride = function() {
    if(!_cfgCurrentCodigo) return;
    if(!confirm('Restaurar configurações padrão para este indicador?')) return;
    ensureData();
    delete DATA.indicadoresCage.overrides[_cfgCurrentCodigo];
    if(typeof markChanged === "function") markChanged(true, true);
    indcageRenderResultados();
  };

  // ─── Formatters ───────────────────────────────────────────────────
  const _meses = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  function _periodoLabel(p) {
    if(!p) return '—';
    const m = p.match(/^(\d{4})-(\d{2})$/);
    if(m) return _meses[parseInt(m[2])-1] + '/' + m[1];
    return p;
  }
  function _fmtNum(v) {
    if(v === null || v === undefined) return '—';
    if(Number.isInteger(v)) return v.toLocaleString('pt-BR');
    return Number(v).toLocaleString('pt-BR', { minimumFractionDigits:1, maximumFractionDigits:2 });
  }
  function _fmtNumDec(v, decimais) {
    if(v === null || v === undefined) return '—';
    const d = Number(decimais) || 0;
    return Number(v).toLocaleString('pt-BR', { minimumFractionDigits:d, maximumFractionDigits:d });
  }

  // ─── Aba Relatório PPT ────────────────────────────────────────────

  window.indcageRenderRelatorioTab = function() {
    ensureData();
    const all = getAllIndicators();
    const resultados = DATA.indicadoresCage.resultados || [];
    const list = document.getElementById('indcage-rel-list');
    const empty = document.getElementById('indrel-empty');
    const countSel = document.getElementById('rel-count-sel');
    if(!list) return;

    if(all.length === 0) {
      list.innerHTML = '';
      if(empty) empty.style.display = 'block';
      return;
    }
    if(empty) empty.style.display = 'none';

    const codigosComDados = new Set(resultados.map(r => r.codigo).filter(Boolean));

    list.innerHTML = all.map(ind => {
      const temDados = ind.codigo && codigosComDados.has(ind.codigo);
      const badge = temDados
        ? `<span class="indrel-has-data">✓ com dados</span>`
        : `<span class="indrel-no-data">sem resultados</span>`;
      const metaInfo = [
        ind.divisao ? `🏢 ${ind.divisao}` : '',
        ind.periodicidade ? `🔁 ${ind.periodicidade}` : '',
        ind.responsavel ? `👤 ${ind.responsavel}` : '',
      ].filter(Boolean).join('  ');
      return `
      <label class="indrel-item" id="indrel-item-${ind.codigo || ind.id}">
        <input type="checkbox" class="rel-ind-check indrel-checkbox" value="${ind.codigo || ''}" data-id="${ind.id || ''}" onchange="indcageRelUpdateCount()">
        <div class="indrel-item-info">
          ${ind.codigo ? `<div class="indrel-item-codigo">${ind.codigo}</div>` : ''}
          <div class="indrel-item-enunciado">${ind.enunciado || '<em style="color:#94a3b8">Sem enunciado</em>'}</div>
          ${metaInfo ? `<div class="indrel-item-meta"><span>${metaInfo}</span></div>` : ''}
        </div>
        ${badge}
      </label>`;
    }).join('');

    indcageRelUpdateCount();
  };

  window.indcageRelUpdateCount = function() {
    const total = document.querySelectorAll('.rel-ind-check').length;
    const sel   = document.querySelectorAll('.rel-ind-check:checked').length;
    const el = document.getElementById('rel-count-sel');
    if(el) el.textContent = sel > 0 ? `(${sel} de ${total} selecionados)` : `(${total} disponíveis)`;
  };

  window.indcageRelSelecionarTodos = function() {
    document.querySelectorAll('.rel-ind-check').forEach(cb => cb.checked = true);
    indcageRelUpdateCount();
  };

  window.indcageRelDesmarcarTodos = function() {
    document.querySelectorAll('.rel-ind-check').forEach(cb => cb.checked = false);
    indcageRelUpdateCount();
  };

  // ─── Renderizar gráfico em canvas offscreen → base64 ──────────────
  async function _chartToBase64(codigo, chartType) {
    return new Promise(resolve => {
      ensureData();
      const cfg = _getOverride(codigo);
      const all = DATA.indicadoresCage.resultados
        .filter(r => r.codigo === codigo)
        .sort((a,b) => (a.periodo||'').localeCompare(b.periodo||''));
      if(all.length === 0) return resolve(null);

      const canvas = document.createElement('canvas');
      canvas.width  = 900;
      canvas.height = 380;
      canvas.style.position = 'absolute';
      canvas.style.left = '-9999px';
      canvas.style.top  = '-9999px';
      document.body.appendChild(canvas);

      let chartCfg;
      const hasPercentage = cfg.tipo !== 'numero' && cfg.tipo !== 'moeda' &&
        all.some(r => r.pctRealizado !== null && r.pctRealizado !== undefined && r.pctRealizado !== 0);

      if(chartType === 'yoy' && hasPercentage) {
        const byYearMonth = {};
        all.forEach(r => {
          if(!r.periodo) return;
          const [yr, mo] = r.periodo.split('-');
          if(!yr || !mo) return;
          if(!byYearMonth[yr]) byYearMonth[yr] = {};
          byYearMonth[yr][mo] = r.pctRealizado;
        });
        const years = Object.keys(byYearMonth).sort().slice(-3);
        const months = [...new Set(all.map(r => r.periodo?.slice(5,7)).filter(Boolean))].sort();
        const monthLabels = months.map(m => { const d=new Date(2000,parseInt(m)-1,1); return d.toLocaleString('pt-BR',{month:'short'}); });
        const palette = ['#1B3022','#00a86b','#e8a020'];
        chartCfg = {
          type: 'bar',
          data: {
            labels: monthLabels,
            datasets: years.map((yr, yi) => ({
              label: yr,
              data: months.map(m => byYearMonth[yr]?.[m] ?? null),
              backgroundColor: palette[yi] + 'cc',
              borderColor: palette[yi],
              borderWidth: 1.5,
              borderRadius: 4
            }))
          },
          options: {
            responsive: false,
            animation: false,
            plugins: { legend: { labels: { font: { size: 13 } } }, tooltip: { enabled: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%', font: { size: 12 } } }, x: { ticks: { font: { size: 12 } } } }
          }
        };
      } else if(hasPercentage) {
        // Evolução percentual
        const last18 = all.slice(-18);
        const labels = last18.map(r => _periodoLabel(r.periodo));
        const realizado = last18.map(r => r.pctRealizado);
        const pctIndice = last18.map(() => 100);
        chartCfg = {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: '% Realizado', data: realizado,
                backgroundColor: realizado.map(v => { if(v===null) return '#cbd5e1'; const cls=_pctClass(v,cfg); return cls==='pct-verde'?'rgba(22,163,74,.8)':cls==='pct-amarelo'?'rgba(234,179,8,.8)':'rgba(220,38,38,.8)'; }),
                borderRadius: 4, order: 2 },
              { label: '% Índice (meta)', data: pctIndice, type: 'line', borderColor: '#1B3022', backgroundColor: 'rgba(27,48,34,.08)', borderWidth: 2.5, pointRadius: 3, tension: .3, fill: false, order: 1 }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            plugins: { legend: { labels: { font: { size: 13 } } }, tooltip: { enabled: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => v + '%', font: { size: 12 } }, grid: { color: 'rgba(0,0,0,.05)' } }, x: { ticks: { font: { size: 10 }, maxRotation: 45 } } }
          }
        };
      } else {
        // Absoluto
        const last18 = all.slice(-18);
        const labels = last18.map(r => _periodoLabel(r.periodo));
        const realizadoAbs = last18.map(r => r.realizado !== undefined ? r.realizado : null);
        let metaAbs = last18.map(r => r.meta !== undefined ? r.meta : null);
        const hasMeta = metaAbs.some(m => m !== null && m !== undefined && m !== 0);
        let metaLabel = 'Meta';
        if(!hasMeta) {
          const last12 = all.slice(-12).filter(r => r.realizado !== null && r.realizado !== undefined && r.realizado !== 0);
          if(last12.length > 0) {
            const media12m = last12.reduce((s, r) => s + r.realizado, 0) / last12.length;
            metaAbs = last18.map(() => media12m);
            metaLabel = 'Meta (média 12m)';
          }
        }
        if(cfg.metaRef !== null) { metaAbs = last18.map(() => cfg.metaRef); metaLabel = 'Meta (configurada)'; }
        const bgColors = realizadoAbs.map((v, i) => {
          if(v === null) return '#cbd5e1';
          const m = metaAbs[i];
          if(m === null || m === 0) return 'rgba(27,48,34,.7)';
          const ratio = v / m * 100;
          const cls = _pctClass(ratio, cfg);
          return cls === 'pct-verde' ? 'rgba(22,163,74,.8)' : cls === 'pct-amarelo' ? 'rgba(234,179,8,.8)' : 'rgba(220,38,38,.8)';
        });
        chartCfg = {
          type: 'bar',
          data: {
            labels,
            datasets: [
              { label: 'Realizado', data: realizadoAbs, backgroundColor: bgColors, borderRadius: 4, order: 2 },
              { label: metaLabel, data: metaAbs, type: 'line', borderColor: '#1B3022', backgroundColor: 'rgba(27,48,34,.08)', borderWidth: 2.5, pointRadius: 3, tension: .3, fill: false, order: 1 }
            ]
          },
          options: {
            responsive: false,
            animation: false,
            plugins: { legend: { labels: { font: { size: 13 } } }, tooltip: { enabled: false } },
            scales: { y: { beginAtZero: true, ticks: { callback: v => _fmtNum(v), font: { size: 12 } }, grid: { color: 'rgba(0,0,0,.05)' } }, x: { ticks: { font: { size: 10 }, maxRotation: 45 } } }
          }
        };
      }

      const chart = new Chart(canvas, chartCfg);

      // Chart.js animation is off, but give a tick for rendering
      setTimeout(() => {
        const dataUrl = canvas.toDataURL('image/png');
        chart.destroy();
        document.body.removeChild(canvas);
        resolve(dataUrl);
      }, 100);
    });
  }

  // ─── Gerar Relatório PPT com análise IA ───────────────────────────
  window.indcageGerarRelatorioPpt = async function() {
    if(typeof PptxGenJS === 'undefined') {
      showToast('Biblioteca PptxGenJS não carregada. Verifique a conexão e recarregue a página.', 'warn');
      return;
    }

    const checkboxes = document.querySelectorAll('.rel-ind-check:checked');
    if(checkboxes.length === 0) {
      showToast('Selecione pelo menos um indicador para gerar o relatório.', 'warn');
      return;
    }

    const trimestre = document.getElementById('rel-trimestre')?.value || '1';
    const ano = document.getElementById('rel-ano')?.value || '2026';
    const subtitulo = document.getElementById('rel-subtitulo')?.value.trim() || 'CAGE-RS — Controladoria-Geral do Estado do Rio Grande do Sul';
    const usarIA = document.getElementById('rel-usar-ia')?.checked !== false;
    const trimestreNomes = ['1º','2º','3º','4º'];
    const trimestreLabel = trimestreNomes[parseInt(trimestre)-1] + ' Trimestre ' + ano;
    const titulo = 'Relatório de Monitoramento de Indicadores';
    const hoje = new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });

    const btn = document.getElementById('rel-generate-btn');
    if(btn) { btn.disabled = true; btn.textContent = '⏳ Gerando…'; }

    try {
      const selectedCodigos = Array.from(checkboxes).map(cb => cb.value).filter(Boolean);
      const allInds = getAllIndicators();
      const resultados = DATA.indicadoresCage.resultados || [];

      const pres = new PptxGenJS();
      pres.layout = 'LAYOUT_16x9';
      pres.title  = titulo + ' — ' + trimestreLabel;
      pres.author = 'SIGA — CAGE-RS';

      const cageLogoB64 = await _loadCageLogoB64();

      const C = { navy:'0A2540', navyFull:'#0A2540', green:'00A86B', gold:'E8A020', white:'FFFFFF', light:'F4F7FB', muted:'8898AA', blue:'1E40AF' };

      // helper: cabeçalho azul padrão
      const addHdr = (slide, title, sub) => {
        slide.addShape(pres.ShapeType.rect, { x:0, y:0, w:10, h:0.75, fill:{ color:C.navy } });
        slide.addShape(pres.ShapeType.rect, { x:0, y:0.75, w:10, h:0.05, fill:{ color:C.green } });
        slide.addText(title, { x:0.35, y:0, w:7.5, h:0.75, fontSize:15, color:C.white, bold:true, valign:'middle' });
        if(sub) slide.addText(sub, { x:0, y:0, w:9.7, h:0.75, fontSize:10, color:'8CB8FF', align:'right', valign:'middle' });
      };

      // ── Slide de capa ──────────────────────────────────────────────
      const capa = pres.addSlide();
      capa.addShape(pres.ShapeType.rect, { x:0, y:0, w:10, h:7.5, fill:{ color:C.navy } });
      capa.addShape(pres.ShapeType.rect, { x:0, y:5.6, w:10, h:0.12, fill:{ color:C.gold } });
      capa.addShape(pres.ShapeType.rect, { x:0, y:5.72, w:10, h:0.1, fill:{ color:C.green } });
      capa.addText(titulo, { x:0.8, y:1.5, w:8.4, fontSize:30, color:C.white, bold:true, align:'center' });
      capa.addText(trimestreLabel, { x:0.8, y:2.55, w:8.4, fontSize:20, color:C.gold, bold:true, align:'center' });
      capa.addText(subtitulo, { x:0.8, y:3.3, w:8.4, fontSize:13, color:'8CB8FF', align:'center' });
      capa.addText(`Gerado em ${hoje}  ·  ${selectedCodigos.length} indicador(es)`, { x:0.8, y:4.1, w:8.4, fontSize:11, color:C.muted, align:'center', italic:true });
      _cageLogoAdd(capa, { x:8.1, y:4.95, w:1.65, h:0.5, sizing:{ type:'contain', w:1.65, h:0.5 } });

      // ── Slide por indicador ────────────────────────────────────────
      for(let idx = 0; idx < selectedCodigos.length; idx++) {
        const codigo = selectedCodigos[idx];
        const ind = allInds.find(i => i.codigo === codigo);
        const cfg = _getOverride(codigo);
        const resDoInd = resultados
          .filter(r => r.codigo === codigo)
          .sort((a,b) => (a.periodo||'').localeCompare(b.periodo||''));
        const resDesc = resultados
          .filter(r => r.codigo === codigo)
          .sort((a,b) => (b.periodo||'').localeCompare(a.periodo||''));

        const tituloInd = [codigo, ind?.enunciado].filter(Boolean).join(' — ');
        showToast(`Processando ${idx+1}/${selectedCodigos.length}: ${codigo}…`, 'info');

        // ── Slide: Ficha do indicador + gráfico ─────────────────────
        const sInd = pres.addSlide();
        addHdr(sInd, tituloInd, `${idx+1} / ${selectedCodigos.length}`);

        // Ficha de metadados (lado esquerdo)
        const fichaRows = [
          ['Código', codigo || '—'],
          ['Divisão', ind?.divisao || '—'],
          ['Responsável', ind?.responsavel || '—'],
          ['Periodicidade', ind?.periodicidade || '—'],
          ['Meta', ind?.meta ? String(ind.meta) : '—'],
          ['Unidade', cfg?.unidade || '—'],
        ];
        const rowH = 0.36;
        const fichaY = 0.95;
        const fichaW = 3.5;
        fichaRows.forEach(([lbl, val], ri) => {
          const ry = fichaY + ri * rowH;
          sInd.addShape(pres.ShapeType.rect, { x:0.2, y:ry, w:fichaW, h:rowH, fill:{ color: ri%2===0?'EFF6FF':'FFFFFF' }, line:{ color:'D1D9F0', pt:0.5 } });
          sInd.addText(lbl, { x:0.25, y:ry, w:1.1, h:rowH, fontSize:9, bold:true, color:C.blue, valign:'middle' });
          sInd.addText(val, { x:1.4, y:ry, w:fichaW-1.25, h:rowH, fontSize:9, color:'1E293B', valign:'middle', wrap:true });
        });

        // Gráfico de evolução (lado direito)
        const imgB64 = await _chartToBase64(codigo, 'evo');
        if(imgB64) {
          sInd.addImage({ data: imgB64, x:3.85, y:0.9, w:5.95, h:3.1 });
          sInd.addText('Evolução dos Resultados', { x:3.85, y:4.0, w:5.95, h:0.28, fontSize:9, italic:true, color:C.muted, align:'center' });
        } else {
          sInd.addText('Sem dados de resultados disponíveis para este indicador.', { x:3.85, y:2.5, w:5.95, h:1, fontSize:11, color:C.muted, align:'center', valign:'middle', italic:true });
        }

        // Tabela de últimos resultados (linha inferior)
        if(resDesc.length > 0) {
          const last6 = resDesc.slice(0, 6).reverse();
          const unidade = cfg?.unidade || '';
          const tblY = 4.35;
          const colW = [1.5, 1.2, 1.2, 1.1, 4.8];
          const hdrs = ['Período','Realizado','Meta','% Realiz.','Análise'];
          let cx = 0.2;
          hdrs.forEach((h, ci) => {
            sInd.addShape(pres.ShapeType.rect, { x:cx, y:tblY, w:colW[ci], h:0.3, fill:{ color:C.navy } });
            sInd.addText(h, { x:cx+0.03, y:tblY, w:colW[ci]-0.06, h:0.3, fontSize:8.5, bold:true, color:C.white, valign:'middle', align: ci>0&&ci<4?'center':'left' });
            cx += colW[ci];
          });
          last6.forEach((r, ri) => {
            const ry = tblY + 0.3 + ri * 0.28;
            const bg = ri%2===0 ? 'F8FAFC' : 'FFFFFF';
            cx = 0.2;
            const cells = [
              _periodoLabel(r.periodo),
              r.realizado !== null && r.realizado !== undefined ? _fmtNum(r.realizado)+(unidade?' '+unidade:'') : '—',
              r.meta !== null && r.meta !== undefined ? _fmtNum(r.meta)+(unidade?' '+unidade:'') : '—',
              r.pctRealizado !== null && r.pctRealizado !== undefined ? _fmtNum(r.pctRealizado)+'%' : '—',
              r.analise || '—',
            ];
            cells.forEach((cell, ci) => {
              sInd.addShape(pres.ShapeType.rect, { x:cx, y:ry, w:colW[ci], h:0.28, fill:{ color:bg }, line:{ color:'E2E8F0', pt:0.5 } });
              sInd.addText(cell, { x:cx+0.03, y:ry, w:colW[ci]-0.06, h:0.28, fontSize:8, color:'1E293B', valign:'middle', align: ci>0&&ci<4?'center':'left', wrap:false });
              cx += colW[ci];
            });
          });
        }

        // ── Slide: Gráfico YoY (se aplicável) ───────────────────────
        const hasPercentage = cfg.tipo !== 'numero' && cfg.tipo !== 'moeda' &&
          resDoInd.some(r => r.pctRealizado !== null && r.pctRealizado !== undefined && r.pctRealizado !== 0);
        if(hasPercentage && resDoInd.length > 0) {
          const imgYoy = await _chartToBase64(codigo, 'yoy');
          if(imgYoy) {
            const sYoy = pres.addSlide();
            addHdr(sYoy, tituloInd + ' — Comparativo Anual (YoY)', `${idx+1} / ${selectedCodigos.length}`);
            sYoy.addImage({ data: imgYoy, x:1.5, y:0.95, w:7, h:5.5 });
          }
        }

        // ── Slide: Análise IA da variação temporal ───────────────────
        if(usarIA && resDoInd.length > 0) {
          showToast(`Analisando variação de ${codigo} com IA…`, 'info');

          // Monta série temporal para o prompt
          const serieTexto = resDoInd.slice(-18).map(r =>
            `${_periodoLabel(r.periodo)}: realizado=${r.realizado !== null && r.realizado !== undefined ? _fmtNum(r.realizado) : '?'}${cfg?.unidade?' '+cfg.unidade:''}, meta=${r.meta !== null && r.meta !== undefined ? _fmtNum(r.meta) : '?'}, %realizado=${r.pctRealizado !== null && r.pctRealizado !== undefined ? _fmtNum(r.pctRealizado)+'%' : '?'}, análise="${r.analise||''}"`)
            .join('\n');

          const promptIA = `Você é um analista de indicadores de desempenho do setor público. Analise a variação temporal dos resultados do indicador abaixo e produza um texto conciso (4 a 6 frases) em português, apontando: (1) a tendência geral (melhora, piora, estabilidade); (2) os meses/períodos de melhor e pior desempenho; (3) se o indicador está atingindo a meta na maioria dos períodos; (4) alguma observação relevante sobre sazonalidade ou mudanças bruscas. Seja objetivo, claro e técnico.

Indicador: ${ind?.enunciado || codigo}
Código: ${codigo}
Divisão: ${ind?.divisao || '—'}
Meta: ${ind?.meta || '—'}
Periodicidade: ${ind?.periodicidade || '—'}

Série histórica (últimos 18 períodos):
${serieTexto}

Responda apenas com o texto da análise, sem listas, sem títulos, sem markdown.`;

          let textoIA = '(Análise IA indisponível)';
          try {
            textoIA = await callGemini(promptIA);
            textoIA = textoIA.trim();
          } catch(e) {
            /* tratamento de erro */
            textoIA = 'Não foi possível obter análise da IA para este indicador.';
          }

          const sIA = pres.addSlide();
          addHdr(sIA, tituloInd + ' — Análise de Variação Temporal', `🤖 Análise IA · ${idx+1} / ${selectedCodigos.length}`);
          sIA.addShape(pres.ShapeType.rect, { x:0.4, y:0.95, w:9.2, h:5.8, fill:{ color:'F0F7FF' }, line:{ color:'C7D7F5', pt:1 }, rectRadius:0.12 });
          sIA.addText('🤖  Análise de Variação Temporal — Inteligência Artificial', { x:0.55, y:1.1, w:8.9, h:0.4, fontSize:12, bold:true, color:C.blue });
          sIA.addText(textoIA, { x:0.55, y:1.6, w:8.9, h:4.8, fontSize:12, color:'1E293B', valign:'top', wrap:true });
        }
      }

      // ── Slide final ───────────────────────────────────────────────
      const sFinal = pres.addSlide();
      sFinal.addShape(pres.ShapeType.rect, { x:0, y:0, w:10, h:7.5, fill:{ color:C.navy } });
      sFinal.addShape(pres.ShapeType.rect, { x:0, y:3.5, w:10, h:0.1, fill:{ color:C.gold } });
      sFinal.addText('Relatório gerado automaticamente pelo SIGA', { x:0.8, y:3.7, w:8.4, fontSize:14, color:C.white, align:'center' });
      sFinal.addText(subtitulo, { x:0.8, y:4.35, w:8.4, fontSize:11, color:'8CB8FF', align:'center', italic:true });
      sFinal.addText(hoje, { x:0.8, y:4.85, w:8.4, fontSize:10, color:C.muted, align:'center', italic:true });
      _cageLogoAdd(sFinal, { x:8.1, y:4.95, w:1.65, h:0.5, sizing:{ type:'contain', w:1.65, h:0.5 } });

      // ── Download ──────────────────────────────────────────────────
      const fileName = `Relatorio_Monitoramento_${trimestreLabel.replace(/\s+/g,'_')}.pptx`;
      await pres.writeFile({ fileName });
      showToast('Relatório PPT gerado com sucesso! 📊', 'success');

    } catch(err) {
      /* notifica o usuario do erro */
      showToast('Erro ao gerar relatório: ' + (err.message || err), 'warn');
    } finally {
      if(btn) { btn.disabled = false; btn.textContent = '📊 Gerar Relatório PPT'; }
    }
  };

})(); // end Indicadores CAGE IIFE

// ═══════════════════════════════════════════════════════════════════
// MÓDULO: COMPETÊNCIAS NECESSÁRIAS
// ═══════════════════════════════════════════════════════════════════

const COMP_CATS = [
  { key:'hard',      label:'🛠 Hard Skills',             configKey:'hardSkills',           desc:'Habilidades técnicas e ferramentas necessárias para executar o processo.' },
  { key:'soft',      label:'💬 Soft Skills',             configKey:'softSkills',           desc:'Habilidades comportamentais e interpessoais necessárias.' },
  { key:'normativo', label:'📜 Conhecimentos Normativos', configKey:'conhecimentosNormativos', desc:'Legislação, normas e regulamentações que o executor precisa conhecer.' },
];

function compGetData(p) {
  if(!DATA[p]) return { hard:[], soft:[], normativo:[] };
  if(!DATA[p].competencias) DATA[p].competencias = { hard:[], soft:[], normativo:[] };
  // Garantir que as três categorias existam
  COMP_CATS.forEach(c => { if(!Array.isArray(DATA[p].competencias[c.key])) DATA[p].competencias[c.key] = []; });
  return DATA[p].competencias;
}

function compToggle(p, cat, val) {
  const comp = compGetData(p);
  const idx = comp[cat].indexOf(val);
  if(idx >= 0) comp[cat].splice(idx, 1);
  else          comp[cat].push(val);
  markChanged(true, true);
  compRender(p);
}

function compAddCustom(p, cat) {
  const inp = document.getElementById(`comp-custom-${p}-${cat}`);
  if(!inp) return;
  const val = inp.value.trim();
  if(!val) return;
  const comp = compGetData(p);
  if(comp[cat].some(v => v.toLowerCase() === val.toLowerCase())) {
    showToast('Competência já adicionada.','warn'); return;
  }
  comp[cat].push(val);
  inp.value = '';
  markChanged(true, true);
  compRender(p);
}

function compRemove(p, cat, idx) {
  const comp = compGetData(p);
  comp[cat].splice(idx, 1);
  markChanged(true, true);
  compRender(p);
}

function compRender(p) {
  const container = document.getElementById(p + '-competencias-body');
  if(!container) return;

  const comp      = compGetData(p);
  const procName  = p === 'd' ? 'Denúncias' : 'Representações';
  const em        = isEditor;

  const catHtml = COMP_CATS.map(cat => {
    const suggestions = getConfig(cat.configKey);
    const selected    = comp[cat.key] || [];

    // Tags de sugestões
    const tagsHtml = suggestions.map(sug => {
      const on = selected.includes(sug);
      return `<button onclick="compToggle('${p}','${cat.key}',${JSON.stringify(sug)})"
        style="padding:5px 12px;border-radius:20px;font-size:12px;cursor:pointer;border:1.5px solid ${on?'#6366f1':'#e2e8f0'};
               background:${on?'#6366f1':'#f8fafc'};color:${on?'#fff':'#475569'};font-weight:${on?'700':'400'};
               margin:3px;transition:all .15s;">${on?'✓ ':''} ${sug}</button>`;
    }).join('');

    // Lista de competências selecionadas (inclui customizadas)
    const selectedHtml = selected.length
      ? selected.map((v, i) => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f0f4ff;border-radius:7px;margin-bottom:4px;">
            <span style="flex:1;font-size:13px;color:#1e293b;">${v}</span>
            ${em ? `<button onclick="compRemove('${p}','${cat.key}',${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;" title="Remover">✕</button>` : ''}
          </div>`).join('')
      : '<div style="color:#94a3b8;font-size:12px;padding:6px 0;">Nenhuma competência selecionada.</div>';

    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin-bottom:16px;">
        <div style="font-size:15px;font-weight:800;color:#1B3022;margin-bottom:3px;">${cat.label}</div>
        <div style="font-size:12px;color:#94a3b8;margin-bottom:14px;">${cat.desc}</div>

        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Sugestões — clique para selecionar</div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:16px;padding:10px;background:#f8fafc;border-radius:8px;">
          ${tagsHtml || '<span style="color:#94a3b8;font-size:12px;">Nenhuma sugestão cadastrada.</span>'}
        </div>

        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">Competências selecionadas</div>
        <div style="margin-bottom:${em?'12px':'0'};">${selectedHtml}</div>

        ${em ? `
        <div style="display:flex;gap:8px;">
          <input id="comp-custom-${p}-${cat.key}" class="modal-input" type="text"
            placeholder="Adicionar competência não listada..."
            style="flex:1;font-size:13px;"
            onkeydown="if(event.key==='Enter') compAddCustom('${p}','${cat.key}')">
          <button onclick="compAddCustom('${p}','${cat.key}')" class="btn btn-primary" style="font-size:12px;padding:6px 14px;">＋</button>
        </div>` : ''}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin-bottom:16px;">
      🎓 Competências Necessárias — <span style="color:#6366f1;">${procName}</span>
    </div>
    <div style="font-size:13px;color:#64748b;margin-bottom:20px;padding:12px 14px;background:#f8fafc;border-radius:8px;border-left:3px solid #6366f1;">
      Selecione as competências exigidas dos executores deste processo. As sugestões vêm das listas configuradas no módulo de Gestão do Sistema.
    </div>
    ${catHtml}`;
}

// ═══════════════════════════════════════════════════════════════════
// COMPETÊNCIAS NA ARQUITETURA DE PROCESSOS
// ═══════════════════════════════════════════════════════════════════

function arqCompGetData(idx) {
  const data = arqGetData();
  if(!data[idx]) return { hard:[], soft:[], normativo:[] };
  if(!data[idx].competencias) data[idx].competencias = { hard:[], soft:[], normativo:[] };
  COMP_CATS.forEach(c => { if(!Array.isArray(data[idx].competencias[c.key])) data[idx].competencias[c.key] = []; });
  return data[idx].competencias;
}

function _arqCompPersist() {
  // Sincroniza _arqData (in-memory) → DATA._arqOverrides e salva na nuvem imediatamente.
  // Não usa markChanged() pois editMode bloqueia o auto-save e perderia as alterações.
  DATA._arqOverrides = arqGetData();
  arqSaveToCloud();
}

function arqCompToggle(idx, cat, val) {
  const comp = arqCompGetData(idx);
  const i = comp[cat].indexOf(val);
  if(i >= 0) comp[cat].splice(i, 1);
  else comp[cat].push(val);
  _arqCompPersist();
  arqCompRenderSection(idx);
}

function arqCompAddCustom(idx, cat) {
  const inp = document.getElementById(`arq-comp-custom-${idx}-${cat}`);
  if(!inp) return;
  const val = inp.value.trim();
  if(!val) return;
  const comp = arqCompGetData(idx);
  if(comp[cat].some(v => v.toLowerCase() === val.toLowerCase())) { showToast('Competência já adicionada.','warn'); return; }
  comp[cat].push(val);
  inp.value = '';
  _arqCompPersist();
  arqCompRenderSection(idx);
}

function arqCompRemove(idx, cat, ci) {
  const comp = arqCompGetData(idx);
  comp[cat].splice(ci, 1);
  _arqCompPersist();
  arqCompRenderSection(idx);
}

function arqCompRenderSection(idx) {
  const container = document.getElementById('arq-comp-section');
  if(!container) return;
  const comp = arqCompGetData(idx);
  const em = isEditor;

  const catHtml = COMP_CATS.map(cat => {
    const suggestions = getConfig(cat.configKey);
    const selected    = comp[cat.key] || [];

    const tagsHtml = suggestions.map(sug => {
      const on = selected.includes(sug);
      return `<button onclick="arqCompToggle(${idx},'${cat.key}',${JSON.stringify(sug)})"
        style="padding:5px 12px;border-radius:20px;font-size:12px;cursor:pointer;border:1.5px solid ${on?'#6366f1':'#e2e8f0'};
               background:${on?'#6366f1':'#f8fafc'};color:${on?'#fff':'#475569'};font-weight:${on?'700':'400'};
               margin:3px;transition:all .15s;">${on?'✓ ':''} ${sug}</button>`;
    }).join('');

    const selectedHtml = selected.length
      ? selected.map((v, i) => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:#f0f4ff;border-radius:7px;margin-bottom:4px;">
            <span style="flex:1;font-size:13px;color:#1e293b;">${v}</span>
            ${em ? `<button onclick="arqCompRemove(${idx},'${cat.key}',${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:14px;line-height:1;padding:0 2px;" title="Remover">✕</button>` : ''}
          </div>`).join('')
      : '<div style="color:#94a3b8;font-size:12px;padding:6px 0;">Nenhuma competência selecionada.</div>';

    return `
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:12px;">
        <div style="font-size:13px;font-weight:800;color:#1B3022;margin-bottom:2px;">${cat.label}</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:12px;">${cat.desc}</div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Sugestões</div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:12px;padding:8px;background:#f8fafc;border-radius:8px;">
          ${tagsHtml || '<span style="color:#94a3b8;font-size:12px;">Nenhuma sugestão cadastrada nas configurações.</span>'}
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Selecionadas</div>
        <div style="margin-bottom:${em?'10px':'0'};">${selectedHtml}</div>
        ${em ? `
        <div style="display:flex;gap:8px;">
          <input id="arq-comp-custom-${idx}-${cat.key}" class="modal-input" type="text"
            placeholder="Adicionar competência não listada..."
            style="flex:1;font-size:12px;"
            onkeydown="if(event.key==='Enter') arqCompAddCustom(${idx},'${cat.key}')">
          <button onclick="arqCompAddCustom(${idx},'${cat.key}')" class="btn btn-primary" style="font-size:12px;padding:5px 12px;">＋</button>
        </div>` : ''}
      </div>`;
  }).join('');

  container.innerHTML = `
    <div style="font-size:12px;color:#64748b;margin-bottom:14px;padding:10px 12px;background:#f8fafc;border-radius:8px;border-left:3px solid #6366f1;">
      Selecione as competências exigidas dos executores deste processo. As sugestões vêm das listas em Gestão do Sistema.
    </div>
    ${catHtml}`;
}

// ═══════════════════════════════════════════════════════════════════
// MÓDULO: MATURIDADE DE PROCESSOS
// ═══════════════════════════════════════════════════════════════════

const MAT_QUESTIONS = [
  { text: 'Mesmo com o fluxo definido, você ainda precisa tirar dúvidas para executar o processo?', inverted: false },
  { text: 'Existem situações em que você não sabe qual decisão tomar?', inverted: false },
  { text: 'O processo funciona bem quando surgem casos fora do padrão?', inverted: true },
  { text: 'Existem muitas exceções que não estão representadas no fluxo?', inverted: false },
  { text: 'Você precisa refazer atividades com frequência?', inverted: false },
  { text: 'Problemas em etapas anteriores impactam seu trabalho?', inverted: false },
  { text: 'As informações que você recebe chegam completas para executar sua etapa?', inverted: true },
  { text: 'Você precisa buscar dados adicionais fora do processo?', inverted: false },
  { text: 'O processo depende de conhecimento informal (não documentado)?', inverted: false },
  { text: 'Existem diferenças relevantes entre o processo desenhado e o que acontece na prática?', inverted: false },
];

const MAT_QUESTIONNAIRE_COUNT = 3;

function matCreateEmptyAnswers() {
  return new Array(MAT_QUESTIONS.length).fill(null);
}

function matNormalizeAnswersArray(arr) {
  const base = matCreateEmptyAnswers();
  if(!Array.isArray(arr)) return base;
  return base.map((_, idx) => {
    const v = arr[idx];
    return (v === 'sim' || v === 'talvez' || v === 'nao') ? v : null;
  });
}

function matNormalizeQuestionnaires(mat) {
  if(!mat || typeof mat !== 'object') {
    return Array.from({ length: MAT_QUESTIONNAIRE_COUNT }, () => matCreateEmptyAnswers());
  }

  let questionnaires = null;
  if(Array.isArray(mat.questionnaires) && mat.questionnaires.length === MAT_QUESTIONNAIRE_COUNT) {
    questionnaires = mat.questionnaires.map(q => matNormalizeAnswersArray(q));
  } else {
    questionnaires = Array.from({ length: MAT_QUESTIONNAIRE_COUNT }, () => matCreateEmptyAnswers());
    if(Array.isArray(mat.answers)) {
      // Migração legado: preserva o questionário único como Questionário 1.
      questionnaires[0] = matNormalizeAnswersArray(mat.answers);
    }
  }

  mat.questionnaires = questionnaires;
  // Compatibilidade com estruturas antigas que ainda leem mat.answers.
  mat.answers = questionnaires[0].slice();
  return questionnaires;
}

function matAnsweredCount(questionnaires) {
  return (questionnaires || []).reduce((acc, q) => {
    if(!Array.isArray(q)) return acc;
    return acc + q.filter(a => a !== null).length;
  }, 0);
}

function matTotalAnswersRequired() {
  return MAT_QUESTIONNAIRE_COUNT * MAT_QUESTIONS.length;
}

function matGetData(p) {
  if(!DATA[p]) {
    const fallback = {
      questionnaires: Array.from({ length: MAT_QUESTIONNAIRE_COUNT }, () => matCreateEmptyAnswers()),
      answers: matCreateEmptyAnswers(),
      indispensaveis: 0,
      sistIndispensaveis: 0,
      version: 'asis',
      geminiAnalysis: '',
      lastAnalysis: ''
    };
    matNormalizeQuestionnaires(fallback);
    return fallback;
  }
  if(!DATA[p].maturity) {
    DATA[p].maturity = {
      questionnaires: Array.from({ length: MAT_QUESTIONNAIRE_COUNT }, () => matCreateEmptyAnswers()),
      answers: matCreateEmptyAnswers(),
      indispensaveis: 0,
      sistIndispensaveis: 0,
      version: 'asis',
      geminiAnalysis: '',
      lastAnalysis: ''
    };
  }
  if(DATA[p].maturity.sistIndispensaveis === undefined) DATA[p].maturity.sistIndispensaveis = 0;
  if(!DATA[p].maturity.version) DATA[p].maturity.version = 'asis';
  matNormalizeQuestionnaires(DATA[p].maturity);
  return DATA[p].maturity;
}

function matSetVersion(p, v) {
  const mat = matGetData(p);
  mat.version = v;
  markChanged(true, true);
  matRender(p);
}

function matAuditDetails(p, version) {
  const steps = (DATA[p] && DATA[p].steps) || [];
  const APPROVAL_KW = ['aprovação','aprovacao','revisão','revisao','autorização','autorizacao','validação','validacao'];
  const audit = { activities:[], decisions:[], approvals:[], loops:[], handoffs:[], digitalized:[], startEvents:[], endEvents:[], actors:new Set() };

  let prevActor = '';
  steps.forEach((step, si) => {
    const actions  = version === 'tobe' ? ((step.tobe && step.tobe.actions) || []) : (step.actions || []);
    const stepName = step.title || `Etapa ${si+1}`;
    if(step.responsible) audit.actors.add(step.responsible);
    const seenHandoffs = new Set();

    actions.forEach((action, ai) => {
      const type    = action.type || 'atividade';
      const nat     = action.natureza || '';
      const actor   = action.actor || step.responsible || '';
      const textLow = (action.text || '').toLowerCase();
      const txt     = action.text || `Ação ${ai+1}`;
      const hasBranches = type === 'decisao' && Array.isArray(action.branches) && action.branches.length > 0;

      if(type === 'atividade') audit.activities.push({ step: stepName, text: txt });
      if(type === 'decisao')   audit.decisions.push({ step: stepName, text: txt });
      if(type === 'evento') {
        const etipo = action.eventoTipo || '';
        if(etipo === 'inicio')        audit.startEvents.push({ step: stepName, text: txt });
        else if(etipo === 'encerramento') audit.endEvents.push({ step: stepName, text: txt });
      }

      // Overhead: aprovacao/revisao por natureza ou palavra-chave; controle por natureza
      // (espelha exatamente matComputeMetrics — controle é overhead separado no Lean)
      if(!hasBranches) {
        const isBurocByNat = (nat === 'aprovacao' || nat === 'revisao');
        const isBurocByKw  = !nat && APPROVAL_KW.some(k => textLow.includes(k));
        const isControle   = nat === 'controle';
        if(isBurocByNat || isBurocByKw)
          audit.approvals.push({ step: stepName, text: txt, via: isBurocByNat ? `nat: ${nat}` : 'palavra-chave' });
        else if(isControle)
          audit.approvals.push({ step: stepName, text: txt, via: 'nat: controle' });
      }

      if(type === 'atividade' && action.loop)
        audit.loops.push({ step: stepName, text: txt });

      if(type === 'atividade') {
        if(actor && prevActor && actor.toLowerCase() !== prevActor.toLowerCase()) {
          const key = `${prevActor.toLowerCase()}→${actor.toLowerCase()}`;
          if(!seenHandoffs.has(key)) { seenHandoffs.add(key); audit.handoffs.push({ step: stepName, from: prevActor, to: actor }); }
        }
        if(actor) { prevActor = actor; audit.actors.add(actor); }
        // Digitalização: tem sistema registrado OU está marcada como automática (⚙️)
        if(action.automatico || (action.sistemas && action.sistemas.trim()))
          audit.digitalized.push({ step: stepName, text: txt, sistemas: action.sistemas || '⚙️ automático' });
      }

      // Processar caminhos de decisão (espelha matComputeMetrics)
      if(hasBranches) {
        let decisionHasApproval = false;
        action.branches.forEach(branch => {
          (branch.actions || []).forEach((ba, bai) => {
            const baType    = ba.type || 'atividade';
            const baNat     = ba.natureza || '';
            const baTextLow = (ba.text || '').toLowerCase();
            const baActor   = ba.actor || '';
            const baTxt     = ba.text || `Sub-ação ${bai+1}`;

            if(baType === 'atividade') audit.activities.push({ step: stepName, text: baTxt });
            if(baType === 'decisao')   audit.decisions.push({ step: stepName, text: baTxt });
            if(baType === 'evento') {
              const baEtipo = ba.eventoTipo || '';
              if(baEtipo === 'inicio')        audit.startEvents.push({ step: stepName, text: baTxt });
              else if(baEtipo === 'encerramento') audit.endEvents.push({ step: stepName, text: baTxt });
            }
            // Decisão aninhada (nível 3): processar sub-ramos
            if(baType === 'decisao' && Array.isArray(ba.branches)) {
              ba.branches.forEach(nbranch => {
                (nbranch.actions || []).forEach(nba => {
                  const nbaType = nba.type || 'atividade';
                  const nbaTxt  = nba.text || '';
                  if(nbaType === 'atividade') audit.activities.push({ step: stepName, text: nbaTxt });
                  if(nbaType === 'decisao')   audit.decisions.push({ step: stepName, text: nbaTxt });
                  if(nbaType === 'evento') {
                    const nbaEtipo = nba.eventoTipo || '';
                    if(nbaEtipo === 'inicio')        audit.startEvents.push({ step: stepName, text: nbaTxt });
                    else if(nbaEtipo === 'encerramento') audit.endEvents.push({ step: stepName, text: nbaTxt });
                  }
                  if(nbaType === 'atividade' && nba.loop) audit.loops.push({ step: stepName, text: nbaTxt });
                  if(nbaType === 'atividade') {
                    const nbaActor = nba.actor || '';
                    if(nbaActor && prevActor && nbaActor.toLowerCase() !== prevActor.toLowerCase()) {
                      const key = `${prevActor.toLowerCase()}→${nbaActor.toLowerCase()}`;
                      if(!seenHandoffs.has(key)) { seenHandoffs.add(key); audit.handoffs.push({ step: stepName, from: prevActor, to: nbaActor }); }
                    }
                    if(nbaActor) { prevActor = nbaActor; audit.actors.add(nbaActor); }
                    if(nba.automatico || (nba.sistemas && nba.sistemas.trim()))
                      audit.digitalized.push({ step: stepName, text: nbaTxt, sistemas: nba.sistemas || '⚙️ automático' });
                  }
                });
              });
            }

            const baBurocByNat = (baNat === 'aprovacao' || baNat === 'revisao');
            const baBurocByKw  = !baNat && APPROVAL_KW.some(k => baTextLow.includes(k));
            if(baBurocByNat || baBurocByKw) decisionHasApproval = true;

            if(baType === 'atividade' && ba.loop)
              audit.loops.push({ step: stepName, text: baTxt });

            if(baType === 'atividade') {
              if(baActor && prevActor && baActor.toLowerCase() !== prevActor.toLowerCase()) {
                const key = `${prevActor.toLowerCase()}→${baActor.toLowerCase()}`;
                if(!seenHandoffs.has(key)) { seenHandoffs.add(key); audit.handoffs.push({ step: stepName, from: prevActor, to: baActor }); }
              }
              if(baActor) { prevActor = baActor; audit.actors.add(baActor); }
              if(ba.automatico || (ba.sistemas && ba.sistemas.trim()))
                audit.digitalized.push({ step: stepName, text: baTxt, sistemas: ba.sistemas || '⚙️ automático' });
            }
          });
        });
        // Conta 1 aprovação por decisão que tiver caminhos com aprovação (igual matComputeMetrics)
        if(decisionHasApproval)
          audit.approvals.push({ step: stepName, text: txt, via: 'decisão c/ caminho de aprovação' });
      }
    });
  });
  return audit;
}

function matShowAudit(p) {
  const mat     = matGetData(p);
  const version = mat.version || 'asis';
  const audit   = matAuditDetails(p, version);

  const row = (text, tag) =>
    `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 10px;background:#f8fafc;border-radius:6px;font-size:12px;">
       <span style="color:#6366f1;font-size:10px;white-space:nowrap;padding-top:1px;min-width:80px;max-width:140px;overflow:hidden;text-overflow:ellipsis;">${tag}</span>
       <span style="color:#1e293b;">${text}</span>
     </div>`;

  const section = (icon, label, items, fn) => {
    const count = items.length;
    const body  = count
      ? `<div style="display:flex;flex-direction:column;gap:3px;">${items.map(fn).join('')}</div>`
      : `<div style="font-size:12px;color:#94a3b8;padding:5px 10px;background:#f8fafc;border-radius:6px;">Nenhum item encontrado.</div>`;
    return `<div style="margin-bottom:16px;">
      <div style="font-weight:700;color:#1B3022;font-size:13px;margin-bottom:6px;">${icon} ${label}
        <span style="color:#6366f1;font-weight:400;font-size:12px;">(${count})</span>
      </div>${body}</div>`;
  };

  const actorsList = [...audit.actors].map(a => ({ text: a }));
  const html = `
    ${section('▶','Atividades',              audit.activities,  i => row(i.text, i.step))}
    ${section('◆','Decisões',               audit.decisions,   i => row(i.text, i.step))}
    ${section('⬤','Eventos de Início',      audit.startEvents, i => row(i.text, i.step))}
    ${section('◉','Eventos de Encerramento',audit.endEvents,   i => row(i.text, i.step))}
    ${section('🔄','Loops',                 audit.loops,       i => row(i.text, i.step))}
    ${section('🔀','Handoffs',              audit.handoffs,    i => row(`${i.from} → ${i.to}`, i.step))}
    ${section('✅','Aprovações/Burocracia', audit.approvals,   i => row(i.text + ` <span style="color:#94a3b8;">(via ${i.via})</span>`, i.step))}
    ${section('⚡','Ações Digitalizadas',   audit.digitalized, i => row(i.text + ` <span style="color:#94a3b8;">[${i.sistemas}]</span>`, i.step))}
    ${section('👤','Atores',               actorsList,        i => row(i.text, 'ator'))}`;

  let modal = document.getElementById('mat-audit-modal');
  if(!modal) { modal = document.createElement('div'); modal.id = 'mat-audit-modal'; document.body.appendChild(modal); }
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto;';
  modal.onclick = e => { if(e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div style="background:white;border-radius:14px;width:100%;max-width:660px;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
        <div>
          <div style="font-weight:800;font-size:15px;color:#1B3022;">🔍 Auditoria das Métricas</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:1px;">Veja exatamente quais ações geraram cada número — ${version === 'tobe' ? 'Fluxo TO BE' : 'Fluxo AS IS'}</div>
        </div>
        <button onclick="document.getElementById('mat-audit-modal').remove()" style="background:none;border:none;font-size:18px;cursor:pointer;color:#94a3b8;padding:4px 8px;">✕</button>
      </div>
      <div style="padding:20px;overflow-y:auto;max-height:72vh;">${html}</div>
    </div>`;
}

function matComputeMetrics(p, version='asis') {
  const steps = (DATA[p] && DATA[p].steps) || [];
  let totalActivities = 0, totalDecisions = 0, totalApprovals = 0, totalLoops = 0, totalHandoffs = 0, actionsWithSistema = 0, totalAutomatico = 0, totalStartEvents = 0, totalEndEvents = 0;
  // Contadores por natureza (7 naturezas)
  let totalExecucao = 0, totalControle = 0, totalDistribuicao = 0, totalComunicacao = 0, totalPlanejamento = 0;
  let anyNatDefined = false;
  const allActors = new Set();
  const allSistemas = new Set();
  const APPROVAL_KW = ['aprovação', 'aprovacao', 'revisão', 'revisao', 'autorização', 'autorizacao', 'validação', 'validacao'];

  let prevActor = '';
  steps.forEach((step) => {
    const actions = version === 'tobe'
      ? ((step.tobe && step.tobe.actions) || [])
      : (step.actions || []);
    const seenHandoffs = new Set(); // dedup por etapa: mesmo par A→B conta só 1x por etapa
    if(step.responsible) allActors.add(step.responsible.toLowerCase());

    actions.forEach(action => {
      const type    = action.type || 'atividade';
      const nat     = action.natureza || '';
      const actor   = action.actor || step.responsible || '';
      const textLow = (action.text || '').toLowerCase();
      const hasBranches = type === 'decisao' && Array.isArray(action.branches) && action.branches.length > 0;

      if(type === 'atividade') totalActivities++;
      if(type === 'decisao')   totalDecisions++;
      // Rastrear naturezas das atividades
      if(type === 'atividade' && nat) {
        anyNatDefined = true;
        if(nat === 'execucao')       totalExecucao++;
        else if(nat === 'controle')  totalControle++;
        else if(nat === 'distribuicao') totalDistribuicao++;
        else if(nat === 'comunicacao')  totalComunicacao++;
        else if(nat === 'planejamento') totalPlanejamento++;
      }
      if(type === 'evento') {
        const etipo = action.eventoTipo || '';
        if(etipo === 'inicio') totalStartEvents++;
        else if(etipo === 'encerramento') totalEndEvents++;
      }

      // Overhead burocrático: aprovacao e revisao por natureza ou palavra-chave
      // controle é rastreado separadamente em totalControle (acima)
      if(!hasBranches) {
        const isBurocByNat = (nat === 'aprovacao' || nat === 'revisao');
        const isBurocByKw  = !nat && APPROVAL_KW.some(k => textLow.includes(k));
        if(isBurocByNat || isBurocByKw) totalApprovals++;
      }

      // Loop: conta apenas atividades marcadas manualmente com 🔄
      if(type === 'atividade' && action.loop) totalLoops++;

      if(type === 'atividade') {
        if(actor && prevActor && actor.toLowerCase() !== prevActor.toLowerCase()) {
          const key = `${prevActor.toLowerCase()}→${actor.toLowerCase()}`;
          if(!seenHandoffs.has(key)) { seenHandoffs.add(key); totalHandoffs++; }
        }
        if(actor) { prevActor = actor; allActors.add(actor.toLowerCase()); }
      }

      // Sistemas: adiciona ao índice de sistemas únicos
      if(action.sistemas && action.sistemas.trim())
        action.sistemas.split(/[,;]/).forEach(s => { const st = s.trim(); if(st) allSistemas.add(st.toLowerCase()); });
      // Digitalização: atividade com sistema registrado OU marcada como automática (⚙️)
      if(type === 'atividade' && (action.automatico || (action.sistemas && action.sistemas.trim()))) actionsWithSistema++;
      // Automação: atividades marcadas explicitamente como automáticas (⚙️)
      if(type === 'atividade' && action.automatico) totalAutomatico++;

      // Processar caminhos de decisão: conta atividades/aprovações, mas deduplica aprovações (conta 1 por decisão)
      if(hasBranches) {
        let decisionHasApproval = false;
        action.branches.forEach(branch => {
          (branch.actions || []).forEach(ba => {
            const baType = ba.type || 'atividade';
            const baNat  = ba.natureza || '';
            const baTextLow = (ba.text || '').toLowerCase();
            const baActor   = ba.actor || '';
            if(baType === 'atividade') {
              totalActivities++;
              // Rastrear naturezas dentro de branches
              if(baNat) {
                anyNatDefined = true;
                if(baNat === 'execucao')       totalExecucao++;
                else if(baNat === 'controle')  totalControle++;
                else if(baNat === 'distribuicao') totalDistribuicao++;
                else if(baNat === 'comunicacao')  totalComunicacao++;
                else if(baNat === 'planejamento') totalPlanejamento++;
              }
              if(baActor && prevActor && baActor.toLowerCase() !== prevActor.toLowerCase()) {
                const key = `${prevActor.toLowerCase()}→${baActor.toLowerCase()}`;
                if(!seenHandoffs.has(key)) { seenHandoffs.add(key); totalHandoffs++; }
              }
              if(baActor) { prevActor = baActor; allActors.add(baActor.toLowerCase()); }
            }
            if(baType === 'decisao') totalDecisions++;
            if(baType === 'evento') {
              if(ba.eventoTipo === 'inicio') totalStartEvents++;
              else if(ba.eventoTipo === 'encerramento') totalEndEvents++;
            }
            // Decisão aninhada dentro do caminho (nível 3): processar seus sub-ramos
            if(baType === 'decisao' && Array.isArray(ba.branches)) {
              ba.branches.forEach(nbranch => {
                (nbranch.actions || []).forEach(nba => {
                  const nbaType = nba.type || 'atividade';
                  if(nbaType === 'evento') {
                    if(nba.eventoTipo === 'inicio') totalStartEvents++;
                    else if(nba.eventoTipo === 'encerramento') totalEndEvents++;
                  }
                  if(nbaType === 'atividade') {
                    totalActivities++;
                    const nbaNat = nba.natureza || '';
                    if(nbaNat) {
                      anyNatDefined = true;
                      if(nbaNat === 'execucao') totalExecucao++;
                      else if(nbaNat === 'controle') totalControle++;
                      else if(nbaNat === 'distribuicao') totalDistribuicao++;
                      else if(nbaNat === 'comunicacao') totalComunicacao++;
                      else if(nbaNat === 'planejamento') totalPlanejamento++;
                    }
                    if(nba.automatico) totalAutomatico++;
                    if(nba.loop) totalLoops++;
                    if(nba.automatico || (nba.sistemas && nba.sistemas.trim())) actionsWithSistema++;
                    if(nba.sistemas && nba.sistemas.trim())
                      nba.sistemas.split(/[,;]/).forEach(s => { const st = s.trim(); if(st) allSistemas.add(st.toLowerCase()); });
                  }
                });
              });
            }
            const baBurocByNat = (baNat === 'aprovacao' || baNat === 'revisao');
            const baBurocByKw  = !baNat && APPROVAL_KW.some(k => baTextLow.includes(k));
            if(baBurocByNat || baBurocByKw) decisionHasApproval = true;
            if(baType === 'atividade' && ba.automatico) totalAutomatico++;
            if(ba.sistemas && ba.sistemas.trim())
              ba.sistemas.split(/[,;]/).forEach(s => { const st = s.trim(); if(st) allSistemas.add(st.toLowerCase()); });
            // Digitalização: atividade com sistema OU automática
            if(baType === 'atividade' && (ba.automatico || (ba.sistemas && ba.sistemas.trim()))) actionsWithSistema++;
            if(baType === 'atividade' && ba.loop) totalLoops++;
          });
        });
        if(decisionHasApproval) totalApprovals++; // conta 1 aprovação por decisão, independente de quantos caminhos
      }
    });
  });

  const totalActors   = allActors.size;
  const totalSistemas = allSistemas.size;
  const automRate     = totalActivities > 0 ? actionsWithSistema / totalActivities : 0;
  const automacaoRate = totalActivities > 0 ? totalAutomatico / totalActivities : 0;
  const complexScore  = totalActivities * 1 + totalDecisions * 2 + totalActors * 1.5 + totalLoops * 3 + totalStartEvents * 1.5 + totalEndEvents * 1;

  let complexLabel, complexCls;
  if(complexScore <= 20)      { complexLabel = 'Simples';        complexCls = '#22c55e'; }
  else if(complexScore <= 40) { complexLabel = 'Moderado';       complexCls = '#eab308'; }
  else if(complexScore <= 70) { complexLabel = 'Complexo';       complexCls = '#f97316'; }
  else                        { complexLabel = 'Muito Complexo'; complexCls = '#ef4444'; }

  // Overhead expandido: aprovacao + revisao (via nat/kw) + controle (via nat)
  const overhead = totalActivities > 0 ? (totalApprovals + totalControle) / totalActivities : 0;
  let overheadLabel, overheadCls;
  if(overhead < 0.20)       { overheadLabel = 'Saudável';  overheadCls = '#22c55e'; }
  else if(overhead <= 0.35) { overheadLabel = 'Moderado';  overheadCls = '#eab308'; }
  else                      { overheadLabel = 'Elevado';   overheadCls = '#ef4444'; }
  // Alias legado (burocracia = overhead para compatibilidade)
  const burocracia = overhead;
  const burocLabel = overheadLabel;
  const burocCls   = overheadCls;

  return { totalActivities, totalDecisions, totalActors, totalLoops, totalHandoffs, totalApprovals, totalSistemas,
           actionsWithSistema, automRate, totalAutomatico, automacaoRate, totalStartEvents, totalEndEvents,
           totalExecucao, totalControle, totalDistribuicao, totalComunicacao, totalPlanejamento, anyNatDefined,
           complexScore, complexLabel, complexCls,
           overhead, overheadLabel, overheadCls,
           burocracia, burocLabel, burocCls };
}

function matComputeRisco(metrics, indispensaveis, sistIndispensaveis) {
  // decisões×2 + handoffs×2 + pessoas indispensáveis×5 + sistemas críticos×3 + eventos início×1,5 + eventos fim×1
  // Múltiplos pontos de entrada/saída indicam processo com fluxos complexos e não-lineares.
  // Nota: distribuição NÃO é somada aqui — as atividades de distribuição já geram
  // handoffs estruturais detectados pela troca de ator, evitando dupla contagem.
  const score = (metrics.totalDecisions * 2) + (metrics.totalHandoffs * 2)
              + (indispensaveis * 5) + ((sistIndispensaveis || 0) * 3)
              + ((metrics.totalStartEvents || 0) * 1.5) + ((metrics.totalEndEvents || 0) * 1);
  let label, cls;
  if(score <= 15)      { label = 'Baixo'; cls = '#22c55e'; }
  else if(score <= 35) { label = 'Médio'; cls = '#eab308'; }
  else                 { label = 'Alto';  cls = '#ef4444'; }
  return { score, label, cls };
}

function matScoreEquipe(answers) {
  const totalQuestions = MAT_QUESTIONS.length;
  let total = 0, count = 0;
  (answers || []).forEach((ans, i) => {
    if(ans === null || ans === undefined) return;
    const q   = MAT_QUESTIONS[i];
    let pts;
    if(q.inverted) pts = ans === 'sim' ? 100 : ans === 'talvez' ? 50 : 0;
    else           pts = ans === 'nao' ? 100 : ans === 'talvez' ? 50 : 0;
    total += pts; count++;
  });
  return count >= totalQuestions ? total / totalQuestions : null;
}

function matScoreEquipeMedia(questionnaires) {
  if(!Array.isArray(questionnaires) || questionnaires.length !== MAT_QUESTIONNAIRE_COUNT) return null;

  // Considera apenas questionários completamente preenchidos (sem nenhum null).
  // Questionários vazios ou parciais são ignorados — o score é a média dos válidos.
  const valid = questionnaires.filter(q =>
    Array.isArray(q) &&
    q.length === MAT_QUESTIONS.length &&
    q.every(a => a === 'sim' || a === 'talvez' || a === 'nao')
  );
  if(!valid.length) return null;

  let total = 0;
  for(let i = 0; i < MAT_QUESTIONS.length; i++) {
    let qTotal = 0;
    for(const q of valid) {
      const ans = q[i];
      const question = MAT_QUESTIONS[i];
      let pts;
      if(question.inverted) {
        if(ans === 'sim')    pts = 100;
        else if(ans === 'talvez') pts = 50;
        else                 pts = 0;
      } else {
        if(ans === 'nao')    pts = 100;
        else if(ans === 'talvez') pts = 50;
        else                 pts = 0;
      }
      qTotal += pts;
    }
    total += qTotal / valid.length;
  }
  return total / MAT_QUESTIONS.length;
}

function matQuestionAverage(questionnaires, questionIndex) {
  if(!Array.isArray(questionnaires) || questionIndex < 0 || questionIndex >= MAT_QUESTIONS.length) return null;
  let total = 0, count = 0;
  questionnaires.forEach((answers) => {
    const ans = answers && answers[questionIndex];
    if(ans === null || ans === undefined) return;
    const q   = MAT_QUESTIONS[questionIndex];
    let pts;
    if(q.inverted) pts = ans === 'sim' ? 100 : ans === 'talvez' ? 50 : 0;
    else           pts = ans === 'nao' ? 100 : ans === 'talvez' ? 50 : 0;
    total += pts; count++;
  });
  return count > 0 ? Math.round(total / count) : null;
}

function matComputeFinal(p) {
  const mat     = matGetData(p);
  const questionnaires = matNormalizeQuestionnaires(mat);
  const version = mat.version || 'asis';
  const metrics = matComputeMetrics(p, version);
  const ind     = parseInt(mat.indispensaveis) || 0;
  const sist    = parseInt(mat.sistIndispensaveis) || 0;
  const { score: riscoRaw, label: riscoLabel } = matComputeRisco(metrics, ind, sist);
  const equipe  = matScoreEquipeMedia(questionnaires);
  if(equipe === null) return null;

  // Normalise all to 0–100 where 100 = most mature
  // Risco: decaimento exponencial (meia-vida ≈ 45 pts)
  const normRisco   = Math.max(0, Math.min(100, Math.round(100 * Math.exp(-riscoRaw / 45))));
  // Digitalização: % de atividades com sistema registrado OU automáticas (0–100)
  const normAutom   = Math.round(metrics.automRate * 100);
  // Lean Operacional: execução / (execução + overhead) — mede proporção de valor direto vs. controle
  // Se nenhuma atividade "opinada" (execucao/aprovacao/controle) → neutro (50)
  const leanDenom = metrics.totalExecucao + metrics.totalApprovals + metrics.totalControle;
  const normLean  = leanDenom > 0
    ? Math.min(100, Math.round((metrics.totalExecucao / leanDenom) * 100))
    : 50;
  // Automação: % de atividades marcadas como automáticas (⚙️)
  const normAutomacao = Math.round(metrics.automacaoRate * 100);

  // Pesos: Equipe 30% · Risco 20% · Lean 30% · Digitalização 10% · Automação 10%
  const final = equipe * 0.30 + normRisco * 0.20 + normLean * 0.30 + normAutom * 0.10 + normAutomacao * 0.10;
  const f = Math.round(final);

  let level, levelColor, levelIcon;
  if(f <= 20)      { level = 'Inicial';    levelColor = '#ef4444'; levelIcon = '🔴'; }
  else if(f <= 40) { level = 'Gerenciado'; levelColor = '#f97316'; levelIcon = '🟠'; }
  else if(f <= 60) { level = 'Definido';   levelColor = '#eab308'; levelIcon = '🟡'; }
  else if(f <= 80) { level = 'Previsível'; levelColor = '#22c55e'; levelIcon = '🟢'; }
  else             { level = 'Otimizado';  levelColor = '#10b981'; levelIcon = '💚'; }

  return { final: f, level, levelColor, levelIcon,
           equipe: Math.round(equipe), normLean, normRisco, normAutom, normAutomacao,
           riscoRaw, riscoLabel };
}

function matSetAnswer(p, idx, val, qx = 0) {
  const mat = matGetData(p);
  const questionnaires = matNormalizeQuestionnaires(mat);
  if(!Array.isArray(questionnaires[qx])) {
    mat.questionnaires = Array.from({ length: MAT_QUESTIONNAIRE_COUNT }, () => matCreateEmptyAnswers());
  }
  if(!mat.questionnaires[qx]) mat.questionnaires[qx] = matCreateEmptyAnswers();
  mat.questionnaires[qx][idx] = val;
  mat.answers = mat.questionnaires[0].slice();
  markChanged(true, true);
  matRender(p);
}

function matSetIndispensaveis(p, val) {
  const mat = matGetData(p);
  mat.indispensaveis = parseInt(val) || 0;
  markChanged(true, true);
  matRender(p);
}

function matSetSistIndispensaveis(p, val) {
  const mat = matGetData(p);
  mat.sistIndispensaveis = parseInt(val) || 0;
  markChanged(true, true);
  matRender(p);
}

function matSetQuestionnaireView(p, idx) {
  const mat = matGetData(p);
  const max = MAT_QUESTIONNAIRE_COUNT - 1;
  const next = Math.max(0, Math.min(max, parseInt(idx, 10) || 0));
  mat.currentQuestionnaire = next;
  matRender(p);
}

function matPrevQuestionnaire(p) {
  const mat = matGetData(p);
  const cur = parseInt(mat.currentQuestionnaire, 10) || 0;
  matSetQuestionnaireView(p, cur - 1);
}

function matNextQuestionnaire(p) {
  const mat = matGetData(p);
  const cur = parseInt(mat.currentQuestionnaire, 10) || 0;
  matSetQuestionnaireView(p, cur + 1);
}

function matRender(p) {
  const container = document.getElementById(p + '-maturidade-body');
  if(!container) { return; }

  // Placeholder imediato enquanto processa
  container.innerHTML = '<div style="padding:20px;color:#94a3b8;font-size:13px;">Carregando análise...</div>';

  const mat         = matGetData(p);
  const version     = mat.version || 'asis';
  const metrics     = matComputeMetrics(p, version);
  const ind         = parseInt(mat.indispensaveis) || 0;
  const sist        = parseInt(mat.sistIndispensaveis) || 0;
  const risco       = matComputeRisco(metrics, ind, sist);
  const final       = matComputeFinal(p);
  const questionnaires = matNormalizeQuestionnaires(mat);
  const answered    = matAnsweredCount(questionnaires);
  const totalAnswers = matTotalAnswersRequired();
  const activeQIndex = Math.max(0, Math.min(MAT_QUESTIONNAIRE_COUNT - 1, parseInt(mat.currentQuestionnaire, 10) || 0));
  mat.currentQuestionnaire = activeQIndex;
  const procName    = p === 'd' ? 'Denúncias' : 'Representações';

  // ── helpers ─────────────────────────────────────────────────────
  const metricCard = (icon, label, value, sub) =>
    `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;min-width:110px;flex:1;text-align:center;">
      <div style="font-size:22px;margin-bottom:4px;">${icon}</div>
      <div style="font-size:26px;font-weight:800;color:#1B3022;">${value}</div>
      <div style="font-size:12px;color:#64748b;">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px;">${sub}</div>` : ''}
    </div>`;

  const indexCard = (title, raw, label, lColor, detail) =>
    `<div style="background:#fff;border:1px solid #e2e8f0;border-top:4px solid ${lColor};border-radius:10px;padding:16px;flex:1;min-width:160px;">
      <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;">${title}</div>
      <div style="font-size:28px;font-weight:800;color:#1B3022;margin-bottom:6px;">${raw}</div>
      <div style="display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:#fff;background:${lColor};">${label}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:8px;">${detail}</div>
    </div>`;

  const ansBtn = (pi, idx, qx, val, lbl, cur) => {
    const sel  = cur === val;
    const cols = { sim:'#22c55e', talvez:'#eab308', nao:'#ef4444' };
    return `<button onclick="matSetAnswer('${pi}',${idx},'${val}',${qx})"
      style="padding:6px 14px;border-radius:20px;border:1.5px solid ${sel ? cols[val] : '#e2e8f0'};
             background:${sel ? cols[val] : '#f8fafc'};color:${sel ? '#fff' : '#64748b'};
             font-size:12px;font-weight:${sel ? '700' : '400'};cursor:pointer;">${lbl}</button>`;
  };

  // ── AS IS / TO BE toggle (issue #6) ─────────────────────────────
  const versionToggle = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;padding:10px 14px;background:#f1f5f9;border-radius:10px;flex-wrap:wrap;">
      <span style="font-size:12px;font-weight:700;color:#475569;margin-right:4px;">Analisando fluxo:</span>
      <button onclick="matSetVersion('${p}','asis')"
        style="padding:6px 16px;border-radius:20px;border:none;font-size:12px;font-weight:700;cursor:pointer;
               background:${version==='asis'?'#1B3022':'#e2e8f0'};color:${version==='asis'?'#fff':'#475569'};">
        AS IS (situação atual)
      </button>
      <button onclick="matSetVersion('${p}','tobe')"
        style="padding:6px 16px;border-radius:20px;border:none;font-size:12px;font-weight:700;cursor:pointer;
               background:${version==='tobe'?'#1B3022':'#e2e8f0'};color:${version==='tobe'?'#fff':'#475569'};">
        TO BE (processo futuro)
      </button>
      <span style="font-size:11px;color:#94a3b8;margin-left:4px;">${version==='tobe'?'⚠️ O questionário de percepção é sempre referente ao processo atual (AS IS).':''}</span>
    </div>`;

  // ── sections ────────────────────────────────────────────────────
  const metricsHtml = `
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      📐 Métricas do Processo — <span style="color:#6366f1;">${procName}</span> <span style="font-size:11px;color:#94a3b8;font-weight:400;">(${version === 'tobe' ? 'TO BE' : 'AS IS'})</span>
      <button onclick="matShowAudit('${p}')" style="font-size:11px;padding:3px 12px;border-radius:20px;border:1.5px solid #e2e8f0;background:#f8fafc;color:#6366f1;font-weight:700;cursor:pointer;white-space:nowrap;">🔍 Auditoria</button>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px;">
      ${metricCard('▶', 'Atividades',   metrics.totalActivities)}
      ${metricCard('◆', 'Decisões',     metrics.totalDecisions)}
      ${metricCard('👤','Atores',        metrics.totalActors)}
      ${metricCard('🔄','Loops',         metrics.totalLoops,    'retrabalho')}
      ${metricCard('🔀','Handoffs',      metrics.totalHandoffs,  'trocas de ator')}
      ${metricCard('⬤', 'Ev. Início',   metrics.totalStartEvents, 'eventos de início')}
      ${metricCard('◉', 'Ev. Encerramento', metrics.totalEndEvents, 'eventos de fim')}
      ${metricCard('🎯','Execução',      metrics.totalExecucao, 'nat. execução')}
      ${metricCard('📤','Distribuição',  metrics.totalDistribuicao, 'nat. distribuição')}
      ${metricCard('⚡','Digitalização', (metrics.automRate*100).toFixed(0)+'%', 'c/ sistema ou automáticas')}
    </div>`;

  // índices calculados com escala de referência
  const automLabel = metrics.automRate >= 0.6 ? 'Alta' : metrics.automRate >= 0.3 ? 'Média' : 'Baixa';
  const automCls   = metrics.automRate >= 0.6 ? '#22c55e' : metrics.automRate >= 0.3 ? '#eab308' : '#ef4444';
  const indicesHtml = `
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin-bottom:6px;">📊 Índices Calculados</div>
    <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;">
      ${indexCard('Risco Operacional ↓', risco.score.toFixed(1), risco.label, risco.cls,
        `decisões×2 + handoffs×2 + pessoas indispensáveis×5 + sistemas críticos×3 + eventos início×1,5 + eventos fim×1<br>Escala: ≤15 baixo · ≤35 médio · &gt;35 alto`)}
      ${(()=>{
        const ld = metrics.totalExecucao + metrics.totalApprovals + metrics.totalControle;
        const lr = ld > 0 ? metrics.totalExecucao / ld : null;
        const lv = lr !== null ? (lr*100).toFixed(1)+'%' : 'N/D';
        const ll = lr === null ? 'Sem dados' : lr >= 0.6 ? 'Lean' : lr >= 0.35 ? 'Moderado' : 'Burocrático';
        const lc = lr === null ? '#94a3b8' : lr >= 0.6 ? '#22c55e' : lr >= 0.35 ? '#eab308' : '#ef4444';
        return indexCard('Lean Operacional ↑', lv, ll, lc,
          `execução ÷ (execução + aprovações + controle)<br>Escala: ≥60% lean · 35–60% moderado · &lt;35% burocrático<br><span style="color:#64748b;">Mede proporção de valor direto vs. etapas de controle no fluxo</span>`);
      })()}
      ${indexCard('Digitalização ↑', (metrics.automRate*100).toFixed(0)+'%', automLabel, automCls,
        `atividades com sistema registrado ou automáticas (⚙️) ÷ total de atividades<br>Escala: &lt;30% baixa · 30–60% média · &gt;60% alta<br><span style="color:#64748b;">Mede penetração digital no fluxo (sistema registrado ou execução automática)</span>`)}
      ${(()=>{
        const ar = metrics.automacaoRate;
        const av = (ar*100).toFixed(0)+'%';
        const al = ar >= 0.5 ? 'Alta' : ar >= 0.2 ? 'Média' : 'Baixa';
        const ac = ar >= 0.5 ? '#22c55e' : ar >= 0.2 ? '#eab308' : '#ef4444';
        return indexCard('Automação ⚙️ ↑', av, al, ac,
          `atividades marcadas como automáticas (⚙️) ÷ total de atividades<br>Escala: &lt;20% baixa · 20–50% média · &gt;50% alta<br><span style="color:#64748b;">Clique em ⚙️ em cada atividade no fluxo para marcar</span>`);
      })()}
    </div>`;

  const manualHtml = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px 18px;margin-bottom:24px;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:700;color:#1B3022;font-size:14px;margin-bottom:2px;">👤 Existem pessoas insubstituíveis neste processo?</div>
          <div style="font-size:12px;color:#94a3b8;">Quantas pessoas são tão específicas ao processo que, sem elas, a execução seria interrompida ou severamente prejudicada? Cada uma adiciona <strong>5 pontos</strong> ao risco operacional.</div>
        </div>
        <input type="number" min="0" max="50" value="${ind}"
          style="width:80px;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:20px;font-weight:800;text-align:center;color:#1B3022;"
          onchange="matSetIndispensaveis('${p}', this.value)" oninput="matSetIndispensaveis('${p}', this.value)">
      </div>
      <div style="border-top:1px solid #f1f5f9;padding-top:14px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:700;color:#1B3022;font-size:14px;margin-bottom:2px;">💻 Existe dependência de sistema específico e indispensável?</div>
          <div style="font-size:12px;color:#94a3b8;">Quantos sistemas são tão críticos que, sem eles, a execução deste processo seria interrompida completamente? Cada um adiciona <strong>3 pontos</strong> ao risco operacional.</div>
        </div>
        <input type="number" min="0" max="50" value="${sist}"
          style="width:80px;padding:8px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:20px;font-weight:800;text-align:center;color:#1B3022;"
          onchange="matSetSistIndispensaveis('${p}', this.value)" oninput="matSetSistIndispensaveis('${p}', this.value)">
      </div>
    </div>`;

  const activeAnswers = questionnaires[activeQIndex] || matCreateEmptyAnswers();
  const activeAnswered = activeAnswers.filter(a => a !== null).length;
  const qIndicators = questionnaires.map((answers, qx) => {
    const qAnswered = answers.filter(a => a !== null).length;
    const isActive = qx === activeQIndex;
    return `<button onclick="matSetQuestionnaireView('${p}',${qx})"
      style="padding:4px 10px;border-radius:999px;border:1px solid ${isActive ? '#6366f1' : '#e2e8f0'};
             background:${isActive ? '#eef2ff' : '#fff'};color:${isActive ? '#4338ca' : '#64748b'};
             font-size:11px;font-weight:700;cursor:pointer;">
      Q${qx+1} · ${qAnswered}/${MAT_QUESTIONS.length}
    </button>`;
  }).join('');

  const qHtml = `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:14px;background:#ffffff;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <button onclick="matPrevQuestionnaire('${p}')" ${activeQIndex === 0 ? 'disabled' : ''}
          style="padding:7px 12px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#334155;font-weight:800;cursor:${activeQIndex === 0 ? 'not-allowed' : 'pointer'};opacity:${activeQIndex === 0 ? '.45' : '1'};">
          ←
        </button>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;">
          <div style="font-size:13px;font-weight:800;color:#1B3022;">Questionário ${activeQIndex + 1}</div>
          <div style="font-size:11px;color:#94a3b8;">${activeAnswered}/${MAT_QUESTIONS.length} respondidas</div>
        </div>
        <button onclick="matNextQuestionnaire('${p}')" ${activeQIndex === MAT_QUESTIONNAIRE_COUNT - 1 ? 'disabled' : ''}
          style="padding:7px 12px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#334155;font-weight:800;cursor:${activeQIndex === MAT_QUESTIONNAIRE_COUNT - 1 ? 'not-allowed' : 'pointer'};opacity:${activeQIndex === MAT_QUESTIONNAIRE_COUNT - 1 ? '.45' : '1'};">
          →
        </button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-bottom:12px;">${qIndicators}</div>
      ${MAT_QUESTIONS.map((q, i) => {
        const cur = activeAnswers[i];
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;background:${cur !== null ? '#f0fdf4' : '#f8fafc'};border-radius:8px;margin-bottom:8px;border:1px solid ${cur !== null ? '#bbf7d0' : '#f1f5f9'};flex-wrap:wrap;">
            <div style="min-width:22px;font-size:12px;font-weight:800;color:#94a3b8;">${i+1}</div>
            <div style="flex:1;font-size:13px;color:#1e293b;min-width:200px;">${q.text}${q.inverted ? ' <span style="font-size:10px;color:#6366f1;font-weight:600;">(invertida)</span>' : ''}</div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              ${ansBtn(p, i, activeQIndex, 'sim',    'Sim',    cur)}
              ${ansBtn(p, i, activeQIndex, 'talvez', 'Talvez', cur)}
              ${ansBtn(p, i, activeQIndex, 'nao',    'Não',    cur)}
            </div>
          </div>`;
      }).join('')}
    </div>`;

  // issue #3: legenda dos níveis de maturidade
  const levelsLegend = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em;">📖 Escala de Maturidade (0–100)</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${[
          { icon:'🔴', level:'Inicial',    range:'0–20',  color:'#ef4444', desc:'Processo sem estrutura definida. Execução depende de conhecimento informal. Resultados imprevisíveis, erros e retrabalho frequentes.' },
          { icon:'🟠', level:'Gerenciado', range:'21–40', color:'#f97316', desc:'Alguma documentação existe, mas sem padronização efetiva. Alta dependência de pessoas-chave e muitas exceções não mapeadas.' },
          { icon:'🟡', level:'Definido',   range:'41–60', color:'#eab308', desc:'Processo documentado e seguido pela equipe, com variações aceitáveis. Exceções parcialmente tratadas. Fluxo estável.' },
          { icon:'🟢', level:'Previsível', range:'61–80', color:'#22c55e', desc:'Processo controlado com resultados consistentes. Exceções mapeadas. Baixa dependência de pessoas. Métricas monitoradas.' },
          { icon:'💚', level:'Otimizado',  range:'81–100',color:'#10b981', desc:'Processo em melhoria contínua, automatizado onde possível. Dados para tomada de decisão. Alta maturidade organizacional.' },
        ].map(l => `
          <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:7px;background:${l.color}0f;border-left:3px solid ${l.color};">
            <span style="font-size:15px;flex-shrink:0;">${l.icon}</span>
            <div>
              <span style="font-weight:700;color:${l.color};font-size:13px;">${l.level}</span>
              <span style="font-size:11px;color:#64748b;margin-left:6px;">${l.range} pts</span>
              <div style="font-size:12px;color:#475569;margin-top:1px;">${l.desc}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`;

  let resultHtml = '';
  if(answered < totalAnswers || !final) {
    resultHtml = `
      ${levelsLegend}
      <div style="text-align:center;padding:28px;background:#f8fafc;border-radius:10px;border:1.5px dashed #e2e8f0;">
        <div style="font-size:36px;">📋</div>
        <div style="font-size:14px;color:#64748b;margin-top:8px;">Responda os <strong>3 questionários completos</strong> para ver o score final.</div>
        <div style="color:#94a3b8;font-size:12px;margin-top:4px;">${answered}/${totalAnswers} respostas preenchidas</div>
      </div>`;
  } else {
    // issue #4: mostrar valores BRUTOS (↓ menor = melhor) para burocracia, complexidade e risco
    const scoreCard = (title, value, sub, weight, color, arrow) =>
      `<div style="background:#fff;border-top:4px solid ${color};border:1px solid ${color}33;border-radius:10px;padding:14px;flex:1;min-width:120px;text-align:center;">
        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;">${title}</div>
        <div style="font-size:30px;font-weight:900;color:${color};margin:6px 0;">${value}</div>
        <div style="font-size:10px;color:#94a3b8;">${sub}</div>
        <div style="font-size:11px;color:#64748b;margin-top:3px;">${arrow} · peso ${weight}</div>
      </div>`;

    resultHtml = `
      <div style="text-align:center;padding:28px 20px;background:linear-gradient(135deg,#f8fafc,#fff);border:1px solid #e2e8f0;border-radius:12px;margin-bottom:16px;">
        <div style="font-size:48px;margin-bottom:6px;">${final.levelIcon}</div>
        <div style="font-size:56px;font-weight:900;color:${final.levelColor};line-height:1;">${final.final}</div>
        <div style="font-size:13px;color:#64748b;margin-top:4px;">Score de Maturidade (0–100)</div>
        <div style="display:inline-block;padding:5px 20px;border-radius:20px;background:${final.levelColor};color:#fff;font-size:17px;font-weight:800;margin-top:8px;">${final.levelIcon} ${final.level}</div>
        <div style="margin-top:16px;background:#f1f5f9;border-radius:8px;height:14px;overflow:hidden;">
          <div style="height:100%;width:${final.final}%;background:linear-gradient(90deg,${final.levelColor}88,${final.levelColor});border-radius:8px;"></div>
        </div>
      </div>
      ${levelsLegend}
      <div style="font-size:12px;font-weight:700;color:#475569;margin-bottom:8px;">Componentes do score (normalizado 0–100):</div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
        ${scoreCard('Percepção da Equipe', final.equipe+'/100', 'média de 3 questionários ↑', '30%', '#6366f1', '↑ maior = melhor')}
        ${(()=>{ const rc = final.normRisco >= 70 ? '#22c55e' : final.normRisco >= 40 ? '#eab308' : '#ef4444'; return scoreCard('Risco Operacional', final.normRisco+'/100', 'maior = melhor', '20%', rc, ''); })()}
        ${scoreCard('Lean Operacional', final.normLean+'/100', 'execução ÷ (exec+overhead) ↑', '30%', '#22c55e', '↑ mais lean = melhor')}
        ${scoreCard('Digitalização', final.normAutom+'/100', '% atividades com sistema ↑', '10%', '#0891b2', '↑ maior = melhor')}
        ${scoreCard('Automação', final.normAutomacao+'/100', '% atividades automáticas ⚙️ ↑', '10%', '#7c3aed', '↑ mais automático = melhor')}
      </div>
      <div style="font-size:11px;color:#94a3b8;text-align:center;margin-bottom:16px;">
        Score = Equipe×30% + Risco×20% + Lean×30% + Digitalização×10% + Automação×10% — todos normalizados 0–100 (100 = mais maduro)
      </div>
      <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-bottom:20px;">
        ${isEditor ? `
        <button onclick="matSaveSnapshot('${p}')"
          style="padding:10px 24px;background:#1B3022;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(27,48,34,.18);">
          💾 Salvar Nota
        </button>` : ''}
        <button onclick="matExportPdf('${p}')"
          style="padding:10px 24px;background:#1d4ed8;color:#fff;border:none;border-radius:10px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(29,78,216,.18);">
          📄 Exportar PDF
        </button>
      </div>
      <div style="font-size:11px;color:#94a3b8;text-align:center;margin-top:-12px;margin-bottom:20px;">
        ${isEditor ? '"Salvar Nota" registra a pontuação com a data de hoje · ' : ''}"Exportar PDF" gera relatório completo
      </div>
      `;
  }

  const cachedResult = mat.geminiAnalysis
    ? `<div style="white-space:pre-wrap;font-size:13px;line-height:1.8;color:#1e293b;">${
        mat.geminiAnalysis
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/^### (.*$)/gm, '<div style="font-size:14px;font-weight:800;color:#1B3022;margin:14px 0 4px;border-left:3px solid #6366f1;padding-left:8px;">$1</div>')
          .replace(/^## (.*$)/gm, '<div style="font-size:15px;font-weight:800;color:#1B3022;margin:16px 0 6px;">$1</div>')
          .replace(/^# (.*$)/gm, '<div style="font-size:16px;font-weight:900;color:#1B3022;margin:16px 0 6px;">$1</div>')
          .replace(/\n/g, '<br>')
      }</div>`
    : '<span style="color:#94a3b8;">O resultado da análise aparecerá aqui.</span>';

  const geminiHtml = `
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;margin-top:4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
        <div>
          <div style="font-weight:700;color:#1B3022;font-size:15px;">🤖 Análise Inteligente — Gemini</div>
          <div style="font-size:12px;color:#94a3b8;">${mat.lastAnalysis ? 'Última análise: ' + mat.lastAnalysis : 'Nenhuma análise realizada ainda.'}</div>
        </div>
        <button onclick="matGeminiAnalyze('${p}')" id="mat-gemini-btn-${p}" class="btn btn-primary"
          style="font-size:13px;" ${answered < totalAnswers ? 'disabled title="Responda os 3 questionários primeiro"' : ''}>
          ✨ Analisar com IA
        </button>
      </div>
      <div id="mat-gemini-result-${p}" style="font-size:13px;color:#334155;line-height:1.7;">
        ${cachedResult}
      </div>
    </div>`;

  const snapshots = mat.snapshots || [];
  const historyHtml = `
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin:24px 0 12px;display:flex;align-items:center;gap:10px;">
      📈 Histórico de Maturidade
      <span style="font-size:11px;font-weight:400;color:#94a3b8;">${snapshots.length} registro${snapshots.length !== 1 ? 's' : ''}</span>
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;">
      ${matRenderHistory(p, snapshots)}
    </div>`;

  container.innerHTML = `
    ${versionToggle}
    ${metricsHtml}
    ${indicesHtml}
    ${manualHtml}
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin-bottom:10px;">
      📋 Questionário de Percepção da Equipe
      <span style="color:#94a3b8;font-size:12px;font-weight:400;margin-left:6px;">${answered}/${totalAnswers} respostas</span>
    </div>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:24px;">${qHtml}</div>
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin-bottom:12px;">🏆 Score de Maturidade</div>
    ${resultHtml}
    ${historyHtml}
    <div style="font-size:14px;font-weight:700;color:#1B3022;margin:20px 0 12px;">🤖 Análise com IA</div>
    ${geminiHtml}`;
}

// ── Maturidade: Histórico de snapshots ──────────────────────────────────
function matSaveSnapshot(p) {
  const final = matComputeFinal(p);
  if(!final) { showToast('Responda os 3 questionários (30 respostas) antes de salvar.', 'warn'); return; }
  const mat = matGetData(p);
  if(!Array.isArray(mat.snapshots)) mat.snapshots = [];
  const today = new Date().toISOString().slice(0,10);
  // Evitar duplicata no mesmo dia
  if(mat.snapshots.some(s => s.date === today)) {
    if(!confirm('Já existe uma nota salva para hoje (' + today + '). Substituir?')) return;
    mat.snapshots = mat.snapshots.filter(s => s.date !== today);
  }
  mat.snapshots.push({
    date: today,
    score: final.final,
    level: final.level,
    levelColor: final.levelColor,
    levelIcon: final.levelIcon,
    equipe:     final.equipe,
    normRisco:  final.normRisco,
    normLean:      final.normLean,
    normAutom:     final.normAutom,
    normAutomacao: final.normAutomacao,
  });
  mat.snapshots.sort((a,b) => a.date.localeCompare(b.date));
  markChanged(true, true);
  // Salvar imediatamente na nuvem (independente do modo edição)
  if(currentUser && window._appInitialized) saveToCloud();
  showToast('✅ Nota de maturidade salva!', 'success');
  matRender(p);
}
function matDeleteSnapshot(p, idx) {
  if(!confirm('Remover este registro do histórico?')) return;
  const mat = matGetData(p);
  if(Array.isArray(mat.snapshots)) mat.snapshots.splice(idx, 1);
  markChanged(true, true);
  if(currentUser && window._appInitialized) saveToCloud();
  matRender(p);
}
function matRenderHistory(p, snapshots) {
  if(!snapshots || !snapshots.length) return `
    <div style="text-align:center;padding:24px;background:#f8fafc;border-radius:10px;border:1.5px dashed #e2e8f0;color:#94a3b8;font-size:13px;">
      Nenhum registro salvo ainda. Clique em <strong>💾 Salvar Nota</strong> para iniciar o histórico.
    </div>`;
  const fmtDate = d => { try { return new Date(d+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}); } catch(e){ return d; } };
  /* tratamento de erro */
  const items = snapshots.map((snap, idx) => {
    const prev  = idx > 0 ? snapshots[idx-1] : null;
    const delta = prev ? snap.score - prev.score : null;
    const deltaHtml = delta === null ? '' :
      delta > 0 ? `<span style="color:#22c55e;font-weight:700;font-size:13px;">▲ +${delta}</span>` :
      delta < 0 ? `<span style="color:#ef4444;font-weight:700;font-size:13px;">▼ ${delta}</span>` :
                  `<span style="color:#94a3b8;font-size:13px;">= sem mudança</span>`;
    const isLast = idx === snapshots.length - 1;
    return `
      <div style="display:flex;gap:0;align-items:stretch;">
        <!-- Trilho da linha do tempo -->
        <div style="display:flex;flex-direction:column;align-items:center;width:36px;flex-shrink:0;">
          <div style="width:14px;height:14px;border-radius:50%;background:${snap.levelColor};border:2.5px solid #fff;box-shadow:0 0 0 2px ${snap.levelColor};margin-top:18px;flex-shrink:0;"></div>
          ${!isLast ? `<div style="width:2px;flex:1;background:#e2e8f0;margin:2px 0;min-height:16px;"></div>` : ''}
        </div>
        <!-- Card do snapshot -->
        <div style="flex:1;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:${isLast?'0':'10px'};">
          <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
              <span style="font-size:12px;font-weight:700;color:#475569;">📅 ${fmtDate(snap.date)}</span>
              <span style="font-size:11px;padding:2px 10px;border-radius:12px;background:${snap.levelColor}22;color:${snap.levelColor};font-weight:700;">${snap.levelIcon} ${snap.level}</span>
              ${deltaHtml}
            </div>
            ${isEditor ? `<button onclick="matDeleteSnapshot('${p}',${idx})" style="padding:2px 8px;border-radius:6px;border:1px solid #fca5a5;background:#fff5f5;color:#ef4444;font-size:11px;cursor:pointer;" title="Remover registro">✕</button>` : ''}
          </div>
          <!-- Score + barra -->
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
            <div style="font-size:40px;font-weight:900;color:${snap.levelColor};line-height:1;">${snap.score}</div>
            <div style="flex:1;min-width:120px;">
              <div style="background:#f1f5f9;border-radius:6px;height:10px;overflow:hidden;margin-bottom:6px;">
                <div style="height:100%;width:${snap.score}%;background:${snap.levelColor};border-radius:6px;transition:width .4s;"></div>
              </div>
              <!-- Componentes compactos -->
              <div style="display:flex;flex-wrap:wrap;gap:6px;">
                ${[
                  ['👥 Equipe',  snap.equipe,           '#6366f1'],
                  ['⚠️ Risco',   snap.normRisco,         '#ef4444'],
                  ['🌿 Lean',    snap.normLean ?? snap.normBuroc, '#22c55e'],
                  ['💻 Digital.',snap.normAutom,          '#0891b2'],
                  ['⚙️ Auto.',  snap.normAutomacao,      '#7c3aed'],
                ].map(([lbl,val,col]) => `<span style="font-size:10px;padding:2px 7px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;color:#475569;">${lbl} <strong style="color:${col};">${val??'—'}</strong></span>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  });
  return items.reverse().join(''); // mais recente primeiro
}

function matExportPdf(p) {
  const mat      = matGetData(p);
  const version  = mat.version || 'asis';
  const metrics  = matComputeMetrics(p, version);
  const ind      = parseInt(mat.indispensaveis) || 0;
  const sist     = parseInt(mat.sistIndispensaveis) || 0;
  const risco    = matComputeRisco(metrics, ind, sist);
  const final    = matComputeFinal(p);
  const questionnaires = matNormalizeQuestionnaires(mat);
  const totalAnswers = matTotalAnswersRequired();
  const answered = matAnsweredCount(questionnaires);
  const snapshots = mat.snapshots || [];
  const popName  = DATA[p]?.meta?.name || (p === 'd' ? 'Denúncias' : 'Representações');
  const today    = new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric' });
  const fmtDate  = d => { try { return new Date(d+'T12:00:00Z').toLocaleDateString('pt-BR',{day:'2-digit',month:'short',year:'numeric'}); } catch(e){ return d; } };
  const esc      = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const ansLabel = { sim:'Sim', talvez:'Talvez', nao:'Não' };
  const ansColor = { sim:'#22c55e', talvez:'#eab308', nao:'#ef4444' };

  const automLabel = metrics.automRate >= 0.6 ? 'Alta' : metrics.automRate >= 0.3 ? 'Média' : 'Baixa';
  const automCls   = metrics.automRate >= 0.6 ? '#22c55e' : metrics.automRate >= 0.3 ? '#eab308' : '#ef4444';

  // ── Score block ────────────────────────────────────────────────────────
  const scoreBlock = final ? `
    <div class="score-block">
      <div class="score-circle" style="border-color:${final.levelColor};">
        <div class="score-icon">${final.levelIcon}</div>
        <div class="score-num" style="color:${final.levelColor};">${final.final}</div>
        <div class="score-label">/ 100</div>
      </div>
      <div class="score-info">
        <div class="level-badge" style="background:${final.levelColor};">${final.levelIcon} ${final.level}</div>
        <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${final.final}%;background:${final.levelColor};"></div></div>
        <table class="comp-table">
          <tr><th>Componente</th><th>Peso</th><th>Valor</th><th>Sentido</th><th>Barra</th></tr>
          ${[
            ['👥 Percepção da Equipe',  '30%', final.equipe,    '#6366f1', '↑ maior = melhor', 'Média das respostas de 3 questionários de percepção (Sim/Talvez/Não), com consolidação por pergunta. Perguntas invertidas têm lógica oposta.'],
            ['⚠️ Risco Operacional',   '20%', final.normRisco, '#ef4444', '100 = risco mínimo (invertido)', 'Decaimento exponencial (meia-vida ≈ 45 pts) sobre: decisões×2 + handoffs×2 + pessoas indispensáveis×5 + sistemas críticos×3 + eventos início×1,5 + eventos fim×1. Score bruto alto → nota baixa.'],
            ['🌿 Lean Operacional',     '30%', final.normLean,      '#22c55e', '100 = totalmente lean', 'execução ÷ (execução + aprovações + controle) × 100. Mede a proporção de atividades de valor direto vs. etapas de controle/burocracia. Neutro (50) quando nenhuma atividade opinada existe.'],
            ['💻 Digitalização',        '10%', final.normAutom,     '#0891b2', '100 = totalmente digitalizado', 'Percentual de atividades com sistema registrado ou marcadas como automáticas (⚙️), incluindo atividades dentro de decisões.'],
            ['⚙️ Automação',            '10%', final.normAutomacao, '#7c3aed', '100 = totalmente automatizado', 'Percentual de atividades marcadas com ⚙️ (automático) ÷ total de atividades. Marque via ícone ⚙️ em cada atividade no fluxo.'],
          ].map(([lbl, peso, val, col, sentido, formula]) => `
            <tr>
              <td>${lbl}</td>
              <td style="text-align:center;">${peso}</td>
              <td style="text-align:center;font-weight:700;color:${col};">${val}/100</td>
              <td style="font-size:10px;color:#64748b;white-space:nowrap;">${sentido}</td>
              <td><div style="background:#e2e8f0;border-radius:4px;height:8px;width:100px;overflow:hidden;"><div style="height:8px;width:${val}%;background:${col};border-radius:4px;"></div></div></td>
            </tr>
            <tr style="background:#f8fafc;">
              <td colspan="5" style="font-size:10px;color:#94a3b8;padding:3px 8px 6px;">${formula}</td>
            </tr>`).join('')}
        </table>
        <p class="formula-note" style="margin-top:10px;padding:8px 10px;background:#f1f5f9;border-radius:6px;border-left:3px solid #1B3022;">
          <strong>Fórmula do Score Final:</strong> Score = (Equipe × 0,30) + (Risco × 0,20) + (Lean × 0,30) + (Digitalização × 0,10) + (Automação × 0,10)<br>
          <span style="color:#94a3b8;">Todos os componentes são normalizados para a escala 0–100, onde 100 representa sempre o estado mais maduro/favorável.</span><br><br>
          <strong>Lean</strong> = execução ÷ (execução + aprovações + controle). <strong>Automação</strong> = % de atividades marcadas com ⚙️ no fluxo.
        </p>
      </div>
    </div>` : `<div class="empty-block">⚠️ Score não disponível — 3 questionários não respondidos completamente.</div>`;

  // ── Métricas ───────────────────────────────────────────────────────────
  const metricsBlock = `
    <table class="data-table">
      <tr><th colspan="2">📐 Métricas do Processo (${version === 'tobe' ? 'TO BE' : 'AS IS'})</th></tr>
      <tr><td>Atividades</td><td>${metrics.totalActivities}</td></tr>
      <tr><td>Decisões</td><td>${metrics.totalDecisions}</td></tr>
      <tr><td>Atores envolvidos</td><td>${metrics.totalActors}</td></tr>
      <tr><td>Loops (retrabalho)</td><td>${metrics.totalLoops}</td></tr>
      <tr><td>Handoffs (trocas de ator)</td><td>${metrics.totalHandoffs}</td></tr>
      <tr><td>Overhead (aprov. + revis. + controle)</td><td>${metrics.totalApprovals + metrics.totalControle}</td></tr>
      <tr><td>— Aprovações / Revisões (nat/kw)</td><td>${metrics.totalApprovals}</td></tr>
      <tr><td>— Controle (natureza controle)</td><td>${metrics.totalControle}</td></tr>
      <tr><td>Execução (natureza execução)</td><td>${metrics.totalExecucao}</td></tr>
      <tr><td>Distribuição (natureza distribuição)</td><td>${metrics.totalDistribuicao}</td></tr>
      <tr><td>Comunicação (natureza comunicação)</td><td>${metrics.totalComunicacao}</td></tr>
      <tr><td>Planejamento (natureza planejamento)</td><td>${metrics.totalPlanejamento}</td></tr>
      <tr><td>Atividades digitalizadas (c/ sistema ou automáticas)</td><td>${metrics.actionsWithSistema} (${(metrics.automRate*100).toFixed(0)}%)</td></tr>
      <tr><td>Pessoas indispensáveis (manual)</td><td>${ind}</td></tr>
      <tr><td>Sistemas indispensáveis (manual)</td><td>${sist}</td></tr>
    </table>`;

  // ── Índices ────────────────────────────────────────────────────────────
  const indicesBlock = `
    <table class="data-table">
      <tr><th colspan="3">📊 Índices Brutos do Processo</th></tr>
      <tr><td colspan="3" style="font-size:10px;color:#64748b;padding:5px 10px;background:#f8fafc;font-style:italic;">
        Valores originais, na escala natural de cada métrica. São invertidos/normalizados para a escala 0–100 dos componentes do Score de Maturidade acima.
      </td></tr>
      <tr><th>Índice</th><th>Valor bruto</th><th>Classificação</th></tr>
      <tr>
        <td>Risco Operacional <span class="note">(bruto — ↓ menor = melhor; normalizado → componente 0–100)</span></td>
        <td>${risco.score.toFixed(1)} pts</td>
        <td><span class="badge" style="background:${risco.cls}20;color:${risco.cls};">${risco.label}</span></td>
      </tr>
      <tr>
        ${(()=>{
          const ld = metrics.totalExecucao + metrics.totalApprovals + metrics.totalControle;
          const lr = ld > 0 ? metrics.totalExecucao / ld : null;
          const lv = lr !== null ? (lr*100).toFixed(1)+'%' : 'N/D';
          const ll = lr === null ? 'Sem dados' : lr >= 0.6 ? 'Lean' : lr >= 0.35 ? 'Moderado' : 'Burocrático';
          const lc = lr === null ? '#94a3b8' : lr >= 0.6 ? '#22c55e' : lr >= 0.35 ? '#eab308' : '#ef4444';
          return `<td>Lean Operacional <span class="note">(bruto — ↑ maior = melhor; execução ÷ (execução+overhead))</span></td>
        <td>${lv}</td>
        <td><span class="badge" style="background:${lc}20;color:${lc};">${ll}</span></td>`;
        })()}
      </tr>
      <tr>
        <td>Digitalização <span class="note">(bruto = normalizado — ↑ maior = melhor; atividades c/ sistema ou automáticas ⚙️, incl. dentro de decisões)</span></td>
        <td>${(metrics.automRate*100).toFixed(0)}%</td>
        <td><span class="badge" style="background:${automCls}20;color:${automCls};">${automLabel}</span></td>
      </tr>
      <tr>
        ${(()=>{
          const ar = metrics.automacaoRate;
          const al = ar >= 0.5 ? 'Alta' : ar >= 0.2 ? 'Média' : 'Baixa';
          const ac = ar >= 0.5 ? '#22c55e' : ar >= 0.2 ? '#eab308' : '#ef4444';
          return `<td>Automação ⚙️ <span class="note">(bruto = normalizado — ↑ maior = melhor; atividades marcadas no fluxo)</span></td>
        <td>${(ar*100).toFixed(0)}%</td>
        <td><span class="badge" style="background:${ac}20;color:${ac};">${al}</span></td>`;
        })()}
      </tr>
    </table>`;

  // ── Questionário ───────────────────────────────────────────────────────
  const questBlock = `
    <h2 class="section-title">📋 Questionários de Percepção da Equipe <span class="note">(${answered}/${totalAnswers} respostas)</span></h2>
    <table class="data-table">
      <tr><th>#</th><th>Pergunta</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Média</th></tr>
      ${MAT_QUESTIONS.map((q, i) => {
        const qAnswers = questionnaires.map(qset => (qset && qset[i]) || null);
        const avg = matQuestionAverage(questionnaires, i);
        return `<tr>
          <td style="text-align:center;font-weight:700;color:#94a3b8;">${i+1}</td>
          <td>${esc(q.text)}${q.inverted ? ' <em style="color:#6366f1;font-size:10px;">(invertida)</em>' : ''}</td>
          ${qAnswers.map(ans => {
            const lbl = ans ? ansLabel[ans] : '—';
            const col = ans ? ansColor[ans] : '#94a3b8';
            return `<td style="text-align:center;"><span class="badge" style="background:${col}20;color:${col};font-weight:700;">${lbl}</span></td>`;
          }).join('')}
          <td style="text-align:center;font-weight:700;color:#6366f1;">${avg !== null ? avg + '/100' : '—'}</td>
        </tr>`;
      }).join('')}
    </table>`;

  // ── Escala de Maturidade ───────────────────────────────────────────────
  const scaleBlock = `
    <table class="data-table">
      <tr><th colspan="3">📖 Escala de Maturidade (0–100)</th></tr>
      <tr><th>Nível</th><th>Faixa</th><th>Descrição</th></tr>
      ${[
        ['🔴 Inicial',    '0–20',   '#ef4444', 'Processo sem estrutura definida. Execução depende de conhecimento informal.'],
        ['🟠 Gerenciado', '21–40',  '#f97316', 'Alguma documentação, sem padronização efetiva. Alta dependência de pessoas-chave.'],
        ['🟡 Definido',   '41–60',  '#eab308', 'Processo documentado e seguido, variações aceitáveis, fluxo estável.'],
        ['🟢 Previsível', '61–80',  '#22c55e', 'Processo controlado com resultados consistentes. Métricas monitoradas.'],
        ['💚 Otimizado',  '81–100', '#10b981', 'Processo em melhoria contínua, automatizado onde possível.'],
      ].map(([lbl, range, col, desc]) => `
        <tr>
          <td><span class="badge" style="background:${col}20;color:${col};font-weight:700;">${lbl}</span></td>
          <td style="text-align:center;white-space:nowrap;">${range} pts</td>
          <td>${desc}</td>
        </tr>`).join('')}
    </table>`;

  // ── Histórico ──────────────────────────────────────────────────────────
  const histBlock = snapshots.length ? `
    <h2 class="section-title">📈 Histórico de Maturidade</h2>
    <table class="data-table">
      <tr><th>Data</th><th>Score</th><th>Nível</th><th>Variação</th><th>Equipe</th><th>Risco</th><th>Lean</th><th>Digital.</th><th>Auto.</th></tr>
      ${[...snapshots].reverse().map((s, idx, arr) => {
        const prevSnap = arr[idx + 1];
        const delta = prevSnap ? s.score - prevSnap.score : null;
        const deltaStr = delta === null ? '—' : delta > 0 ? `▲ +${delta}` : delta < 0 ? `▼ ${delta}` : '= 0';
        const deltaCol = delta === null ? '#94a3b8' : delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#94a3b8';
        return `<tr>
          <td style="white-space:nowrap;">${fmtDate(s.date)}</td>
          <td style="text-align:center;font-weight:800;color:${s.levelColor||'#1B3022'};">${s.score}</td>
          <td><span class="badge" style="background:${(s.levelColor||'#1B3022')}20;color:${s.levelColor||'#1B3022'};">${s.levelIcon||''} ${s.level||''}</span></td>
          <td style="text-align:center;font-weight:700;color:${deltaCol};">${deltaStr}</td>
          <td style="text-align:center;">${s.equipe??'—'}</td>
          <td style="text-align:center;">${s.normRisco??'—'}</td>
          <td style="text-align:center;">${s.normLean ?? s.normBuroc ?? '—'}</td>
          <td style="text-align:center;">${s.normAutom??'—'}</td>
          <td style="text-align:center;">${s.normAutomacao??'—'}</td>
        </tr>`;
      }).join('')}
    </table>` : '';

  // ── Análise IA ─────────────────────────────────────────────────────────
  const aiBlock = mat.geminiAnalysis ? `
    <h2 class="section-title">🤖 Análise Inteligente — Gemini${mat.lastAnalysis ? ` <span class="note">(${mat.lastAnalysis})</span>` : ''}</h2>
    <div class="ai-content">${mat.geminiAnalysis
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/^### (.*)$/gm,'<h4>$1</h4>')
      .replace(/^## (.*)$/gm,'<h3>$1</h3>')
      .replace(/^# (.*)$/gm,'<h3>$1</h3>')
      .replace(/\n/g,'<br>')
    }</div>` : '';

  const win = window.open('', '_blank', 'width=960,height=750');
  if(!win) { showToast('Popup bloqueado. Permita popups para este site.', 'warn'); return; }
  win.document.write(`<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="utf-8">
<title>Análise de Maturidade — ${esc(popName)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'Inter',sans-serif;color:#1e293b;font-size:13px;padding:36px 48px;max-width:940px;margin:0 auto;}
.doc-header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;padding-bottom:18px;border-bottom:3px solid #1B3022;}
.doc-header-left .badge-org{font-size:9px;font-weight:800;letter-spacing:.12em;color:#00a86b;text-transform:uppercase;}
.doc-header-left h1{font-size:22px;font-weight:900;color:#1B3022;margin:4px 0;}
.doc-header-left .sub{font-size:11px;color:#64748b;}
.doc-header-right{text-align:right;font-size:11px;color:#64748b;line-height:1.7;}
.score-block{display:flex;gap:28px;align-items:flex-start;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:20px;}
.score-circle{width:100px;height:100px;border-radius:50%;border:5px solid;display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;}
.score-icon{font-size:22px;line-height:1;}
.score-num{font-size:30px;font-weight:900;line-height:1;}
.score-label{font-size:10px;color:#94a3b8;}
.score-info{flex:1;}
.level-badge{display:inline-block;color:#fff;font-size:14px;font-weight:800;padding:5px 16px;border-radius:20px;margin-bottom:10px;}
.score-bar-wrap{background:#e2e8f0;border-radius:6px;height:10px;margin-bottom:12px;overflow:hidden;}
.score-bar-fill{height:10px;border-radius:6px;}
.comp-table{width:100%;border-collapse:collapse;font-size:12px;}
.comp-table th{background:#1B3022;color:#fff;padding:5px 8px;text-align:left;font-weight:700;}
.comp-table td{padding:5px 8px;border-bottom:1px solid #f1f5f9;}
.comp-table tr:last-child td{border-bottom:none;}
.formula-note{font-size:10px;color:#94a3b8;margin-top:8px;}
.section-title{font-size:14px;font-weight:800;color:#1B3022;margin:20px 0 8px;padding-bottom:5px;border-bottom:2px solid #00a86b;page-break-after:avoid;}
.data-table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;}
.data-table th{background:#1B3022;color:#fff;padding:7px 10px;text-align:left;font-weight:700;}
.data-table td{padding:6px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle;}
.data-table tr:nth-child(even) td{background:#f8fafc;}
.badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;white-space:nowrap;}
.note{font-size:10px;color:#94a3b8;font-weight:400;}
.empty-block{padding:20px;background:#f8fafc;border:1.5px dashed #e2e8f0;border-radius:8px;color:#94a3b8;text-align:center;margin-bottom:20px;}
.ai-content{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;font-size:12.5px;line-height:1.75;white-space:pre-wrap;}
.ai-content h3,.ai-content h4{color:#1B3022;margin:12px 0 4px;}
.print-btn{position:fixed;top:16px;right:16px;padding:10px 22px;background:#1B3022;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;}
@media print{
  .print-btn{display:none!important;}
  body{padding:0 20px;}
  .score-block{break-inside:avoid;}
  .data-table{break-inside:auto;}
  .data-table tr{break-inside:avoid;}
}
</style>
</head><body>
<button class="print-btn" onclick="window.print()">🖨 Imprimir / Salvar PDF</button>
<div class="doc-header">
  <div class="doc-header-left">
    <div class="badge-org">CAGE-RS · SIGA</div>
    <h1>${esc(popName)}</h1>
    <div class="sub">Análise de Maturidade de Processos · Fluxo: ${version === 'tobe' ? 'TO BE' : 'AS IS'}</div>
  </div>
  <div class="doc-header-right">
    <div><strong>Data:</strong> ${today}</div>
    <div><strong>Histórico:</strong> ${snapshots.length} registro${snapshots.length !== 1 ? 's' : ''}</div>
  </div>
</div>

<h2 class="section-title">🏆 Score de Maturidade</h2>
${scoreBlock}
${scaleBlock}
<h2 class="section-title">📐 Métricas e Índices do Processo</h2>
${metricsBlock}
${indicesBlock}
${questBlock}
${histBlock}
${aiBlock}
<script>window.onload=function(){window.print();}<\/script>
</body></html>`);
  win.document.close();
}

async function matGeminiAnalyze(p) {
  const btn       = document.getElementById('mat-gemini-btn-' + p);
  const resultDiv = document.getElementById('mat-gemini-result-' + p);
  if(!btn || !resultDiv) return;

  btn.disabled    = true;
  btn.textContent = '⏳ Analisando...';
  resultDiv.innerHTML = '<span style="color:#94a3b8;">Aguardando resposta da IA...</span>';

  try {
    const mat     = matGetData(p);
    const questionnaires = matNormalizeQuestionnaires(mat);
    const version = mat.version || 'asis';
    const metrics = matComputeMetrics(p, version);
    const ind     = parseInt(mat.indispensaveis) || 0;
    const sist    = parseInt(mat.sistIndispensaveis) || 0;
    const risco   = matComputeRisco(metrics, ind, sist);
    const equipe  = matScoreEquipeMedia(questionnaires);
    const final   = matComputeFinal(p);
    const popMeta = (DATA[p] && DATA[p].meta) ? DATA[p].meta : {};
    const procName = p === 'd' ? 'Denúncias' : 'Representações';

    const answersText = MAT_QUESTIONS.map((q, i) => {
      const labels = questionnaires.map((set, idx) => {
        const a = set && set[i];
        const label = a === 'sim' ? 'Sim' : a === 'nao' ? 'Não' : a === 'talvez' ? 'Talvez' : '—';
        return `Q${idx + 1}: ${label}`;
      }).join(' | ');
      const avg = matQuestionAverage(questionnaires, i);
      return `${i+1}. [${labels}] [Média: ${avg !== null ? avg + '/100' : '—'}] ${q.text}${q.inverted ? ' (pergunta invertida)' : ''}`;
    }).join('\n');

    const prompt = `Você é um especialista em gestão por processos e maturidade organizacional. Analise os dados abaixo do processo "${procName}" e gere insights práticos e acionáveis em português brasileiro.

## PROCESSO
Nome: ${popMeta.name || procName}
Descrição: ${popMeta.desc || 'Não informado'}

## MÉTRICAS ESTRUTURAIS
- Atividades: ${metrics.totalActivities}
- Decisões: ${metrics.totalDecisions}
- Atores distintos: ${metrics.totalActors}
- Loops/retrabalho marcados (🔄): ${metrics.totalLoops}
- Handoffs (trocas de responsável): ${metrics.totalHandoffs}
- Aprovações: ${metrics.totalApprovals}
- Sistemas únicos referenciados: ${metrics.totalSistemas}
- Atividades digitalizadas (c/ sistema ou automáticas): ${metrics.actionsWithSistema} de ${metrics.totalActivities} (${(metrics.automRate*100).toFixed(0)}%)
- Pessoas indispensáveis (informado pelo usuário): ${ind}
- Sistemas indispensáveis (informado pelo usuário): ${sist}

## ÍNDICES
- Complexidade: ${metrics.complexScore.toFixed(1)} → ${metrics.complexLabel} (escala: 0–20 simples, 21–40 moderado, 41–70 complexo, 70+ muito complexo)
- Burocracia: ${(metrics.burocracia*100).toFixed(1)}% → ${metrics.burocLabel} (escala: <15% saudável, 15–30% moderado, >30% burocrático)
- Risco Operacional: ${risco.score} → ${risco.label} (escala: 0–15 baixo, 16–35 médio, 36+ alto)
- Digitalização: ${(metrics.automRate*100).toFixed(0)}% das atividades possuem sistema registrado ou são automáticas (escala: <30% baixa, 30–60% média, >60% alta)

## QUESTIONÁRIOS DA EQUIPE (3 respondentes; Sim=maduro nessa pergunta / Talvez=incerto / Não=imaduro)
${answersText}

## SCORES FINAIS (0–100, quanto maior melhor — normalização exponencial para complexidade e risco)
- Percepção da Equipe: ${equipe !== null ? Math.round(equipe) : '—'}/100 (peso 30%)
- Risco normalizado: ${final ? final.normRisco : '—'}/100 (peso 20%)
- Lean Operacional normalizado: ${final ? final.normLean : '—'}/100 (peso 30%)
- Automação (⚙️): ${final ? final.normAutomacao : '—'}/100 (peso 10%)
- Digitalização: ${final ? final.normAutom : '—'}/100 (peso 10%)
- **SCORE GERAL DE MATURIDADE: ${final ? final.final : '—'}/100**
- **NÍVEL: ${final ? final.level : '—'}** (Inicial→Gerenciado→Definido→Previsível→Otimizado)

## TAREFA
Gere uma análise estruturada com exatamente estas seções:

### 1. Diagnóstico Geral
(2-3 frases resumindo o estado atual do processo)

### 2. Pontos Críticos
(Liste os 3 principais problemas identificados nos dados)

### 3. Insights Cruzados
(Combine os índices para gerar observações não óbvias. Exemplos de padrões: baixa maturidade + alto risco = prioridade máxima; boa equipe + alta burocracia = processo engessado mas equipe adaptada; alta complexidade + poucos atores = gargalo de conhecimento; muitos loops + burocracia alta = fluxo ineficiente; alta complexidade + baixa digitalização = processo complexo sem automação = alto risco operacional latente; baixa digitalização + burocracia alta = aprovações manuais que poderiam ser sistematizadas)

### 4. Prioridade de Intervenção
(Urgente / Moderada / Baixa — com justificativa baseada nos dados)

### 5. Top 3 Recomendações
(Ações práticas e específicas para elevar o nível de maturidade)

Use linguagem direta, técnica e objetiva. Evite frases genéricas. Base todas as observações nos dados fornecidos.`;

    const text = await callGemini(prompt);
    mat.geminiAnalysis = text;
    mat.lastAnalysis   = new Date().toLocaleString('pt-BR');
    markChanged(true, true);

    resultDiv.innerHTML = `<div style="white-space:pre-wrap;font-size:13px;line-height:1.8;color:#1e293b;">${
      escapeHtml(text)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/^### (.*$)/gm, '<div style="font-size:14px;font-weight:800;color:#1B3022;margin:14px 0 4px;border-left:3px solid #6366f1;padding-left:8px;">$1</div>')
        .replace(/^## (.*$)/gm, '<div style="font-size:15px;font-weight:800;color:#1B3022;margin:16px 0 6px;">$1</div>')
        .replace(/\n/g, '<br>')
    }</div>`;
  } catch(e) {
    /* exibe mensagem de erro na interface */
    resultDiv.innerHTML = `<span style="color:#ef4444;">Erro: ${escapeHtml(e.message)}</span>`;
  } finally {
    btn.disabled    = false;
    btn.textContent = '✨ Analisar com IA';
  }
}

