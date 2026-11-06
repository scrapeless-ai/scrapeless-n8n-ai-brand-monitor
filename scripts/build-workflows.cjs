'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const functions = require('../src/monitor.cjs');
const root = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'config/monitor.example.json'), 'utf8'));
const embed = names => names.map(name => functions[name].toString()).join('\n\n');
const uuid = name => '00000000-0000-4000-8000-' + createHash('sha256').update(name).digest('hex').slice(0, 12);
function code(name, jsCode, position) {
  return { id: uuid(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { mode: 'runOnceForAllItems', jsCode } };
}
function dataTable(name, position, parameters, alwaysOutputData = false) {
  return { id: uuid(name), name, type: 'n8n-nodes-base.dataTable', typeVersion: 1.1, position, parameters, ...(alwaysOutputData ? { alwaysOutputData } : {}) };
}
function makeWorkflow(synthetic) {
  const mode = synthetic ? 'synthetic' : 'live';
  const selectedConfig = structuredClone(config);
  if (synthetic) selectedConfig.prompts = [
    { id: 'selection-criteria', text: config.prompts[0].text },
    { id: 'missing-sources', text: 'How should a team evaluate support and data quality?' },
    { id: 'empty-answer', text: 'Controlled empty answer case.' },
    { id: 'request-error', text: 'Controlled request failure case.' },
  ];
  const configCode = '// Edit only this configuration object. Never put an API key here.\nconst config = ' + JSON.stringify(selectedConfig, null, 2) + ';\n\n' + embed(['hostnameFromUrl', 'validateConfig', 'monitorKey']) + '\nconst validated = validateConfig(config);\nconst dataMode = ' + JSON.stringify(mode) + ';\nreturn [{ json: { ...validated, data_mode: dataMode, monitor_key: monitorKey(validated, dataMode), run_started_at: new Date().toISOString() } }];';
  const prepareCode = embed(['hostnameFromUrl', 'validateConfig', 'preparePrompts']) + "\nconst config = $('Configure Monitor').first().json;\nreturn preparePrompts(config, $execution.id, config.run_started_at, config.data_mode).map(json => ({ json }));";
  const historyTable = { __rl: true, mode: 'id', value: "={{ $('Ensure History Table').first().json.id }}" };
  const historyColumns = [
    ['monitor_key', 'string'], ['run_id', 'string'], ['run_started_at', 'date'],
    ['brand', 'string'], ['country', 'string'], ['changed_observations', 'number'], ['report_json', 'string'],
  ];
  const nodes = [
    { id: uuid('manual'), name: 'Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 300], parameters: {} },
    code('Configure Monitor', configCode, [240, 300]),
    dataTable('Ensure History Table', [480, 300], {
      resource: 'table', operation: 'create', tableName: synthetic ? 'ai_brand_monitor_demo_history' : 'ai_brand_monitor_history',
      columns: { column: historyColumns.map(([name, type]) => ({ name, type })) },
      options: { createIfNotExists: true },
    }),
    dataTable('Read Previous Run', [720, 300], {
      resource: 'row', operation: 'get', dataTableId: historyTable, matchType: 'allConditions',
      filters: { conditions: [
        { keyName: 'monitor_key', condition: 'eq', keyValue: "={{ $('Configure Monitor').first().json.monitor_key }}" },
        { keyName: 'run_started_at', condition: 'lt', keyValue: "={{ $('Configure Monitor').first().json.run_started_at }}" },
      ] },
      returnAll: false, limit: 1, orderBy: true, orderByColumn: 'run_started_at', orderByDirection: 'DESC',
    }, true),
    code('Prepare Prompts', prepareCode, [960, 300]),
  ];
  if (!synthetic) nodes.push({
    id: uuid('schedule'), name: 'Daily Schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.3, position: [0, 80],
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 1, triggerAtMinute: 0 }] } },
  });
  for (const [engine, label, y] of [['chatgpt', 'ChatGPT', 140], ['perplexity', 'Perplexity', 460]]) {
    const name = 'Scrapeless ' + label;
    if (synthetic) {
      const responseCode = `// SYNTHETIC DATA ONLY. This node never calls Scrapeless.\nreturn $input.all().map((item, i) => {\n  const c = item.json;\n  let json;\n  if (c.prompt_id === 'request-error') json = { error: 'Synthetic request failure' };\n  else if (c.prompt_id === 'empty-answer') json = { result_text: '' };\n  else if (c.prompt_id === 'missing-sources') json = ${engine === 'chatgpt' ? "{ result_text: 'Compare support, reliability, and data quality.' }" : "{ result_text: 'Company-A is one option to evaluate.', web_results: [{ url: 'https://example.com.other-site.example/compare' }] }"};\n  else json = ${engine === 'chatgpt' ? "{ result_text: 'Company A offers a useful comparison point. See [documentation](https://docs.example.com/guide).', web_search: true, content_references: [{ url: 'https://docs.example.com/guide' }, { url: 'https://docs.example.com/guide' }] }" : "{ result_text: 'Compare reliability and support. [Company A](https://example.com/about) can be included in an evaluation.', web_results: [{ url: 'https://example.com/about' }] }"};\n  return { json, pairedItem: { item: i } };\n});`;
      nodes.push(code(name, responseCode, [1220, y]));
    } else {
      nodes.push({
        id: uuid(name), name, type: 'n8n-nodes-scrapeless.scrapeless', typeVersion: 1,
        position: [1220, y],
        parameters: { resource: 'aiScraper', operation: engine, prompt: '={{ $json.prompt }}', country: '={{ $json.country }}', web_search: true, ...(engine === 'chatgpt' ? { shopping: false } : {}) },
        onError: 'continueRegularOutput', retryOnFail: false,
        notes: 'Bind your Scrapeless API credential. No automatic retries, to avoid duplicate billable tasks. Errors are normalized downstream.',
      });
    }
    const normalizeCode = embed(['hostnameFromUrl', 'answerTextForMatching', 'findAliases', 'normalizeObservation']) + `\nreturn $input.all().map((item, i) => {\n  const context = $('Prepare Prompts').itemMatching(i).json;\n  return { json: normalizeObservation(item.json, context, '${engine}', new Date().toISOString()), pairedItem: { item: i } };\n});`;
    nodes.push(code('Normalize ' + label, normalizeCode, [1480, y]));
  }
  nodes.push(
    { id: uuid('merge'), name: 'Merge Observations', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [1740, 300], parameters: { mode: 'append', numberInputs: 2 } },
    code('Build Report', embed(['buildReport', 'compareWithPrevious']) + "\nconst contexts = $('Prepare Prompts').all().map(item => item.json);\nconst saved = $('Read Previous Run').first().json.report_json;\nconst report = buildReport($input.all().map(item => item.json), contexts, new Date().toISOString());\nreturn [{ json: compareWithPrevious(report, saved ? JSON.parse(saved) : null) }];", [1980, 300]),
    dataTable('Save Run', [2220, 300], {
      resource: 'row', operation: 'upsert', dataTableId: historyTable,
      filters: { conditions: [{ keyName: 'run_id', condition: 'eq', keyValue: '={{ $json.run_id }}' }] },
      columns: {
        mappingMode: 'defineBelow',
        value: {
          monitor_key: "={{ $('Configure Monitor').first().json.monitor_key }}",
          run_id: '={{ $json.run_id }}', run_started_at: '={{ $json.run_started_at }}',
          brand: '={{ $json.brand }}', country: '={{ $json.country }}',
          changed_observations: '={{ $json.comparison.changed_observations }}',
          report_json: '={{ JSON.stringify($json) }}',
        },
        schema: historyColumns.map(([id, type]) => ({ id, displayName: id, type, display: true })),
      },
    }),
    code('Read Saved Report', 'return [{ json: JSON.parse($input.first().json.report_json) }];', [2460, 300]),
    { id: uuid('jsonfile'), name: 'Download JSON Report', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, position: [2940, 140], parameters: { operation: 'toJson', mode: 'each', binaryPropertyName: 'data', options: { fileName: 'ai-brand-report.json', format: true } } },
    code('Flatten CSV Rows', embed(['flattenCsvRows']) + '\nreturn flattenCsvRows($input.first().json).map(json => ({ json }));', [2700, 460]),
    { id: uuid('csvfile'), name: 'Download CSV Observations', type: 'n8n-nodes-base.convertToFile', typeVersion: 1.1, position: [2940, 460], parameters: { operation: 'csv', binaryPropertyName: 'data', options: { fileName: 'ai-brand-observations.csv', headerRow: true } } },
    { id: uuid('note'), name: 'Start Here', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [0, -180], parameters: { width: 690, height: 260, content: synthetic ? '## Offline demo - SYNTHETIC DATA\nNo API key or community package needed.\n\n1. Execute workflow.\n2. Inspect Build Report.\n3. Run it again to compare the saved snapshots.\n4. Download the JSON and CSV binary outputs.\n\nThe demo writes only to ai_brand_monitor_demo_history.' : '## AI Brand Monitor - ChatGPT + Perplexity\n1. Install n8n-nodes-scrapeless@0.5.4.\n2. Bind a Scrapeless API credential to both Scrapeless nodes.\n3. Edit Configure Monitor, then Execute workflow.\n4. Open Build Report for changes and the Data Tables view for history.\n5. Publish to start the daily schedule at 01:00 UTC.\n\nOne prompt creates two remote tasks per run. Downloads are available from the two final nodes.' } },
  );
  const connections = {};
  const connect = (from, to, input = 0) => {
    connections[from] ??= { main: [[]] };
    connections[from].main[0].push({ node: to, type: 'main', index: input });
  };
  connect('Manual Trigger', 'Configure Monitor');
  if (!synthetic) connect('Daily Schedule', 'Configure Monitor');
  connect('Configure Monitor', 'Ensure History Table');
  connect('Ensure History Table', 'Read Previous Run');
  connect('Read Previous Run', 'Prepare Prompts');
  for (const [label, input] of [['ChatGPT', 0], ['Perplexity', 1]]) {
    connect('Prepare Prompts', 'Scrapeless ' + label);
    connect('Scrapeless ' + label, 'Normalize ' + label);
    connect('Normalize ' + label, 'Merge Observations', input);
  }
  connect('Merge Observations', 'Build Report');
  connect('Build Report', 'Save Run'); connect('Save Run', 'Read Saved Report');
  connect('Read Saved Report', 'Download JSON Report'); connect('Read Saved Report', 'Flatten CSV Rows');
  connect('Flatten CSV Rows', 'Download CSV Observations');
  // No instance ids, credential references, execution data, or pinData in the public export.
  return { name: 'AI Brand Monitor - ' + (synthetic ? 'Offline Demo (Synthetic)' : 'ChatGPT + Perplexity'), nodes, connections, active: false, settings: { executionOrder: 'v1', executionTimeout: 600, timezone: 'UTC' }, tags: [] };
}
const targets = [ ['ai-brand-monitor.json', false], ['ai-brand-monitor-demo.json', true] ];
let failed = false;
for (const [filename, synthetic] of targets) {
  const destination = path.join(root, 'workflows', filename);
  const contents = JSON.stringify(makeWorkflow(synthetic), null, 2) + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== contents) { console.error(filename + ' is out of sync. Run npm run build.'); failed = true; }
  } else { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, contents); console.log('Built ' + filename); }
}
if (failed) process.exitCode = 1;
