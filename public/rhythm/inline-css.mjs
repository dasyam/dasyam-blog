#!/usr/bin/env node
/* inline-css.mjs
 *
 * Replaces the render-blocking <link rel="stylesheet"> in index.html with an
 * inline <style> block containing the current contents of styles.css, so the
 * page paints without a second network round trip.
 *
 * Run AFTER every Tailwind rebuild, BEFORE deploy:
 *     node inline-css.mjs
 *
 * Check without writing (exits 1 if index.html is stale or not inlined):
 *     node inline-css.mjs --check
 *
 * Restore the external <link>, undoing the inline:
 *     node inline-css.mjs --revert
 *
 * Idempotent. Running it twice is the same as running it once. Running it
 * after a rebuild replaces the old inlined copy rather than appending.
 *
 * Design note: this script only ever rewrites the region between the two
 * CSS-INLINE markers in index.html. It touches nothing else in the file.
 * If the markers are missing it refuses to run rather than guessing.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Adjust these two if the script does not sit next to the files.
const HTML_PATH = resolve(here, 'index.html');
const CSS_PATH = resolve(here, 'styles.css');

const START = '<!-- CSS-INLINE-START';
const END = '<!-- CSS-INLINE-END -->';
const LINK_TAG = '<link rel="stylesheet" href="/rhythm/styles.css">';

const mode = process.argv[2] || '--write';

function fail(msg) {
  console.error('inline-css: ' + msg);
  process.exit(1);
}

if (!existsSync(HTML_PATH)) fail('cannot find index.html at ' + HTML_PATH);
if (!existsSync(CSS_PATH)) fail('cannot find styles.css at ' + CSS_PATH);

const html = readFileSync(HTML_PATH, 'utf8');
const css = readFileSync(CSS_PATH, 'utf8');

const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  fail('CSS-INLINE-START / CSS-INLINE-END markers not found in index.html. ' +
       'Refusing to guess where the stylesheet goes. Re-add the markers first.');
}

// The marker block runs from the START comment through the end of the END comment.
const blockStart = startIdx;
const blockEnd = endIdx + END.length;
const currentBlock = html.slice(blockStart, blockEnd);

// A closing tag inside CSS would terminate the <style> element early. Tailwind
// output will not contain one, but a stray one in a custom layer would break
// the page silently, so it is neutralised rather than trusted.
const safeCss = css.replace(/<\/style/gi, '<\\/style');
const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);

// Preserve the explanatory comment that sits inside the START marker, so the
// reasoning is not lost the first time the script runs.
const commentEnd = html.indexOf('-->', startIdx);
const leadComment = html.slice(startIdx, commentEnd + 3);

const inlinedBlock =
  leadComment + '\n' +
  '<style data-inlined-from="styles.css" data-css-hash="' + hash + '">' + safeCss + '</style>\n' +
  END;

const externalBlock = leadComment + '\n' + LINK_TAG + '\n' + END;

if (mode === '--check') {
  const m = currentBlock.match(/data-css-hash="([0-9a-f]+)"/);
  if (!m) {
    console.error('inline-css: STALE. index.html is not inlined. Run: node inline-css.mjs');
    process.exit(1);
  }
  if (m[1] !== hash) {
    console.error('inline-css: STALE. Inlined CSS does not match styles.css. Run: node inline-css.mjs');
    process.exit(1);
  }
  console.log('inline-css: up to date (' + hash + ')');
  process.exit(0);
}

if (mode === '--revert') {
  writeFileSync(HTML_PATH, html.slice(0, blockStart) + externalBlock + html.slice(blockEnd));
  console.log('inline-css: reverted to external <link>. Page is one round trip slower.');
  process.exit(0);
}

if (mode !== '--write') fail('unknown option "' + mode + '". Use --write, --check or --revert.');

writeFileSync(HTML_PATH, html.slice(0, blockStart) + inlinedBlock + html.slice(blockEnd));

const kb = (Buffer.byteLength(css, 'utf8') / 1024).toFixed(1);
console.log('inline-css: inlined ' + kb + ' KB from styles.css (hash ' + hash + ')');
console.log('inline-css: index.html now paints without the styles.css round trip.');
