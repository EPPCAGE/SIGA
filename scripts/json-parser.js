function _escapeControlChar(c) {
  if (c === '\n') return String.raw`\n`;
  if (c === '\r') return String.raw`\r`;
  if (c === '\t') return String.raw`\t`;
  return c;
}

function repairJsonString(str) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const c of str) {
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
  do { prev = s; s = s.replaceAll(/,\s*([}\]])/g, '$1'); } while (s !== prev);

  const stack = [];
  let inString = false;
  let escaped = false;

  for (const c of s) {
    if (escaped) { escaped = false; continue; }
    if (c === '\\' && inString) { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (!inString) _updateBracketStack(c, stack);
  }

  if (inString) s += '"';
  s = s.replaceAll(/[,:]\s*$/g, '');
  while (stack.length) s += stack.pop();

  return s;
}

function parseAiJson(text) {
  let clean = String(text || '').trim();
  clean = clean.replaceAll(/^```(?:json)?\s*/gi, '').replaceAll(/\s*```$/gi, '').trim();
  let lastError = null;

  const m = /\{[\s\S]*/.exec(clean);
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
