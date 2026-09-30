#!/usr/bin/env node
'use strict';
/**
 * Builds self-contained static pages with every local stylesheet and script
 * inlined. The result runs the offline demo with no server.
 *
 *   dist/            full HTML documents, ready for Vercel / Netlify / GitHub Pages
 *   dist-artifact/   page fragments for publishing as Claude artifacts
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PAGES = ['index.html', 'app/index.html', 'tv/index.html', 't/index.html', 'checkin/index.html', '404.html'];

function inline(html) {
  html = html.replace(/<link rel="stylesheet" href="\/(assets\/[^"]+\.css)">/g, (m, p) => `<style>\n${fs.readFileSync(path.join(ROOT, 'public', p), 'utf8')}\n</style>`);
  html = html.replace(/<script src="\/(shared|assets|vendor)\/([^"]+\.js)"><\/script>/g, (m, dir, f) => {
    const file = dir === 'shared' ? path.join(ROOT, 'shared', f) : path.join(ROOT, 'public', dir, f);
    return `<script>\n${fs.readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script')}\n</script>`;
  });
  return html;
}

function toFragment(html) {
  // Artifacts supply their own document shell: keep <title>, styles and body content.
  const head = (html.match(/<head>([\s\S]*?)<\/head>/) || [, ''])[1];
  const body = (html.match(/<body[^>]*>([\s\S]*)<\/body>/) || [, html])[1];
  const styles = head.match(/<style>[\s\S]*?<\/style>/g) || [];
  const title = (head.match(/<title>[\s\S]*?<\/title>/) || [''])[0];
  const links = (head.match(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g) || []).filter(l => /fonts\.g/.test(l));
  return [title, ...links, ...styles, body.trim()].join('\n');
}

for (const out of ['dist', 'dist-artifact']) fs.rmSync(path.join(ROOT, out), { recursive: true, force: true });
for (const page of PAGES) {
  const src = path.join(ROOT, 'public', page);
  if (!fs.existsSync(src)) continue;
  const html = inline(fs.readFileSync(src, 'utf8'));
  for (const [dir, content] of [['dist', html], ['dist-artifact', toFragment(html)]]) {
    const dest = path.join(ROOT, dir, page);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  console.log('built', page);
}
console.log('\nStatic demo written to dist/ (deploy this folder to any static host).');
