// Składa jeden plik dla Tampermonkey: dist/allegro-listener.user.js
// Moduły trafiają do wspólnego obiektu `self` (nie do window strony).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODULES = ['src/rules/title.js', 'src/rules/description.js', 'src/lib/gemini.js', 'src/lib/listing.js', 'src/userscript/main.js'];
const OUT = path.join(ROOT, 'dist', 'allegro-listener.user.js');

function build() {
  const { version } = require(path.join(ROOT, 'package.json'));
  const header = fs.readFileSync(path.join(ROOT, 'src/userscript/header.txt'), 'utf8').replace('{{VERSION}}', version);
  const body = MODULES.map((file) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return `// ----- ${file} -----\n(function (self, module) {\n${src}\n})(NS, undefined);\n`;
  }).join('\n');
  const out = `${header}\n// Plik generowany przez scripts/build.js – nie edytuj ręcznie.\n(function () {\n'use strict';\nconst NS = {};\n\n${body}})();\n`;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  return OUT;
}

if (require.main === module) console.log('Zbudowano', path.relative(ROOT, build()));
module.exports = { build, OUT };
