function _escapeControlChar(c) {
  if (c === '\n') return '\\n';
  if (c === '\r') return '\\r';
  if (c === '\t') return '\\t';
  return c;
}

function repairJsonString(str) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (escaped) { result += c; escaped = false; continue; }
    if (c === '\\' && inString) { result += c; escaped = true; continue; }
    if (c === '"') { inString = !inString; result += c; continue; }
    result += inString ? _escapeControlChar(c) : c;
  }

  return result;
}

function _updateBracketStack(c, stack) {
  if (c === '{') { stack.push('}'); return; }
  if (c === '[') { stack.push(']'); return; }
  if (c === '}' || c === ']') stack.pop();
}

function truncateRepairJson(str) {
  let s = repairJsonString(str);
  // Remove trailing commas antes de } ou ] iterativamente (uma passagem pode deixar ",," → ",]")
  let prev;
  do { prev = s; s = s.replace(/,\s*([}\]])/g, '$1'); } while (s !== prev);

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (!inString) _updateBracketStack(c, stack);
  }

  if (inString) s += '"';
  s = s.replace(/[,:]\s*$/, '');
  while (stack.length) s += stack.pop();

  return s;
}

function parseAiJson(text) {
  let clean = String(text || '').trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let lastError = null;

  const m = clean.match(/\{[\s\S]*/);
  if (m) clean = m[0];

  try {
    return JSON.parse(clean);
  } catch (parseError) {
    lastError = parseError;
  }

  try {
    return JSON.parse(repairJsonString(clean));
  } catch (repairError) {
    lastError = repairError;
  }

  try {
    return JSON.parse(truncateRepairJson(clean));
  } catch (truncateError) {
    lastError = truncateError;
    throw new Error(`Falha em todos os mecanismos de reparo JSON: ${lastError.message}`);
  }
}

module.exports = {
  repairJsonString,
  truncateRepairJson,
  parseAiJson,
};
