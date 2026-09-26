/**
 * Panel wtyczki na salescenter.allegro.com/offer…
 * Zdjęcie + nazwa (albo dane z katalogu) → jedno kliknięcie → Gemini: słowa kluczowe, tytuł, opis
 * wg reguł z rules/ → wstawienie tytułu do formularza, kopiowanie sekcji opisu.
 *
 * Moduły (AllegroTitleRules, AllegroDescriptionRules, AllegroGemini, AllegroListing)
 * dostarcza scripts/build.js w obiekcie `self`.
 */
/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_setClipboard */
'use strict';

const T = self.AllegroTitleRules;
const D = self.AllegroDescriptionRules;
const G = self.AllegroGemini;
const L = self.AllegroListing;

const OFFER_PATH = /^\/offer/;
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MAX_PHOTOS = 4;
const PHOTO_MAX_SIDE = 1024;

// ---------- ustawienia ----------

const settings = {
  get apiKey() { return GM_getValue('apiKey', ''); },
  get model() { return GM_getValue('model', '') || DEFAULT_MODEL; },
  get caseStyle() { return GM_getValue('caseStyle', 'AUTO'); },
  get search() { return GM_getValue('search', true); },
  save(values) {
    GM_setValue('apiKey', values.apiKey.trim());
    GM_setValue('model', values.model.trim().replace(/^models\//, ''));
    GM_setValue('caseStyle', values.caseStyle);
    GM_setValue('search', values.search);
  },
};

const state = {
  mode: null, // 'NEW' | 'CATALOG' – null = wybór automatyczny
  userPhotos: [], // [{mimeType, data, preview}]
  removedFormUrls: new Set(), // zdjęcia z formularza usunięte w panelu
  form: { name: '', parameters: [], imageUrls: [] },
  result: null,
  searchQueries: [],
};

// ---------- transport ----------

function gm(req) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      timeout: 180000,
      ...req,
      onload: resolve,
      onerror: () => reject(new Error(`Brak połączenia: ${new URL(req.url).host}`)),
      ontimeout: () => reject(new Error(`Przekroczony czas odpowiedzi: ${new URL(req.url).host}`)),
    });
  });
}

async function gmTransport(req) {
  const r = await gm({ method: req.method, url: req.url, headers: req.headers, data: req.body });
  return { status: r.status, text: r.responseText };
}

function ask() {
  return G.createAsk({
    apiKey: settings.apiKey,
    model: settings.model,
    transport: gmTransport,
    onSearch: (q) => { state.searchQueries = q; },
  });
}

// ---------- zdjęcia ----------

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

/** Zmniejsza zdjęcie do max 1024 px (JPEG) – szybciej i taniej dla Gemini. */
async function preparePhoto(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  const preview = await blobToDataUrl(jpeg);
  return { mimeType: 'image/jpeg', data: preview.split(',')[1], preview };
}

async function fetchPhoto(url) {
  const r = await gm({ method: 'GET', url, responseType: 'blob', timeout: 30000 });
  if (r.status !== 200) throw new Error(`Zdjęcie ${url}: HTTP ${r.status}`);
  return preparePhoto(r.response);
}

// ---------- integracja ze stroną ----------

function labelText(el) {
  const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  const wrap = el.closest('label');
  const labelled = el.getAttribute('aria-labelledby');
  return [byFor, wrap, labelled && document.getElementById(labelled)].filter(Boolean).map((l) => l.textContent).join(' ');
}

function visibleFields(selector) {
  return [...document.querySelectorAll(selector)].filter((el) => el.offsetParent !== null && !el.closest('#allegro-listener-root'));
}

/** Pole tytułu oferty w formularzu (heurystyka: maxlength 75 albo etykieta „Tytuł”). */
function findTitleInput() {
  const fields = visibleFields('input[type="text"], input:not([type]), textarea');
  return (
    fields.find((el) => el.maxLength === T.TITLE_MAX) ||
    fields.find((el) => /tytu[łl] oferty|tytu[łl]|nazwa oferty/i.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelText(el)].join(' ')))
  );
}

// Pola formularza, które nie są parametrami produktu.
const NOT_PARAMETER = /tytu[łl]|opis|cen[ay]|price|ilo[śs][ćc]|liczba sztuk|sygnatura|sku|\bean\b|gtin|kod|koszt|wysy[łl]k|dostaw|cennik|faktur|vat|termin|zwrot|reklamac|gwarancj|promowan|waluta|czas trwania/i;

function fieldLabel(el) {
  const own = labelText(el) || el.getAttribute('aria-label') || '';
  if (own.trim()) return own;
  const box = el.closest('[class*="field" i], [class*="param" i], [data-testid], fieldset, li, tr');
  const lab = box && box.querySelector('label, legend, [class*="label" i]');
  return lab ? lab.textContent : '';
}

/** Parametry produktu z formularza Sales Center (heurystyka: widoczne pola z etykietą i wartością). */
function readFormParameters() {
  const out = [];
  const seen = new Set();
  for (const el of visibleFields('input[type="text"], input[type="number"], input:not([type]), select, [role="combobox"]')) {
    const name = fieldLabel(el).replace(/\s+/g, ' ').replace(/[*:]\s*$/, '').trim();
    let value = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent : el.value ?? el.textContent;
    value = String(value || '').replace(/\s+/g, ' ').trim();
    if (!name || !value || name.length > 60 || NOT_PARAMETER.test(name) || /^wybierz/i.test(value) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value });
  }
  return out;
}

// Logo i grafiki interfejsu Sales Center (też hostowane na allegroimg) – nie są zdjęciami produktu.
const NOT_PRODUCT_IMAGE = /logo|sales[\s_-]?center|avatar|icon|ikon|banner/i;

function isInterfaceImage(img, src) {
  if (img.closest('header, nav, [role="banner"], [role="navigation"], [class*="logo" i], [class*="navbar" i]')) return true;
  if (NOT_PRODUCT_IMAGE.test([img.alt, img.title, src.split('/').pop()].join(' '))) return true;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  return w && h && (w / h > 2.5 || h / w > 2.5); // wąskie paski, np. logo z napisem
}

/** Zdjęcia produktu/oferty widoczne w formularzu (serwer allegroimg), w oryginalnym rozmiarze. */
function readFormImageUrls() {
  const urls = [];
  for (const img of document.querySelectorAll('img')) {
    if (img.closest('#allegro-listener-root')) continue;
    const src = img.currentSrc || img.src || '';
    if (!/allegroimg\.com/.test(src) || (img.naturalWidth && img.naturalWidth < 60) || isInterfaceImage(img, src)) continue;
    const url = src.replace(/\/s\d+\//, '/original/');
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

function readForm() {
  const title = findTitleInput();
  return { name: (title && title.value.trim()) || '', parameters: readFormParameters(), imageUrls: readFormImageUrls() };
}

/** Ustawia wartość tak, żeby zauważył ją React (natywny setter + zdarzenia). */
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------- edytor opisu ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/** Edytowalne pola tekstu opisu (contenteditable) – bez zagnieżdżonych i bez panelu wtyczki. */
function findDescriptionEditors() {
  return visibleFields('[contenteditable="true"], [contenteditable=""]')
    .filter((el) => !(el.parentElement && el.parentElement.closest('[contenteditable="true"], [contenteditable=""]')));
}

function selectContents(editor) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Czyści edytor i ustawia pusty akapit (bez resztek starego nagłówka z katalogu). */
function clearToParagraph(editor) {
  selectContents(editor);
  document.execCommand('delete');
  document.execCommand('formatBlock', false, 'p');
}

/**
 * Zastępuje treść edytora: najpierw jak wklejenie (edytory rich-text obsługują zdarzenie paste),
 * a gdy to nie zadziała – execCommand('insertHTML').
 */
async function replaceEditorContent(editor, html, text) {
  const probe = squash(text).slice(0, 40);
  const done = () => (probe ? squash(editor.innerText).includes(probe) : !squash(editor.innerText));
  selectContents(editor);
  if (html) {
    const dt = new DataTransfer();
    dt.setData('text/html', html);
    dt.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(150);
    if (done()) return true;
    clearToParagraph(editor);
    document.execCommand('insertHTML', false, html);
  } else {
    clearToParagraph(editor);
  }
  await sleep(150);
  return done();
}

/**
 * Wstawia opis do edytora Allegro: sekcja 1 → pole 1, sekcja 2 → pole 2…,
 * nadmiarowe sekcje opisu trafiają do ostatniego pola, nadmiarowe pola (np. opis z katalogu) są czyszczone.
 * @returns {Promise<{ok: boolean, editors: number, cleared: number}>}
 */
async function insertDescriptionIntoForm(sections) {
  const editors = findDescriptionEditors();
  if (!editors.length) return { ok: false, editors: 0, cleared: 0 };
  let ok = true;
  let cleared = 0;
  for (let i = 0; i < editors.length; i++) {
    const last = i === editors.length - 1;
    const part = last ? sections.slice(i) : sections.slice(i, i + 1);
    if (!part.length) {
      await replaceEditorContent(editors[i], '', '');
      cleared++;
      continue;
    }
    const html = part.map((s) => D.toAllegroHtml(s.blocks)).join('');
    const text = part.map((s) => s.blocks.map((b) => b.text.replace(/\*\*/g, '')).join('\n')).join('\n\n');
    ok = (await replaceEditorContent(editors[i], html, text)) && ok;
  }
  return { ok, editors: editors.length, cleared };
}

/** Uproszczona budowa edytora opisu (bez treści) – do dopasowania wtyczki do Sales Center. */
function describeDescriptionDom() {
  let root = null;
  const editors = findDescriptionEditors();
  if (editors.length) {
    root = editors[0];
    for (let i = 0; i < 8 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
  } else {
    const heading = [...document.querySelectorAll('h1, h2, h3, h4, legend, label, span, div')]
      .find((e) => e.children.length === 0 && /^opis( oferty| produktu)?$/i.test(squash(e.textContent)));
    root = heading && (heading.closest('section, fieldset, form') || heading.parentElement.parentElement.parentElement);
  }
  if (!root) return 'Nie znaleziono edytora opisu ani nagłówka „Opis”.';
  const lines = [`URL: ${location.pathname}`, `Pola contenteditable: ${editors.length}`];
  const walk = (node, depth) => {
    if (lines.length > 400 || depth > 16 || node.id === 'allegro-listener-root') return;
    const a = (n) => node.getAttribute(n);
    const cls = (node.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    const parts = [node.tagName.toLowerCase() + (node.id ? `#${node.id}` : '') + (cls ? `.${cls}` : '')];
    for (const n of ['role', 'aria-label', 'title', 'data-testid', 'data-role', 'contenteditable', 'type', 'name']) if (a(n) != null) parts.push(`${n}="${a(n).slice(0, 40)}"`);
    if (/^(BUTTON|A|LABEL|H\d|LEGEND)$/.test(node.tagName) || a('role') === 'button') parts.push(`"${squash(node.textContent).slice(0, 40)}"`);
    if (node.tagName === 'IMG') parts.push(`src=${(node.src || '').split('/')[2] || ''}`);
    lines.push('  '.repeat(depth) + parts.join(' '));
    if (a('contenteditable') != null) return; // bez treści opisu
    for (const c of node.children) walk(c, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

function copy(text, html) {
  GM_setClipboard(text, html ? 'html' : 'text');
}

// ---------- DOM ----------

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'class') node.className = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
}

const CSS_TEXT = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.fab { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; background: #ff5a00; color: #fff; border: 0;
  border-radius: 24px; padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.25); }
.panel { position: fixed; top: 0; right: 0; width: 460px; max-width: 100vw; height: 100vh; z-index: 2147483001; background: #fff;
  color: #222; box-shadow: -4px 0 20px rgba(0,0,0,.2); display: flex; flex-direction: column; font-size: 13px; }
.panel[hidden], .fab[hidden], [hidden] { display: none !important; }
header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #ff5a00; color: #fff; }
header b { font-size: 15px; }
header button { background: transparent; border: 0; color: #fff; font-size: 20px; cursor: pointer; }
nav { display: flex; border-bottom: 1px solid #ddd; }
nav button { flex: 1; padding: 9px 4px; border: 0; background: #f6f6f6; cursor: pointer; font-size: 13px; }
nav button.active { background: #fff; border-bottom: 2px solid #ff5a00; font-weight: 600; }
main { flex: 1; overflow: auto; padding: 12px 14px 40px; }
.modes { display: flex; gap: 6px; }
.modes button { flex: 1; padding: 10px 6px; border: 2px solid #ddd; border-radius: 6px; background: #fff; cursor: pointer; font-size: 13px; text-align: left; }
.modes button b { display: block; font-size: 14px; }
.modes button.active { border-color: #ff5a00; background: #fff4ec; }
label { display: block; margin: 10px 0 3px; font-weight: 600; }
small, .muted { color: #777; font-weight: 400; }
input[type=text], input[type=password], textarea, select { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
textarea { min-height: 54px; resize: vertical; }
.check { display: flex; gap: 6px; align-items: center; font-weight: 400; margin: 4px 12px 0 0; }
.row { display: flex; flex-wrap: wrap; align-items: center; }
.drop { border: 2px dashed #ccc; border-radius: 6px; padding: 8px; min-height: 76px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; cursor: pointer; outline: none; }
.drop:focus, .drop.over { border-color: #ff5a00; background: #fff8f3; }
.thumb { position: relative; width: 60px; height: 60px; border: 1px solid #ddd; border-radius: 4px; overflow: hidden; background: #fafafa; }
.thumb img { width: 100%; height: 100%; object-fit: contain; }
.thumb button { position: absolute; top: 0; right: 0; border: 0; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; font-size: 11px; padding: 1px 4px; }
.thumb .tag { position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,.5); color: #fff; font-size: 9px; text-align: center; }
.btn { background: #ff5a00; color: #fff; border: 0; border-radius: 4px; padding: 8px 12px; font-weight: 600; cursor: pointer; margin: 8px 6px 0 0; }
.btn.big { width: 100%; padding: 12px; font-size: 15px; margin-top: 14px; }
.btn.sec { background: #eee; color: #222; }
.btn.small { padding: 4px 8px; font-size: 12px; margin-top: 4px; }
.btn:disabled { opacity: .5; cursor: wait; }
.status { margin-top: 8px; color: #555; }
.status.err { color: #c00; }
.card { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; margin-top: 8px; }
.card.ok { border-color: #2a9d4b; }
h3 { font-size: 14px; margin: 18px 0 4px; border-top: 1px solid #eee; padding-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { background: #f0f0f0; border-radius: 12px; padding: 2px 8px; }
.chip.top { background: #ff5a00; color: #fff; }
ul.msgs { margin: 4px 0 0; padding-left: 18px; }
.e { color: #c00; } .w { color: #b36b00; }
.hint { background: #fff4ec; border-left: 3px solid #ff5a00; padding: 4px 8px; margin-bottom: 6px; color: #7a3c00; }
.preview h1 { font-size: 17px; margin: 4px 0; } .preview h2 { font-size: 15px; margin: 4px 0; } .preview p { margin: 3px 0; }
details { margin-top: 8px; } summary { cursor: pointer; color: #555; }
`;

function buildUi() {
  const host = el('div', { id: 'allegro-listener-root' });
  const root = host.attachShadow({ mode: 'open' });
  root.append(el('style', {}, CSS_TEXT));
  document.body.append(host);
  const $ = (id) => root.getElementById(id);
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, on: { change: () => addFiles(fileInput.files) } });

  // --- Generuj ---
  const genTab = el('div', { id: 'tab-gen' },
    el('div', { class: 'modes' },
      el('button', { id: 'modeNEW', on: { click: () => setMode('NEW', true) } }, el('b', {}, 'Nowy produkt'), el('span', { class: 'muted' }, 'zdjęcie + nazwa')),
      el('button', { id: 'modeCATALOG', on: { click: () => setMode('CATALOG', true) } }, el('b', {}, 'Z katalogu'), el('span', { class: 'muted' }, 'dane z formularza Allegro')),
    ),
    el('label', { for: 'productName' }, 'Nazwa produktu'),
    el('input', { type: 'text', id: 'productName', placeholder: 'np. Klocki magnetyczne 100 el.' }),
    el('label', {}, 'Zdjęcia ', el('small', { id: 'photoInfo' })),
    el('div', { class: 'drop', id: 'drop', tabindex: '0', title: 'Kliknij, przeciągnij zdjęcie albo wklej Ctrl+V',
      on: {
        click: (e) => { if (e.target.id === 'drop' || e.target.classList.contains('muted')) fileInput.click(); },
        dragover: (e) => { e.preventDefault(); $('drop').classList.add('over'); },
        dragleave: () => $('drop').classList.remove('over'),
        drop: (e) => { e.preventDefault(); $('drop').classList.remove('over'); addFiles(e.dataTransfer.files); },
      } }),
    fileInput,
    el('div', { id: 'catalogInfo', class: 'card', hidden: true }),
    el('button', { class: 'btn sec small', on: { click: refreshForm } }, 'Odśwież dane z formularza'),
    el('label', { for: 'extra' }, 'Dodatkowe informacje ', el('small', {}, '– opcjonalnie: wymiary, wiek, zawartość, materiał…')),
    el('textarea', { id: 'extra', rows: '3' }),
    el('details', {},
      el('summary', {}, 'Więcej opcji'),
      el('label', { for: 'promo' }, 'Promocja ', el('small', {}, '– tylko prawdziwa, trafi do opisu dosłownie')),
      el('input', { type: 'text', id: 'promo' }),
      el('label', { for: 'socialProof' }, 'Social proof ', el('small', {}, '– tylko prawdziwe dane, np. 4,9/5 – 1200 ocen')),
      el('input', { type: 'text', id: 'socialProof' }),
      el('label', { for: 'allowWords' }, 'Dozwolone mimo zakazu ', el('small', {}, '– po przecinku, np. słowo z nazwy produktu')),
      el('input', { type: 'text', id: 'allowWords' }),
    ),
    el('button', { class: 'btn big', id: 'generate', on: { click: onGenerate } }, '⚡ Generuj tytuł i opis'),
    el('div', { class: 'status', id: 'status' }),
    el('div', { id: 'results', hidden: true },
      el('h3', {}, 'Słowa kluczowe'),
      el('div', { class: 'chips', id: 'keywords' }),
      el('div', { class: 'muted', id: 'searched' }),
      el('h3', {}, 'Tytuł ', el('small', { id: 'titleInfo' })),
      el('input', { type: 'text', id: 'title', on: { input: refreshDescription } }),
      el('ul', { class: 'msgs', id: 'titleMsgs' }),
      el('button', { class: 'btn', on: { click: insertTitle } }, 'Wstaw do formularza'),
      el('button', { class: 'btn sec', on: { click: () => copy($('title').value) } }, 'Kopiuj'),
      el('details', {}, el('summary', { id: 'altTitlesSummary' }, 'Inne propozycje'), el('div', { id: 'altTitles' })),
      el('h3', {}, 'Opis'),
      el('div', { class: 'row' },
        el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'smallParts', on: { change: refreshDescription } }), 'Małe elementy (ostrzeżenie 36 mies.)'),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'isNew', checked: true, on: { change: refreshDescription } }), 'Produkt nowy'),
      ),
      el('ul', { class: 'msgs', id: 'descMsgs' }),
      el('button', { class: 'btn', id: 'insertDesc', on: { click: insertDescription } }, 'Wstaw opis do formularza'),
      el('button', { class: 'btn sec', on: { click: () => copyAll(true) } }, 'Kopiuj cały opis'),
      el('button', { class: 'btn sec', on: { click: () => copyAll(false) } }, 'Kopiuj sam tekst'),
      el('div', { id: 'descSections' }),
    ),
  );

  // --- Ustawienia ---
  const settingsTab = el('div', { id: 'tab-settings', hidden: true },
    el('label', { for: 'apiKey' }, 'Klucz API Gemini ', el('small', {}, '– zapisywany tylko w Tampermonkey na tym komputerze')),
    el('input', { type: 'password', id: 'apiKey', value: settings.apiKey }),
    el('label', { for: 'model' }, 'Model Gemini ', el('small', {}, `– domyślnie ${DEFAULT_MODEL}`)),
    el('input', { type: 'text', id: 'model', value: settings.model, list: 'modelList' }),
    el('datalist', { id: 'modelList' }),
    el('label', { for: 'caseStyle' }, 'Wielkość liter w tytule'),
    el('select', { id: 'caseStyle' },
      el('option', { value: 'AUTO' }, 'AUTO – jak konkurencja (Gemini sprawdza)'),
      el('option', { value: 'UPPER' }, 'Zawsze CAPSLOCK'),
      el('option', { value: 'TITLE' }, 'Zawsze Pierwsze Litery Wielkie')),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'search', checked: settings.search }),
      'Szukaj słów kluczowych w Google (Trends, Allegro) – dokładniej, ale wolniej'),
    el('button', { class: 'btn', on: { click: saveSettings } }, 'Zapisz'),
    el('button', { class: 'btn sec', on: { click: loadModels } }, 'Pobierz listę modeli'),
    el('button', { class: 'btn sec', on: { click: () => {
      copy(describeDescriptionDom());
      setStatus('settingsStatus', 'Skopiowano budowę edytora opisu (bez treści). Wklej ją w rozmowie z autorem wtyczki.');
    } } }, 'Skopiuj budowę edytora opisu'),
    el('div', { class: 'status', id: 'settingsStatus' }),
  );
  settingsTab.querySelector('#caseStyle').value = settings.caseStyle;

  const tabs = { gen: ['Generuj', genTab], settings: ['Ustawienia', settingsTab] };
  const nav = el('nav', {}, ...Object.entries(tabs).map(([key, [label]]) =>
    el('button', { 'data-tab': key, class: key === 'gen' ? 'active' : '', on: { click: () => showTab(key) } }, label)));

  const panel = el('div', { class: 'panel', hidden: true },
    el('header', {}, el('b', {}, '✨ Allegro Listener'), el('button', { title: 'Zamknij', on: { click: () => toggle(false) } }, '×')),
    nav,
    el('main', {}, genTab, settingsTab),
  );
  const fab = el('button', { class: 'fab', on: { click: () => toggle(true) } }, '✨ AI oferta');
  root.append(fab, panel);

  // Ctrl+V ze zdjęciem w panelu
  root.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  function showTab(key) {
    for (const [k, [, node]] of Object.entries(tabs)) node.hidden = k !== key;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.tab === key);
  }

  function toggle(open) {
    panel.hidden = !open;
    fab.hidden = open;
    if (!open) return;
    refreshForm();
    if (!settings.apiKey) showTab('settings');
  }

  function setStatus(id, text, isError) {
    $(id).textContent = text;
    $(id).classList.toggle('err', !!isError);
  }

  function msgs(list, errors, warnings) {
    list.replaceChildren(
      ...(errors || []).map((m) => el('li', { class: 'e' }, m)),
      ...(warnings || []).map((m) => el('li', { class: 'w' }, m)),
    );
  }

  // --- tryb i dane z formularza ---
  function setMode(mode, manual) {
    if (manual) state.mode = mode;
    for (const m of ['NEW', 'CATALOG']) $(`mode${m}`).classList.toggle('active', m === mode);
    $('catalogInfo').hidden = mode !== 'CATALOG';
  }

  function currentMode() {
    return state.mode || (state.form.parameters.length >= 3 ? 'CATALOG' : 'NEW');
  }

  function refreshForm() {
    state.form = readForm();
    if (state.form.name && !$('productName').value.trim()) $('productName').value = state.form.name;
    const p = state.form.parameters;
    $('catalogInfo').replaceChildren(
      el('b', {}, `Z formularza: ${p.length} parametrów, ${formImageUrls().length} zdjęć`),
      p.length ? el('details', {}, el('summary', {}, 'Pokaż parametry'), el('ul', { class: 'msgs' }, ...p.map((x) => el('li', {}, `${x.name}: ${x.value}`)))) : el('div', { class: 'muted' }, 'Wybierz produkt z katalogu w formularzu Allegro i kliknij „Odśwież”.'),
    );
    setMode(currentMode());
    renderPhotos();
  }

  function formImageUrls() {
    return state.form.imageUrls.filter((u) => !state.removedFormUrls.has(u));
  }

  function photoList() {
    const user = state.userPhotos.map((p, i) => ({ src: p.preview, tag: 'Twoje', remove: () => state.userPhotos.splice(i, 1) }));
    const form = formImageUrls().map((u) => ({ src: u, tag: 'formularz', remove: () => state.removedFormUrls.add(u) }));
    return [...user, ...form].slice(0, MAX_PHOTOS);
  }

  function renderPhotos() {
    const list = photoList();
    $('photoInfo').replaceChildren(
      `– ${list.length}/${MAX_PHOTOS}${list.length ? '' : ': kliknij, przeciągnij albo wklej Ctrl+V'} `,
      state.removedFormUrls.size
        ? el('a', { href: '#', on: { click: (e) => { e.preventDefault(); state.removedFormUrls.clear(); renderPhotos(); } } }, `przywróć usunięte (${state.removedFormUrls.size})`)
        : '',
    );
    $('drop').replaceChildren(
      ...list.map((p) => el('div', { class: 'thumb' },
        el('img', { src: p.src, alt: '' }),
        el('span', { class: 'tag' }, p.tag),
        el('button', { title: 'Usuń', on: { click: (e) => { e.stopPropagation(); p.remove(); renderPhotos(); } } }, '×'))),
      ...(list.length < MAX_PHOTOS ? [el('span', { class: 'muted' }, list.length ? '+ dodaj' : 'Kliknij, przeciągnij zdjęcie albo wklej Ctrl+V')] : []),
    );
  }

  async function addFiles(files) {
    for (const f of [...files].filter((x) => x.type.startsWith('image/'))) {
      if (state.userPhotos.length >= MAX_PHOTOS) break;
      try {
        state.userPhotos.push(await preparePhoto(f));
      } catch (e) {
        setStatus('status', `Nie udało się wczytać zdjęcia: ${e.message}`, true);
      }
    }
    fileInput.value = '';
    renderPhotos();
  }

  /** Zdjęcia do wysłania: Twoje + z formularza (pobierane dopiero teraz), max 4. */
  async function collectPhotos() {
    const photos = state.userPhotos.slice(0, MAX_PHOTOS);
    for (const url of formImageUrls()) {
      if (photos.length >= MAX_PHOTOS) break;
      try {
        photos.push(await fetchPhoto(url));
      } catch (e) {
        // zdjęcie z formularza niedostępne – pomijamy
      }
    }
    return photos;
  }

  // --- generowanie ---
  async function onGenerate() {
    refreshForm();
    const mode = currentMode();
    const productName = $('productName').value.trim();
    if (!settings.apiKey) {
      showTab('settings');
      return setStatus('settingsStatus', 'Najpierw wklej klucz API Gemini i kliknij Zapisz.', true);
    }
    if (!productName && !state.userPhotos.length && !formImageUrls().length) {
      return setStatus('status', 'Dodaj zdjęcie albo wpisz nazwę produktu.', true);
    }
    $('generate').disabled = true;
    const started = Date.now();
    let phase = 'Przygotowuję zdjęcia…';
    const tick = () => setStatus('status', `${phase} ${Math.round((Date.now() - started) / 1000)} s`);
    tick();
    const timer = setInterval(tick, 1000);
    try {
      const images = await collectPhotos();
      state.searchQueries = [];
      const input = {
        mode,
        productName,
        extra: $('extra').value.trim(),
        parameters: state.form.parameters,
        images,
        search: settings.search,
        caseStyle: settings.caseStyle,
        promo: $('promo').value.trim(),
        socialProof: $('socialProof').value.trim(),
        allowWords: $('allowWords').value.split(',').map((s) => s.trim()).filter(Boolean),
        date: new Date(),
      };
      state.result = await L.generateListing(input, ask(), { onProgress: (m) => { phase = m; tick(); } });
      renderResult();
      const secs = Math.round((Date.now() - started) / 1000);
      const r = state.result;
      setStatus('status', r.title.ok && r.description.ok
        ? `Gotowe w ${secs} s. Sprawdź i wstaw tytuł, potem skopiuj opis.`
        : `Gotowe w ${secs} s, ale ${!r.title.ok ? 'tytuł' : 'opis'} nadal łamie reguły – popraw ręcznie (czerwone uwagi).`, !(r.title.ok && r.description.ok));
    } catch (e) {
      setStatus('status', e.message, true);
    } finally {
      clearInterval(timer);
      $('generate').disabled = false;
    }
  }

  // --- wyniki ---
  function renderResult() {
    const r = state.result;
    $('results').hidden = false;
    $('keywords').replaceChildren(...r.research.keywords.map((k, i) => el('span', { class: `chip${i === 0 ? ' top' : ''}` }, k)));
    $('searched').textContent = state.searchQueries.length ? `Gemini szukał w Google: ${state.searchQueries.join(' · ')}` : '';
    $('title').value = r.title.value;
    $('altTitlesSummary').textContent = `Inne propozycje (${r.title.results.length})`;
    $('altTitles').replaceChildren(...r.title.results.map((t) =>
      el('div', { class: `card${t.ok ? ' ok' : ''}` },
        el('div', {}, t.title),
        el('div', { class: 'muted' }, `${t.length} znaków${t.ok ? ' · ✔ OK' : ''}`),
        el('ul', { class: 'msgs' }, ...t.errors.map((m) => el('li', { class: 'e' }, m))),
        el('button', { class: 'btn small', on: { click: () => { $('title').value = t.title; refreshDescription(); } } }, 'Wybierz'))));
    $('smallParts').checked = !!r.descInput.smallParts;
    $('isNew').checked = r.descInput.condition === 'NEW';
    refreshDescription();
  }

  /** Przelicza tytuł i opis lokalnie (bez Gemini) po zmianie tytułu lub przełączników. */
  function refreshDescription() {
    const r = state.result;
    if (!r) return;
    const title = $('title').value.trim();
    const tv = T.validateTitle(title, { topKeyword: r.titleInput.keywords[0] || r.titleInput.productName, allowWords: r.titleInput.allowWords });
    $('titleInfo').textContent = `${tv.length}/${T.TITLE_MAX} znaków`;
    msgs($('titleMsgs'), tv.errors, tv.warnings);

    const input = { ...r.descInput, title, smallParts: $('smallParts').checked, condition: $('isNew').checked ? 'NEW' : 'USED' };
    const v = D.validateDescription(r.description.content, input);
    state.current = v;
    msgs($('descMsgs'), v.errors, v.warnings);
    $('descSections').replaceChildren(...v.description.sections.map((s, i) => {
      const html = D.toAllegroHtml(s.blocks);
      const preview = el('div', { class: 'preview' });
      preview.innerHTML = html; // HTML z toAllegroHtml – tekst jest escapowany
      return el('div', { class: 'card' },
        el('div', { class: 'hint' }, `Sekcja ${i + 1}: ${s.layout === 'TEXT' ? 'sam tekst' : `zdjęcie po lewej – ${s.imageHint}`}`),
        preview,
        el('button', { class: 'btn small', on: { click: () => copy(html, true) } }, 'Kopiuj sekcję'),
        el('button', { class: 'btn small sec', on: { click: () => copy(s.blocks.map((b) => b.text.replace(/\*\*/g, '')).join('\n')) } }, 'Kopiuj tekst'));
    }));
  }

  function copyAll(html) {
    if (!state.current) return;
    const d = state.current.description;
    copy(html ? d.sections.map((s) => D.toAllegroHtml(s.blocks)).join('') : D.toPlainText(d), html);
    setStatus('status', 'Skopiowano opis do schowka.');
  }

  async function insertDescription() {
    if (!state.current) return;
    $('insertDesc').disabled = true;
    try {
      const r = await insertDescriptionIntoForm(state.current.description.sections);
      if (!r.editors) {
        copyAll(true);
        setStatus('status', 'Nie znalazłem pola opisu na stronie – opis skopiowany. Kliknij w tekst opisu, Ctrl+A i Ctrl+V. '
          + 'Jeśli to się powtarza: Ustawienia → „Skopiuj budowę edytora opisu” i wyślij to autorowi wtyczki.', true);
      } else if (!r.ok) {
        copyAll(true);
        setStatus('status', `Pole opisu znalezione (${r.editors}), ale edytor nie przyjął tekstu – opis skopiowany, wklej go ręcznie (Ctrl+V). `
          + 'Ustawienia → „Skopiuj budowę edytora opisu” pomoże to naprawić.', true);
      } else {
        setStatus('status', `Opis wstawiony (pól tekstu: ${r.editors}${r.cleared ? `, wyczyszczone stare: ${r.cleared}` : ''}). `
          + 'Sprawdź formularz – puste sekcje i stare zdjęcia z katalogu usuń w edytorze Allegro.');
      }
    } finally {
      $('insertDesc').disabled = false;
    }
  }

  function insertTitle() {
    const title = $('title').value.trim();
    const input = findTitleInput();
    if (!input) {
      copy(title);
      return setStatus('status', 'Nie znalazłem pola tytułu na stronie – tytuł skopiowany do schowka.', true);
    }
    setNativeValue(input, title);
    input.focus();
    setStatus('status', 'Tytuł wstawiony do formularza.');
  }

  // --- ustawienia ---
  function saveSettings() {
    settings.save({ apiKey: $('apiKey').value, model: $('model').value, caseStyle: $('caseStyle').value, search: $('search').checked });
    setStatus('settingsStatus', 'Zapisano.');
    if (settings.apiKey) setTimeout(() => showTab('gen'), 600);
  }

  async function loadModels() {
    setStatus('settingsStatus', 'Pobieram listę modeli…');
    try {
      const models = await G.listModels({ apiKey: $('apiKey').value.trim() || settings.apiKey, transport: gmTransport });
      $('modelList').replaceChildren(...models.map((m) => el('option', { value: m })));
      setStatus('settingsStatus', `Dostępne modele (${models.length}): kliknij pole „Model” i wybierz. Np. ${models.filter((m) => /flash/.test(m)).slice(-3).join(', ')}`);
    } catch (e) {
      setStatus('settingsStatus', e.message, true);
    }
  }

  renderPhotos();
  setMode('NEW');

  // Sales Center to SPA – przycisk tylko na stronach /offer…
  const syncVisibility = () => {
    host.style.display = OFFER_PATH.test(location.pathname) ? '' : 'none';
  };
  syncVisibility();
  setInterval(syncVisibility, 1000);
}

buildUi();
