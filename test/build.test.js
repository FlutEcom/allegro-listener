const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { build } = require('../scripts/build.js');

test('userscript: nagłówek Tampermonkey i poprawna składnia', () => {
  const src = fs.readFileSync(build(), 'utf8');
  const { version } = require('../package.json');
  assert.match(src, /^\/\/ ==UserScript==/);
  assert.match(src, new RegExp(`@version\\s+${version.replace(/\./g, '\\.')}`));
  assert.match(src, /@match\s+https:\/\/salescenter\.allegro\.com\/\*/);
  assert.match(src, /@connect\s+generativelanguage\.googleapis\.com/);
  assert.doesNotThrow(() => new vm.Script(src));
});
