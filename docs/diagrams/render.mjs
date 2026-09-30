// Renders docs/diagrams/*.mmd to .svg and .png with Mermaid (pinned, from jsDelivr) in Playwright's Chromium.
// Usage: node docs/diagrams/render.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const DIR = dirname(fileURLToPath(import.meta.url));
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1400 }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0;background:#fff"><div id="out"></div></body></html>`);
await page.addScriptTag({ url: MERMAID });
await page.evaluate(() =>
  window.mermaid.initialize({
    startOnLoad: false,
    theme: 'default',
    securityLevel: 'loose',
    flowchart: { htmlLabels: true },
  }),
);
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.mmd'))) {
  const src = readFileSync(join(DIR, f), 'utf8');
  const svg = await page.evaluate(
    async ([id, code]) => {
      const { svg } = await window.mermaid.render(id, code);
      document.getElementById('out').innerHTML = svg;
      return svg;
    },
    [f.replace(/\W/g, '_'), src],
  );
  const base = join(DIR, f.replace(/\.mmd$/, ''));
  writeFileSync(`${base}.svg`, svg);
  await page.locator('#out svg').screenshot({ path: `${base}.png` });
  console.log('rendered', f);
}
await browser.close();
