'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hostnameFromUrl, validateConfig, preparePrompts, findAliases, normalizeObservation, buildReport, flattenCsvRows, monitorKey, compareWithPrevious } = require('../src/monitor.cjs');
const config = require('../config/monitor.example.json');
const now = '2026-01-01T00:00:00.000Z';
const context = () => preparePrompts(config, 'test-run', now, 'synthetic')[0];
const normalize = (raw, engine = 'chatgpt') => normalizeObservation(raw, context(), engine, now);
const good = (answer = 'Company A is mentioned.') => ({ result_text: answer, content_references: [{ url: 'https://docs.example.com/guide' }] });

test('aliases match case-insensitively with Unicode normalization', () => {
  assert.deepEqual(findAliases('COMPANY A and Company-A.', ['Company A', 'Company-A']), ['Company A', 'Company-A']);
  assert.deepEqual(findAliases('\uFF23\uFF4F\uFF4D\uFF50\uFF41\uFF4E\uFF59 \uFF21', ['Company A']), ['Company A']);
});
test('word boundaries reject substring matches', () => {
  assert.deepEqual(findAliases('XCompany A2 and MyCompany-Acme.', ['Company A', 'Company-A']), []);
});
test('regex punctuation in an alias is literal', () => {
  assert.deepEqual(findAliases('Use A+B (a tool).', ['A+B', 'A.B']), ['A+B']);
});
test('link labels count but URLs and fenced or inline code do not', () => {
  assert.deepEqual(findAliases('[Company A](https://example.com)', ['Company A']), ['Company A']);
  assert.deepEqual(findAliases('https://example.com/Company-A `Company A`\n```\nCompany A\n```', ['Company A', 'Company-A']), []);
});
test('HTML attributes, comments and hidden script or style text do not count as answer mentions', () => {
  const hidden = '<img title="Company A > other" src="https://example.com/image"> <!-- Company A --> <script>Company A</script><style>Company A</style>';
  assert.deepEqual(findAliases(hidden, ['Company A']), []);
  assert.deepEqual(findAliases('<a href="https://example.com">Company A</a>', ['Company A']), ['Company A']);
});
test('bare hostname matching rejects lookalike suffixes and userinfo', () => {
  for (const url of ['https://example.com.other.example/path', 'https://notexample.com/path']) {
    const row = normalize({ result_text: 'No mention.', content_references: [{ url }] });
    assert.equal(row.brand_source_found, false);
  }
  for (const url of ['https://example.com@other.example/', 'https://example.com\\@other.example/', 'javascript:alert(1)', 'https://example.com:99999/']) assert.equal(hostnameFromUrl(url), null);
});
test('exact domains, case, trailing dot, ports and subdomains match', () => {
  for (const url of ['https://example.com/', 'https://DOCS.EXAMPLE.COM:443/guide', 'https://example.com./']) {
    assert.equal(normalize({ ...good(), content_references: [{ url }] }).brand_source_found, true);
  }
});
test('citations are deduplicated and preserve exact URLs', () => {
  const url = 'https://docs.example.com/guide#section';
  const row = normalize({ ...good(), content_references: [{ url }, { url }] });
  assert.equal(row.source_count, 1); assert.deepEqual(row.matched_source_urls, [url]);
});
test('missing and null source fields remain unknown', () => {
  for (const value of [undefined, null]) {
    const row = normalize({ result_text: 'An answer.', content_references: value });
    assert.equal(row.status, 'ok'); assert.equal(row.source_status, 'unavailable'); assert.equal(row.brand_source_found, null);
  }
});
test('an explicitly empty source array means a measurable negative', () => {
  const row = normalize({ result_text: 'An answer.', content_references: [] });
  assert.equal(row.source_status, 'available'); assert.equal(row.source_count, 0); assert.equal(row.brand_source_found, false);
});
test('malformed or partially invalid source lists do not become negatives', () => {
  for (const value of ['not an array', [{}], [{ url: 'https://example.com/' }, { title: 'missing URL' }]]) {
    const row = normalize({ result_text: 'An answer.', content_references: value });
    assert.equal(row.source_status, 'invalid'); assert.equal(row.brand_source_found, null);
  }
});
test('ChatGPT supplementary links and search results do not inflate source hits', () => {
  const row = normalize({ result_text: 'An answer.', links: [{ url: 'https://example.com/' }], search_result: [{ url: 'https://example.com/' }] });
  assert.equal(row.source_status, 'unavailable'); assert.equal(row.brand_source_found, null);
});
test('Perplexity uses web_results, not ChatGPT fields', () => {
  const row = normalize({ result_text: 'An answer.', web_results: [{ name: 'Documentation', url: 'https://example.com/' }], content_references: [] }, 'perplexity');
  assert.equal(row.source_field, 'web_results'); assert.equal(row.brand_source_found, true);
});
test('brand mentions and domain hits can disagree', () => {
  const row = normalize({ result_text: 'An unbranded answer.', content_references: [{ url: 'https://example.com/' }] });
  assert.equal(row.brand_mentioned, false); assert.equal(row.brand_source_found, true);
});
test('empty answers do not count as negative observations', () => {
  const row = normalize({ result_text: ' \n ', content_references: [] });
  assert.equal(row.status, 'empty'); assert.equal(row.brand_mentioned, null); assert.equal(row.brand_source_found, null);
});
test('missing answer or wrong response types become errors', () => {
  for (const raw of [null, [], {}, { result_text: {} }]) assert.equal(normalize(raw).status, 'error');
});
test('raw errors are not exported and cannot leak credentials', () => {
  const row = normalize({ error: 'Sensitive private diagnostic', result_text: 'Company A' });
  assert.equal(row.status, 'error'); assert.equal(row.brand_mentioned, null);
  assert.ok(!JSON.stringify(row).includes('Sensitive private diagnostic'));
});
test('summary uses separate denominators and excludes collection failures', () => {
  const contexts = preparePrompts({ ...config, prompts: [{ id: 'a', text: 'A?' }, { id: 'b', text: 'B?' }] }, 'r', now, 'synthetic');
  const rows = [
    normalizeObservation(good(), contexts[0], 'chatgpt', now),
    normalizeObservation({ result_text: 'An answer.' }, contexts[1], 'chatgpt', now),
    normalizeObservation({ error: 'Controlled failure' }, contexts[0], 'perplexity', now),
    normalizeObservation({ result_text: '' }, contexts[1], 'perplexity', now),
  ];
  const report = buildReport(rows, contexts, now);
  assert.equal(report.report_complete, true); assert.equal(report.all_answers_valid, false);
  assert.equal(report.summary[0].mention_rate, 0.5); assert.equal(report.summary[0].source_hit_rate, 1);
  assert.equal(report.summary[0].mention_denominator, 2); assert.equal(report.summary[0].source_denominator, 1);
  assert.equal(report.summary[1].mention_rate, null); assert.equal(report.summary[1].source_hit_rate, null);
});
test('incomplete, duplicate or unexpected observations cannot produce a complete report', () => {
  const contexts = [context()]; const row = normalize(good());
  assert.throws(() => buildReport([row], contexts, now), /Missing/);
  assert.throws(() => buildReport([row, row], contexts, now), /duplicate/);
  assert.throws(() => buildReport([{ ...row, observation_id: 'wrong' }], contexts, now), /Unexpected/);
});
test('CSV escapes dangerous spreadsheet formulas while JSON stays exact', () => {
  const row = { ...normalize(good()), answer: '=SUM(1,2)', prompt: '  @danger', brand: '-Example' };
  const csv = flattenCsvRows({ observations: [row] })[0];
  assert.equal(csv.answer, "'=SUM(1,2)"); assert.equal(csv.prompt, "'  @danger"); assert.equal(csv.brand, "'-Example");
  assert.equal(row.answer, '=SUM(1,2)'); assert.equal(csv.error, '');
  assert.deepEqual(JSON.parse(csv.matched_source_urls), ['https://docs.example.com/guide']);
});
test('configuration rejects empty, invalid or duplicate prompts before any API call', () => {
  for (const patch of [{ brand: '' }, { aliases: [''] }, { domains: ['https://example.com/'] }, { country: 'us' }, { prompts: [] }, { prompts: [{ id: 'x', text: 'A' }, { id: 'x', text: 'B' }] }]) {
    assert.throws(() => validateConfig({ ...config, ...patch }));
  }
});
test('prepare prompts preserves shared context without injecting the brand', () => {
  const prepared = preparePrompts(config, 'r', now);
  assert.equal(prepared[0].prompt, config.prompts[0].text); assert.equal(prepared[0].brand, config.brand);
  assert.equal(prepared[0].data_mode, 'live'); assert.equal(prepared[0].run_started_at, now);
});
test('portable workflow exports have unique node ids, valid edges and no private bindings', () => {
  for (const filename of ['ai-brand-monitor.json', 'ai-brand-monitor-demo.json']) {
    const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflows', filename), 'utf8'));
    assert.equal(new Set(workflow.nodes.map(n => n.id)).size, workflow.nodes.length);
    const names = new Set(workflow.nodes.map(n => n.name));
    for (const [from, connection] of Object.entries(workflow.connections)) {
      assert.ok(names.has(from));
      for (const output of connection.main) for (const edge of output) assert.ok(names.has(edge.node));
    }
    assert.equal(workflow.active, false); assert.equal(workflow.settings.executionTimeout, 600);
    for (const node of workflow.nodes) assert.equal(node.credentials, undefined);
    assert.equal(workflow.pinData, undefined);
    assert.equal(workflow.id, undefined);
  }
});

test('history groups equivalent settings and separates changed questions or data modes', () => {
  const original = validateConfig(config);
  const equivalent = { ...original, aliases: [...original.aliases].reverse() };
  assert.equal(monitorKey(original, 'live'), monitorKey(equivalent, 'live'));
  assert.notEqual(monitorKey(original, 'live'), monitorKey(original, 'synthetic'));
  assert.notEqual(monitorKey(original, 'live'), monitorKey({
    ...original, prompts: [{ ...original.prompts[0], text: 'A different question.' }],
  }, 'live'));
});

test('comparison tracks known gains and losses per engine without treating unknown as absence', () => {
  const oldRows = [normalize(good()), normalize({ result_text: 'No mention.', web_results: [] }, 'perplexity')];
  const newRows = [
    normalize({ result_text: 'No mention.' }),
    normalize({ result_text: 'Company A.', web_results: [{ url: 'https://example.com/' }] }, 'perplexity'),
  ];
  const old = buildReport(oldRows, [context()], now);
  const current = buildReport(newRows, [context()], now);
  const initial = compareWithPrevious(current, null);
  assert.equal(initial.observations[0].brand_mention_change, 'no_baseline');
  const compared = compareWithPrevious(current, old);
  assert.equal(compared.comparison.changed_observations, 2);
  assert.deepEqual(compared.comparison.changes.map(row => [row.brand_mention_change, row.brand_source_change]), [
    ['lost', 'unknown'], ['gained', 'gained'],
  ]);
  assert.equal(flattenCsvRows(compared)[1].previous_brand_mentioned, false);
});
