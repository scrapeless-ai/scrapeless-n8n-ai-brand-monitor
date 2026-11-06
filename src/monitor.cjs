'use strict';

function hostnameFromUrl(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f]/u.test(value)) return null;
  // Only absolute HTTP(S) links without userinfo. No network request is made.
  const match = /^https?:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(?:[/?#]|$)/i.exec(value);
  if (!match || (match[2] && Number(match[2]) > 65535)) return null;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  return host;
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Monitor configuration must be an object.');
  if (typeof config.brand !== 'string' || !config.brand.trim()) throw new Error('brand must be a non-empty string.');
  if (!Array.isArray(config.aliases) || config.aliases.some(v => typeof v !== 'string' || !v.trim())) throw new Error('aliases must be an array of non-empty strings.');
  if (!Array.isArray(config.domains) || !config.domains.length) throw new Error('domains must contain at least one hostname.');
  const domains = config.domains.map(domain => {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/i.test(domain) || !domain.includes('.')) throw new Error('Use bare ASCII hostnames in domains, for example example.com.');
    const host = hostnameFromUrl('https://' + domain);
    if (!host) throw new Error('Invalid domain hostname.');
    return host;
  });
  if (typeof config.country !== 'string' || !/^[A-Z]{2}$/.test(config.country)) throw new Error('country must be a two-letter uppercase country code supported by the actor.');
  if (!Array.isArray(config.prompts) || !config.prompts.length || config.prompts.length > 10) throw new Error('Provide between 1 and 10 prompts per run.');
  const ids = new Set();
  const prompts = config.prompts.map(prompt => {
    if (!prompt || typeof prompt.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(prompt.id)) throw new Error('Each prompt needs an alphanumeric id, up to 64 characters.');
    if (ids.has(prompt.id)) throw new Error('Prompt ids must be unique.');
    ids.add(prompt.id);
    if (typeof prompt.text !== 'string' || !prompt.text.trim()) throw new Error('Each prompt needs non-empty text.');
    return { id: prompt.id, text: prompt.text.trim() };
  });
  return {
    brand: config.brand.trim(),
    aliases: [...new Set([config.brand.trim(), ...config.aliases.map(v => v.trim())])],
    domains: [...new Set(domains)],
    country: config.country,
    prompts,
  };
}

function preparePrompts(config, runId, startedAt, dataMode = 'live') {
  const valid = validateConfig(config);
  if (!['live', 'synthetic'].includes(dataMode)) throw new Error('Unsupported data mode.');
  return valid.prompts.map(prompt => ({
    run_id: String(runId), run_started_at: startedAt, data_mode: dataMode,
    brand: valid.brand, aliases: valid.aliases, domains: valid.domains,
    country: valid.country, prompt_id: prompt.id, prompt: prompt.text,
    web_search_requested: true, shopping_requested: false,
  }));
}

function answerTextForMatching(markdown) {
  // Keep answer text and link labels, excluding non-visible markup and code.
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*https?:\/\/\S+.*$/gm, ' ')
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .normalize('NFKC');
}

function findAliases(answer, aliases) {
  const visible = answerTextForMatching(answer);
  return aliases.filter(alias => {
    const literal = alias.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![\\p{L}\\p{N}_])' + literal + '(?![\\p{L}\\p{N}_])', 'iu').test(visible);
  });
}

function normalizeObservation(raw, context, engine, observedAt) {
  if (!['chatgpt', 'perplexity'].includes(engine)) throw new Error('Unsupported engine.');
  const base = {
    observation_id: context.run_id + ':' + context.prompt_id + ':' + engine,
    run_id: context.run_id, run_started_at: context.run_started_at,
    observed_at: observedAt, data_mode: context.data_mode,
    prompt_id: context.prompt_id, prompt: context.prompt,
    brand: context.brand, country: context.country, engine,
    web_search_requested: context.web_search_requested,
    shopping_requested: engine === 'chatgpt' ? false : null,
    web_search_reported: typeof raw?.web_search === 'boolean' ? raw.web_search : null,
    status: 'error', error: null, answer: null,
    brand_mentioned: null, matched_aliases: [],
    source_field: engine === 'chatgpt' ? 'content_references' : 'web_results',
    source_status: 'unavailable', source_count: null,
    source_urls: [], brand_source_found: null, matched_source_urls: [],
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...base, error: 'Invalid response object.' };
  if (raw.error !== undefined) {
    // Keep raw exception details in the private execution, not in exported files.
    return { ...base, error: 'Collection failed. Inspect this node in the private n8n execution.' };
  }
  if (typeof raw.result_text !== 'string') return { ...base, error: 'Missing or invalid result_text.' };
  if (!raw.result_text.trim()) return { ...base, status: 'empty', error: null, answer: '' };
  const matchedAliases = findAliases(raw.result_text, context.aliases);
  const row = {
    ...base, status: 'ok', answer: raw.result_text,
    brand_mentioned: matchedAliases.length > 0, matched_aliases: matchedAliases,
  };
  const sources = raw[row.source_field];
  if (sources === undefined || sources === null) return row;
  if (!Array.isArray(sources)) return { ...row, source_status: 'invalid' };
  let invalidCount = 0;
  const urls = new Set();
  for (const entry of sources) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    const host = hostnameFromUrl(url);
    if (!host) { invalidCount++; continue; }
    urls.add(url);
  }
  const sourceUrls = [...urls];
  const matching = sourceUrls.filter(url => {
    const host = hostnameFromUrl(url);
    return context.domains.some(domain => host === domain || host.endsWith('.' + domain));
  });
  return {
    ...row, source_status: invalidCount ? 'invalid' : 'available',
    source_count: invalidCount ? null : sourceUrls.length,
    source_urls: sourceUrls,
    // Incomplete or malformed source lists are excluded from the source rate.
    brand_source_found: invalidCount ? null : matching.length > 0,
    matched_source_urls: matching,
  };
}

function buildReport(rows, expectedContexts, generatedAt) {
  const expected = new Set(expectedContexts.flatMap(context => ['chatgpt', 'perplexity'].map(engine => context.run_id + ':' + context.prompt_id + ':' + engine)));
  const seen = new Set();
  for (const row of rows) {
    if (!expected.has(row.observation_id) || seen.has(row.observation_id)) throw new Error('Unexpected or duplicate observation; report not generated.');
    seen.add(row.observation_id);
    if (!['ok', 'empty', 'error'].includes(row.status)) throw new Error('Invalid observation status.');
  }
  if (seen.size !== expected.size) throw new Error('Missing observations; report not generated.');
  const summary = ['chatgpt', 'perplexity'].map(engine => {
    const all = rows.filter(row => row.engine === engine);
    const valid = all.filter(row => row.status === 'ok');
    const sources = valid.filter(row => row.source_status === 'available');
    const mentions = valid.filter(row => row.brand_mentioned === true).length;
    const hits = sources.filter(row => row.brand_source_found === true).length;
    return {
      engine, planned_observations: all.length, valid_answers: valid.length,
      empty_answers: all.filter(row => row.status === 'empty').length,
      errors: all.filter(row => row.status === 'error').length,
      brand_mentions: mentions, mention_denominator: valid.length,
      mention_rate: valid.length ? mentions / valid.length : null,
      source_hits: hits, source_denominator: sources.length,
      source_hit_rate: sources.length ? hits / sources.length : null,
      unavailable_source_answers: valid.filter(row => row.source_status === 'unavailable').length,
      invalid_source_answers: valid.filter(row => row.source_status === 'invalid').length,
    };
  });
  const first = expectedContexts[0];
  return {
    schema_version: '1.0', data_mode: first.data_mode,
    run_id: first.run_id, run_started_at: first.run_started_at, generated_at: generatedAt,
    brand: first.brand, country: first.country,
    report_complete: true,
    all_answers_valid: rows.every(row => row.status === 'ok'),
    planned_observations: expected.size,
    definitions: {
      mention_rate: 'Answers with a visible brand or alias match / valid answers. Range 0 to 1.',
      source_hit_rate: 'Valid answers with a configured hostname in the returned source list / valid answers with a complete, parseable source list. Range 0 to 1.',
      unknown: 'Null means unavailable or unmeasurable, not false or zero.',
      source_limit: 'Returned sources do not establish inline citation, endorsement, rank, or sentiment.',
    },
    summary,
    observations: [...rows].sort((a, b) => a.observation_id.localeCompare(b.observation_id)),
  };
}

function flattenCsvRows(report) {
  function safeCell(value) {
    // Prevent spreadsheet formulas; JSON keeps the original text unchanged.
    return typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? "'" + value : value;
  }
  return report.observations.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key, safeCell(value === null ? '' : Array.isArray(value) ? JSON.stringify(value) : value),
  ])));
}

function monitorKey(config, dataMode) {
  return JSON.stringify([
    'brand-monitor-v1', dataMode, config.brand, config.country,
    [...config.aliases].sort(), [...config.domains].sort(),
    config.prompts.map(prompt => [prompt.id, prompt.text]).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

function compareWithPrevious(report, previous) {
  const earlierRows = new Map((previous?.observations ?? []).map(row => [
    row.prompt_id + ':' + row.engine, row,
  ]));

  function change(current, before, hasBaseline) {
    if (!hasBaseline) return 'no_baseline';
    if (typeof current !== 'boolean' || typeof before !== 'boolean') return 'unknown';
    if (current === before) return 'unchanged';
    return current ? 'gained' : 'lost';
  }

  const observations = report.observations.map(row => {
    const earlier = earlierRows.get(row.prompt_id + ':' + row.engine);
    return {
      ...row,
      previous_brand_mentioned: earlier?.brand_mentioned ?? null,
      brand_mention_change: change(row.brand_mentioned, earlier?.brand_mentioned, Boolean(earlier)),
      previous_brand_source_found: earlier?.brand_source_found ?? null,
      brand_source_change: change(row.brand_source_found, earlier?.brand_source_found, Boolean(earlier)),
    };
  });
  const changed = observations.filter(row =>
    ['gained', 'lost'].includes(row.brand_mention_change) || ['gained', 'lost'].includes(row.brand_source_change)
  );
  return {
    ...report,
    comparison: {
      previous_run_id: previous?.run_id ?? null,
      previous_run_started_at: previous?.run_started_at ?? null,
      changed_observations: changed.length,
      changes: changed.map(({ prompt_id, engine, brand_mention_change, brand_source_change }) => ({
        prompt_id, engine, brand_mention_change, brand_source_change,
      })),
    },
    observations,
  };
}

module.exports = { hostnameFromUrl, validateConfig, preparePrompts, answerTextForMatching, findAliases, normalizeObservation, buildReport, flattenCsvRows, monitorKey, compareWithPrevious };
