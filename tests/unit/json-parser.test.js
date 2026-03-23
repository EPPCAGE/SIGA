const { parseAiJson, truncateRepairJson } = require('../../scripts/json-parser');

describe('json-parser utilities', () => {
  test('parses clean JSON', () => {
    const out = parseAiJson('{"ok":true,"items":[1,2]}');
    expect(out.ok).toBe(true);
    expect(out.items).toEqual([1, 2]);
  });

  test('parses JSON wrapped in markdown fences', () => {
    const out = parseAiJson('```json\n{"name":"SIGA"}\n```');
    expect(out.name).toBe('SIGA');
  });

  test('repairs truncated JSON payload', () => {
    const repaired = truncateRepairJson('{"a":1,"b":["x","y"');
    expect(() => JSON.parse(repaired)).not.toThrow();
    const out = JSON.parse(repaired);
    expect(out.a).toBe(1);
    expect(out.b).toEqual(['x', 'y']);
  });

  test('parses response with prose before JSON', () => {
    const out = parseAiJson('Resultado:\n{"relatorio":"ok","gargalos":[]}');
    expect(out.relatorio).toBe('ok');
  });
});
