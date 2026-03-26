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

