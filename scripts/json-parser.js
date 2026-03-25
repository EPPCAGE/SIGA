function repairJsonString(str) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (escaped) {
      result += c;
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      result += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      result += c;
      continue;
    }
    if (inString) {
      if (c === '\n') {
        result += '\\n';
        continue;
      }
      if (c === '\r') {
        result += '\\r';
        continue;
      }
      if (c === '\t') {
        result += '\\t';
        continue;
      }
    }
    result += c;
  }

  return result;
}

function truncateRepairJson(str) {
  let s = repairJsonString(str);
  s = s.replaceAll(/,\s*([}\]])/g, '$1');

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
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
