/**
 * Panel wtyczki na salescenter.allegro.com/offer…
 * Dane produktu → Gemini → tytuł i opis wg reguł z rules/ → wstawienie / kopiowanie.
 *
 * Moduły (AllegroTitleRules, AllegroDescriptionRules, AllegroGemini, AllegroPipeline)
 * dostarcza scripts/build.js w obiekcie `self`.
 */
/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_setClipboard */
'use strict';

const T = self.AllegroTitleRules;
const D = self.AllegroDescriptionRules;
const G = self.AllegroGemini;
const P = self.AllegroPipeline;

const OFFER_PATH = /^\/offer/;
const DEFAULT_MODEL = 'gemini-3.8-flash';

// ---------- ustawienia i szkic ----------

const settings = {
  get apiKey() { return GM_getValue('apiKey', ''); },
  get model() { return GM_getValue('model', '') || DEFAULT_MODEL; },
  save(apiKey, model) {
    GM_setValue('apiKey', apiKey.trim());
    GM_setValue('model', model.trim().replace(/^models\//, ''));
  },
};

const state = { title: GM_getValue('title', ''), titleResults: [], description: null };

// ---------- transport ----------

function gmTransport(req) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: req.method,
      url: req.url,
      headers: req.headers,
      data: req.body,
      timeout: 180000,
      onload: (r) => resolve({ status: r.status, text: r.responseText }),
      onerror: () => reject(new Error('Brak połączenia z Gemini API')),
      ontimeout: () => reject(new Error('Gemini nie odpowiada (timeout)')),
    });
  });
}

function ask() {
  return G.createAsk({ apiKey: settings.apiKey, model: settings.model, transport: gmTransport });
}

// ---------- integracja ze stroną ----------

function labelText(el) {
  const byFor = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
  const wrap = el.closest('label');
  const labelled = el.getAttribute('aria-labelledby');
  return [byFor, wrap, labelled && document.getElementById(labelled)].filter(Boolean).map((l) => l.textContent).join(' ');
}

/** Pole tytułu oferty w formularzu (heurystyka: maxlength 75 albo etykieta „Tytuł”). */
function findTitleInput() {
  const fields = [...document.querySelectorAll('input[type="text"], input:not([type]), textarea')].filter((el) => el.offsetParent !== null);
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
  const fields = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), select, [role="combobox"]');
  for (const el of fields) {
    if (el.offsetParent === null || el.closest('#allegro-listener-root')) continue;
    const name = fieldLabel(el).replace(/\s+/g, ' ').replace(/[*:]\s*$/, '').trim();
    let value = el.tagName === 'SELECT' ? (el.selectedOptions[0] || {}).textContent : el.value ?? el.textContent;
    value = String(value || '').replace(/\s+/g, ' ').trim();
    if (!name || !value || name.length > 60 || NOT_PARAMETER.test(name) || /^wybierz/i.test(value) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, value });
  }
  return out;
}

/** Ustawia wartość tak, żeby zauważył ją React (natywny setter + zdarzenia). */
function setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function copy(text, html) {
  if (html) GM_setClipboard(text, 'html');
  else GM_setClipboard(text, 'text');
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
.panel[hidden], .fab[hidden] { display: none; }
header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #ff5a00; color: #fff; }
header b { font-size: 15px; }
header button { background: transparent; border: 0; color: #fff; font-size: 20px; cursor: pointer; }
nav { display: flex; border-bottom: 1px solid #ddd; }
nav button { flex: 1; padding: 9px 4px; border: 0; background: #f6f6f6; cursor: pointer; font-size: 13px; }
nav button.active { background: #fff; border-bottom: 2px solid #ff5a00; font-weight: 600; }
main { flex: 1; overflow: auto; padding: 12px 14px 40px; }
label { display: block; margin: 10px 0 3px; font-weight: 600; }
small { color: #777; font-weight: 400; }
input[type=text], input[type=password], textarea, select { width: 100%; padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
textarea { min-height: 54px; resize: vertical; }
.check { display: flex; gap: 6px; align-items: center; font-weight: 400; }
.btn { background: #ff5a00; color: #fff; border: 0; border-radius: 4px; padding: 8px 12px; font-weight: 600; cursor: pointer; margin: 8px 6px 0 0; }
.btn.sec { background: #eee; color: #222; }
.btn.small { padding: 4px 8px; font-size: 12px; margin-top: 4px; }
.btn:disabled { opacity: .5; cursor: wait; }
.status { margin-top: 8px; color: #555; }
.status.err { color: #c00; }
.card { border: 1px solid #ddd; border-radius: 6px; padding: 8px 10px; margin-top: 8px; }
.card.ok { border-color: #2a9d4b; }
.card.best { box-shadow: 0 0 0 2px #2a9d4b inset; }
.len { font-weight: 600; }
ul.msgs { margin: 4px 0 0; padding-left: 18px; }
.e { color: #c00; } .w { color: #b36b00; }
.hint { background: #fff4ec; border-left: 3px solid #ff5a00; padding: 4px 8px; margin-bottom: 6px; color: #7a3c00; }
.preview h1 { font-size: 17px; margin: 4px 0; } .preview h2 { font-size: 15px; margin: 4px 0; } .preview p { margin: 3px 0; }
`;

function textarea(id, rows) {
  return el('textarea', { id, rows: String(rows || 3) });
}

const FIELDS = [
  ['productName', 'Nazwa produktu', () => el('input', { type: 'text', id: 'productName' })],
  ['keywords', 'Frazy kluczowe', () => textarea('keywords', 3), 'jedna w linii, od najpopularniejszej (Google Trends)'],
  ['age', 'Wiek', () => el('input', { type: 'text', id: 'age', placeholder: 'np. 3+' })],
  ['brand', 'Marka', () => el('input', { type: 'text', id: 'brand' })],
  ['features', 'Cechy', () => textarea('features'), 'jedna w linii'],
  ['benefits', 'Korzyści', () => textarea('benefits'), 'jedna w linii'],
  ['contents', 'Zawartość zestawu', () => textarea('contents'), 'jeden element w linii'],
  ['parameters', 'Parametry', () => textarea('parameters'), 'Nazwa: wartość – jeden w linii'],
  ['competitorTitles', 'Tytuły TOP 10 konkurencji', () => textarea('competitorTitles', 4), 'wklej, jeden w linii – do wyboru stylu liter'],
  ['caseStyle', 'Wielkość liter w tytule', () =>
    el('select', { id: 'caseStyle' },
      el('option', { value: 'AUTO' }, 'AUTO – jak konkurencja'),
      el('option', { value: 'UPPER' }, 'CAPSLOCK'),
      el('option', { value: 'TITLE' }, 'Pierwsze Litery Wielkie'))],
  ['allowWords', 'Dozwolone mimo zakazu', () => el('input', { type: 'text', id: 'allowWords' }), 'po przecinku, np. słowo z nazwy produktu'],
  ['socialProof', 'Social proof', () => el('input', { type: 'text', id: 'socialProof', placeholder: 'np. 4,9/5 – 1200 ocen' }), 'tylko prawdziwe dane'],
  ['promo', 'Promocja', () => el('input', { type: 'text', id: 'promo' }), 'tylko prawdziwa – trafi do opisu dosłownie'],
  ['extra', 'Dodatkowe informacje', () => textarea('extra')],
];

function lines(v) {
  return String(v || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

function buildUi() {
  const host = el('div', { id: 'allegro-listener-root' });
  const root = host.attachShadow({ mode: 'open' });
  root.append(el('style', {}, CSS_TEXT));
  document.body.append(host);
  const $ = (id) => root.getElementById(id);

  // --- Dane ---
  const dataTab = el('div', { id: 'tab-data' },
    ...FIELDS.map(([id, label, make, hint]) => [el('label', { for: id }, label, hint ? el('small', {}, ` – ${hint}`) : null), make()]),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'smallParts' }), 'Zawiera małe elementy (ostrzeżenie 36 mies.)'),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', id: 'isNew', checked: true }), 'Produkt nowy'),
    el('button', { class: 'btn sec', on: { click: pullFromPage } }, 'Pobierz z formularza'),
    el('button', { class: 'btn sec', on: { click: clearDraft } }, 'Wyczyść'),
    el('div', { class: 'status', id: 'dataStatus' }),
  );

  // --- Tytuł ---
  const titleTab = el('div', { id: 'tab-title', hidden: true },
    el('button', { class: 'btn', id: 'genTitle', on: { click: onGenerateTitle } }, 'Generuj tytuł'),
    el('div', { class: 'status', id: 'titleStatus' }),
    el('label', { for: 'chosenTitle' }, 'Wybrany tytuł ', el('small', { id: 'chosenInfo' })),
    el('input', { type: 'text', id: 'chosenTitle', on: { input: onChosenTitleInput } }),
    el('ul', { class: 'msgs', id: 'chosenMsgs' }),
    el('button', { class: 'btn', on: { click: insertTitle } }, 'Wstaw do formularza'),
    el('button', { class: 'btn sec', on: { click: () => copy($('chosenTitle').value) } }, 'Kopiuj'),
    el('div', { id: 'titleResults' }),
  );

  // --- Opis ---
  const descTab = el('div', { id: 'tab-desc', hidden: true },
    el('button', { class: 'btn', id: 'genDesc', on: { click: onGenerateDescription } }, 'Generuj opis'),
    el('button', { class: 'btn sec', on: { click: () => state.description && copy(D.toPlainText(state.description.description)) } }, 'Kopiuj cały tekst'),
    el('button', { class: 'btn sec', on: { click: copyApiJson } }, 'Kopiuj JSON (API)'),
    el('div', { class: 'status', id: 'descStatus' }),
    el('ul', { class: 'msgs', id: 'descMsgs' }),
    el('div', { id: 'descSections' }),
  );

  // --- Ustawienia ---
  const settingsTab = el('div', { id: 'tab-settings', hidden: true },
    el('label', { for: 'apiKey' }, 'Klucz API Gemini ', el('small', {}, '– zapisywany tylko w Tampermonkey na tym komputerze')),
    el('input', { type: 'password', id: 'apiKey', value: settings.apiKey }),
    el('label', { for: 'model' }, 'Model Gemini ', el('small', {}, `– domyślnie ${DEFAULT_MODEL}`)),
    el('input', { type: 'text', id: 'model', value: settings.model, list: 'modelList' }),
    el('datalist', { id: 'modelList' }),
    el('button', { class: 'btn', on: { click: saveSettings } }, 'Zapisz'),
    el('button', { class: 'btn sec', on: { click: loadModels } }, 'Pobierz listę modeli'),
    el('div', { class: 'status', id: 'settingsStatus' }),
  );

  const tabs = { data: ['Dane', dataTab], title: ['Tytuł', titleTab], desc: ['Opis', descTab], settings: ['Ustawienia', settingsTab] };
  const nav = el('nav', {}, ...Object.entries(tabs).map(([key, [label]]) =>
    el('button', { 'data-tab': key, class: key === 'data' ? 'active' : '', on: { click: () => showTab(key) } }, label)));

  const panel = el('div', { class: 'panel', hidden: true },
    el('header', {}, el('b', {}, '✨ Allegro Listener'), el('button', { title: 'Zamknij', on: { click: () => toggle(false) } }, '×')),
    nav,
    el('main', { on: { input: saveDraft, change: saveDraft } }, dataTab, titleTab, descTab, settingsTab),
  );
  const fab = el('button', { class: 'fab', on: { click: () => toggle(true) } }, '✨ AI oferta');
  root.append(fab, panel);

  function showTab(key) {
    for (const [k, [, node]] of Object.entries(tabs)) node.hidden = k !== key;
    for (const b of nav.children) b.classList.toggle('active', b.dataset.tab === key);
  }

  function toggle(open) {
    panel.hidden = !open;
    fab.hidden = open;
    if (open && !settings.apiKey) showTab('settings');
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

  // --- szkic danych ---
  function saveDraft(ev) {
    if (!ev.target.closest('#tab-data')) return;
    const draft = {};
    for (const [id] of FIELDS) draft[id] = $(id).value;
    draft.smallParts = $('smallParts').checked;
    draft.isNew = $('isNew').checked;
    GM_setValue('draft', draft);
  }

  function loadDraft() {
    const draft = GM_getValue('draft', null);
    if (!draft) return;
    for (const [id] of FIELDS) if (draft[id] != null) $(id).value = draft[id];
    $('smallParts').checked = !!draft.smallParts;
    $('isNew').checked = draft.isNew !== false;
  }

  function clearDraft() {
    for (const [id] of FIELDS) $(id).value = id === 'caseStyle' ? 'AUTO' : '';
    $('smallParts').checked = false;
    $('isNew').checked = true;
    GM_setValue('draft', null);
    setChosenTitle('');
  }

  function pullFromPage() {
    const input = findTitleInput();
    const found = [];
    if (input && input.value && !$('productName').value.trim()) {
      $('productName').value = input.value;
      found.push('nazwa');
    }
    const existing = lines($('parameters').value);
    const names = new Set(existing.map((l) => l.split(':')[0].trim().toLowerCase()));
    const added = readFormParameters().filter((p) => !names.has(p.name.toLowerCase()));
    if (added.length) {
      $('parameters').value = [...existing, ...added.map((p) => `${p.name}: ${p.value}`)].join('\n');
      found.push(`parametry: ${added.length}`);
    }
    saveDraft({ target: $('productName') });
    setStatus('dataStatus', found.length
      ? `Pobrano z formularza – ${found.join(', ')}. Sprawdź i popraw w razie potrzeby.`
      : 'Nie znalazłem nowych danych w formularzu – wpisz je ręcznie.', !found.length);
  }

  function collectInput() {
    const v = (id) => $(id).value.trim();
    return {
      productName: v('productName'),
      keywords: lines(v('keywords')),
      age: v('age'),
      brand: v('brand'),
      features: lines(v('features')),
      benefits: lines(v('benefits')),
      contents: lines(v('contents')),
      parameters: lines(v('parameters')).map((l) => {
        const i = l.indexOf(':');
        return i > 0 ? { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : null;
      }).filter(Boolean),
      competitorTitles: lines(v('competitorTitles')),
      caseStyle: v('caseStyle'),
      allowWords: v('allowWords').split(',').map((s) => s.trim()).filter(Boolean),
      socialProof: v('socialProof'),
      promo: v('promo'),
      extra: v('extra'),
      smallParts: $('smallParts').checked,
      condition: $('isNew').checked ? 'NEW' : 'USED',
      date: new Date(),
      title: state.title,
    };
  }

  // --- tytuł ---
  function setChosenTitle(title) {
    state.title = title;
    GM_setValue('title', title);
    $('chosenTitle').value = title;
    const input = collectInput();
    const r = T.validateTitle(title, { topKeyword: input.keywords[0] || input.productName, allowWords: input.allowWords });
    $('chosenInfo').textContent = title ? `${r.length}/${T.TITLE_MAX} znaków` : '';
    msgs($('chosenMsgs'), title ? r.errors : [], title ? r.warnings : []);
  }

  function onChosenTitleInput() {
    setChosenTitle($('chosenTitle').value);
  }

  async function onGenerateTitle() {
    const input = collectInput();
    if (!input.productName) return setStatus('titleStatus', 'Uzupełnij nazwę produktu w zakładce Dane.', true);
    $('genTitle').disabled = true;
    setStatus('titleStatus', 'Gemini pisze tytuły…');
    try {
      const res = await P.generateTitle(input, ask());
      state.titleResults = res.results;
      renderTitleResults(res.best);
      if (res.best) {
        setChosenTitle(res.best);
        setStatus('titleStatus', `Gotowe (prób: ${res.attempts}). Najlepszy tytuł wybrany – możesz go zmienić.`);
      } else {
        setStatus('titleStatus', `Żadna propozycja nie spełnia reguł po ${res.attempts} próbach. Popraw ręcznie jedną z nich.`, true);
      }
    } catch (e) {
      setStatus('titleStatus', e.message, true);
    } finally {
      $('genTitle').disabled = false;
    }
  }

  function renderTitleResults(best) {
    $('titleResults').replaceChildren(
      ...state.titleResults.map((r) =>
        el('div', { class: `card${r.ok ? ' ok' : ''}${r.title === best ? ' best' : ''}` },
          el('div', {}, r.title),
          el('div', {}, el('span', { class: 'len' }, `${r.length} znaków`), ` · próba ${r.attempt}${r.ok ? ' · ✔ OK' : ''}`),
          el('ul', { class: 'msgs' }, ...r.errors.map((m) => el('li', { class: 'e' }, m)), ...r.warnings.map((m) => el('li', { class: 'w' }, m))),
          el('button', { class: 'btn small', on: { click: () => setChosenTitle(r.title) } }, 'Wybierz'),
          el('button', { class: 'btn small sec', on: { click: () => copy(r.title) } }, 'Kopiuj'),
        )),
    );
  }

  function insertTitle() {
    const input = findTitleInput();
    if (!input) {
      copy(state.title);
      return setStatus('titleStatus', 'Nie znalazłem pola tytułu na stronie – tytuł skopiowany do schowka.', true);
    }
    setNativeValue(input, state.title);
    input.focus();
    setStatus('titleStatus', 'Tytuł wstawiony do formularza.');
  }

  // --- opis ---
  async function onGenerateDescription() {
    const input = collectInput();
    if (!input.title) return setStatus('descStatus', 'Najpierw wybierz tytuł w zakładce Tytuł.', true);
    $('genDesc').disabled = true;
    setStatus('descStatus', 'Gemini pisze opis…');
    msgs($('descMsgs'));
    try {
      const res = await P.generateDescription(input, ask());
      state.description = res;
      renderDescription(res);
      setStatus('descStatus', res.ok
        ? `Gotowe (prób: ${res.attempts}).${res.warnings.length ? ' Sprawdź ostrzeżenia.' : ''}`
        : `Opis nadal ma błędy po ${res.attempts} próbach – popraw je przed wklejeniem.`, !res.ok);
    } catch (e) {
      setStatus('descStatus', e.message, true);
    } finally {
      $('genDesc').disabled = false;
    }
  }

  function renderDescription(res) {
    msgs($('descMsgs'), res.errors, res.warnings);
    $('descSections').replaceChildren(
      ...res.description.sections.map((s, i) => {
        const html = D.toAllegroHtml(s.blocks);
        const preview = el('div', { class: 'preview' });
        preview.innerHTML = html; // HTML z toAllegroHtml – tekst jest escapowany
        return el('div', { class: 'card' },
          el('div', { class: 'hint' }, `Sekcja ${i + 1}: ${s.layout === 'TEXT' ? 'sam tekst' : `zdjęcie po lewej – ${s.imageHint}`}`),
          preview,
          el('button', { class: 'btn small', on: { click: () => copy(html, true) } }, 'Kopiuj sekcję'),
          el('button', { class: 'btn small sec', on: { click: () => copy(s.blocks.map((b) => b.text.replace(/\*\*/g, '')).join('\n')) } }, 'Kopiuj tekst'),
        );
      }),
    );
  }

  function copyApiJson() {
    if (!state.description) return;
    copy(JSON.stringify(D.toAllegroApiDescription(state.description.description, []), null, 2));
  }

  // --- ustawienia ---
  function saveSettings() {
    settings.save($('apiKey').value, $('model').value);
    setStatus('settingsStatus', 'Zapisano.');
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

  loadDraft();
  setChosenTitle(state.title);

  // Sales Center to SPA – przycisk tylko na stronach /offer…
  const syncVisibility = () => {
    const onOffer = OFFER_PATH.test(location.pathname);
    host.style.display = onOffer ? '' : 'none';
  };
  syncVisibility();
  setInterval(syncVisibility, 1000);
}

buildUi();
