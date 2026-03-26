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

