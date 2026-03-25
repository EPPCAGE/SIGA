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
  s = s.replaceAll(/,\s*([}\]])/g, '$1');

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

  const m = clean.match(/\{[\s\S]*/);
  if (m) clean = m[0];

  try {
    return JSON.parse(clean);
  } catch (_e1) {
    // Keep trying with fallbacks below.
  }

  try {
    return JSON.parse(repairJsonString(clean));
  } catch (_e2) {
    // Keep trying with truncation repair below.
  }

  return JSON.parse(truncateRepairJson(clean));
}

module.exports = {
  repairJsonString,
  truncateRepairJson,
  parseAiJson,
};
