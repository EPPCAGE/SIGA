(function competencyManagementModule() {
  'use strict';

  const MODULE_ID = 'competency-module';
  const DATA_KEY = 'competencyManagement';
  const HOME_CARD_ID = 'home-competency-card';
  const SIDEBAR_BTN_ID = 'sidebar-competency-btn';
  const TABS = [
    { key: 'overview', label: 'Visão Geral' },
    { key: 'people', label: 'Quadro de Pessoal' },
    { key: 'performance', label: 'Performance' },
    { key: 'removals', label: 'Banco de Remoções' },
    { key: 'competencies', label: 'Competências' },
    { key: 'trails', label: 'Trilhas e Treinamentos' },
    { key: 'surveys', label: 'Pesquisa de Ambiente' },
    { key: 'talent', label: 'Banco de Talentos' },
  ];
  const COMPETENCY_TYPES = [
    { value: 'hard', label: 'Hard Skills' },
    { value: 'soft', label: 'Soft Skills' },
    { value: 'normative', label: 'Conhecimentos Normativos' },
  ];
  const FIXED_TRAIL_LEVELS = [
    'Iniciante',
    'Básico',
    'Intermediário',
    'Avançado',
    'Especialista',
  ];
  const DEFAULT_STORE = {
    people: [],
    gapAnalyses: [],
    feedbackMeetings: [],
    performanceReviews: [],
    removals: [],
    competencies: [],
    trails: [],
    trainings: [],
    surveys: [],
  };
  const state = {
    tab: 'overview',
    personId: '',
    gapId: '',
    feedbackId: '',
    performanceId: '',
    removalId: '',
    competencyId: '',
    trailId: '',
    trainingId: '',
    surveyId: '',
    talentSearch: null,
    talentLoading: false,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function appMain() {
    return document.querySelector('main.main');
  }

  function createNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createButton(label, className, onClick) {
    const button = createNode('button', className, label);
    button.type = 'button';
    if (onClick) button.addEventListener('click', onClick);
    return button;
  }

  function createOption(value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }

  function safeArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function safeText(value) {
    return String(value || '').trim();
  }

  function parseNumber(value) {
    const num = Number(String(value || '').replaceAll(',', '.'));
    return Number.isFinite(num) ? num : 0;
  }

  function splitList(value) {
    return safeText(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function uniqueSorted(items) {
    return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function readFormValue(id) {
    const field = byId(id);
    return field ? field.value : '';
  }

  function setFormValue(id, value) {
    const field = byId(id);
    if (field) field.value = value || '';
  }

  function setSelectOptions(id, items, placeholder, mapper) {
    const select = byId(id);
    if (!select) return;
    select.replaceChildren(createOption('', placeholder));
    items.forEach((item) => {
      const mapped = mapper(item);
      select.appendChild(createOption(mapped.value, mapped.label));
    });
  }

  function setDataListOptions(id, items) {
    const list = byId(id);
    if (!list) return;
    list.replaceChildren();
    uniqueSorted(items).forEach((item) => {
      const option = document.createElement('option');
      option.value = item;
      list.appendChild(option);
    });
  }

  function showInfo(message, type) {
    if (typeof showToast === 'function') showToast(message, type || 'success');
  }

  function persist(message) {
    if (typeof markChanged === 'function') markChanged(true, true);
    if (globalThis.currentUser && globalThis._appInitialized && typeof saveToCloud === 'function') {
      saveToCloud();
    }
    if (message) showInfo(message, 'success');
  }

  function requireEditor() {
    if (typeof isEditor === 'undefined' || isEditor) return true;
    showInfo('Apenas editores podem alterar o módulo de competências.', 'warn');
    return false;
  }

  function safeUrl(url) {
    const target = safeText(url);
    if (!target) return '';
    if (typeof URL.canParse === 'function' && !URL.canParse(target, location.href)) return '';
    const parsed = new URL(target, location.href);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  }

  function yearsSince(dateValue) {
    const date = safeText(dateValue);
    if (!date) return 0;
    const start = new Date(`${date}T00:00:00`);
    if (Number.isNaN(start.getTime())) return 0;
    const diff = Date.now() - start.getTime();
    return Math.max(0, Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000)));
  }

  function probationInfo(entryDate) {
    const date = safeText(entryDate);
    if (!date) return { probation: 'Não', probationEnd: '' };
    const start = new Date(`${date}T00:00:00`);
    if (Number.isNaN(start.getTime())) return { probation: 'Não', probationEnd: '' };
    const end = new Date(start);
    end.setFullYear(end.getFullYear() + 3);
    const probation = end.getTime() > Date.now() ? 'Sim' : 'Não';
    const probationEnd = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    return { probation, probationEnd };
  }

  function personKey(person) {
    return `${safeText(person.name).toLowerCase()}|${safeText(person.role).toLowerCase()}`;
  }

  function normalizeRecord(record, template) {
    const normalized = { ...template };
    Object.keys(template).forEach((key) => {
      normalized[key] = record?.[key] !== undefined ? record[key] : template[key];
    });
    return normalized;
  }

  function ensureStore() {
    const hasGlobalData = globalThis.DATA && typeof globalThis.DATA === 'object';
    if (hasGlobalData !== true) {
      globalThis.DATA = {};
    }
    const hasModuleStore = DATA[DATA_KEY] && typeof DATA[DATA_KEY] === 'object';
    if (hasModuleStore !== true) {
      DATA[DATA_KEY] = { ...DEFAULT_STORE };
    }
    Object.keys(DEFAULT_STORE).forEach((key) => {
      DATA[DATA_KEY][key] = safeArray(DATA[DATA_KEY][key]);
    });
    return DATA[DATA_KEY];
  }

  function getStore() {
    return ensureStore();
  }

  function people() {
    return getStore().people;
  }

  function removals() {
    return getStore().removals;
  }

  function competencies() {
    return getStore().competencies;
  }

  function trails() {
    return getStore().trails;
  }

  function trainings() {
    return getStore().trainings;
  }

  function surveys() {
    return getStore().surveys;
  }

  function gapAnalyses() {
    return getStore().gapAnalyses;
  }

  function feedbackMeetings() {
    return getStore().feedbackMeetings;
  }

  function performanceReviews() {
    return getStore().performanceReviews;
  }

  function personTemplate() {
    return {
      id: '',
      name: '',
      age: '',
      gender: '',
      entryDate: '',
      basicEducation: '',
      extraEducation: '',
      unit: '',
      team: '',
      role: '',
      competencies: [],
      preferences: '',
      experiences: '',
      completedTrails: [],
      probation: 'Não',
      probationEnd: '',
      removalInterest: 'Não',
      desiredUnit: '',
      taughtCourses: '',
      notes: '',
    };
  }

  function gapTemplate() {
    return {
      id: '',
      personId: '',
      unit: '',
      team: '',
      currentCompetencies: '',
      requiredCompetencies: '',
      observations: '',
      recommendations: '',
      actionPlan: '',
    };
  }

  function feedbackTemplate() {
    return {
      id: '',
      personId: '',
      date: '',
      participants: '',
      objectives: '',
      minutes: '',
    };
  }

  function performanceTemplate() {
    return {
      id: '',
      personId: '',
      date: '',
      method: '',
      objective: '',
      result: '',
      notes: '',
    };
  }

  function removalTemplate() {
    return { id: '', personId: '', fromUnit: '', desiredUnit: '', notes: '' };
  }

  function competencyTemplate() {
    return {
      id: '',
      name: '',
      type: 'hard',
      macroprocess: '',
      process: '',
      role: '',
      division: '',
      team: '',
      personId: '',
      trailId: '',
      trainingId: '',
      description: '',
    };
  }

  function trailTemplate() {
    return {
      id: '',
      name: '',
      objective: '',
      macroprocess: '',
      division: '',
      competencies: [],
      prerequisites: [],
      levels: FIXED_TRAIL_LEVELS.map((name) => ({ name, goal: '' })),
    };
  }

  function trainingTemplate() {
    return {
      id: '',
      name: '',
      costType: '',
      deliveryMode: '',
      remoteLink: '',
      provider: '',
      trailId: '',
      personIds: [],
      notes: '',
    };
  }

  function surveyTemplate() {
    return { id: '', year: '', engagement: '', leadership: '', climate: '', notes: '' };
  }

  function normalizeData() {
    getStore().people = people().map((item) => normalizeRecord(item, personTemplate())).map((item) => ({
      ...item,
      competencies: safeArray(item.competencies),
      completedTrails: safeArray(item.completedTrails),
    }));
    getStore().gapAnalyses = gapAnalyses().map((item) => normalizeRecord(item, gapTemplate()));
    getStore().feedbackMeetings = feedbackMeetings().map((item) => normalizeRecord(item, feedbackTemplate()));
    getStore().performanceReviews = performanceReviews().map((item) => normalizeRecord(item, performanceTemplate()));
    getStore().removals = removals().map((item) => normalizeRecord(item, removalTemplate()));
    getStore().competencies = competencies().map((item) => normalizeRecord(item, competencyTemplate()));
    getStore().trails = trails().map((item) => normalizeRecord(item, trailTemplate())).map((item) => ({
      ...item,
      competencies: safeArray(item.competencies),
      prerequisites: safeArray(item.prerequisites),
      levels: safeArray(item.levels),
    }));
    getStore().trainings = trainings().map((item) => normalizeRecord(item, trainingTemplate())).map((item) => ({
      ...item,
      personIds: safeArray(item.personIds),
    }));
    getStore().surveys = surveys().map((item) => normalizeRecord(item, surveyTemplate()));
  }

  function getUnits() {
    const fromConfig = typeof getConfig === 'function' ? getConfig('areas') : [];
    const fromMap = typeof getConfig === 'function' ? getConfig('equipeUnidade') : [];
    const mapped = safeArray(fromMap).flatMap((item) => [item?.unidade, item?.area, item?.sigla]);
    return uniqueSorted([...safeArray(fromConfig), ...mapped, ...people().map((item) => item.unit)]);
  }

  function getTeams() {
    const fromConfig = typeof getConfig === 'function' ? getConfig('equipes') : [];
    const fromMap = typeof getConfig === 'function' ? getConfig('equipeUnidade') : [];
    const mapped = safeArray(fromMap).flatMap((item) => [item?.equipe, item?.team]);
    return uniqueSorted([...safeArray(fromConfig), ...mapped, ...people().map((item) => item.team)]);
  }

  function getRoles() {
    const fromConfig = typeof getConfig === 'function' ? safeArray(getConfig('cargos')) : [];
    const fromPeople = people().map((item) => item.role).filter(Boolean);
    return uniqueSorted([...fromConfig, ...fromPeople]);
  }

  function getMacroprocesses() {
    return typeof getConfig === 'function' ? safeArray(getConfig('macroprocessos')) : [];
  }

  function getProcesses() {
    if (typeof arqGetData !== 'function') return [];
    return uniqueSorted(arqGetData().map((item) => item.processo).filter(Boolean));
  }

  function getCompetencySuggestions() {
    const hard = typeof getConfig === 'function' ? safeArray(getConfig('hardSkills')) : [];
    const soft = typeof getConfig === 'function' ? safeArray(getConfig('softSkills')) : [];
    const normative = typeof getConfig === 'function' ? safeArray(getConfig('conhecimentosNormativos')) : [];
    return uniqueSorted([...hard, ...soft, ...normative, ...competencies().map((item) => item.name)]);
  }

  function syncCompetencyCatalog(item) {
    if (typeof getConfig !== 'function' || typeof setConfig !== 'function') return;
    const map = { hard: 'hardSkills', soft: 'softSkills', normative: 'conhecimentosNormativos' };
    const configKey = map[item.type];
    const name = safeText(item.name);
    if (!configKey || !name) return;
    const current = safeArray(getConfig(configKey));
    const exists = current.some((value) => String(value).toLowerCase() === name.toLowerCase());
    if (!exists) setConfig(configKey, [...current, name]);
  }

  function syncRoleCatalog(role) {
    if (typeof getConfig !== 'function' || typeof setConfig !== 'function') return;
    const value = safeText(role);
    if (!value) return;
    const current = safeArray(getConfig('cargos'));
    const exists = current.some((item) => String(item).toLowerCase() === value.toLowerCase());
    if (!exists) setConfig('cargos', [...current, value]);
  }

  function getPersonById(id) {
    return people().find((item) => item.id === id) || null;
  }

  function getTrailById(id) {
    return trails().find((item) => item.id === id) || null;
  }

  function getTypeLabel(type) {
    const found = COMPETENCY_TYPES.find((item) => item.value === type);
    return found ? found.label : 'Competência';
  }

  function getTypeBadgeClass(type) {
    if (type === 'soft') return 'soft';
    if (type === 'normative') return 'normative';
    return 'hard';
  }

  function tokenize(text) {
    return safeText(text)
      .toLowerCase()
      .normalize('NFD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/i)
      .filter(Boolean);
  }

  function personSearchCorpus(person) {
    const trailsText = safeArray(person.completedTrails).join(' ');
    const removal = removals().find((item) => item.personId === person.id);
    return [
      person.name,
      person.role,
      person.unit,
      person.team,
      person.basicEducation,
      person.extraEducation,
      person.preferences,
      person.experiences,
      safeArray(person.competencies).join(' '),
      trailsText,
      person.desiredUnit,
      removal?.desiredUnit,
    ].join(' ');
  }

  function architectureEntries() {
    if (typeof arqGetData !== 'function') return [];
    return safeArray(arqGetData()).map((item) => ({
      macroprocesso: safeText(item?.macroprocesso),
      processo: safeText(item?.processo),
      subprocesso: safeText(item?.subprocesso),
      area: safeText(item?.area),
      equipe: safeText(item?.equipe),
      sigla: safeText(item?.sigla),
      gerente: safeText(item?.gerente),
    }));
  }

  function architectureCorpus(entry) {
    return [
      entry.macroprocesso,
      entry.processo,
      entry.subprocesso,
      entry.area,
      entry.equipe,
      entry.sigla,
      entry.gerente,
    ].join(' ');
  }

  function relatedArchitectureEntries(queryText, roleText, prereqList) {
    const tokens = uniqueSorted([
      ...tokenize(queryText),
      ...tokenize(roleText),
      ...prereqList.flatMap((item) => tokenize(item)),
    ]);
    if (!tokens.length) return architectureEntries().slice(0, 8);
    return architectureEntries()
      .map((entry) => {
        const corpus = tokenize(architectureCorpus(entry));
        const score = tokens.reduce((total, token) => total + (corpus.includes(token) ? 10 : 0), 0);
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.entry);
  }

  function architectureLinkedCompetencies(entries, roleText, prereqList) {
    const processes = new Set(entries.map((item) => safeText(item.processo).toLowerCase()).filter(Boolean));
    const macros = new Set(entries.map((item) => safeText(item.macroprocesso).toLowerCase()).filter(Boolean));
    const divisions = new Set(entries.map((item) => safeText(item.area).toLowerCase()).filter(Boolean));
    const teams = new Set(entries.map((item) => safeText(item.equipe).toLowerCase()).filter(Boolean));
    const role = safeText(roleText).toLowerCase();
    const required = prereqList.map((item) => item.toLowerCase());

    const names = competencies()
      .filter((item) => {
        const process = safeText(item.process).toLowerCase();
        const macro = safeText(item.macroprocess).toLowerCase();
        const division = safeText(item.division).toLowerCase();
        const team = safeText(item.team).toLowerCase();
        const itemRole = safeText(item.role).toLowerCase();
        if (process && processes.has(process)) return true;
        if (macro && macros.has(macro)) return true;
        if (division && divisions.has(division)) return true;
        if (team && teams.has(team)) return true;
        if (role && itemRole === role) return true;
        return required.some((value) =>
          safeText(item.name).toLowerCase().includes(value) ||
          safeText(item.description).toLowerCase().includes(value),
        );
      })
      .map((item) => item.name);

    return uniqueSorted(names);
  }

  function buildTalentCandidate(person, roleText, prereqList, architectureCompetencies, architectureMatches) {
    const role = safeText(roleText).toLowerCase();
    const personRole = safeText(person.role).toLowerCase();
    const skills = safeArray(person.competencies).map((item) => safeText(item).toLowerCase());
    const desiredUnit = safeText(person.desiredUnit).toLowerCase();
    const queryTokens = tokenize(readFormValue('gc-talent-query'));
    const corpus = tokenize(personSearchCorpus(person));
    const architectureTokens = new Set(architectureMatches.flatMap((item) => tokenize(architectureCorpus(item))));
    let score = 0;
    const reasons = [];

    if (role && personRole === role) {
      score += 22;
      reasons.push(`cargo aderente: ${person.role}`);
    }

    prereqList.forEach((item) => {
      if (skills.some((skill) => skill.includes(item.toLowerCase()))) {
        score += 14;
        reasons.push(`atende pré-requisito: ${item}`);
      }
    });

    architectureCompetencies.forEach((item) => {
      if (skills.some((skill) => skill.includes(item.toLowerCase()))) {
        score += 10;
        reasons.push(`competência vinculada à arquitetura: ${item}`);
      }
    });

    queryTokens.forEach((token) => {
      if (corpus.includes(token)) score += 6;
      if (architectureTokens.has(token)) score += 2;
    });

    if (queryTokens.includes('remocao') || queryTokens.includes('remoção')) {
      if (removals().some((item) => item.personId === person.id)) {
        score += 10;
        reasons.push('possui pedido de remoção cadastrado');
      }
    }

    if (desiredUnit && architectureMatches.some((item) => safeText(item.area).toLowerCase() === desiredUnit || safeText(item.equipe).toLowerCase() === desiredUnit)) {
      score += 8;
      reasons.push(`interesse de movimentação para ${person.desiredUnit}`);
    }

    return { person, score, reasons: uniqueSorted(reasons).slice(0, 4) };
  }

  function parseAiJson(text) {
    const raw = safeText(text)
      .replace(/^```json/i, '')
      .replace(/^```/i, '')
      .replace(/```$/i, '')
      .trim();
    try {
      return JSON.parse(raw);
    } catch (error) {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        return JSON.parse(raw.slice(start, end + 1));
      }
      throw error;
    }
  }

  async function callTalentAi(prompt) {
    const caller = globalThis.callGeminiProxy || globalThis.callGemini;
    if (typeof caller !== 'function') throw new Error('Serviço de IA não disponível no frontend.');
    return caller(prompt, null, { maxTokens: 1200 });
  }

  async function interpretTalentQueryWithAi(queryText, roleText, prereqList, architectureMatches, architectureCompetencies) {
    const peopleSummary = people().slice(0, 80).map((person) => ({
      id: person.id,
      nome: person.name,
      cargo: person.role,
      unidade: person.unit,
      equipe: person.team,
      competencias: safeArray(person.competencies).slice(0, 12),
      preferencias: person.preferences,
      remocao: person.removalInterest,
      unidadeDesejada: person.desiredUnit,
    }));
    const prompt = [
      'Você é um assistente de alocação de talentos da CAGE-RS.',
      'Interprete a necessidade em linguagem natural e devolva somente JSON válido.',
      'Considere o contexto de arquitetura de processos e competências vinculadas.',
      '',
      `Consulta do usuário: ${queryText || 'não informada'}`,
      `Cargo informado: ${roleText || 'não informado'}`,
      `Pré-requisitos informados: ${prereqList.join(', ') || 'não informados'}`,
      `Arquitetura relacionada: ${JSON.stringify(architectureMatches)}`,
      `Competências relacionadas à arquitetura: ${JSON.stringify(architectureCompetencies)}`,
      `Candidatos possíveis: ${JSON.stringify(peopleSummary)}`,
      '',
      'Formato obrigatório:',
      '{"interpreted_need":"","recommended_role":"","recommended_unit":"","recommended_team":"","recommended_competencies":[],"candidate_ids":["id1","id2"],"explanations":{"id1":"motivo"}}',
    ].join('\n');
    const text = await callTalentAi(prompt);
    return parseAiJson(text);
  }

  async function tryInterpretTalentQueryWithAi(queryText, roleText, prereqList, architectureMatches, architectureCompetencies) {
    try {
      return await interpretTalentQueryWithAi(queryText, roleText, prereqList, architectureMatches, architectureCompetencies);
    } catch {
      return null;
    }
  }

  function normalizeAiExplanations(ai) {
    const explanations = ai?.explanations;
    return explanations && typeof explanations === 'object' ? explanations : {};
  }

  async function runTalentSearchAi() {
    const queryText = safeText(readFormValue('gc-talent-query'));
    const roleText = '';
    const prereqList = [];
    if (!queryText) {
      showInfo('Descreva a necessidade em linguagem natural para a busca com IA.', 'warn');
      return;
    }
    state.talentLoading = true;
    state.talentSearch = null;
    renderTalentResults();
    try {
      const architectureMatches = relatedArchitectureEntries(queryText, roleText, prereqList);
      const architectureCompetencies = architectureLinkedCompetencies(architectureMatches, roleText, prereqList);
      const ai = await tryInterpretTalentQueryWithAi(queryText, roleText, prereqList, architectureMatches, architectureCompetencies);

      const aiCandidateIds = safeArray(ai?.candidate_ids);
      const ranked = people()
        .map((person) => buildTalentCandidate(person, roleText || safeText(ai?.recommended_role), prereqList, architectureCompetencies, architectureMatches))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const ordered = aiCandidateIds.length
        ? aiCandidateIds
          .map((id) => ranked.find((item) => item.person.id === id))
          .filter(Boolean)
          .concat(ranked.filter((item) => !aiCandidateIds.includes(item.person.id)))
        : ranked;

      state.talentSearch = {
        interpretedNeed: safeText(ai?.interpreted_need) || queryText,
        recommendedRole: safeText(ai?.recommended_role) || roleText,
        recommendedUnit: safeText(ai?.recommended_unit),
        recommendedTeam: safeText(ai?.recommended_team),
        architectureMatches,
        architectureCompetencies,
        explanations: normalizeAiExplanations(ai),
        candidates: ordered.slice(0, 12),
      };
    } catch (error) {
      showInfo(`Erro ao executar busca inteligente: ${error.message}`, 'warn');
    } finally {
      state.talentLoading = false;
      renderTalentResults();
    }
  }

  function handleTalentSearchInput() {
    state.talentSearch = null;
    renderTalentResults();
  }

  function createPanelHead(title, desc) {
    const head = createNode('div', 'gc-panel-head');
    const box = createNode('div');
    box.append(createNode('div', 'gc-panel-title', title));
    box.append(createNode('div', 'gc-panel-desc', desc));
    head.appendChild(box);
    return head;
  }

  function createInlineList(label, items) {
    const wrap = createNode('div', 'gc-inline-list');
    wrap.append(createNode('strong', '', `${label}: `));
    wrap.append(createNode('span', '', items.join(' ⬢ ')));
    return wrap;
  }

  function fillBar(container, label, value, total) {
    const row = createNode('div', 'gc-bar-row');
    const top = createNode('div');
    top.style.display = 'flex';
    top.style.justifyContent = 'space-between';
    top.append(createNode('span', '', label), createNode('span', '', String(value)));
    const track = createNode('div', 'gc-bar-track');
    const fill = createNode('div', 'gc-bar-fill');
    const width = total > 0 ? Math.round((value / total) * 100) : 0;
    fill.style.width = `${width}%`;
    track.appendChild(fill);
    row.append(top, track);
    container.appendChild(row);
  }

  function distributionEntries(items, fallbackLabel) {
    const grouped = new Map();
    items.forEach((item) => {
      const label = safeText(item) || fallbackLabel;
      grouped.set(label, (grouped.get(label) || 0) + 1);
    });
    return [...grouped.entries()].sort((a, b) => b[1] - a[1]);
  }

  function donutSegments(entries) {
    const palette = ['#183c36', '#0f766e', '#2563eb', '#7c3aed', '#d97706', '#dc2626', '#0891b2', '#65a30d'];
    const total = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
    let cursor = 0;
    return entries.map(([label, value], index) => {
      const angle = (value / total) * 360;
      const segment = { label, value, color: palette[index % palette.length], start: cursor, end: cursor + angle };
      cursor += angle;
      return segment;
    });
  }

  function createDonutPanel(title, desc, entries) {
    const panel = createNode('div', 'gc-panel');
    panel.append(createPanelHead(title, desc));
    if (!entries.length) {
      panel.appendChild(createNode('div', 'gc-empty', 'Sem dados suficientes para gerar este gráfico.'));
      return panel;
    }
    const segments = donutSegments(entries);
    const donut = createNode('div', 'gc-donut');
    donut.style.background = `conic-gradient(${segments.map((item) => `${item.color} ${item.start}deg ${item.end}deg`).join(', ')})`;
    const center = createNode('div', 'gc-donut-center');
    center.append(createNode('strong', '', String(entries.reduce((sum, [, value]) => sum + value, 0))));
    center.append(createNode('span', '', 'pessoas'));
    donut.appendChild(center);
    const legend = createNode('div', 'gc-donut-legend');
    segments.forEach((item) => {
      const row = createNode('div', 'gc-donut-legend-item');
      const swatch = createNode('span', 'gc-donut-swatch');
      swatch.style.background = item.color;
      row.append(swatch, createNode('span', '', item.label), createNode('strong', '', String(item.value)));
      legend.appendChild(row);
    });
    const wrap = createNode('div', 'gc-donut-layout');
    wrap.append(donut, legend);
    panel.appendChild(wrap);
    return panel;
  }

  function createBarPanel(title, desc, entries) {
    const panel = createNode('div', 'gc-panel');
    panel.append(createPanelHead(title, desc));
    if (!entries.length) {
      panel.appendChild(createNode('div', 'gc-empty', 'Cadastre competências nas pessoas para visualizar este gráfico.'));
      return panel;
    }
    const bars = createNode('div', 'gc-stat-bars');
    const maxValue = entries[0]?.[1] || 0;
    entries.forEach(([label, value]) => fillBar(bars, label, value, maxValue));
    panel.appendChild(bars);
    return panel;
  }

  function ageBandLabel(age) {
    if (age <= 29) return 'Até 29';
    if (age <= 39) return '30-39';
    if (age <= 49) return '40-49';
    if (age <= 59) return '50-59';
    return '60+';
  }

  function tenureBandLabel(years) {
    if (years < 3) return '1-3 anos';
    if (years < 5) return '3-5 anos';
    if (years < 10) return '5-10 anos';
    if (years < 15) return '10-15 anos';
    return '15+ anos';
  }

  function competencyUsageEntries() {
    const grouped = new Map();
    people().forEach((person) => {
      safeArray(person.competencies).forEach((item) => {
        const label = safeText(item);
        if (!label) return;
        grouped.set(label, (grouped.get(label) || 0) + 1);
      });
    });
    return [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }

  function renderOverview() {
    const view = byId('gc-view-overview');
    if (!view) return;
    const allPeople = people();
    const totalPeople = allPeople.length;
    const unitCount = getUnits().length;
    const roleCount = getRoles().length;
    const avgAge = totalPeople ? Math.round(allPeople.reduce((sum, item) => sum + parseNumber(item.age), 0) / totalPeople) : 0;
    const retirement = allPeople.filter((item) => parseNumber(item.age) >= 60).length;
    const roleEntries = distributionEntries(allPeople.map((item) => item.role), 'Não informado');
    const genderEntries = distributionEntries(allPeople.map((item) => item.gender), 'Não informado');
    const ageEntries = distributionEntries(allPeople.map((item) => {
      const age = parseNumber(item.age);
      return age > 0 ? ageBandLabel(age) : 'Não informado';
    }), 'Não informado');
    const tenureEntries = distributionEntries(allPeople.map((item) => {
      const years = yearsSince(item.entryDate);
      return years > 0 ? tenureBandLabel(years) : 'Não informado';
    }), 'Não informado');
    const unitEntries = distributionEntries(allPeople.map((item) => item.unit), 'Não informado');
    const competencyEntries = competencyUsageEntries();
    view.replaceChildren();
    const grid = createNode('div', 'gc-grid');
    [
      ['Total de servidores', String(totalPeople), `${unitCount} unidade(s) mapeada(s)`],
      ['Cargos mapeados', String(roleCount), `${competencies().length} competências`],
      ['Idade média', avgAge ? `${avgAge} anos` : '—', `${retirement} em idade de aposentadoria`],
      ['Trilhas e treinamentos', String(trails().length), `${trainings().length} capacitações`],
    ].forEach(([title, value, sub]) => {
      const card = createNode('div', 'gc-card');
      card.append(createNode('div', 'gc-card-title', title));
      card.append(createNode('div', 'gc-card-value', value));
      card.append(createNode('div', 'gc-card-sub', sub));
      grid.appendChild(card);
    });
    const chartGrid = createNode('div', 'gc-overview-charts');
    chartGrid.append(
      createDonutPanel('Divisão entre cargos', 'Distribuição do quadro por cargo cadastrado.', roleEntries),
      createDonutPanel('Divisão entre sexos', 'Panorama do quadro por sexo informado.', genderEntries),
      createDonutPanel('Faixas de idade', 'Distribuição etária do quadro atual.', ageEntries),
      createDonutPanel('Faixas de tempo de CAGE', 'Tempo de permanência institucional.', tenureEntries),
      createDonutPanel('Pessoas por unidade', 'Quantidade de pessoas por unidade.', unitEntries),
    );
    const bottom = createNode('div', 'gc-overview-bottom');
    bottom.appendChild(createBarPanel('Competências mais utilizadas na CAGE', 'Top 10 competências mais recorrentes entre as pessoas cadastradas.', competencyEntries));
    const surveyPanel = createNode('div', 'gc-panel');
    surveyPanel.append(createPanelHead('Pesquisa de ambiente', 'Último recorte anual cadastrado no módulo.'));
    const latest = [...surveys()].sort((a, b) => String(b.year).localeCompare(String(a.year))).at(0);
    if (latest) {
      const list = createNode('div', 'gc-list');
      [['Engajamento', latest.engagement], ['Liderança', latest.leadership], ['Clima', latest.climate]].forEach(([label, value]) => {
        const item = createNode('div', 'gc-list-item');
        item.append(createNode('div', 'gc-list-title', `${label}: ${value || '?'}`));
        list.appendChild(item);
      });
      if (latest.notes) list.append(createNode('div', 'gc-list-text', latest.notes));
      surveyPanel.appendChild(list);
    } else {
      surveyPanel.appendChild(createNode('div', 'gc-empty', 'Cadastre a pesquisa anual para completar o painel.'));
    }
    bottom.appendChild(surveyPanel);
    view.append(grid, chartGrid, bottom);
  }

  function populatePeopleForm(record) {
    const person = normalizeRecord(record, personTemplate());
    state.personId = person.id || '';
    setFormValue('gc-person-name', person.name);
    setFormValue('gc-person-age', person.age);
    setFormValue('gc-person-gender', person.gender);
    setFormValue('gc-person-entry-date', person.entryDate);
    setFormValue('gc-person-basic-education', person.basicEducation);
    setFormValue('gc-person-extra-education', person.extraEducation);
    setFormValue('gc-person-unit', person.unit);
    setFormValue('gc-person-team', person.team);
    setFormValue('gc-person-role', person.role);
    setFormValue('gc-person-competencies', safeArray(person.competencies).join(', '));
    setFormValue('gc-person-preferences', person.preferences);
    setFormValue('gc-person-experiences', person.experiences);
    setFormValue('gc-person-trails', safeArray(person.completedTrails).join(', '));
    setFormValue('gc-person-probation', person.probation);
    setFormValue('gc-person-probation-end', person.probationEnd);
    setFormValue('gc-person-removal-interest', person.removalInterest);
    setFormValue('gc-person-desired-unit', person.desiredUnit);
    setFormValue('gc-person-taught-courses', person.taughtCourses);
    setFormValue('gc-person-notes', person.notes);
  }

  function resetPeopleForm() {
    populatePeopleForm(personTemplate());
  }

  function savePerson() {
    if (!requireEditor()) return;
    const name = safeText(readFormValue('gc-person-name'));
    if (!name) return showInfo('Informe o nome da pessoa.', 'warn');
    const probation = probationInfo(readFormValue('gc-person-entry-date'));
    const entry = {
      id: state.personId || makeId('gc_person'),
      name,
      age: safeText(readFormValue('gc-person-age')),
      gender: safeText(readFormValue('gc-person-gender')),
      entryDate: safeText(readFormValue('gc-person-entry-date')),
      basicEducation: safeText(readFormValue('gc-person-basic-education')),
      extraEducation: safeText(readFormValue('gc-person-extra-education')),
      unit: safeText(readFormValue('gc-person-unit')),
      team: safeText(readFormValue('gc-person-team')),
      role: safeText(readFormValue('gc-person-role')),
      competencies: splitList(readFormValue('gc-person-competencies')),
      preferences: safeText(readFormValue('gc-person-preferences')),
      experiences: safeText(readFormValue('gc-person-experiences')),
      completedTrails: splitList(readFormValue('gc-person-trails')),
      probation: probation.probation,
      probationEnd: probation.probationEnd,
      removalInterest: safeText(readFormValue('gc-person-removal-interest')) || 'Não',
      desiredUnit: safeText(readFormValue('gc-person-desired-unit')),
      taughtCourses: safeText(readFormValue('gc-person-taught-courses')),
      notes: safeText(readFormValue('gc-person-notes')),
    };
    const list = people();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    syncRoleCatalog(entry.role);
    persist(index >= 0 ? 'Pessoa atualizada.' : 'Pessoa cadastrada.');
    resetPeopleForm();
    renderAll();
  }

  function removePerson(id) {
    if (!requireEditor()) return;
    getStore().people = people().filter((item) => item.id !== id);
    getStore().removals = removals().filter((item) => item.personId !== id);
    getStore().competencies = competencies().map((item) => (item.personId === id ? { ...item, personId: '' } : item));
    getStore().trainings = trainings().map((item) => ({ ...item, personIds: item.personIds.filter((personId) => personId !== id) }));
    persist('Pessoa removida.');
    renderAll();
  }

  function renderPeopleList() {
    const list = byId('gc-people-list');
    if (!list) return;
    list.replaceChildren();
    const filter = safeText(readFormValue('gc-people-filter')).toLowerCase();
    const items = people().filter((item) => !filter || personSearchCorpus(item).toLowerCase().includes(filter));
    if (!items.length) return list.appendChild(createNode('div', 'gc-empty', 'Nenhuma pessoa cadastrada ainda.'));
    items.forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      const head = createNode('div', 'gc-list-head');
      const wrap = createNode('div');
      const title = createButton(item.name, 'gc-list-title', () => populatePeopleForm(item));
      title.classList.add('btn-link');
      wrap.append(title, createNode('div', 'gc-list-meta', [item.role, item.unit, item.team].filter(Boolean).join(' ⬢ ')));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populatePeopleForm(item)));
      actions.append(createButton('Remoção', 'btn btn-outline', () => populateRemovalForm({ ...removalTemplate(), personId: item.id, fromUnit: item.unit })));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removePerson(item.id)));
      head.append(wrap, actions);
      card.appendChild(head);
      if (item.competencies.length) {
        const badges = createNode('div', 'gc-badges');
        item.competencies.slice(0, 6).forEach((value) => badges.appendChild(createNode('span', 'gc-badge', value)));
        if (item.probation === 'Sim') badges.appendChild(createNode('span', 'gc-badge alert', `Prob. até ${item.probationEnd}`));
        if (item.removalInterest === 'Sim' && item.desiredUnit) badges.appendChild(createNode('span', 'gc-badge match', `Interesse: ${item.desiredUnit}`));
        card.appendChild(badges);
      }
      if (item.preferences) card.appendChild(createNode('div', 'gc-list-text', `Preferências: ${item.preferences}`));
      if (item.taughtCourses) card.appendChild(createNode('div', 'gc-list-text', `Cursos ministrados: ${item.taughtCourses}`));
      list.appendChild(card);
    });
  }

  function renderPeople() {
    setDataListOptions('gc-units-list', getUnits());
    setDataListOptions('gc-teams-list', getTeams());
    setDataListOptions('gc-roles-list', getRoles());
    setSelectOptions('gc-gap-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    setSelectOptions('gc-feedback-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    renderPeopleList();
    renderGaps();
    renderFeedbacks();
  }

  function renderGaps() {
    const list = byId('gc-gap-list');
    if (!list) return;
    list.replaceChildren();
    if (!gapAnalyses().length) return list.appendChild(createNode('div', 'gc-empty', 'Nenhuma análise de gaps cadastrada.'));
    gapAnalyses().forEach((item) => {
      const person = getPersonById(item.personId);
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', person ? person.name : 'Pessoa não encontrada'));
      card.append(createNode('div', 'gc-list-meta', [item.unit, item.team].filter(Boolean).join(' ⬢ ')));
      if (item.requiredCompetencies) card.appendChild(createNode('div', 'gc-list-text', `Necessárias: ${item.requiredCompetencies}`));
      if (item.currentCompetencies) card.appendChild(createNode('div', 'gc-list-text', `Atuais: ${item.currentCompetencies}`));
      if (item.recommendations) card.appendChild(createNode('div', 'gc-list-text', `Recomendações: ${item.recommendations}`));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateGapForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeGap(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function renderFeedbacks() {
    const list = byId('gc-feedback-list');
    if (!list) return;
    list.replaceChildren();
    if (!feedbackMeetings().length) return list.appendChild(createNode('div', 'gc-empty', 'Nenhuma reunião de feedback registrada.'));
    feedbackMeetings().forEach((item) => {
      const person = getPersonById(item.personId);
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', `${person ? person.name : 'Pessoa'} ⬢ ${item.date}`));
      card.append(createNode('div', 'gc-list-meta', item.participants || 'Participantes não informados'));
      if (item.objectives) card.appendChild(createNode('div', 'gc-list-text', `Objetivos: ${item.objectives}`));
      if (item.minutes) card.appendChild(createNode('div', 'gc-list-text', `Ata: ${item.minutes}`));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateFeedbackForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeFeedback(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

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
          role: safeText(row.cargo || row.Cargo),
          age: safeText(row.idade || row.Idade),
          gender: safeText(row.sexo || row.Sexo),
          entryDate: safeText(row['data de entrada na CAGE'] || row['data de entrada'] || row.posse),
          basicEducation: safeText(row['formação básica'] || row['formacao basica']),
          extraEducation: safeText(row['formação complementar'] || row['formacao complementar']),
          unit: safeText(row['divisão'] || row.divisao || row.unidade),
          team: safeText(row.equipe),
          competencies: splitList(row['competências'] || row.competencias),
          preferences: safeText(row['preferencias/objetivos pessoais na carreira'] || row.preferencias),
          experiences: safeText(row['experiencias relevantes anteriores'] || row.experiencias),
          removalInterest: safeText(row['interesse remoção'] || row['interesse remocao']) || 'Não',
          desiredUnit: safeText(row['para onde'] || row.destino),
          taughtCourses: safeText(row['cursos ministrados'] || row['já ministrou cursos?'] || row['ja ministrou cursos?']),
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

  function populateGapForm(record) {
    const item = normalizeRecord(record, gapTemplate());
    state.gapId = item.id || '';
    setFormValue('gc-gap-person', item.personId);
    setFormValue('gc-gap-unit', item.unit);
    setFormValue('gc-gap-team', item.team);
    setFormValue('gc-gap-current', item.currentCompetencies);
    setFormValue('gc-gap-required', item.requiredCompetencies);
    setFormValue('gc-gap-observations', item.observations);
    setFormValue('gc-gap-recommendations', item.recommendations);
    setFormValue('gc-gap-action', item.actionPlan);
  }

  function resetGapForm() {
    populateGapForm(gapTemplate());
  }

  function saveGap() {
    if (!requireEditor()) return;
    const personId = safeText(readFormValue('gc-gap-person'));
    if (!personId) return showInfo('Selecione a pessoa para registrar o gap.', 'warn');
    const entry = {
      id: state.gapId || makeId('gc_gap'),
      personId,
      unit: safeText(readFormValue('gc-gap-unit')),
      team: safeText(readFormValue('gc-gap-team')),
      currentCompetencies: safeText(readFormValue('gc-gap-current')),
      requiredCompetencies: safeText(readFormValue('gc-gap-required')),
      observations: safeText(readFormValue('gc-gap-observations')),
      recommendations: safeText(readFormValue('gc-gap-recommendations')),
      actionPlan: safeText(readFormValue('gc-gap-action')),
    };
    const list = gapAnalyses();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Gap atualizado.' : 'Gap registrado.');
    resetGapForm();
    renderAll();
  }

  function removeGap(id) {
    if (!requireEditor()) return;
    getStore().gapAnalyses = gapAnalyses().filter((item) => item.id !== id);
    persist('Gap removido.');
    renderAll();
  }

  function populateFeedbackForm(record) {
    const item = normalizeRecord(record, feedbackTemplate());
    state.feedbackId = item.id || '';
    setFormValue('gc-feedback-person', item.personId);
    setFormValue('gc-feedback-date', item.date);
    setFormValue('gc-feedback-participants', item.participants);
    setFormValue('gc-feedback-objectives', item.objectives);
    setFormValue('gc-feedback-minutes', item.minutes);
  }

  function resetFeedbackForm() {
    populateFeedbackForm(feedbackTemplate());
  }

  function saveFeedback() {
    if (!requireEditor()) return;
    const personId = safeText(readFormValue('gc-feedback-person'));
    const date = safeText(readFormValue('gc-feedback-date'));
    if (!personId || !date) return showInfo('Informe pessoa e data da reunião.', 'warn');
    const entry = {
      id: state.feedbackId || makeId('gc_feedback'),
      personId,
      date,
      participants: safeText(readFormValue('gc-feedback-participants')),
      objectives: safeText(readFormValue('gc-feedback-objectives')),
      minutes: safeText(readFormValue('gc-feedback-minutes')),
    };
    const list = feedbackMeetings();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Reunião de feedback atualizada.' : 'Reunião de feedback registrada.');
    resetFeedbackForm();
    renderAll();
  }

  function removeFeedback(id) {
    if (!requireEditor()) return;
    getStore().feedbackMeetings = feedbackMeetings().filter((item) => item.id !== id);
    persist('Reunião de feedback removida.');
    renderAll();
  }

  function populateRemovalForm(record) {
    const removal = normalizeRecord(record, removalTemplate());
    state.removalId = removal.id || '';
    setFormValue('gc-removal-person', removal.personId);
    setFormValue('gc-removal-from', removal.fromUnit);
    setFormValue('gc-removal-to', removal.desiredUnit);
    setFormValue('gc-removal-notes', removal.notes);
  }

  function resetRemovalForm() {
    populateRemovalForm(removalTemplate());
  }

  function saveRemoval() {
    if (!requireEditor()) return;
    const personId = safeText(readFormValue('gc-removal-person'));
    const fromUnit = safeText(readFormValue('gc-removal-from'));
    const desiredUnit = safeText(readFormValue('gc-removal-to'));
    if (!personId || !fromUnit || !desiredUnit) return showInfo('Preencha pessoa, unidade de origem e unidade desejada.', 'warn');
    const entry = {
      id: state.removalId || makeId('gc_removal'),
      personId,
      fromUnit,
      desiredUnit,
      notes: safeText(readFormValue('gc-removal-notes')),
    };
    const list = removals();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Movimentação atualizada.' : 'Movimentação cadastrada.');
    resetRemovalForm();
    renderAll();
  }

  function removeRemoval(id) {
    if (!requireEditor()) return;
    getStore().removals = removals().filter((item) => item.id !== id);
    persist('Registro de remoção excluído.');
    renderAll();
  }

  function renderRemovals() {
    setSelectOptions('gc-removal-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    setDataListOptions('gc-removals-units-list', getUnits());
    const list = byId('gc-removals-list');
    if (!list) return;
    list.replaceChildren();
    if (!removals().length) return list.appendChild(createNode('div', 'gc-empty', 'Nenhuma movimentação registrada.'));
    removals().forEach((item) => {
      const person = getPersonById(item.personId);
      const insight = removalInsight(item);
      const card = createNode('div', 'gc-list-item');
      const head = createNode('div', 'gc-list-head');
      const wrap = createNode('div');
      wrap.append(createNode('div', 'gc-list-title', person ? person.name : 'Pessoa não encontrada'));
      wrap.append(createNode('div', 'gc-list-meta', `${item.fromUnit} → ${item.desiredUnit}`));
      head.append(wrap);
      if (insight.type) {
        const badges = createNode('div', 'gc-badges');
        badges.appendChild(createNode('span', `gc-badge ${insight.type}`, insight.label));
        head.appendChild(badges);
      }
      card.appendChild(head);
      if (item.notes) card.appendChild(createNode('div', 'gc-list-text', item.notes));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateRemovalForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeRemoval(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function populatePerformanceForm(record) {
    const item = normalizeRecord(record, performanceTemplate());
    state.performanceId = item.id || '';
    setFormValue('gc-performance-person', item.personId);
    setFormValue('gc-performance-date', item.date);
    setFormValue('gc-performance-method', item.method);
    setFormValue('gc-performance-objective', item.objective);
    setFormValue('gc-performance-result', item.result);
    setFormValue('gc-performance-notes', item.notes);
  }

  function resetPerformanceForm() {
    populatePerformanceForm(performanceTemplate());
  }

  function savePerformance() {
    if (!requireEditor()) return;
    const personId = safeText(readFormValue('gc-performance-person'));
    const date = safeText(readFormValue('gc-performance-date'));
    if (!personId || !date) return showInfo('Informe pessoa e data da avaliação.', 'warn');
    const entry = {
      id: state.performanceId || makeId('gc_perf'),
      personId,
      date,
      method: safeText(readFormValue('gc-performance-method')),
      objective: safeText(readFormValue('gc-performance-objective')),
      result: safeText(readFormValue('gc-performance-result')),
      notes: safeText(readFormValue('gc-performance-notes')),
    };
    const list = performanceReviews();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Avaliação atualizada.' : 'Avaliação registrada.');
    resetPerformanceForm();
    renderAll();
  }

  function removePerformance(id) {
    if (!requireEditor()) return;
    getStore().performanceReviews = performanceReviews().filter((item) => item.id !== id);
    persist('Avaliação removida.');
    renderAll();
  }

  function renderPerformance() {
    setSelectOptions('gc-performance-person', people(), 'Selecione a pessoa', (item) => ({ value: item.id, label: item.name }));
    setSelectOptions('gc-performance-filter-person', people(), 'Todas as pessoas', (item) => ({ value: item.id, label: item.name }));
    const list = byId('gc-performance-list');
    const chart = byId('gc-performance-chart');
    if (!list || !chart) return;
    list.replaceChildren();
    chart.replaceChildren();
    const personFilter = safeText(readFormValue('gc-performance-filter-person'));
    const unitFilter = safeText(readFormValue('gc-performance-filter-unit')).toLowerCase();
    const roleFilter = safeText(readFormValue('gc-performance-filter-role')).toLowerCase();
    const filtered = performanceReviews().filter((item) => {
      const person = getPersonById(item.personId);
      if (!person) return false;
      if (personFilter && item.personId !== personFilter) return false;
      if (unitFilter && safeText(person.unit).toLowerCase() !== unitFilter) return false;
      if (roleFilter && safeText(person.role).toLowerCase() !== roleFilter) return false;
      return true;
    });
    if (!filtered.length) {
      list.appendChild(createNode('div', 'gc-empty', 'Nenhuma avaliação encontrada para os filtros selecionados.'));
      return;
    }
    const grouped = new Map();
    filtered.forEach((item) => {
      const person = getPersonById(item.personId);
      const score = parseNumber(item.result);
      const key = person ? person.name : item.personId;
      grouped.set(key, (grouped.get(key) || 0) + score);
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', `${person ? person.name : 'Pessoa'} ⬢ ${item.date}`));
      card.append(createNode('div', 'gc-list-meta', [item.method, item.objective, `Resultado ${item.result || '—'}`].filter(Boolean).join(' ⬢ ')));
      if (item.notes) card.appendChild(createNode('div', 'gc-list-text', item.notes));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populatePerformanceForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removePerformance(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
    const bars = createNode('div', 'gc-stat-bars');
    [...grouped.entries()].sort((a, b) => b[1] - a[1]).forEach(([label, value]) => fillBar(bars, label, value, Math.max(...grouped.values())));
    chart.appendChild(bars);
  }

  function populateCompetencyForm(record) {
    const item = normalizeRecord(record, competencyTemplate());
    state.competencyId = item.id || '';
    setFormValue('gc-competency-name', item.name);
    setFormValue('gc-competency-type', item.type);
    setFormValue('gc-competency-macro', item.macroprocess);
    setFormValue('gc-competency-process', item.process);
    setFormValue('gc-competency-role', item.role);
    setFormValue('gc-competency-division', item.division);
    setFormValue('gc-competency-team', item.team);
    setFormValue('gc-competency-person', item.personId);
    setFormValue('gc-competency-trail', item.trailId);
    setFormValue('gc-competency-training', item.trainingId);
    setFormValue('gc-competency-description', item.description);
  }

  function resetCompetencyForm() {
    populateCompetencyForm(competencyTemplate());
  }

  function saveCompetency() {
    if (!requireEditor()) return;
    const name = safeText(readFormValue('gc-competency-name'));
    if (!name) return showInfo('Informe o nome da competência.', 'warn');
    const entry = {
      id: state.competencyId || makeId('gc_competency'),
      name,
      type: safeText(readFormValue('gc-competency-type')) || 'hard',
      macroprocess: safeText(readFormValue('gc-competency-macro')),
      process: safeText(readFormValue('gc-competency-process')),
      role: safeText(readFormValue('gc-competency-role')),
      division: safeText(readFormValue('gc-competency-division')),
      team: safeText(readFormValue('gc-competency-team')),
      personId: safeText(readFormValue('gc-competency-person')),
      trailId: safeText(readFormValue('gc-competency-trail')),
      trainingId: safeText(readFormValue('gc-competency-training')),
      description: safeText(readFormValue('gc-competency-description')),
    };
    const list = competencies();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    syncRoleCatalog(entry.role);
    syncCompetencyCatalog(entry);
    persist(index >= 0 ? 'Competência atualizada.' : 'Competência cadastrada.');
    resetCompetencyForm();
    renderAll();
  }

  function removeCompetency(id) {
    if (!requireEditor()) return;
    getStore().competencies = competencies().filter((item) => item.id !== id);
    persist('Competência removida.');
    renderAll();
  }

  function renderCompetencies() {
    setSelectOptions('gc-competency-type', COMPETENCY_TYPES, 'Tipo', (item) => ({ value: item.value, label: item.label }));
    setDataListOptions('gc-macro-list', getMacroprocesses());
    setDataListOptions('gc-process-list', getProcesses());
    setDataListOptions('gc-roles-list', getRoles());
    setDataListOptions('gc-units-list', getUnits());
    setDataListOptions('gc-teams-list', getTeams());
    setSelectOptions('gc-competency-person', people(), 'Pessoa específica', (item) => ({ value: item.id, label: item.name }));
    setSelectOptions('gc-competency-trail', trails(), 'Trilha', (item) => ({ value: item.id, label: item.name }));
    setSelectOptions('gc-competency-training', trainings(), 'Treinamento', (item) => ({ value: item.id, label: item.name }));
    const list = byId('gc-competencies-list');
    if (!list) return;
    list.replaceChildren();
    if (!competencies().length) return list.appendChild(createNode('div', 'gc-empty', 'Cadastre competências, hard skills e conhecimentos normativos aqui.'));
    competencies().forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      const head = createNode('div', 'gc-list-head');
      const wrap = createNode('div');
      wrap.append(createNode('div', 'gc-list-title', item.name));
      wrap.append(createNode('div', 'gc-list-meta', [getTypeLabel(item.type), item.macroprocess, item.team, item.role].filter(Boolean).join(' ⬢ ')));
      const badges = createNode('div', 'gc-badges');
      badges.appendChild(createNode('span', `gc-badge ${getTypeBadgeClass(item.type)}`, getTypeLabel(item.type)));
      head.append(wrap, badges);
      card.appendChild(head);
      if (item.description) card.appendChild(createNode('div', 'gc-list-text', item.description));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateCompetencyForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeCompetency(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function populateTrailForm(record) {
    const item = normalizeRecord(record, trailTemplate());
    state.trailId = item.id || '';
    setFormValue('gc-trail-name', item.name);
    setFormValue('gc-trail-objective', item.objective);
    setFormValue('gc-trail-level-name', item.levelName);
    setFormValue('gc-trail-level-goal', item.levelGoal);
    setFormValue('gc-trail-level-degree', item.levelDegree);
    setFormValue('gc-trail-macro', item.macroprocess);
    setFormValue('gc-trail-division', item.division);
    setFormValue('gc-trail-competencies', safeArray(item.competencies).join(', '));
    setFormValue('gc-trail-prereq', safeArray(item.prerequisites).join(', '));
  }

  function resetTrailForm() {
    populateTrailForm(trailTemplate());
  }

  function populateTrainingForm(record) {
    const item = normalizeRecord(record, trainingTemplate());
    state.trainingId = item.id || '';
    setFormValue('gc-training-name', item.name);
    setFormValue('gc-training-cost', item.costType);
    setFormValue('gc-training-mode', item.deliveryMode);
    setFormValue('gc-training-link', item.remoteLink);
    setFormValue('gc-training-provider', item.provider);
    setFormValue('gc-training-trail', item.trailId);
    setFormValue('gc-training-persons', safeArray(item.personIds).join(', '));
    setFormValue('gc-training-notes', item.notes);
  }

  function resetTrainingForm() {
    populateTrainingForm(trainingTemplate());
  }

  function saveTrail() {
    if (!requireEditor()) return;
    const name = safeText(readFormValue('gc-trail-name'));
    if (!name) return showInfo('Informe o nome da trilha.', 'warn');
    const entry = {
      id: state.trailId || makeId('gc_trail'),
      name,
      objective: safeText(readFormValue('gc-trail-objective')),
      levelName: safeText(readFormValue('gc-trail-level-name')),
      levelGoal: safeText(readFormValue('gc-trail-level-goal')),
      levelDegree: safeText(readFormValue('gc-trail-level-degree')),
      macroprocess: safeText(readFormValue('gc-trail-macro')),
      division: safeText(readFormValue('gc-trail-division')),
      competencies: splitList(readFormValue('gc-trail-competencies')),
      prerequisites: splitList(readFormValue('gc-trail-prereq')),
    };
    const list = trails();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Trilha atualizada.' : 'Trilha cadastrada.');
    resetTrailForm();
    renderAll();
  }

  function saveTraining() {
    if (!requireEditor()) return;
    const name = safeText(readFormValue('gc-training-name'));
    if (!name) return showInfo('Informe o nome do treinamento.', 'warn');
    const entry = {
      id: state.trainingId || makeId('gc_training'),
      name,
      costType: safeText(readFormValue('gc-training-cost')),
      deliveryMode: safeText(readFormValue('gc-training-mode')),
      remoteLink: safeUrl(readFormValue('gc-training-link')),
      provider: safeText(readFormValue('gc-training-provider')),
      trailId: safeText(readFormValue('gc-training-trail')),
      personIds: splitList(readFormValue('gc-training-persons')),
      notes: safeText(readFormValue('gc-training-notes')),
    };
    const list = trainings();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Treinamento atualizado.' : 'Treinamento cadastrado.');
    resetTrainingForm();
    renderAll();
  }

  function removeTrail(id) {
    if (!requireEditor()) return;
    getStore().trails = trails().filter((item) => item.id !== id);
    getStore().trainings = trainings().map((item) => (item.trailId === id ? { ...item, trailId: '' } : item));
    persist('Trilha removida.');
    renderAll();
  }

  function removeTraining(id) {
    if (!requireEditor()) return;
    getStore().trainings = trainings().filter((item) => item.id !== id);
    getStore().competencies = competencies().map((item) => (item.trainingId === id ? { ...item, trainingId: '' } : item));
    persist('Treinamento removido.');
    renderAll();
  }

  function renderTrailLadder(panel, trail) {
    const ladder = createNode('div', 'gc-ladder');
    [['Objetivo', trail.objective], [trail.levelName || 'Nível', trail.levelGoal], ['Grau esperado', trail.levelDegree]].forEach(([title, subtitle]) => {
      const step = createNode('div', 'gc-step');
      step.append(createNode('div', 'gc-step-title', title || 'Etapa'));
      step.append(createNode('div', 'gc-step-sub', subtitle || 'Sem detalhamento'));
      ladder.appendChild(step);
    });
    panel.appendChild(ladder);
  }

  function renderTrails() {
    setDataListOptions('gc-macro-list', getMacroprocesses());
    setDataListOptions('gc-units-list', getUnits());
    setSelectOptions('gc-training-trail', trails(), 'Trilha vinculada', (item) => ({ value: item.id, label: item.name }));
    const trailsList = byId('gc-trails-list');
    const trainingsList = byId('gc-trainings-list');
    if (!trailsList || !trainingsList) return;
    trailsList.replaceChildren();
    trainingsList.replaceChildren();
    if (!trails().length) trailsList.appendChild(createNode('div', 'gc-empty', 'Cadastre trilhas para montar a escada de desenvolvimento.'));
    if (!trainings().length) trainingsList.appendChild(createNode('div', 'gc-empty', 'Nenhum treinamento cadastrado.'));
    trails().forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', item.name));
      card.append(createNode('div', 'gc-list-meta', [item.macroprocess, item.division].filter(Boolean).join(' ⬢ ')));
      renderTrailLadder(card, item);
      if (item.competencies.length) card.appendChild(createInlineList('Competências-chave', item.competencies));
      if (item.prerequisites.length) card.appendChild(createInlineList('Pré-requisitos', item.prerequisites));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateTrailForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeTrail(item.id)));
      card.appendChild(actions);
      trailsList.appendChild(card);
    });
    trainings().forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', item.name));
      card.append(createNode('div', 'gc-list-meta', [item.provider, item.costType, item.deliveryMode].filter(Boolean).join(' ⬢ ')));
      if (item.notes) card.appendChild(createNode('div', 'gc-list-text', item.notes));
      if (item.remoteLink) {
        const link = createNode('a', 'gc-list-text', 'Abrir link remoto');
        link.href = item.remoteLink;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        card.appendChild(link);
      }
      const trail = getTrailById(item.trailId);
      if (trail) card.appendChild(createNode('div', 'gc-list-text', `Trilha: ${trail.name}`));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateTrainingForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeTraining(item.id)));
      card.appendChild(actions);
      trainingsList.appendChild(card);
    });
  }

  function populateSurveyForm(record) {
    const item = normalizeRecord(record, surveyTemplate());
    state.surveyId = item.id || '';
    setFormValue('gc-survey-year', item.year);
    setFormValue('gc-survey-engagement', item.engagement);
    setFormValue('gc-survey-leadership', item.leadership);
    setFormValue('gc-survey-climate', item.climate);
    setFormValue('gc-survey-notes', item.notes);
  }

  function resetSurveyForm() {
    populateSurveyForm(surveyTemplate());
  }

  function saveSurvey() {
    if (!requireEditor()) return;
    const year = safeText(readFormValue('gc-survey-year'));
    if (!year) return showInfo('Informe o ano da pesquisa.', 'warn');
    const entry = {
      id: state.surveyId || makeId('gc_survey'),
      year,
      engagement: safeText(readFormValue('gc-survey-engagement')),
      leadership: safeText(readFormValue('gc-survey-leadership')),
      climate: safeText(readFormValue('gc-survey-climate')),
      notes: safeText(readFormValue('gc-survey-notes')),
    };
    const list = surveys();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = entry; else list.push(entry);
    persist(index >= 0 ? 'Pesquisa atualizada.' : 'Pesquisa cadastrada.');
    resetSurveyForm();
    renderAll();
  }

  function removeSurvey(id) {
    if (!requireEditor()) return;
    getStore().surveys = surveys().filter((item) => item.id !== id);
    persist('Pesquisa removida.');
    renderAll();
  }

  function renderSurveys() {
    const list = byId('gc-surveys-list');
    if (!list) return;
    list.replaceChildren();
    if (!surveys().length) return list.appendChild(createNode('div', 'gc-empty', 'Cadastre a pesquisa anual da GEPESC para enriquecer o diagnóstico.'));
    [...surveys()].sort((a, b) => String(b.year).localeCompare(String(a.year))).forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      card.append(createNode('div', 'gc-list-title', `Pesquisa ${item.year}`));
      card.append(createNode('div', 'gc-list-meta', `Engajamento ${item.engagement || '—'} ⬢ Liderança ${item.leadership || '—'} ⬢ Clima ${item.climate || '—'}`));
      if (item.notes) card.appendChild(createNode('div', 'gc-list-text', item.notes));
      const actions = createNode('div', 'gc-actions');
      actions.append(createButton('Editar', 'btn btn-outline', () => populateSurveyForm(item)));
      actions.append(createButton('Excluir', 'btn btn-outline', () => removeSurvey(item.id)));
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  function ensureTalentAiControls() {
    const trigger = byId('gc-run-talent-search');
    if (!trigger) return;
    trigger.textContent = 'Buscar com IA';
    const panel = trigger.closest('.gc-panel');
    if (!panel || byId('gc-talent-ai-note')) return;
    const note = createNode('div', 'gc-list-text', 'A IA interpreta o texto livre, cruza com a Arquitetura de Processos e com as competências cadastradas, e então ranqueia os candidatos.');
    note.id = 'gc-talent-ai-note';
    trigger.parentElement?.appendChild(note);
  }

  function renderTalentContextBox(list, search) {
    const box = createNode('div', 'gc-list-item');
    box.append(createNode('div', 'gc-list-title', 'Leitura da necessidade'));
    box.append(createNode('div', 'gc-list-text', search.interpretedNeed || 'Sem interpretação disponível.'));
    const meta = [
      search.recommendedRole ? `Cargo sugerido: ${search.recommendedRole}` : '',
      search.recommendedUnit ? `Unidade sugerida: ${search.recommendedUnit}` : '',
      search.recommendedTeam ? `Equipe sugerida: ${search.recommendedTeam}` : '',
    ].filter(Boolean).join(' ⬢ ');
    if (meta) box.append(createNode('div', 'gc-list-meta', meta));
    if (search.architectureMatches.length) {
      box.append(createNode('div', 'gc-list-text', `Arquitetura relacionada: ${search.architectureMatches.map((item) => [item.processo, item.subprocesso, item.area, item.equipe].filter(Boolean).join(' / ')).join(' ⬢ ')}`));
    }
    if (search.architectureCompetencies.length) {
      const badges = createNode('div', 'gc-badges');
      search.architectureCompetencies.slice(0, 12).forEach((value) => badges.appendChild(createNode('span', 'gc-badge match', value)));
      box.appendChild(badges);
    }
    list.appendChild(box);
  }

  function renderTalentResults() {
    ensureTalentAiControls();
    const list = byId('gc-talent-results');
    if (!list) return;
    list.replaceChildren();
    if (state.talentLoading) {
      list.appendChild(createNode('div', 'gc-empty', 'Interpretando a demanda com IA e cruzando com a Arquitetura de Processos...'));
      return;
    }
    const search = state.talentSearch;
    if (!search) {
      list.appendChild(createNode('div', 'gc-empty', 'Descreva a necessidade em linguagem natural e clique em "Buscar com IA". Exemplo: procuro auditor para atuar com balanços contábeis na divisão de contabilidade.'));
      return;
    }
    renderTalentContextBox(list, search);
    if (!search.candidates.length) {
      list.appendChild(createNode('div', 'gc-empty', 'Nenhum candidato aderente foi encontrado para a necessidade interpretada.'));
      return;
    }
    search.candidates.forEach((item) => {
      const card = createNode('div', 'gc-list-item');
      const head = createNode('div', 'gc-list-head');
      const wrap = createNode('div');
      wrap.append(createNode('div', 'gc-list-title', item.person.name));
      wrap.append(createNode('div', 'gc-list-meta', [item.person.role, item.person.unit, item.person.team].filter(Boolean).join(' ⬢ ')));
      head.append(wrap, createNode('div', 'gc-result-score', `${item.score} pts`));
      card.appendChild(head);
      const aiReason = safeText(search.explanations?.[item.person.id]);
      const reason = aiReason || item.reasons.join(' ⬢ ');
      if (reason) card.appendChild(createNode('div', 'gc-list-text', reason));
      if (item.person.preferences) card.appendChild(createNode('div', 'gc-list-text', `Preferências: ${item.person.preferences}`));
      if (item.person.competencies.length) {
        const badges = createNode('div', 'gc-badges');
        item.person.competencies.slice(0, 8).forEach((value) => badges.appendChild(createNode('span', 'gc-badge match', value)));
        card.appendChild(badges);
      }
      list.appendChild(card);
    });
  }

  function renderHero() {
    const map = [
      ['gc-hero-people', people().length],
      ['gc-hero-competencies', competencies().length],
      ['gc-hero-paths', trails().length],
      ['gc-hero-removals', removals().length],
    ];
    map.forEach(([id, value]) => {
      const node = byId(id);
      if (node) node.textContent = String(value);
    });
  }

  function updateHomeCardCount() {
    const footer = byId('home-competency-count');
    if (footer) footer.textContent = `${people().length} pessoa(s) ⬢ ${trails().length} trilha(s)`;
  }

  function showView(tab) {
    state.tab = tab;
    document.querySelectorAll('.gc-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === tab);
    });
    document.querySelectorAll('.gc-view').forEach((panel) => {
      panel.style.display = panel.dataset.view === tab ? 'flex' : 'none';
    });
  }

  function renderAll() {
    normalizeData();
    fillSuggestionList();
    renderHero();
    renderOverview();
    renderPeople();
    renderPerformance();
    renderRemovals();
    renderCompetencies();
    renderTrails();
    renderSurveys();
    renderTalentResults();
    updateHomeCardCount();
    showView(state.tab);
  }

  function showModule() {
    if (typeof hideHome === 'function') hideHome();
    if (typeof hideAllModules === 'function') hideAllModules();
    const shell = byId(MODULE_ID);
    if (shell) shell.style.display = 'block';
    renderAll();
  }

  function injectSidebarButton() {
    const host = byId('sidebar-nav-btns');
    if (!host || byId(SIDEBAR_BTN_ID)) return;
    const button = createButton('🎓 Gestão de Competências', 'sidebar-pat-btn', () => {
      if (typeof closeSidebar === 'function') closeSidebar();
      showModule();
    });
    button.id = SIDEBAR_BTN_ID;
    button.dataset.mod = 'competency';
    button.dataset.sortkey = 'competency';
    button.style.marginTop = '4px';
    button.style.background = '#047857';
    button.style.color = 'white';
    button.style.borderColor = 'rgba(21,128,61,.5)';
    host.appendChild(button);
  }

  function injectHomeCard() {
    const host = byId('home-cards-grid');
    if (!host || byId(HOME_CARD_ID)) return;
    const card = createButton('', 'home-card', showModule);
    card.id = HOME_CARD_ID;
    card.dataset.sortkey = 'competency';
    card.style.borderTop = '4px solid #15803d';
    card.style.background = 'none';
    card.style.width = '100%';
    card.style.padding = '0';
    card.style.fontFamily = 'inherit';
    card.style.fontSize = 'inherit';
    card.style.textAlign = 'left';
    const icon = createNode('div', 'home-card-icon', '🎓');
    icon.style.background = '#047857';
    icon.style.color = '#fff';
    card.append(icon);
    card.append(createNode('div', 'home-card-title', 'Gestão de Competências'));
    card.append(createNode('div', 'home-card-desc', 'Gerencie quadro de pessoal, competências, trilhas, remoções e um banco de talentos com busca inteligente.'));
    const footer = createNode('div', 'home-card-footer', '0 pessoa(s) ⬢ 0 trilha(s)');
    footer.id = 'home-competency-count';
    card.append(footer);
    host.appendChild(card);
  }

  function injectShell() {
    const host = appMain();
    if (!host || byId(MODULE_ID)) return;
    const shell = createNode('section', 'gc-module-shell');
    shell.id = MODULE_ID;
    shell.innerHTML = `
      <div class="gc-shell">
        <section class="gc-hero">
          <div>
            <div class="gc-hero-kicker">Gestão de Pessoas e Competências</div>
            <div class="gc-hero-title">Módulo de Gestão de Competências</div>
            <div class="gc-hero-subtitle">Centralize quadro de pessoal, trilhas, treinamentos, pedidos de remoção, pesquisas de ambiente e um banco de talentos pesquisável.</div>
          </div>
          <div class="gc-hero-meta">
            <div class="gc-hero-pill"><span class="gc-hero-pill-label">Pessoas</span><span class="gc-hero-pill-value" id="gc-hero-people">0</span></div>
            <div class="gc-hero-pill"><span class="gc-hero-pill-label">Competências</span><span class="gc-hero-pill-value" id="gc-hero-competencies">0</span></div>
            <div class="gc-hero-pill"><span class="gc-hero-pill-label">Trilhas</span><span class="gc-hero-pill-value" id="gc-hero-paths">0</span></div>
            <div class="gc-hero-pill"><span class="gc-hero-pill-label">Remoções</span><span class="gc-hero-pill-value" id="gc-hero-removals">0</span></div>
          </div>
        </section>
        <div class="gc-toolbar"><div class="gc-tabs" id="gc-tabs"></div></div>
        <section class="gc-view" data-view="overview" id="gc-view-overview"></section>
        <section class="gc-view" data-view="people" id="gc-view-people" style="display:none;"></section>
        <section class="gc-view" data-view="performance" id="gc-view-performance" style="display:none;"></section>
        <section class="gc-view" data-view="removals" id="gc-view-removals" style="display:none;"></section>
        <section class="gc-view" data-view="competencies" id="gc-view-competencies" style="display:none;"></section>
        <section class="gc-view" data-view="trails" id="gc-view-trails" style="display:none;"></section>
        <section class="gc-view" data-view="surveys" id="gc-view-surveys" style="display:none;"></section>
        <section class="gc-view" data-view="talent" id="gc-view-talent" style="display:none;"></section>
        <datalist id="gc-competency-suggestions"></datalist>
        <datalist id="gc-units-list"></datalist>
        <datalist id="gc-teams-list"></datalist>
        <datalist id="gc-roles-list"></datalist>
        <datalist id="gc-macro-list"></datalist>
        <datalist id="gc-process-list"></datalist>
        <datalist id="gc-removals-units-list"></datalist>
      </div>`;
    host.appendChild(shell);
    buildStaticViews();
  }

  function buildStaticViews() {
    const viewPeople = byId('gc-view-people');
    const viewPerformance = byId('gc-view-performance');
    const viewRemovals = byId('gc-view-removals');
    const viewCompetencies = byId('gc-view-competencies');
    const viewTrails = byId('gc-view-trails');
    const viewSurveys = byId('gc-view-surveys');
    const viewTalent = byId('gc-view-talent');
    if (!viewPeople || !viewPerformance || !viewRemovals || !viewCompetencies || !viewTrails || !viewSurveys || !viewTalent) return;
    viewPeople.innerHTML = `<div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Cadastrar pessoa</div><div class="gc-panel-desc">Nome, perfil, trilhas cursadas, objetivos e importação sem duplicidade.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-person-name">Nome</label><input id="gc-person-name" type="text" maxlength="160"></div><div class="gc-field"><label for="gc-person-age">Idade</label><input id="gc-person-age" type="number" min="16" max="100"></div><div class="gc-field"><label for="gc-person-gender">Sexo</label><select id="gc-person-gender"><option value="">Selecione</option><option value="Feminino">Feminino</option><option value="Masculino">Masculino</option><option value="Outro">Outro</option></select></div><div class="gc-field"><label for="gc-person-entry-date">Entrada na CAGE</label><input id="gc-person-entry-date" type="date"></div><div class="gc-field"><label for="gc-person-basic-education">Formação básica</label><input id="gc-person-basic-education" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-person-extra-education">Formação complementar</label><input id="gc-person-extra-education" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-person-unit">Divisão / unidade</label><input id="gc-person-unit" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-team">Equipe</label><input id="gc-person-team" type="text" list="gc-teams-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-role">Cargo</label><input id="gc-person-role" type="text" list="gc-roles-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-competencies">Competências</label><input id="gc-person-competencies" type="text" list="gc-competency-suggestions" placeholder="Separar por vírgula"></div><div class="gc-field"><label for="gc-person-trails">Trilhas cursadas + nível</label><input id="gc-person-trails" type="text" placeholder="Separar por vírgula"></div><div class="gc-field"><label for="gc-person-probation">Em estágio probatório?</label><input id="gc-person-probation" type="text" readonly></div><div class="gc-field"><label for="gc-person-probation-end">Término do probatório</label><input id="gc-person-probation-end" type="date" readonly></div><div class="gc-field"><label for="gc-person-removal-interest">Interesse em remoção</label><select id="gc-person-removal-interest"><option value="Não">Não</option><option value="Sim">Sim</option></select></div><div class="gc-field"><label for="gc-person-desired-unit">Unidade desejada</label><input id="gc-person-desired-unit" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-person-taught-courses">Cursos ministrados</label><input id="gc-person-taught-courses" type="text" maxlength="220"></div><div class="gc-field"><label for="gc-person-preferences">Preferências / objetivos</label><textarea id="gc-person-preferences"></textarea></div><div class="gc-field"><label for="gc-person-experiences">Experiências relevantes</label><textarea id="gc-person-experiences"></textarea></div><div class="gc-field"><label for="gc-person-notes">Observações</label><textarea id="gc-person-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-person">Salvar pessoa</button><button type="button" class="btn btn-outline" id="gc-reset-person">Limpar</button><button type="button" class="btn btn-outline" id="gc-import-people-trigger">Importar planilha</button><input id="gc-people-import" type="file" accept=".xlsx,.xls,.csv" style="display:none;"></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Quadro de pessoal</div><div class="gc-panel-desc">Lista clicável com filtros por texto livre.</div></div><div class="gc-filter-row"><input id="gc-people-filter" type="search" placeholder="Filtrar por nome, cargo, equipe ou competência"></div></div><div class="gc-list" id="gc-people-list"></div></div><div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Análise de gaps</div><div class="gc-panel-desc">Compara competências atuais e necessárias para o contexto da pessoa.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-gap-person">Pessoa</label><select id="gc-gap-person"></select></div><div class="gc-field"><label for="gc-gap-unit">Unidade</label><input id="gc-gap-unit" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-gap-team">Equipe</label><input id="gc-gap-team" type="text" list="gc-teams-list" maxlength="120"></div><div class="gc-field"><label for="gc-gap-current">Competências atuais</label><textarea id="gc-gap-current"></textarea></div><div class="gc-field"><label for="gc-gap-required">Competências necessárias</label><textarea id="gc-gap-required"></textarea></div><div class="gc-field"><label for="gc-gap-observations">Observações</label><textarea id="gc-gap-observations"></textarea></div><div class="gc-field"><label for="gc-gap-recommendations">Recomendações</label><textarea id="gc-gap-recommendations"></textarea></div><div class="gc-field"><label for="gc-gap-action">Plano de ação</label><textarea id="gc-gap-action"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-gap">Salvar gap</button><button type="button" class="btn btn-outline" id="gc-reset-gap">Limpar</button></div><div class="gc-list" id="gc-gap-list"></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Reuniões de feedback</div><div class="gc-panel-desc">Registre participantes, objetivos e ata por pessoa.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-feedback-person">Pessoa</label><select id="gc-feedback-person"></select></div><div class="gc-field"><label for="gc-feedback-date">Data</label><input id="gc-feedback-date" type="date"></div><div class="gc-field"><label for="gc-feedback-participants">Participantes</label><input id="gc-feedback-participants" type="text" maxlength="220"></div><div class="gc-field"><label for="gc-feedback-objectives">Objetivos</label><textarea id="gc-feedback-objectives"></textarea></div><div class="gc-field"><label for="gc-feedback-minutes">Ata</label><textarea id="gc-feedback-minutes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-feedback">Salvar feedback</button><button type="button" class="btn btn-outline" id="gc-reset-feedback">Limpar</button></div><div class="gc-list" id="gc-feedback-list"></div></div></div>`;
    viewPerformance.innerHTML = `<div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Avaliação de performance</div><div class="gc-panel-desc">Cadastre avaliações manualmente e acompanhe a evolução.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-performance-person">Pessoa</label><select id="gc-performance-person"></select></div><div class="gc-field"><label for="gc-performance-date">Data da avaliação</label><input id="gc-performance-date" type="date"></div><div class="gc-field"><label for="gc-performance-method">Método</label><input id="gc-performance-method" type="text" maxlength="120"></div><div class="gc-field"><label for="gc-performance-objective">Objetivo</label><input id="gc-performance-objective" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-performance-result">Resultado</label><input id="gc-performance-result" type="text" maxlength="80"></div><div class="gc-field"><label for="gc-performance-notes">Observações</label><textarea id="gc-performance-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-performance">Salvar avaliação</button><button type="button" class="btn btn-outline" id="gc-reset-performance">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Histórico de avaliações</div><div class="gc-panel-desc">Filtre por pessoa, unidade e cargo para comparar a evolução.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-performance-filter-person">Pessoa</label><select id="gc-performance-filter-person"></select></div><div class="gc-field"><label for="gc-performance-filter-unit">Unidade</label><input id="gc-performance-filter-unit" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-performance-filter-role">Cargo</label><input id="gc-performance-filter-role" type="text" list="gc-roles-list" maxlength="120"></div></div><div class="gc-stat-bars" id="gc-performance-chart"></div><div class="gc-list" id="gc-performance-list"></div></div></div>`;
    viewRemovals.innerHTML = `<div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Banco de remoções</div><div class="gc-panel-desc">Registre origem, destino desejado e veja cruzamentos.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-removal-person">Pessoa</label><select id="gc-removal-person"></select></div><div class="gc-field"><label for="gc-removal-from">Unidade de origem</label><input id="gc-removal-from" type="text" list="gc-removals-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-removal-to">Unidade desejada</label><input id="gc-removal-to" type="text" list="gc-removals-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-removal-notes">Observação</label><textarea id="gc-removal-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-removal">Salvar remoção</button><button type="button" class="btn btn-outline" id="gc-reset-removal">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Solicitações cadastradas</div><div class="gc-panel-desc">Detecta cruzamentos diretos e triangulações.</div></div></div><div class="gc-list" id="gc-removals-list"></div></div></div>`;
    viewCompetencies.innerHTML = `<div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Cadastrar competência</div><div class="gc-panel-desc">Vincule a processos, equipes, pessoas, trilhas e treinamentos.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-competency-name">Competência / habilidade</label><input id="gc-competency-name" type="text" maxlength="160"></div><div class="gc-field"><label for="gc-competency-type">Tipo</label><select id="gc-competency-type"></select></div><div class="gc-field"><label for="gc-competency-macro">Macroprocesso</label><input id="gc-competency-macro" type="text" list="gc-macro-list" maxlength="160"></div><div class="gc-field"><label for="gc-competency-process">Processo</label><input id="gc-competency-process" type="text" list="gc-process-list" maxlength="160"></div><div class="gc-field"><label for="gc-competency-role">Cargo</label><input id="gc-competency-role" type="text" list="gc-roles-list" maxlength="120"></div><div class="gc-field"><label for="gc-competency-division">Divisão</label><input id="gc-competency-division" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-competency-team">Equipe</label><input id="gc-competency-team" type="text" list="gc-teams-list" maxlength="120"></div><div class="gc-field"><label for="gc-competency-person">Pessoa</label><select id="gc-competency-person"></select></div><div class="gc-field"><label for="gc-competency-trail">Trilha</label><select id="gc-competency-trail"></select></div><div class="gc-field"><label for="gc-competency-training">Treinamento</label><select id="gc-competency-training"></select></div><div class="gc-field"><label for="gc-competency-description">Descrição</label><textarea id="gc-competency-description"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-competency">Salvar competência</button><button type="button" class="btn btn-outline" id="gc-reset-competency">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Catálogo</div><div class="gc-panel-desc">Lista agrupada por vínculos e tipo.</div></div></div><div class="gc-list" id="gc-competencies-list"></div></div></div>`;
    viewTrails.innerHTML = `<div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Cadastrar trilha</div><div class="gc-panel-desc">Defina objetivo, degrau principal, pré-requisitos e competências.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-trail-name">Nome da trilha</label><input id="gc-trail-name" type="text" maxlength="160"></div><div class="gc-field"><label for="gc-trail-objective">Objetivo</label><input id="gc-trail-objective" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-trail-level-name">Nome do nível</label><input id="gc-trail-level-name" type="text" maxlength="120"></div><div class="gc-field"><label for="gc-trail-level-goal">Objetivo do nível</label><input id="gc-trail-level-goal" type="text" maxlength="180"></div><div class="gc-field"><label for="gc-trail-level-degree">Grau esperado</label><input id="gc-trail-level-degree" type="text" maxlength="120"></div><div class="gc-field"><label for="gc-trail-macro">Macroprocesso</label><input id="gc-trail-macro" type="text" list="gc-macro-list" maxlength="160"></div><div class="gc-field"><label for="gc-trail-division">Divisão</label><input id="gc-trail-division" type="text" list="gc-units-list" maxlength="120"></div><div class="gc-field"><label for="gc-trail-competencies">Competências vinculadas</label><input id="gc-trail-competencies" type="text" placeholder="Separar por vírgula"></div><div class="gc-field"><label for="gc-trail-prereq">Pré-requisitos</label><input id="gc-trail-prereq" type="text" placeholder="Separar por vírgula"></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-trail">Salvar trilha</button><button type="button" class="btn btn-outline" id="gc-reset-trail">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Cadastrar treinamento</div><div class="gc-panel-desc">Capacitações grátis/pagas, presenciais/remotas e vínculo com pessoas.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-training-name">Nome do treinamento</label><input id="gc-training-name" type="text" maxlength="160"></div><div class="gc-field"><label for="gc-training-cost">Grátis ou pago</label><input id="gc-training-cost" type="text" maxlength="40"></div><div class="gc-field"><label for="gc-training-mode">Presencial ou remoto</label><input id="gc-training-mode" type="text" maxlength="40"></div><div class="gc-field"><label for="gc-training-link">Link remoto</label><input id="gc-training-link" type="url" maxlength="240"></div><div class="gc-field"><label for="gc-training-provider">Fornecedor</label><input id="gc-training-provider" type="text" maxlength="120"></div><div class="gc-field"><label for="gc-training-trail">Trilha</label><select id="gc-training-trail"></select></div><div class="gc-field"><label for="gc-training-persons">Pessoas vinculadas</label><input id="gc-training-persons" type="text" placeholder="IDs ou nomes separados por vírgula"></div><div class="gc-field"><label for="gc-training-notes">Observações</label><textarea id="gc-training-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-training">Salvar treinamento</button><button type="button" class="btn btn-outline" id="gc-reset-training">Limpar</button></div></div></div><div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Trilhas</div><div class="gc-panel-desc">Capa com escada de desenvolvimento.</div></div></div><div class="gc-list" id="gc-trails-list"></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Treinamentos</div><div class="gc-panel-desc">Oferta e vínculo com trilhas e pessoas.</div></div></div><div class="gc-list" id="gc-trainings-list"></div></div></div>`;
    viewSurveys.innerHTML = `<div class="gc-split"><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Pesquisa de ambiente</div><div class="gc-panel-desc">Cadastre os dados anuais da pesquisa da GEPESC.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-survey-year">Ano</label><input id="gc-survey-year" type="number" min="2020" max="2100"></div><div class="gc-field"><label for="gc-survey-engagement">Engajamento</label><input id="gc-survey-engagement" type="text" maxlength="60"></div><div class="gc-field"><label for="gc-survey-leadership">Liderança</label><input id="gc-survey-leadership" type="text" maxlength="60"></div><div class="gc-field"><label for="gc-survey-climate">Clima</label><input id="gc-survey-climate" type="text" maxlength="60"></div><div class="gc-field"><label for="gc-survey-notes">Observações</label><textarea id="gc-survey-notes"></textarea></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-save-survey">Salvar pesquisa</button><button type="button" class="btn btn-outline" id="gc-reset-survey">Limpar</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Histórico</div><div class="gc-panel-desc">Série anual disponível para consulta.</div></div></div><div class="gc-list" id="gc-surveys-list"></div></div></div>`;
    viewTalent.innerHTML = `<div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Banco de talentos</div><div class="gc-panel-desc">Busca livre com IA, cruzando a necessidade textual com a Arquitetura de Processos, competências cadastradas, preferências e pedidos de remoção.</div></div></div><div class="gc-form-grid"><div class="gc-field"><label for="gc-talent-query">Busca livre com IA</label><input id="gc-talent-query" type="search" placeholder="Ex: procuro auditor para atuar com balanços contábeis na divisão de contabilidade"></div></div><div class="gc-actions"><button type="button" class="btn btn-primary" id="gc-run-talent-search">Buscar com IA</button></div></div><div class="gc-panel"><div class="gc-panel-head"><div><div class="gc-panel-title">Candidatos potenciais</div><div class="gc-panel-desc">A IA interpreta a necessidade e ranqueia candidatos aderentes.</div></div></div><div class="gc-match-list" id="gc-talent-results"></div></div>`;
  }

  function bindTabs() {
    const tabs = byId('gc-tabs');
    if (!tabs || tabs.childElementCount) return;
    TABS.forEach((item) => {
      const button = createButton(item.label, 'gc-tab', () => showView(item.key));
      button.dataset.tab = item.key;
      tabs.appendChild(button);
    });
  }

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
    byId('gc-save-gap')?.addEventListener('click', saveGap);
    byId('gc-reset-gap')?.addEventListener('click', resetGapForm);
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

  function fillSuggestionList() {
    const list = byId('gc-competency-suggestions');
    if (!list) return;
    list.replaceChildren();
    getCompetencySuggestions().forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      list.appendChild(option);
    });
  }

  function hookHideAllModules() {
    if (globalThis._gcHidePatched || typeof hideAllModules !== 'function') return;
    const original = hideAllModules;
    globalThis.hideAllModules = function patchedHideAllModules() {
      original();
      const shell = byId(MODULE_ID);
      if (shell) shell.style.display = 'none';
    };
    globalThis._gcHidePatched = true;
  }

  function hookHomeRefresh() {
    if (globalThis._gcHomeRefreshPatched || typeof homeRefresh !== 'function') return;
    const original = homeRefresh;
    globalThis.homeRefresh = function patchedHomeRefresh() {
      original();
      updateHomeCardCount();
    };
    globalThis._gcHomeRefreshPatched = true;
  }

  function init() {
    ensureStore();
    normalizeData();
    injectShell();
    injectHomeCard();
    injectSidebarButton();
    bindTabs();
    bindActions();
    hookHideAllModules();
    hookHomeRefresh();
    globalThis.showCompetencyModule = showModule;
    resetPeopleForm();
    resetRemovalForm();
    resetCompetencyForm();
    resetTrailForm();
    resetTrainingForm();
    resetSurveyForm();
    renderAll();
  }

  init();
})();
