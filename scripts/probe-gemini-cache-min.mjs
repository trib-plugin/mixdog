// probe-gemini-cache-min.mjs
// One-shot probe to determine the actual minimum-token threshold for the
// Gemini cachedContents API. Hits the v1beta endpoint directly with several
// payload sizes and prints the HTTP status + first 400 chars of the body.
//
// Result is decisive evidence for whether the documented "32,768 token min"
// is a hard limit or a recommendation.

import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'plugins', 'data', 'mixdog-trib-plugin', 'mixdog-config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const apiKey = config?.providers?.gemini?.apiKey || process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('No Gemini API key found.');
  process.exit(1);
}

// 4 chars ≈ 1 token rough estimate. We craft sizes to bracket the suspected
// 32k threshold: well below, around our actual prefix size, just below 32k,
// and well above.
const sizes = [
  { label: '4k tokens',  chars: 4 * 1024 * 4 },
  { label: '11.7k tokens (our actual prefix)', chars: 11700 * 4 },
  { label: '20k tokens', chars: 20 * 1024 * 4 },
  { label: '31k tokens', chars: 31 * 1024 * 4 },
  { label: '40k tokens', chars: 40 * 1024 * 4 },
];

const model = 'models/gemini-3-flash-preview';

async function probe({ label, chars }) {
  const sysText = ('system prompt segment. '.repeat(Math.ceil(chars / 23))).slice(0, chars);
  const body = {
    model,
    contents: [{ role: 'user', parts: [{ text: '.' }] }],
    systemInstruction: { role: 'system', parts: [{ text: sysText }] },
    ttl: '60s',
    displayName: `mixdog-probe-${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`,
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const elapsed = Date.now() - t0;
    const txt = await res.text();
    console.log(`\n[${label}] HTTP ${res.status} (${elapsed}ms)`);
    console.log(`  request body chars: ${sysText.length}`);
    console.log(`  response head: ${txt.slice(0, 400)}`);
    if (res.ok) {
      try {
        const json = JSON.parse(txt);
        console.log(`  → cache name: ${json.name}`);
        console.log(`  → usageMetadata: ${JSON.stringify(json.usageMetadata)}`);
        // Try to delete so we don't leak cached resources.
        if (json.name) {
          await fetch(`https://generativelanguage.googleapis.com/v1beta/${json.name}?key=${encodeURIComponent(apiKey)}`, { method: 'DELETE' });
          console.log(`  ✓ deleted`);
        }
      } catch {}
    }
  } catch (err) {
    console.log(`\n[${label}] FETCH ERROR: ${err.message}`);
  }
}

for (const s of sizes) {
  await probe(s);
}
