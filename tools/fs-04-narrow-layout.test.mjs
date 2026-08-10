import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('field legacy shell keeps both panes shrinkable without page-level overflow', () => {
  const src = read('public/field.html');
  assert.match(src, /\.f-workspace\s*\{[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(src, /\.f-right\s*\{[^}]*width:\s*0[^}]*min-width:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(src, /\.f-chat-b\s*\{[^}]*min-width:\s*0[^}]*overflow-y:\s*auto[^}]*overflow-x:\s*hidden/s);
  assert.match(src, /\.f-chat-f\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(src, /\.f-chat-f input\.input\s*\{[^}]*width:\s*0[^}]*min-width:\s*0/s);
});

test('field legacy Markdown wraps long prose and confines wide blocks', () => {
  const src = read('public/field.html');
  assert.match(src, /\.f-msg \.bub\s*\{[^}]*max-width:\s*calc\(100% - 40px\)[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(src, /\.f-msg \.bub code\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(src, /\.f-msg \.bub pre\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/s);
  assert.match(src, /\.md-table-wrap\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*overflow-x:\s*auto/s);
});

test('shared and public-submit Markdown surfaces carry the same overflow contract', () => {
  const shared = read('public/assets/ui.js');
  const submit = read('public/submit.html');
  assert.match(shared, /\.md-body\{min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere/);
  assert.match(shared, /\.md-table-wrap\{width:100%;min-width:0;max-width:100%;box-sizing:border-box;overflow-x:auto/);
  assert.match(submit, /\.cp-body\{[^}]*overflow-y:auto;overflow-x:hidden/s);
  assert.match(submit, /\.msg \.bubble\{[^}]*min-width:0;max-width:80%[^}]*overflow-wrap:anywhere/s);
  assert.match(submit, /\.cp-foot textarea\{[^}]*width:0;min-width:0;max-width:100%/s);
});

test('browser fixture consumes the real field stylesheet and includes all stress cases', () => {
  const fixture = read('tools/fixtures/fs-04-narrow-layout.html');
  assert.match(fixture, /fetch\('\/public\/field\.html'\)/);
  assert.match(fixture, /data-layout-smoke/);
  assert.match(fixture, /class="md-table-wrap"/);
  assert.match(fixture, /VeryLongIdentifierWithoutBreakPoints/);
  assert.match(fixture, /class="f-chat-row"/);
});
