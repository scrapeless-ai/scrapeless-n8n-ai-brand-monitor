# Contributing

For a workflow or report issue, open an issue in the hosting repository with the n8n and Scrapeless node versions, the affected node, a sanitized configuration, and the expected and observed output. For API or account issues, use [Scrapeless Support](https://docs.scrapeless.com/en/help/contact-support/?utm_source=github&utm_medium=referral&utm_campaign=scrapeless-n8n-ai-brand-monitor&utm_content=repository-readme).

Run these checks from the repository root with Node.js 22 or later:

```bash
npm run build
npm test
npm run check
```

Make logic changes in [the analysis source](src/monitor.cjs) and graph changes in [the generator](scripts/build-workflows.cjs). Include regenerated workflow JSON files with their source changes. Use the [offline demo](workflows/ai-brand-monitor-demo.json) or controlled responses for local verification. Keep credentials and raw live answers in private storage, and use sanitized examples when documenting changes.

See the [README](README.md) for the workflow contract and the [MIT license](LICENSE) for project terms.
