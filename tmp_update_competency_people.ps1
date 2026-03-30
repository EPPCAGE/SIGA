$path = 'modules/competency-management/module.js'
$raw = Get-Content -Raw $path

function Replace-Block([string]$pattern, [string]$replacement) {
  $script:raw = [regex]::Replace(
    $script:raw,
    $pattern,
    $replacement,
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )
}

Replace-Block 'function populatePeopleForm\(record\) \{.*?\n  \}\r?\n\r?\n  function resetPeopleForm\(\)' @'
function populatePeopleForm(record) {
    const person = normalizeRecord(record, personTemplate());
    state.personId = person.id || '';
    setFormValue('gc-person-name', person.name);
    setFormValue('gc-person-birth-date', person.birthDate);
    setFormValue('gc-person-gender', person.gender);
    setFormValue('gc-person-entry-date', person.entryDate);
    setFormValue('gc-person-undergraduate-course', person.undergraduateCourse);
    setFormValue('gc-person-postgrad-type', person.postGradType);
    setFormValue('gc-person-postgrad-course', person.postGradCourse);
    setFormValue('gc-person-division', person.division);
    setFormValue('gc-person-team', person.team);
    setFormValue('gc-person-role', person.role);
    renderCheckboxSelector('gc-person-competencies-panel', personCompetencyOptions(), person.competencies);
    renderTrailProgressEditor(person.completedTrails);
    setFormValue('gc-person-probation', person.probation);
    setFormValue('gc-person-probation-end', person.probationEnd);
    setFormValue('gc-person-removal-interest', person.removalInterest);
    setFormValue('gc-person-desired-unit', person.desiredUnit);
    renderTextRows('gc-person-taught-courses-editor', person.taughtCourses, 'Curso ministrado');
    setFormValue('gc-person-preferences', person.preferences);
    setFormValue('gc-person-experiences', person.experiences);
    setFormValue('gc-person-notes', person.notes);
    const agePreview = birthDateAge(person.birthDate);
    setFormValue('gc-person-age-preview', agePreview ? `${agePreview} anos` : '');
  }

  function resetPeopleForm()'@

Replace-Block 'function savePerson\(\) \{.*?\n  \}\r?\n\r?\n  function removePerson\(id\)' @'
function savePerson() {
    if (!requireEditor()) return;
    const name = safeText(readFormValue('gc-person-name'));
    if (!name) return showInfo('Informe o nome da pessoa.', 'warn');
    const entryDate = safeText(readFormValue('gc-person-entry-date'));
    const probation = probationInfo(entryDate);
    const entry = {
      id: state.personId || makeId('gc_person'),
      name,
      birthDate: safeText(readFormValue('gc-person-birth-date')),
      gender: safeText(readFormValue('gc-person-gender')),
      entryDate,
      undergraduateCourse: safeText(readFormValue('gc-person-undergraduate-course')),
      postGradType: safeText(readFormValue('gc-person-postgrad-type')),
      postGradCourse: safeText(readFormValue('gc-person-postgrad-course')),
      division: safeText(readFormValue('gc-person-division')),
      team: safeText(readFormValue('gc-person-team')),
      role: safeText(readFormValue('gc-person-role')),
      competencies: readCheckboxSelector('gc-person-competencies-panel'),
      preferences: safeText(readFormValue('gc-person-preferences')),
      experiences: safeText(readFormValue('gc-person-experiences')),
      completedTrails: readTrailProgressEditor(),
      probation: probation.probation,
      probationEnd: probation.probationEnd,
      removalInterest: safeText(readFormValue('gc-person-removal-interest')) || 'Não',
      desiredUnit: safeText(readFormValue('gc-person-desired-unit')),
      taughtCourses: readTextRows('gc-person-taught-courses-editor'),
      notes: safeText(readFormValue('gc-person-notes')),
    };
    const list = people();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index -ge 0) { $null = $null }
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Pessoa atualizada.' : 'Pessoa cadastrada.');
    resetPeopleForm();
    renderAll();
  }

  function removePerson(id)'@

Replace-Block 'function renderPeopleList\(\) \{.*?\n  \}\r?\n\r?\n  function renderPeople\(\)' @'
function renderPeopleList() {
    const list = byId('gc-people-list');
    if (!list) return;
    list.replaceChildren();
    const filter = safeText(readFormValue('gc-people-filter')).toLowerCase();
    const items = people().filter((item) => !filter || personSearchCorpus(item).toLowerCase().includes(filter));
    if (!items.length) {
      list.appendChild(createNode('div', 'gc-empty', 'Nenhuma pessoa cadastrada ainda.'));
      return;
    }
    items.forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      const head = createNode('div', 'gc-list-head');
      const wrap = createNode('div');
      const title = createButton(item.name, 'gc-list-title', () => populatePeopleForm(item));
      title.classList.add('btn-link');
      wrap.append(title, createNode('div', 'gc-list-meta', [item.role, item.division, item.team].filter(Boolean).join(' • ')));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populatePeopleForm(item)));
      actions.append(createButton('Remoção', 'btn btn-outline', () => populateRemovalForm({ ...removalTemplate(), personId: item.id, fromUnit: item.division })));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removePerson(item.id)));
      head.append(wrap, actions);
      card.appendChild(head);
      if (item.competencies.length) {
        const badges = createNode('div', 'gc-badges');
        item.competencies.slice(0, 8).forEach((value) => badges.appendChild(createNode('span', 'gc-badge', value)));
        if (item.probation === 'Sim') badges.appendChild(createNode('span', 'gc-badge alert', `Prob. até ${item.probationEnd}`));
        if (item.removalInterest === 'Sim' && item.desiredUnit) badges.appendChild(createNode('span', 'gc-badge match', `Interesse: ${item.desiredUnit}`));
        card.appendChild(badges);
      }
      if (item.completedTrails.length) {
        const trailsSummary = item.completedTrails.map((entry) => `${entry.trailName || getTrailById(entry.trailId)?.name || 'Trilha'} (${levelLabel(entry.level) || entry.level})`).join(' • ');
        card.appendChild(createNode('div', 'gc-list-text', `Trilhas cursadas: ${trailsSummary}`));
      }
      if (item.preferences) card.appendChild(createNode('div', 'gc-list-text', `Preferências: ${item.preferences}`));
      if (item.taughtCourses.length) card.appendChild(createNode('div', 'gc-list-text', `Cursos ministrados: ${item.taughtCourses.join(' • ')}`));
      list.appendChild(card);
    });
  }

  function renderPeople()'@

Replace-Block 'function renderPeople\(\) \{.*?\n  \}\r?\n\r?\n  function renderGaps\(\)' @'
function renderPeople() {
    setDataListOptions('gc-units-list', getUnits());
    setDataListOptions('gc-teams-list', getTeams());
    setDataListOptions('gc-roles-list', getRoles());
    setSelectOptions('gc-feedback-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    setSelectOptions('gc-person-undergraduate-course', UNDERGRAD_COURSES, 'Selecione', (item) => ({ value: item, label: item }));
    setSelectOptions('gc-person-postgrad-type', POSTGRAD_TYPES, 'Selecione', (item) => ({ value: item, label: item }));
    renderCheckboxSelector('gc-person-competencies-panel', personCompetencyOptions(), readCheckboxSelector('gc-person-competencies-panel'));
    renderPeopleList();
    renderFeedbacks();
  }

  function renderGaps()'@

Replace-Block 'function renderGaps\(\) \{.*?\n  \}\r?\n\r?\n  function renderFeedbacks\(\)' @'
function renderGaps() {
    setSelectOptions('gc-gap-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    const list = byId('gc-gap-list');
    if (!list) return;
    list.replaceChildren();
    if (!gapAnalyses().length) {
      list.appendChild(createNode('div', 'gc-empty', 'Nenhuma análise de gaps cadastrada.'));
      return;
    }
    gapAnalyses().forEach((item) => {
      const person = getPersonById(item.personId);
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', person ? person.name : 'Pessoa não encontrada'));
      card.append(createNode('div', 'gc-list-meta', [item.role, item.division, item.team, item.analysisDate].filter(Boolean).join(' • ')));
      card.append(createNode('div', 'gc-list-text', `Índice de compatibilidade: ${item.compatibilityIndex || 0}%`));
      if (item.diagnosis) card.appendChild(createNode('div', 'gc-list-text', item.diagnosis));
      if (item.recommendations) card.appendChild(createNode('div', 'gc-list-text', `Sugestões: ${item.recommendations}`));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateGapForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeGap(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function renderFeedbacks()'@

Replace-Block 'async function importPeopleFile\(file\) \{.*?\n  \}\r?\n\r?\n  function populateGapForm\(record\)' @'
async function importPeopleFile(file) {
    if (!requireEditor() || !file) return;
    if (typeof XLSX === 'undefined') return showInfo('Biblioteca XLSX não carregada.', 'warn');
    try {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const existing = new Map(people().map((item) => [personKey(item), item]));
      let created = 0;
      rows.forEach((row) => {
        const draft = {
          id: makeId('gc_person'),
          name: safeText(row.nome || row.Nome),
          birthDate: safeText(row['data de nascimento'] || row['Data de nascimento']),
          role: safeText(row.cargo || row.Cargo),
          gender: safeText(row.sexo || row.Sexo),
          entryDate: safeText(row['data de entrada na CAGE'] || row['data de entrada'] || row.posse),
          undergraduateCourse: safeText(row['curso superior'] || row['Curso superior'] || row['formação básica'] || row['formacao basica']),
          postGradType: safeText(row['tipo de pós-graduação'] || row['tipo de pos-graduacao']),
          postGradCourse: safeText(row['curso de pós-graduação'] || row['curso de pos-graduacao'] || row['formação complementar'] || row['formacao complementar']),
          division: safeText(row.divisão || row.divisao || row.unidade),
          team: safeText(row.equipe),
          competencies: splitList(row['competências'] || row.competencias),
          preferences: safeText(row['preferencias/objetivos pessoais na carreira'] || row.preferencias),
          experiences: safeText(row['experiencias relevantes anteriores'] || row.experiencias),
          removalInterest: safeText(row['interesse remoção'] || row['interesse remocao']) || 'Não',
          desiredUnit: safeText(row['para onde'] || row.destino),
          taughtCourses: splitLines(row['cursos ministrados'] || row['ja ministrou cursos?']),
          completedTrails: [],
          notes: '',
        };
        if (!draft.name) return;
        const probation = probationInfo(draft.entryDate);
        const candidate = { ...personTemplate(), ...draft, probation: probation.probation, probationEnd: probation.probationEnd };
        const key = personKey(candidate);
        if (existing.has(key)) return;
        people().push(candidate);
        existing.set(key, candidate);
        created += 1;
      });
      persist(`${created} pessoa(s) importada(s) sem duplicidade.`);
      renderAll();
    } catch (error) {
      showInfo(`Erro ao importar planilha: ${error.message}`, 'warn');
    } finally {
      const input = byId('gc-people-import');
      if (input) input.value = '';
    }
  }

  function populateGapForm(record)'@

Replace-Block 'function populateGapForm\(record\) \{.*?\n  \}\r?\n\r?\n  function resetGapForm\(\)' @'
function populateGapForm(record) {
    const item = normalizeRecord(record, gapTemplate());
    state.gapId = item.id || '';
    setFormValue('gc-gap-person', item.personId);
    setFormValue('gc-gap-division', item.division);
    setFormValue('gc-gap-team', item.team);
    setFormValue('gc-gap-role', item.role);
    setFormValue('gc-gap-analysis-date', item.analysisDate);
    setFormValue('gc-gap-observations', item.observations);
    setFormValue('gc-gap-diagnosis', item.diagnosis);
    setFormValue('gc-gap-compatibility', item.compatibilityIndex ? `${item.compatibilityIndex}%` : '');
    setFormValue('gc-gap-recommendations', item.recommendations);
    setFormValue('gc-gap-action', item.actionPlan);
    renderGapAssessmentEditor(buildGapAssessmentRows(getPersonById(item.personId), item.assessments));
  }

  function resetGapForm()'@

Replace-Block 'function saveGap\(\) \{.*?\n  \}\r?\n\r?\n  function removeGap\(id\)' @'
function saveGap() {
    if (!requireEditor()) return;
    const personId = safeText(readFormValue('gc-gap-person'));
    if (!personId) return showInfo('Selecione a pessoa para registrar a análise.', 'warn');
    const person = getPersonById(personId);
    if (!person) return showInfo('Pessoa não encontrada para a análise.', 'warn');
    const assessments = readGapAssessments();
    const diagnosis = computeGapDiagnosis(person, assessments);
    const entry = {
      id: state.gapId || makeId('gc_gap'),
      personId,
      division: safeText(readFormValue('gc-gap-division')),
      team: safeText(readFormValue('gc-gap-team')),
      role: safeText(readFormValue('gc-gap-role')),
      analysisDate: safeText(readFormValue('gc-gap-analysis-date')),
      assessments,
      diagnosis: diagnosis.diagnosis,
      compatibilityIndex: diagnosis.compatibilityIndex,
      observations: safeText(readFormValue('gc-gap-observations')),
      recommendations: diagnosis.recommendations,
      actionPlan: diagnosis.actionPlan,
    };
    const list = gapAnalyses();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Análise de gaps atualizada.' : 'Análise de gaps registrada.');
    resetGapForm();
    renderAll();
  }

  function removeGap(id)'@

Replace-Block "const viewPerformance = byId\\('gc-view-performance'\\);" @'
const viewGaps = byId('gc-view-gaps');
    const viewPerformance = byId('gc-view-performance');
'@

Replace-Block "if \\(!viewPeople \\|\\| !viewPerformance \\|\\| !viewRemovals \\|\\| !viewCompetencies \\|\\| !viewTrails \\|\\| !viewSurveys \\|\\| !viewTalent\\) return;" "if (!viewPeople || !viewGaps || !viewPerformance || !viewRemovals || !viewCompetencies || !viewTrails || !viewSurveys || !viewTalent) return;"

Replace-Block 'viewPeople\.innerHTML = `.*?`;\r?\n    viewPerformance\.innerHTML =' @'
viewPeople.innerHTML = `<div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Cadastrar pessoa</div><div class="gc-panel-desc">Cadastre dados pessoais, competências, trilhas cursadas e histórico de capacitação.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-person-name">Nome</label><input id="gc-person-name" type="text" maxlength="160"></div><div class="gc-field"><label for="gc-person-birth-date">Data de nascimento</label><input id="gc-person-birth-date" type="date"></div><div class="gc-field"><label for="gc-person-age-preview">Idade calculada</label><input id="gc-person-age-preview" type="text" readonly></div><div class="gc-field"><label for="gc-person-gender">Sexo</label><select id="gc-person-gender"><option value="">Selecione</option><option value="Feminino">Feminino</option><option value="Masculino">Masculino</option><option value="Outro">Outro</option></select></div><div class="gc-field"><label for="gc-person-entry-date">Entrada na CAGE</label><input id="gc-person-entry-date" type="date"></div><div class="gc-field"><label for="gc-person-undergraduate-course">Curso superior</label><select id="gc-person-undergraduate-course"></select></div><div class="gc-field"><label for="gc-person-postgrad-type">Pós-graduação</label><select id="gc-person-postgrad-type"></select></div><div class="gc-field"><label for="gc-person-postgrad-course">Curso de pós-graduação</label><input id="gc-person-postgrad-course" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-person-division">Divisão</label><input id="gc-person-division" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-team">Equipe</label><input id="gc-person-team" type="text" list="gc-teams-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-role">Cargo</label><input id="gc-person-role" type="text" list="gc-roles-list" maxlength="120"></div><div class="gc-field gc-field-span-2"><label>Competências</label><div class="gc-check-panel" id="gc-person-competencies-panel"></div></div><div class="gc-field gc-field-span-2"><label>Trilhas cursadas</label><div class="gc-inline-editor" id="gc-person-trails-editor"></div><button type="button" class="btn btn-outline gc-inline-add" id="gc-add-person-trail">Adicionar trilha</button></div><div class="gc-field"><label for="gc-person-probation">Em estágio probatório?</label><input id="gc-person-probation" type="text" readonly></div><div class="gc-field"><label for="gc-person-probation-end">Término do probatório</label><input id="gc-person-probation-end" type="date" readonly></div><div class="gc-field"><label for="gc-person-removal-interest">Interesse em remoção</label><select id="gc-person-removal-interest"><option value="Não">Não</option><option value="Sim">Sim</option></select></div><div class="gc-field"><label for="gc-person-desired-unit">Unidade desejada</label><input id="gc-person-desired-unit" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field gc-field-span-2"><label>Cursos ministrados</label><div class="gc-inline-editor" id="gc-person-taught-courses-editor"></div><button type="button" class="btn btn-outline gc-inline-add" id="gc-add-taught-course">Adicionar curso ministrado</button></div><div class="gc-field"><label for="gc-person-preferences">Preferências / objetivos</label><textarea id="gc-person-preferences"></textarea></div><div class="gc-field"><label for="gc-person-experiences">Experiências relevantes</label><textarea id="gc-person-experiences"></textarea></div><div class="gc-field"><label for="gc-person-notes">Observações</label><textarea id="gc-person-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-person">Salvar pessoa</button><button type="button" class="btn btn-outline" id="gc-reset-person">Limpar</button><button type="button" class="btn btn-outline" id="gc-import-people-trigger">Importar planilha</button><input id="gc-people-import" type="file" accept=".xlsx,.xls,.csv" style="display:none;"></div></div><div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Quadro de pessoal</div><div class="gc-panel-desc">Lista clicável com filtros por texto livre.</div></div><div class="gc-filter-row"><input id="gc-people-filter" type="search" placeholder="Filtrar por nome, cargo, equipe, divisão ou competência"></div></div><div class="gc-list" id="gc-people-list"></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Reuniões de feedback</div><div class="gc-panel-desc">Registre participantes, objetivos e ata por pessoa.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-feedback-person">Pessoa</label><select id="gc-feedback-person"></select></div><div class="gc-field"><label for="gc-feedback-date">Data</label><input id="gc-feedback-date" type="date"></div><div class="gc-field"><label for="gc-feedback-participants">Participantes</label><input id="gc-feedback-participants" type="text" maxlength="220"></div><div class="gc-field"><label for="gc-feedback-objectives">Objetivos</label><textarea id="gc-feedback-objectives"></textarea></div><div class="gc-field"><label for="gc-feedback-minutes">Ata</label><textarea id="gc-feedback-minutes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-feedback">Salvar feedback</button><button type="button" class="btn btn-outline" id="gc-reset-feedback">Limpar</button></div><div class="gc-list" id="gc-feedback-list"></div></div></div>`;
    viewGaps.innerHTML = `<div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Análise de Gaps</div><div class="gc-panel-desc">Ao selecionar o servidor, o sistema carrega equipe, cargo, divisão e as competências esperadas para avaliação de proficiência.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-gap-person">Servidor</label><select id="gc-gap-person"></select></div><div class="gc-field"><label for="gc-gap-analysis-date">Data da análise</label><input id="gc-gap-analysis-date" type="date"></div><div class="gc-field"><label for="gc-gap-division">Divisão</label><input id="gc-gap-division" type="text" readonly></div><div class="gc-field"><label for="gc-gap-team">Equipe</label><input id="gc-gap-team" type="text" readonly></div><div class="gc-field"><label for="gc-gap-role">Cargo</label><input id="gc-gap-role" type="text" readonly></div><div class="gc-field gc-field-span-2"><label>Competências avaliadas</label><div class="gc-assessment-list" id="gc-gap-assessment-list"></div></div><div class="gc-field"><label for="gc-gap-observations">Observações da análise</label><textarea id="gc-gap-observations"></textarea></div><div class="gc-field"><label for="gc-gap-diagnosis">Diagnóstico automático</label><textarea id="gc-gap-diagnosis" readonly></textarea></div><div class="gc-field"><label for="gc-gap-compatibility">Índice de compatibilidade</label><input id="gc-gap-compatibility" type="text" readonly></div><div class="gc-field"><label for="gc-gap-recommendations">Sugestões de capacitação</label><textarea id="gc-gap-recommendations" readonly></textarea></div><div class="gc-field gc-field-span-2"><label for="gc-gap-action">Plano de ação sugerido</label><textarea id="gc-gap-action" readonly></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-gap">Salvar análise</button><button type="button" class="btn btn-outline" id="gc-reset-gap">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Histórico de análises</div><div class="gc-panel-desc">Compatibilidade com a função, lacunas técnicas e ações sugeridas para sucessão e alocação em projetos.</div></div></div><div class="gc-list" id="gc-gap-list"></div></div>`;
    viewPerformance.innerHTML ='@

Replace-Block '<section class="gc-view" data-view="people" id="gc-view-people" style="display:none;"></section>\r?\n        <section class="gc-view" data-view="performance"' @'
<section class="gc-view" data-view="people" id="gc-view-people" style="display:none;"></section>
        <section class="gc-view" data-view="gaps" id="gc-view-gaps" style="display:none;"></section>
        <section class="gc-view" data-view="performance"'@

Replace-Block 'function bindActions\(\) \{.*?\n  \}\r?\n\r?\n  function fillSuggestionList\(\)' @'
function bindActions() {
    byId('gc-save-person')?.addEventListener('click', savePerson);
    byId('gc-reset-person')?.addEventListener('click', resetPeopleForm);
    byId('gc-people-filter')?.addEventListener('input', renderPeopleList);
    byId('gc-import-people-trigger')?.addEventListener('click', () => byId('gc-people-import')?.click());
    byId('gc-people-import')?.addEventListener('change', (event) => importPeopleFile(event.target.files?.[0]));
    byId('gc-person-entry-date')?.addEventListener('change', () => {
      const data = probationInfo(readFormValue('gc-person-entry-date'));
      setFormValue('gc-person-probation', data.probation);
      setFormValue('gc-person-probation-end', data.probationEnd);
    });
    byId('gc-person-birth-date')?.addEventListener('change', () => {
      const age = birthDateAge(readFormValue('gc-person-birth-date'));
      setFormValue('gc-person-age-preview', age ? `${age} anos` : '');
    });
    byId('gc-add-person-trail')?.addEventListener('click', () => {
      byId('gc-person-trails-editor')?.appendChild(createTrailProgressRow({ trailId: '', level: '' }));
    });
    byId('gc-add-taught-course')?.addEventListener('click', () => {
      byId('gc-person-taught-courses-editor')?.appendChild(createTextRow('', 'Curso ministrado'));
    });
    byId('gc-save-gap')?.addEventListener('click', saveGap);
    byId('gc-reset-gap')?.addEventListener('click', resetGapForm);
    byId('gc-gap-person')?.addEventListener('change', () => {
      const person = getPersonById(readFormValue('gc-gap-person'));
      if (!person) {
        resetGapForm();
        return;
      }
      populateGapForm({
        ...gapTemplate(),
        personId: person.id,
        division: person.division,
        team: person.team,
        role: person.role,
        analysisDate: new Date().toISOString().slice(0, 10),
      });
    });
    byId('gc-save-feedback')?.addEventListener('click', saveFeedback);
    byId('gc-reset-feedback')?.addEventListener('click', resetFeedbackForm);
    byId('gc-save-performance')?.addEventListener('click', savePerformance);
    byId('gc-reset-performance')?.addEventListener('click', resetPerformanceForm);
    byId('gc-performance-filter-person')?.addEventListener('change', renderPerformance);
    byId('gc-performance-filter-unit')?.addEventListener('input', renderPerformance);
    byId('gc-performance-filter-role')?.addEventListener('input', renderPerformance);
    byId('gc-save-removal')?.addEventListener('click', saveRemoval);
    byId('gc-reset-removal')?.addEventListener('click', resetRemovalForm);
    byId('gc-save-competency')?.addEventListener('click', saveCompetency);
    byId('gc-reset-competency')?.addEventListener('click', resetCompetencyForm);
    byId('gc-save-trail')?.addEventListener('click', saveTrail);
    byId('gc-reset-trail')?.addEventListener('click', resetTrailForm);
    byId('gc-save-training')?.addEventListener('click', saveTraining);
    byId('gc-reset-training')?.addEventListener('click', resetTrainingForm);
    byId('gc-save-survey')?.addEventListener('click', saveSurvey);
    byId('gc-reset-survey')?.addEventListener('click', resetSurveyForm);
    byId('gc-run-talent-search')?.addEventListener('click', runTalentSearchAi);
    byId('gc-talent-query')?.addEventListener('input', handleTalentSearchInput);
  }

  function fillSuggestionList()'@

Set-Content -Path $path -Value $raw -Encoding UTF8
