// ==UserScript==
// @name         Allegro Listener – AI tytuł i opis
// @namespace    https://github.com/FlutEcom/allegro-listener
// @version      0.3.0
// @description  Błyskawiczne wystawianie ofert: zdjęcie + nazwa → Gemini pisze tytuł i opis wg reguł z rules/
// @match        https://salescenter.allegro.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      generativelanguage.googleapis.com
// @connect      allegroimg.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

// Plik generowany przez scripts/build.js – nie edytuj ręcznie.
(function () {
'use strict';
const NS = {};

// ----- src/rules/title.js -----
(function (self, module) {
/**
 * Reguły tytułu oferty Allegro – prompt dla Gemini + walidator.
 * Opis reguł: rules/01-tytul.md
 *
 * Działa w Tampermonkey (window.AllegroTitleRules, np. przez @require)
 * oraz w Node (module.exports) – na potrzeby testów.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroTitleRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TITLE_MIN = 70;
  const TITLE_MAX = 75;
  const MAX_SEPARATORS = 2;

  // Porównywane bez polskich znaków i bez względu na wielkość liter, jako całe słowa/frazy.
  const FORBIDDEN_WORDS = [
    // promocyjne
    'HIT', 'PROMOCJA', 'PROMO', 'OKAZJA', 'WYPRZEDAŻ', 'SALE', 'SUPER CENA',
    'NAJTANIEJ', 'NAJTAŃSZY', 'NAJTAŃSZA', 'NAJTAŃSZE', 'TANIO', 'TANI', 'RABAT',
    'GRATIS', 'BESTSELLER', 'NOWOŚĆ', 'WOW', 'NAJLEPSZY', 'NAJLEPSZA', 'NAJLEPSZE',
    'LIKWIDACJA', 'OKAZYJNIE', 'ZNIŻKA', 'OFERTA',
    // dostawa i sprzedaż
    'WYSYŁKA', 'DOSTAWA', 'DARMOWA', 'DARMOWY', '24H', '24 H', 'FAKTURA', 'FV', 'VAT',
    'KURIER', 'PACZKOMAT', 'ODBIÓR OSOBISTY', 'SKLEP', 'ALLEGRO', 'SPRZEDAM',
    // porównania z cudzymi markami
    'TYPU', "A'LA", 'A LA', 'PODOBNY DO', 'PODOBNA DO', 'PODOBNE DO', 'ZAMIAST',
  ];

  const FORBIDDEN_PATTERNS = [
    { re: /(https?:\/\/|www\.|\.(pl|com|eu|net|org)\b)/i, msg: 'adres strony WWW' },
    { re: /[^\s@]+@[^\s@]+\.[^\s@]+/, msg: 'adres e-mail' },
    { re: /(\+?48[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/, msg: 'numer telefonu' },
    { re: /\p{Extended_Pictographic}/u, msg: 'emoji' },
    { re: /[!?*#@$%~|_^=]/, msg: 'niedozwolony znak specjalny (!?*#@$%~|_^=)' },
    { re: /[&<>"]/, msg: 'znak & < > " (Allegro liczy go jako kilka znaków) – zamiast & użyj I' },
    { re: /([^\p{L}\p{N}\s])\1/u, msg: 'powtórzony znak interpunkcyjny (np. -- lub ..)' },
  ];

  // Słowa pomijane przy wykrywaniu powtórzeń.
  const STOPWORDS = new Set([
    'I', 'W', 'Z', 'ZE', 'NA', 'DO', 'DLA', 'OD', 'PO', 'PRZY', 'BEZ', 'LUB', 'ORAZ',
    'A', 'O', 'U', 'ZA', 'PRZEZ', 'POD', 'NAD', 'X', 'CM', 'MM', 'M', 'ML', 'L', 'KG', 'G',
  ]);

  // Tokeny zachowujące zapis w trybie „Pierwsze Litery Wielkie”.
  const LOWERCASE_UNITS = new Set(['cm', 'mm', 'm', 'ml', 'l', 'kg', 'g', 'mah', 'w', 'v', 'x']);

  // ---------- pomocnicze ----------

  function stripDiacritics(s) {
    return s
      .replace(/ł/g, 'l').replace(/Ł/g, 'L')
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /** Klucz do porównań: bez polskich znaków, wielkie litery, pojedyncze spacje. */
  function normKey(s) {
    return stripDiacritics(String(s)).toUpperCase().replace(/\s+/g, ' ').trim();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function words(title) {
    return title.split(/[\s,/]+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+]+$/gu, '')).filter(Boolean);
  }

  function commonPrefixLength(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  // ---------- wielkość liter ----------

  function isUpperTitle(title) {
    const letters = title.match(/\p{L}/gu) || [];
    if (!letters.length) return false;
    const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
    return upper / letters.length >= 0.8;
  }

  /** AUTO: ≥ 50% tytułów konkurencji CAPSLOCKIEM → UPPER, inaczej TITLE. Brak danych → UPPER. */
  function detectCaseStyle(competitorTitles) {
    const titles = (competitorTitles || []).filter((t) => t && t.trim()).slice(0, 10);
    if (!titles.length) return 'UPPER';
    const upper = titles.filter(isUpperTitle).length;
    return upper / titles.length >= 0.5 ? 'UPPER' : 'TITLE';
  }

  function resolveCaseStyle(caseStyle, competitorTitles) {
    return caseStyle === 'UPPER' || caseStyle === 'TITLE' ? caseStyle : detectCaseStyle(competitorTitles);
  }

  function titleCaseToken(token) {
    const lower = token.toLowerCase();
    if (LOWERCASE_UNITS.has(lower)) return lower;
    if (/\d/.test(token)) return token; // 3+, 100ml, iPhone15, 2x…
    const letters = token.replace(/[^\p{L}]/gu, '');
    if (letters.length > 1 && letters.length <= 4 && token === token.toUpperCase()) return token; // LED, USB-C, XXL
    return lower.replace(/(^|[-'])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
  }

  function applyCase(title, style) {
    if (style === 'UPPER') return title.toUpperCase();
    return title.split(' ').map(titleCaseToken).join(' ');
  }

  // ---------- normalizacja i walidacja ----------

  function cleanTitle(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeTitle(title, opts) {
    opts = opts || {};
    const style = resolveCaseStyle(opts.caseStyle, opts.competitorTitles);
    return applyCase(cleanTitle(title), style);
  }

  function findForbidden(title, allowWords) {
    const key = ' ' + normKey(title).replace(/[^A-Z0-9' ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const allowed = new Set((allowWords || []).map(normKey));
    const hits = [];
    for (const w of FORBIDDEN_WORDS) {
      const wk = normKey(w);
      if (allowed.has(wk)) continue;
      if (new RegExp(' ' + escapeRe(wk) + ' ').test(key)) hits.push(w);
    }
    return hits;
  }

  function findRepetitions(title) {
    const ws = words(title).map(normKey).filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d/.test(w));
    const exact = [];
    const stems = [];
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        const a = ws[i];
        const b = ws[j];
        if (a === b) {
          if (!exact.includes(a)) exact.push(a);
        } else {
          const minLen = Math.min(a.length, b.length);
          if (minLen >= 5 && commonPrefixLength(a, b) >= Math.max(4, minLen - 2)) stems.push(a + '/' + b);
        }
      }
    }
    return { exact, stems };
  }

  function countSeparators(title) {
    return (title.match(/,|\/|\s[-–—]\s/g) || []).length;
  }

  /**
   * Sprawdza tytuł wg reguł z rules/01-tytul.md.
   * @param {string} title
   * @param {{topKeyword?: string, allowWords?: string[], min?: number, max?: number}} [opts]
   * @returns {{ok: boolean, length: number, errors: string[], warnings: string[]}}
   */
  function validateTitle(title, opts) {
    opts = opts || {};
    const min = opts.min || TITLE_MIN;
    const max = opts.max || TITLE_MAX;
    const t = String(title || '');
    const length = [...t].length;
    const errors = [];
    const warnings = [];

    if (t !== cleanTitle(t)) warnings.push('podwójne spacje lub spacje na początku/końcu');

    if (length < min) errors.push(`za krótki: ${length} znaków (min ${min}) – dopisz ${min - length}+ znaków: cechę lub korzyść`);
    if (length > max) errors.push(`za długi: ${length} znaków (max ${max}) – skróć o ${length - max}+ znaków`);

    if (opts.topKeyword) {
      const kw = normKey(opts.topKeyword);
      if (!normKey(t).startsWith(kw)) errors.push(`tytuł musi zaczynać się od frazy „${opts.topKeyword}”`);
    }

    const forbidden = findForbidden(t, opts.allowWords);
    if (forbidden.length) errors.push('zabronione słowa: ' + forbidden.join(', '));

    for (const p of FORBIDDEN_PATTERNS) {
      if (p.re.test(t)) errors.push('niedozwolone: ' + p.msg);
    }

    const rep = findRepetitions(t);
    if (rep.exact.length) errors.push('keyword stuffing – powtórzone słowa: ' + rep.exact.join(', '));
    if (rep.stems.length) warnings.push('możliwe powtórzenie tego samego słowa w innej odmianie: ' + rep.stems.join(', '));

    const seps = countSeparators(t);
    if (seps > MAX_SEPARATORS) warnings.push(`za dużo separatorów (${seps}, max ${MAX_SEPARATORS}) – tytuł wygląda jak lista tagów`);

    return { ok: errors.length === 0, length, errors, warnings };
  }

  /**
   * Normalizuje propozycje z Gemini i wybiera najlepszą poprawną
   * (bez błędów, najmniej ostrzeżeń, najdłuższą).
   * @returns {{best: string|null, results: Array<{title: string, ok: boolean, length: number, errors: string[], warnings: string[]}>}}
   */
  function pickBestTitle(candidates, opts) {
    opts = opts || {};
    const results = (candidates || [])
      .map((c) => (typeof c === 'string' ? c : c && c.title))
      .filter(Boolean)
      .map((raw) => {
        const title = normalizeTitle(raw, opts);
        return Object.assign({ title }, validateTitle(title, opts));
      });
    const valid = results
      .filter((r) => r.ok)
      .sort((a, b) => a.warnings.length - b.warnings.length || b.length - a.length);
    return { best: valid.length ? valid[0].title : null, results };
  }

  // ---------- prompty dla Gemini ----------

  function list(items) {
    return (items || []).filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n') || '(brak)';
  }

  const RULES_TEXT = `
REGUŁY TYTUŁU ALLEGRO (obowiązkowe):
1. DŁUGOŚĆ: ${TITLE_MIN}–${TITLE_MAX} znaków łącznie ze spacjami. Wykorzystaj pełny limit – tytuł krótszy niż ${TITLE_MIN} znaków jest błędny. Nigdy nie przekraczaj ${TITLE_MAX} znaków.
2. POCZĄTEK: tytuł zaczyna się dokładnie od najpopularniejszej frazy (TOP KEYWORD) – nazwy produktu, pod którą klienci go wyszukują.
3. STRUKTURA: [TOP KEYWORD] [KEYWORD 2] [WIEK] [CECHA] [KORZYŚĆ]
   - KEYWORD 2: druga najpopularniejsza fraza, INNA niż pierwsza,
   - WIEK: tylko jeśli ma sens dla produktu (np. 3+, 6-12 LAT); w innym wypadku pomiń,
   - CECHA: konkretny parametr (ilość, rozmiar, materiał, model, kolor),
   - KORZYŚĆ: co klient zyskuje.
4. WIELKOŚĆ LITER: {{CASE_RULE}}
5. ZAKAZANE: słowa promocyjne i sprzedażowe (${FORBIDDEN_WORDS.slice(0, 16).join(', ')} itp.), informacje o dostawie/fakturze/cenie, nazwy cudzych marek w porównaniach („typu”, „a'la”), linki, e-maile, telefony, emoji, znaki ! ? * # @ $ % ~ | _ & < > " oraz powtarzana interpunkcja.
6. ZAKAZ KEYWORD STUFFINGU: każde słowo znaczące tylko RAZ (także w innej odmianie, np. KLOCKI i KLOCKÓW to powtórzenie). Bez list synonimów po przecinku – maksymalnie ${MAX_SEPARATORS} separatory. Tytuł ma brzmieć jak naturalna nazwa produktu.
7. Tylko prawdziwe informacje z danych produktu – niczego nie wymyślaj.`.trim();

  function caseRule(style) {
    return style === 'UPPER'
      ? 'CAPSLOCK – cały tytuł wielkimi literami (styl TOP 10 konkurencji).'
      : 'Pierwsze Litery Wielkie w każdym słowie; skróty i oznaczenia (LED, USB-C, XXL) bez zmian, jednostki małymi (cm, ml) – styl TOP 10 konkurencji.';
  }

  /**
   * Prompt generujący propozycje tytułu. Odpowiedź Gemini: JSON
   * {"candidates":[{"title": "...", "length": 73}]}.
   * @param {{
   *   productName: string, keywords?: string[], age?: string, features?: string[],
   *   benefits?: string[], brand?: string, category?: string, extra?: string,
   *   competitorTitles?: string[], caseStyle?: 'AUTO'|'UPPER'|'TITLE', count?: number
   * }} input  keywords – posortowane od najpopularniejszej (Google Trends / podpowiedzi Allegro)
   */
  function buildTitlePrompt(input) {
    const style = resolveCaseStyle(input.caseStyle, input.competitorTitles);
    const count = input.count || 5;
    const topKeyword = (input.keywords && input.keywords[0]) || input.productName;
    return `Jesteś ekspertem od SEO na Allegro. Napisz ${count} różnych propozycji tytułu oferty.

${RULES_TEXT.replace('{{CASE_RULE}}', caseRule(style))}

DANE PRODUKTU:
Nazwa: ${input.productName}
${input.brand ? `Marka: ${input.brand}\n` : ''}${input.category ? `Kategoria: ${input.category}\n` : ''}${input.age ? `Wiek: ${input.age}\n` : ''}TOP KEYWORD (tytuł MUSI się od niego zaczynać): ${topKeyword}

Frazy kluczowe od najpopularniejszej (Google Trends):
${list(input.keywords)}

Cechy:
${list(input.features)}

Korzyści:
${list(input.benefits)}
${input.extra ? `\nDodatkowe informacje:\n${input.extra}\n` : ''}
TYTUŁY TOP 10 KONKURENCJI (wzór stylu, nie kopiuj):
${list(input.competitorTitles)}

Przed podaniem odpowiedzi policz znaki każdego tytułu. Jeśli ma mniej niż ${TITLE_MIN} – dopisz cechę lub korzyść; jeśli więcej niż ${TITLE_MAX} – skróć.
Odpowiedz WYŁĄCZNIE poprawnym JSON-em w formacie:
{"candidates":[{"title":"...","length":0}]}`;
  }

  /**
   * Prompt z prośbą o poprawkę, gdy żadna propozycja nie przeszła walidacji.
   * @param {object} input  to samo co w buildTitlePrompt
   * @param {Array<{title: string, errors: string[]}>} failed  wyniki z pickBestTitle().results
   */
  function buildTitleRepairPrompt(input, failed) {
    const report = failed
      .map((r) => `- "${r.title}" (${r.length ?? [...r.title].length} znaków): ${r.errors.join('; ')}`)
      .join('\n');
    return `${buildTitlePrompt(input)}

POPRZEDNIE PROPOZYCJE ZOSTAŁY ODRZUCONE PRZEZ WALIDATOR:
${report}

Popraw te błędy. Każdy nowy tytuł musi mieć ${TITLE_MIN}–${TITLE_MAX} znaków i spełniać wszystkie reguły.`;
  }

  /** Schemat odpowiedzi dla Gemini (generationConfig.responseSchema). */
  const TITLE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      candidates: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, length: { type: 'INTEGER' } }, required: ['title'] },
      },
    },
    required: ['candidates'],
  };

  return {
    TITLE_MIN,
    TITLE_MAX,
    MAX_SEPARATORS,
    FORBIDDEN_WORDS,
    FORBIDDEN_PATTERNS,
    RULES_TEXT,
    TITLE_SCHEMA,
    detectCaseStyle,
    applyCase,
    normalizeTitle,
    validateTitle,
    pickBestTitle,
    buildTitlePrompt,
    buildTitleRepairPrompt,
  };
});

})(NS, undefined);

// ----- src/rules/description.js -----
(function (self, module) {
/**
 * Reguły opisu oferty Allegro – prompt dla Gemini, składanie opisu z szablonu i walidator.
 * Opis reguł: rules/02-opis.md
 *
 * Gemini zwraca wyłącznie treść (JSON, bez HTML). Strukturę – H1 z tytułem, nagłówki H2,
 * emoji, opcjonalny separator, specyfikację i zdanie „Produkt nowy…” – dokłada buildDescription().
 *
 * Działa w Tampermonkey (window.AllegroDescriptionRules, np. przez @require)
 * oraz w Node (module.exports) – na potrzeby testów.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroDescriptionRules = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOOK_LIMIT = 200;
  const MAX_SENTENCE_WORDS = 12;
  const MAX_PARAGRAPH_CHARS = 200;
  const MAX_SECTION_CHARS = 600;
  const MAX_KEYWORD_REPEATS = 4;
  // Linia pod nagłówkami H2 – domyślnie wyłączona; włączenie: input.separator = SEPARATOR_LINE.
  const SEPARATOR_LINE = '━'.repeat(20);

  // Emoji wyświetlane poprawnie na Allegro (pełna lista: https://allemoji.pl/).
  const ALLOWED_EMOJI = [
    '✨', '⭐', '✅', '✔️', '❤️', 'ℹ️', '➡️', '⚙️', '❓', '⬇️', '☺️', '⚡', '☘️', '❇️',
    '❄️', '☑️', '❗', '☀️', '☹️', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣',
  ];
  const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

  const NEW_PRODUCT_SENTENCE = 'Produkt nowy, nieużywany, fabrycznie zapakowany.';
  const SMALL_PARTS_WARNING = 'Nieodpowiednie dla dzieci w wieku poniżej 36 miesięcy. Zawiera małe elementy.';

  const IMAGE_HINTS = {
    hook: 'Zdjęcie główne – cały zestaw lub produkt w opakowaniu',
    gains: 'Produkt w użyciu – dziecko podczas zabawy',
    play: 'Efekt przed i po – np. gotowa budowla, ułożone bransoletki',
    contents: 'Wszystkie elementy zestawu rozłożone obok siebie',
    gift: 'Produkt jako prezent – pod choinką lub w ozdobnym opakowaniu',
    spec: 'Skala – produkt obok dziecka lub w dłoni, z wymiarami',
  };

  // Frazy sprawdzane bez polskich znaków i bez względu na wielkość liter (początek słowa).
  const COMPARISON_PHRASES = [
    'lepszy od', 'lepsza od', 'lepsze od', 'lepszy niz', 'lepsza niz', 'lepsze niz',
    'tanszy niz', 'tansza niz', 'tansze niz', 'konkurencj', 'w przeciwienstwie do innych',
    'najlepszy na rynku', 'najlepsza na rynku', 'najlepsze na rynku', 'nr 1', 'numer 1',
    'numer jeden', 'inne sklepy', 'innych sprzedawcow', 'jedyny taki', 'jedyna taka',
  ];
  const PRESSURE_PHRASES = [
    'ostatnie sztuki', 'tylko dzis', 'tylko dzisiaj', 'zanim zniknie', 'spiesz sie', 'pospiesz sie',
    'nie czekaj', 'kup teraz', 'ostatnia szansa', 'musisz miec', 'pozalujesz',
    'zostalo tylko', 'oferta konczy sie',
  ];
  const SOCIAL_PROOF_PHRASES = [
    'zadowolonych klientow', 'klienci pokochali', 'klienci kochaja', 'bestseller', 'hit sprzedazy',
    'tysiace rodzicow', 'tysiace klientow', 'najczesciej kupowan', 'rekordzista sprzedazy',
  ];
  const JARGON = [
    ['wzmocniona konstrukcja', '„pancerne pudełko”, „mocne jak skała”'],
    ['ergonomiczn', '„wygodny dla małej rączki”'],
    ['innowacyjn', 'napisz konkretnie, co jest nowego'],
    ['wielofunkcyjn', '„do wielu zabaw”'],
    ['multifunkcyjn', '„do wielu zabaw”'],
    ['kompatybiln', '„pasuje do…”'],
    ['wysokiej jakosci', 'napisz, z czego jest i dlaczego jest mocne'],
    ['funkcjonalnosc', '„co potrafi”'],
    ['parametry techniczne', '„ważne informacje”'],
  ];
  // Pojęcia, które trzeba wyjaśnić w glossary (sekcja ℹ️), jeśli pojawiają się w opisie.
  const DIFFICULT_TERMS = ['motoryk', 'sensoryczn', 'montessori', 'koordynacj', 'propriocep', 'manualn'];

  // ---------- pomocnicze ----------

  function stripDiacritics(s) {
    return String(s)
      .replace(/ł/g, 'l').replace(/Ł/g, 'L')
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  /** Klucz do wyszukiwania fraz: bez polskich znaków, małe litery, tylko litery/cyfry i spacje. */
  function searchKey(s) {
    return ' ' + stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  }

  function containsPhrase(key, phrase) {
    return key.includes(' ' + searchKey(phrase).trim());
  }

  function cp(s) {
    return [...String(s)].length;
  }

  function upper(s) {
    return String(s).toLocaleUpperCase('pl-PL');
  }

  /** Usuwa emoji/znaki z początku (Gemini czasem je dodaje, a szablon wstawia własne). */
  function stripLead(s) {
    return String(s || '').replace(/^[^\p{L}\p{N}*]+/u, '').trim();
  }

  function stripEndDot(s) {
    return stripLead(s).replace(/[.\s]+$/, '');
  }

  function spaced(s) {
    return [...upper(s)].join(' ');
  }

  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter
    ? (s) => Array.from(new Intl.Segmenter('pl', { granularity: 'grapheme' }).segment(s), (x) => x.segment)
    : (s) => [...s];
  const EMOJI_RE = /\p{Extended_Pictographic}|⃣/u;
  const NOT_EMOJI = new Set(['©', '®', '™']);
  const allowedEmojiKeys = new Set(ALLOWED_EMOJI.map((e) => e.replace(/️/g, '')));

  function findDisallowedEmoji(s) {
    const bad = [];
    for (const g of graphemes(String(s))) {
      if (!EMOJI_RE.test(g) || NOT_EMOJI.has(g)) continue;
      if (!allowedEmojiKeys.has(g.replace(/️/g, '')) && !bad.includes(g)) bad.push(g);
    }
    return bad;
  }

  // ---------- okazje (sezon) ----------

  /**
   * Okazje prezentowe wg daty wystawienia oferty.
   * @returns {{occasions: string[], emoji: string}}
   */
  function occasionsFor(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    const m = d.getMonth() + 1;
    const day = d.getDate();
    if (m >= 9 && (m < 12 || day <= 24)) {
      const list = ['Boże Narodzenie – prezent pod choinkę'];
      if (m < 12 || day <= 6) list.push('Mikołajki (6 grudnia)');
      list.push('urodziny');
      return { occasions: list, emoji: '❄️' };
    }
    if (m === 12 || m === 1) return { occasions: ['urodziny', 'imieniny', 'nagroda bez okazji'], emoji: '❤️' };
    if (m === 2 || m === 3) return { occasions: ['Wielkanoc – prezent od zajączka', 'urodziny'], emoji: '❤️' };
    if (m === 4 || m === 5 || (m === 6 && day === 1)) {
      return { occasions: ['Dzień Dziecka (1 czerwca)', 'Komunia', 'urodziny'], emoji: '❤️' };
    }
    return { occasions: ['urodziny', 'prezent na wakacje'], emoji: '☀️' };
  }

  function resolveOccasions(input) {
    const auto = occasionsFor(input.date);
    return input.occasions && input.occasions.length ? { occasions: input.occasions, emoji: auto.emoji } : auto;
  }

  // ---------- składanie opisu ----------

  function h(type, text) {
    return { type, text };
  }

  /**
   * Składa opis z treści od Gemini wg szablonu z rules/02-opis.md.
   * @param {object} content  odpowiedź Gemini (patrz DESCRIPTION_SCHEMA)
   * @param {object} input    dane produktu (patrz buildDescriptionPrompt)
   * @returns {{sections: Array<{id: string, layout: 'IMAGE_TEXT'|'TEXT', imageHint?: string, blocks: Array<{type: 'h1'|'h2'|'p', text: string}>}>}}
   */
  function buildDescription(content, input) {
    content = content || {};
    input = input || {};
    const sep = input.separator || '';
    const heading = (emoji, text) => {
      const blocks = [h('h2', `${emoji} ${upper(stripLead(text))}`)];
      if (sep) blocks.push(h('p', sep));
      return blocks;
    };
    const sections = [];
    const section = (id, blocks, layout) =>
      sections.push({ id, layout: layout || 'IMAGE_TEXT', imageHint: IMAGE_HINTS[id], blocks });

    // SEKCJA 0 + 1: hook i TOP korzyści
    const hook = content.hook || {};
    const hookBlocks = [h('h1', input.title || ''), h('p', stripLead(hook.headline))];
    if (input.socialProof) hookBlocks.push(h('p', `⭐ ${stripLead(input.socialProof)}`));
    hookBlocks.push(h('p', `${stripLead(hook.benefit)} ${stripEndDot(hook.cta)} ⬇️`.trim()));
    if (input.promo) hookBlocks.push(h('p', `❗ ${stripLead(input.promo)}`));
    for (const b of content.topBenefits || []) hookBlocks.push(h('p', `✅ ${stripLead(b)}`));
    section('hook', hookBlocks);

    // SEKCJA 2: co zyskujesz
    section('gains', [
      ...heading('⭐', 'CO ZYSKUJESZ?'),
      ...(content.gains || []).map((g) =>
        h('p', `✔️ **${stripEndDot(g.feature).replace(/\*\*/g, '')}** ➡️ ${stripEndDot(g.benefit)}. ${stripEndDot(g.emotion)}.`)),
    ]);

    // SEKCJA 3: zabawa i rozwój + trudne pojęcia
    const play = content.play || {};
    section('play', [
      ...heading('✨', play.heading || 'ZABAWA I ROZWÓJ'),
      ...(play.paragraphs || []).map((p) => h('p', stripLead(p))),
      ...(content.glossary || []).map((g) => h('p', `ℹ️ **${stripEndDot(g.term).replace(/\*\*/g, '')}** – ${stripLead(g.explanation)}`)),
    ]);

    // SEKCJA 4: zawartość zestawu
    const contents = content.contents || {};
    const items = input.contents && input.contents.length ? input.contents : contents.items || [];
    section('contents', [
      ...heading('☑️', contents.heading || 'CO JEST W ZESTAWIE?'),
      ...items.map((it, i) => h('p', `${items.length <= KEYCAPS.length ? KEYCAPS[i] : '☑️'} ${stripLead(it)}`)),
      ...(contents.sizeNote ? [h('p', `➡️ ${stripLead(contents.sizeNote)}`)] : []),
    ]);

    // SEKCJA 5: prezent
    const gift = content.gift || {};
    section('gift', [
      ...heading(resolveOccasions(input).emoji, gift.heading || 'IDEALNY PREZENT'),
      ...(gift.paragraph ? [h('p', stripLead(gift.paragraph))] : []),
    ]);

    // SEKCJA 6: specyfikacja – parametry sprzedawcy mają pierwszeństwo
    const params = [...(input.parameters || [])];
    const known = new Set(params.map((p) => searchKey(p.name)));
    for (const p of content.spec || []) {
      if (p && p.name && p.value && !known.has(searchKey(p.name))) {
        params.push(p);
        known.add(searchKey(p.name));
      }
    }
    const specBlocks = [...heading('⚙️', spaced('SPECYFIKACJA')), ...params.map((p) => h('p', `**${stripEndDot(p.name)}:** ${p.value}`))];
    if (input.smallParts) specBlocks.push(h('p', `❗ ${SMALL_PARTS_WARNING}`));
    if (!input.condition || input.condition === 'NEW') specBlocks.push(h('p', `✅ ${NEW_PRODUCT_SENTENCE}`));
    section('spec', specBlocks);

    // SEKCJA 7: Q&A – zawsze na końcu, sam tekst
    const faqBlocks = heading('❓', 'PYTANIA I ODPOWIEDZI');
    for (const f of content.faq || []) {
      faqBlocks.push(h('p', `❓ **${stripLead(f.q).replace(/\*\*/g, '')}**`), h('p', `➡️ ${stripLead(f.a)}`));
    }
    if (content.closing) faqBlocks.push(h('p', `❤️ ${stripLead(content.closing)}`));
    section('faq', faqBlocks, 'TEXT');

    return { sections };
  }

  // ---------- eksport do Allegro ----------

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inlineHtml(s) {
    return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  }

  function plain(s) {
    return String(s).replace(/\*\*/g, '');
  }

  /** HTML z tagów dozwolonych przez Allegro (h1, h2, p, b). */
  function toAllegroHtml(blocks) {
    return blocks
      .map((b) => (b.type === 'p' ? `<p>${inlineHtml(b.text)}</p>` : `<${b.type}>${escapeHtml(plain(b.text))}</${b.type}>`))
      .join('');
  }

  /**
   * Opis w formacie REST API Allegro: {sections: [{items: [{type: 'IMAGE', url}, {type: 'TEXT', content}]}]}.
   * Zdjęcie po lewej, tekst po prawej. Zdjęcia przydzielane kolejno sekcjom IMAGE_TEXT.
   */
  function toAllegroApiDescription(description, imageUrls) {
    const images = [...(imageUrls || [])];
    return {
      sections: description.sections.map((s) => {
        const items = [];
        if (s.layout === 'IMAGE_TEXT' && images.length) items.push({ type: 'IMAGE', url: images.shift() });
        items.push({ type: 'TEXT', content: toAllegroHtml(s.blocks) });
        return { items };
      }),
    };
  }

  /** Tekst tak, jak zobaczy go klient (bez formatowania) – do podglądu i liczenia znaków. */
  function toPlainText(description) {
    return description.sections.map((s) => s.blocks.map((b) => plain(b.text)).join('\n')).join('\n\n');
  }

  // ---------- walidacja ----------

  /** Zbiera wszystkie teksty z odpowiedzi Gemini: [{path, text}]. */
  function collectStrings(value, path, out) {
    if (typeof value === 'string') out.push({ path, text: value });
    else if (Array.isArray(value)) value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
    else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) collectStrings(value[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }

  function sentences(text) {
    return plain(text).split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  }

  function wordCount(sentence) {
    return sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  }

  function countRange(errors, label, arr, min, max) {
    const n = Array.isArray(arr) ? arr.length : 0;
    if (n < min || n > max) errors.push(`${label}: ${n} pozycji (wymagane ${min}–${max})`);
  }

  /**
   * Sprawdza treść od Gemini i złożony opis wg rules/02-opis.md.
   * @returns {{ok: boolean, errors: string[], warnings: string[], description: object, plainText: string}}
   */
  function validateDescription(content, input) {
    content = content || {};
    input = input || {};
    const errors = [];
    const warnings = [];

    // Struktura i liczności
    const hook = content.hook || {};
    for (const k of ['headline', 'benefit', 'cta']) {
      if (!hook[k] || !String(hook[k]).trim()) errors.push(`hook.${k}: brak tekstu`);
    }
    countRange(errors, 'topBenefits (TOP korzyści)', content.topBenefits, 2, 3);
    countRange(errors, 'gains (CO ZYSKUJESZ?)', content.gains, 4, 6);
    countRange(errors, 'play.paragraphs', content.play && content.play.paragraphs, 1, 3);
    countRange(errors, 'faq (Q&A)', content.faq, 3, 5);
    if (content.glossary && content.glossary.length > 3) warnings.push('glossary: więcej niż 3 pojęcia – uprość język');
    for (const [i, g] of (content.gains || []).entries()) {
      for (const k of ['feature', 'benefit', 'emotion']) {
        if (!g || !g[k] || !String(g[k]).trim()) errors.push(`gains[${i}].${k}: brak tekstu (schemat: cecha → korzyść → emocja)`);
      }
    }
    for (const k of ['play', 'contents', 'gift']) {
      if (!content[k] || !content[k].heading) errors.push(`${k}.heading: brak nagłówka`);
    }

    // Wszystkie teksty od Gemini
    const promoKey = searchKey(input.promo || '');
    const glossaryKey = searchKey((content.glossary || []).map((g) => g && g.term).join(' '));
    for (const { path, text } of collectStrings(content, '', [])) {
      const key = searchKey(text);
      const where = `${path}: `;
      if (/<\/?[a-z][^>]*>/i.test(text)) errors.push(where + 'znacznik HTML w tekście – formatowanie robi wtyczka');
      if (/(^|\n)\s*(#{1,6}\s|[-*•]\s)|__|\[[^\]]*\]\([^)]*\)|`/.test(text)) {
        errors.push(where + 'formatowanie Markdown – dozwolone tylko **pogrubienie**');
      }
      if (/(https?:\/\/|www\.)|\.(pl|com|eu)\b/i.test(text)) errors.push(where + 'link');
      if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) errors.push(where + 'adres e-mail');
      if (/(\+?48[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{3}\b/.test(text)) errors.push(where + 'numer telefonu');
      const bad = findDisallowedEmoji(text);
      if (bad.length) errors.push(where + 'niedozwolone emoji: ' + bad.join(' '));
      if (/!!|\?\?/.test(text)) errors.push(where + 'powtórzone !! lub ?? – bez krzyku');

      const cmp = COMPARISON_PHRASES.filter((p) => containsPhrase(key, p));
      if (cmp.length) errors.push(where + 'porównanie z konkurencją: ' + cmp.join(', '));
      const press = PRESSURE_PHRASES.filter((p) => containsPhrase(key, p) && !containsPhrase(promoKey, p));
      if (press.length) errors.push(where + 'presja/manipulacja: ' + press.join(', ') + ' (promocję podaje tylko sprzedawca w polu promo)');
      if (!input.socialProof) {
        const sp = SOCIAL_PROOF_PHRASES.filter((p) => containsPhrase(key, p));
        if (sp.length) errors.push(where + 'wymyślony social proof: ' + sp.join(', '));
      }

      const isHeading = /\.heading$/.test(path);
      const capsWords = (plain(text).match(/\b\p{Lu}{4,}\b/gu) || []).length;
      if (!isHeading && capsWords >= 3) errors.push(where + 'CAPSLOCK w treści – to wygląda jak krzyk');

      for (const s of sentences(text)) {
        const n = wordCount(s);
        if (n > MAX_SENTENCE_WORDS) warnings.push(`${where}zdanie ma ${n} słów (max ${MAX_SENTENCE_WORDS}): „${s.slice(0, 60)}…”`);
      }
      if (cp(plain(text)) > MAX_PARAGRAPH_CHARS) {
        warnings.push(`${where}akapit ma ${cp(plain(text))} znaków (max ${MAX_PARAGRAPH_CHARS} – 3–4 linijki na telefonie)`);
      }
      for (const [j, tip] of JARGON) {
        if (containsPhrase(key, j)) warnings.push(`${where}żargon „${j}…” – zamień na ${tip}`);
      }
      if (!/^glossary/.test(path)) {
        for (const t of DIFFICULT_TERMS) {
          if (containsPhrase(key, t) && !containsPhrase(glossaryKey, t)) {
            warnings.push(`${where}trudne pojęcie „${t}…” – wyjaśnij je w glossary lub użyj prostszego słowa`);
          }
        }
      }
    }

    // Złożony opis
    const description = buildDescription(content, input);
    const plainText = toPlainText(description);
    if (!input.title) errors.push('brak tytułu (H1 musi powtarzać tytuł oferty)');

    const hookText = description.sections[0].blocks.map((b) => plain(b.text)).join('\n');
    const arrow = hookText.indexOf('⬇️');
    const hookLen = arrow < 0 ? cp(hookText) : cp(hookText.slice(0, arrow + 2));
    if (arrow < 0 || hookLen > HOOK_LIMIT) {
      errors.push(`hook: tytuł + hook do strzałki ⬇️ ma ${hookLen} znaków (max ${HOOK_LIMIT}) – skróć headline/benefit/cta o ${Math.max(0, hookLen - HOOK_LIMIT)}+ znaków`);
    }

    for (const s of description.sections) {
      if (s.id === 'faq' || s.id === 'hook') continue;
      const body = s.blocks.filter((b) => b.type === 'p' && !(input.separator && b.text === input.separator));
      const len = cp(body.map((b) => plain(b.text)).join(' '));
      if (len > MAX_SECTION_CHARS) warnings.push(`sekcja ${s.id}: ${len} znaków tekstu (max ${MAX_SECTION_CHARS}) – tekst nie może być większy niż zdjęcie`);
    }

    const topKeyword = (input.keywords && input.keywords[0]) || input.productName;
    if (topKeyword) {
      const kw = searchKey(topKeyword).trim();
      const hits = searchKey(plainText).split(' ' + kw + ' ').length - 1;
      if (hits > MAX_KEYWORD_REPEATS) warnings.push(`fraza „${topKeyword}” występuje ${hits} razy (max ${MAX_KEYWORD_REPEATS}) – keyword stuffing`);
    }

    return { ok: errors.length === 0, errors, warnings, description, plainText };
  }

  // ---------- prompty dla Gemini ----------

  /** Schemat odpowiedzi dla Gemini (generationConfig.responseSchema, responseMimeType: application/json). */
  const S = { type: 'STRING' };
  const DESCRIPTION_SCHEMA = {
    type: 'OBJECT',
    properties: {
      hook: { type: 'OBJECT', properties: { headline: S, benefit: S, cta: S }, required: ['headline', 'benefit', 'cta'] },
      topBenefits: { type: 'ARRAY', items: S },
      gains: {
        type: 'ARRAY',
        items: { type: 'OBJECT', properties: { feature: S, benefit: S, emotion: S }, required: ['feature', 'benefit', 'emotion'] },
      },
      play: { type: 'OBJECT', properties: { heading: S, paragraphs: { type: 'ARRAY', items: S } }, required: ['heading', 'paragraphs'] },
      glossary: { type: 'ARRAY', items: { type: 'OBJECT', properties: { term: S, explanation: S }, required: ['term', 'explanation'] } },
      contents: { type: 'OBJECT', properties: { heading: S, items: { type: 'ARRAY', items: S }, sizeNote: S }, required: ['heading', 'items'] },
      gift: { type: 'OBJECT', properties: { heading: S, paragraph: S }, required: ['heading', 'paragraph'] },
      spec: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: S, value: S }, required: ['name', 'value'] } },
      faq: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: S, a: S }, required: ['q', 'a'] } },
      closing: S,
    },
    required: ['hook', 'topBenefits', 'gains', 'play', 'contents', 'gift', 'faq'],
  };

  function list(items) {
    return (items || []).filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n') || '(brak)';
  }

  /** Ile znaków zostaje na headline + benefit + cta, żeby ⬇️ zmieściła się w pierwszych 200 znakach. */
  function hookBudget(input) {
    let fixed = cp(input.title || '') + 1; // H1 + nowa linia
    if (input.socialProof) fixed += cp(`⭐ ${input.socialProof}`) + 1;
    fixed += 1 + 1 + 3; // nowa linia po headline, spacja przed cta, „ ⬇️”
    return HOOK_LIMIT - fixed;
  }

  const RULES_TEXT = `
JĘZYK I TON:
- Pisz tak prosto, żeby zrozumiał 7-latek. Zdania max ${MAX_SENTENCE_WORDS} słów. Akapit max 3–4 linijki na telefonie (${MAX_PARAGRAPH_CHARS} znaków).
- Bez żargonu: „pancerne pudełko” zamiast „wzmocniona konstrukcja”, „wygodny dla małej rączki” zamiast „ergonomiczny”.
- Ton ciepły, przyjazny, rodzicielski. Buduj zaufanie i spokój. Trochę entuzjazmu, bez przesady.
- Zero krzyku, presji i manipulacji: bez CAPSLOCKA w treści, bez „!!”, bez „ostatnie sztuki”, „tylko dziś”, „kup teraz”.
- Najważniejsze słowa pogrub jako **tekst**. Żadnego innego formatowania: bez HTML (<h1>, <br>, <b>…), bez Markdown (#, -, __), bez emoji – emoji i nagłówki doda wtyczka.

ZAKAZY:
- Nie porównuj z konkurencją („lepszy od…”, „w przeciwieństwie do innych”, „najlepszy na rynku”, „nr 1”).
- Nie wymyślaj faktów: wymiarów, wieku, certyfikatów, materiałów, liczby elementów, opinii ani liczby klientów. Używaj tylko danych produktu.
- Nie wymyślaj promocji ani terminów. Bez linków, e-maili i telefonów.

SEKCJE (pola JSON):
- hook: headline = nazwa produktu + cecha główna (np. „Zestaw do bransoletek 500 elementów”); benefit = główna korzyść w 1 zdaniu; cta = zachęta do czytania dalej (np. „Sprawdź, co jest w środku”).
- topBenefits: 2–3 najważniejsze korzyści, każda max 6 słów.
- gains: 4–6 par. feature = cecha (2–3 słowa), benefit = co to daje, emotion = jak się poczuje rodzic lub dziecko. Mieszaj korzyści dla rodzica („spokojna kawa”, „zero zmartwień”) i dla dziecka („duma z osiągnięcia”).
  Przykłady: Pancerne pudełko → Wytrzyma lata zabawy → Nie musisz dokupować; 500 elementów → Godziny kreatywności → Ty masz czas na kawę; Instrukcja krok po kroku → Dziecko radzi sobie samo → Buduje pewność siebie.
- play: heading = zaleta produktu (np. „Rozwija wyobraźnię i sprawne paluszki”), paragraphs = 1–3 krótkie akapity: jak wygląda zabawa, co dziecko ćwiczy, efekt przed → po.
- glossary: 0–3 trudne pojęcia użyte w opisie (np. motoryka mała, Montessori) z prostym wyjaśnieniem.
- contents: heading = zaleta zestawu (np. „500 koralików i wszystko, czego potrzeba”), items = elementy zestawu, sizeNote = rozmiar w odniesieniu do dziecka (tylko jeśli znasz wymiary, inaczej pusty).
- gift: heading i 1 akapit o prezencie na podane okazje.
- spec: parametry tylko z danych produktu (nazwa + wartość).
- faq: 3–5 pytań, które zadają rodzice (od ilu lat, baterie, bezpieczeństwo, przechowywanie, prezent). Odpowiedzi krótkie, tylko z danych. Nie zadawaj pytań, na które nie znasz odpowiedzi.
- closing: 1 ciepłe zdanie na koniec, bez presji.`.trim();

  /**
   * Prompt generujący treść opisu. Odpowiedź Gemini: JSON zgodny z DESCRIPTION_SCHEMA.
   * @param {{
   *   title: string, productName: string, keywords?: string[], age?: string, brand?: string,
   *   features?: string[], benefits?: string[], contents?: string[], parameters?: Array<{name: string, value: string}>,
   *   socialProof?: string, promo?: string, condition?: string, smallParts?: boolean,
   *   occasions?: string[], date?: Date|string, extra?: string, separator?: string
   * }} input
   */
  function buildDescriptionPrompt(input) {
    const budget = hookBudget(input);
    const { occasions } = resolveOccasions(input);
    const params = (input.parameters || []).map((p) => `${p.name}: ${p.value}`);
    return `Jesteś copywriterem sklepu z zabawkami na Allegro. Napisz treść opisu oferty, który sprzedaje.

${RULES_TEXT}

LIMIT HOOKA: headline + benefit + cta razem max ${budget} znaków (w aplikacji Allegro widać tylko pierwsze ${HOOK_LIMIT} znaków opisu, razem z tytułem).

DANE PRODUKTU:
Tytuł oferty: ${input.title}
Nazwa: ${input.productName}
${input.brand ? `Marka: ${input.brand}\n` : ''}${input.age ? `Wiek: ${input.age}\n` : ''}${input.socialProof ? `Social proof (wtyczka wstawi go sama): ${input.socialProof}\n` : ''}
Frazy kluczowe od najpopularniejszej (użyj drugiej naturalnie w hooku lub nagłówku, bez powtarzania):
${list(input.keywords)}

Cechy:
${list(input.features)}

Korzyści:
${list(input.benefits)}

Zawartość zestawu:
${list(input.contents)}

Parametry:
${list(params)}

Okazje prezentowe: ${occasions.join(', ')}
${input.extra ? `\nDodatkowe informacje:\n${input.extra}\n` : ''}
Odpowiedz WYŁĄCZNIE poprawnym JSON-em w formacie:
{"hook":{"headline":"","benefit":"","cta":""},"topBenefits":[""],"gains":[{"feature":"","benefit":"","emotion":""}],"play":{"heading":"","paragraphs":[""]},"glossary":[{"term":"","explanation":""}],"contents":{"heading":"","items":[""],"sizeNote":""},"gift":{"heading":"","paragraph":""},"spec":[{"name":"","value":""}],"faq":[{"q":"","a":""}],"closing":""}`;
  }

  /** Prompt z prośbą o poprawkę treści, która nie przeszła walidacji. */
  function buildDescriptionRepairPrompt(input, content, errors) {
    return `${buildDescriptionPrompt(input)}

POPRZEDNIA ODPOWIEDŹ:
${JSON.stringify(content)}

ZOSTAŁA ODRZUCONA PRZEZ WALIDATOR:
${errors.map((e) => `- ${e}`).join('\n')}

Popraw te błędy i zwróć cały JSON ponownie.`;
  }

  return {
    HOOK_LIMIT,
    MAX_SENTENCE_WORDS,
    MAX_PARAGRAPH_CHARS,
    MAX_SECTION_CHARS,
    ALLOWED_EMOJI,
    SEPARATOR_LINE,
    NEW_PRODUCT_SENTENCE,
    IMAGE_HINTS,
    DESCRIPTION_SCHEMA,
    RULES_TEXT,
    occasionsFor,
    spaced,
    findDisallowedEmoji,
    buildDescription,
    toAllegroHtml,
    toAllegroApiDescription,
    toPlainText,
    validateDescription,
    hookBudget,
    buildDescriptionPrompt,
    buildDescriptionRepairPrompt,
  };
});

})(NS, undefined);

// ----- src/lib/gemini.js -----
(function (self, module) {
/**
 * Klient Gemini API (generateContent) niezależny od transportu:
 * w Tampermonkey transportem jest GM_xmlhttpRequest, w testach – atrapa.
 *
 * transport(request) → Promise<{status: number, text: string}>
 * request = {method, url, headers, body?}
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroGemini = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /**
   * @param {{apiKey: string, model: string, prompt: string, schema?: object, temperature?: number,
   *   images?: Array<{mimeType: string, data: string}>, search?: boolean, jsonMode?: boolean}} p
   *   images – base64 bez prefiksu data:, search – wyszukiwarka Google (grounding),
   *   jsonMode: false – bez wymuszania JSON/schematu (zapasowo, gdy model nie łączy schematu z wyszukiwarką)
   */
  function buildGenerateRequest({ apiKey, model, prompt, schema, temperature, images, search, jsonMode = true }) {
    const generationConfig = {};
    if (temperature != null) generationConfig.temperature = temperature;
    if (jsonMode) {
      generationConfig.responseMimeType = 'application/json';
      if (schema) generationConfig.responseSchema = schema;
    }
    const parts = [
      ...(images || []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: prompt },
    ];
    const body = { contents: [{ role: 'user', parts }], generationConfig };
    if (search) body.tools = [{ google_search: {} }];
    return {
      method: 'POST',
      url: `${API_BASE}/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    };
  }

  function buildListModelsRequest({ apiKey }) {
    return { method: 'GET', url: `${API_BASE}/models?pageSize=1000`, headers: { 'x-goog-api-key': apiKey } };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /** JSON z tekstu modelu: cały tekst, blok ```json albo fragment od pierwszej { do ostatniej }. */
  function extractJson(text) {
    const direct = safeJson(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (direct) return direct;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && safeJson(fenced[1])) return safeJson(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? safeJson(text.slice(start, end + 1)) : null;
  }

  /** Czytelny komunikat błędu HTTP z podpowiedzią, co poprawić. */
  function httpError(status, text) {
    const body = safeJson(text);
    const msg = (body && body.error && body.error.message) || String(text || '').slice(0, 200);
    let hint = '';
    if (status === 400 && /api key/i.test(msg)) hint = 'Sprawdź klucz API w ustawieniach.';
    else if (status === 401 || status === 403) hint = 'Klucz API jest nieprawidłowy albo nie ma dostępu do Gemini API.';
    else if (status === 404) hint = 'Nie ma takiego modelu – kliknij „Pobierz listę modeli” w ustawieniach.';
    else if (status === 429) hint = 'Przekroczony limit zapytań – odczekaj chwilę.';
    else if (status >= 500) hint = 'Błąd po stronie Google – spróbuj ponownie.';
    const err = new Error(`Gemini ${status}: ${msg}${hint ? ' ' + hint : ''}`);
    err.status = status;
    return err;
  }

  /** Wyciąga JSON z odpowiedzi generateContent. */
  function parseGenerateResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text);
    if (!body) throw new Error('Gemini: odpowiedź nie jest JSON-em');
    if (body.promptFeedback && body.promptFeedback.blockReason) {
      throw new Error(`Gemini zablokował zapytanie: ${body.promptFeedback.blockReason}`);
    }
    const cand = body.candidates && body.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const out = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    if (!out) throw new Error(`Gemini: pusta odpowiedź${cand && cand.finishReason ? ` (${cand.finishReason})` : ''}`);
    const json = extractJson(out);
    if (!json) {
      throw new Error(cand.finishReason === 'MAX_TOKENS' ? 'Gemini: odpowiedź ucięta (MAX_TOKENS)' : 'Gemini: odpowiedź nie jest poprawnym JSON-em');
    }
    return json;
  }

  /** Czego Gemini szukał w Google (grounding) – do pokazania w panelu. */
  function parseSearchQueries(text) {
    const body = safeJson(text) || {};
    const meta = body.candidates && body.candidates[0] && body.candidates[0].groundingMetadata;
    return (meta && meta.webSearchQueries) || [];
  }

  /** Lista modeli obsługujących generateContent, np. ['gemini-…-flash', …]. */
  function parseListModelsResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text) || {};
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort();
  }

  // Model odrzucił połączenie wyszukiwarki z wymuszonym JSON-em → ponów bez schematu.
  const SCHEMA_WITH_TOOLS_ERROR = /mime|json|schema|tool/i;

  /**
   * Zwraca funkcję ask(prompt, schema, {images, search}) → Promise<object> używaną przez pipeline.
   * @param {{apiKey: string, model: string, transport: Function, temperature?: number,
   *   onSearch?: (queries: string[]) => void}} cfg
   */
  function createAsk(cfg) {
    return async function ask(prompt, schema, opts) {
      opts = opts || {};
      if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
      if (!cfg.model) throw new Error('Brak nazwy modelu Gemini – uzupełnij ją w ustawieniach.');
      const request = (jsonMode) => buildGenerateRequest({ ...cfg, prompt, schema, images: opts.images, search: opts.search, jsonMode });
      let res = await cfg.transport(request(true));
      if (opts.search && res.status === 400 && SCHEMA_WITH_TOOLS_ERROR.test(res.text)) res = await cfg.transport(request(false));
      const json = parseGenerateResponse(res.status, res.text);
      if (cfg.onSearch && opts.search) cfg.onSearch(parseSearchQueries(res.text));
      return json;
    };
  }

  async function listModels(cfg) {
    if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
    const res = await cfg.transport(buildListModelsRequest(cfg));
    return parseListModelsResponse(res.status, res.text);
  }

  return {
    API_BASE,
    buildGenerateRequest,
    buildListModelsRequest,
    parseGenerateResponse,
    parseSearchQueries,
    parseListModelsResponse,
    createAsk,
    listModels,
  };
});

})(NS, undefined);

// ----- src/lib/listing.js -----
(function (self, module) {
/**
 * Szybkie wystawianie: jedno zapytanie do Gemini (zdjęcia + nazwa + wyszukiwarka Google)
 * rozpoznaje produkt, znajduje słowa kluczowe i styl konkurencji, pisze tytuł i opis.
 * Potem walidacja wg rules/ i – tylko gdy trzeba – krótkie zapytania naprawcze (bez zdjęć i wyszukiwania).
 *
 * Tryby:
 *   NEW     – nowy produkt spoza katalogu: zdjęcia + nazwa + opcjonalne informacje,
 *   CATALOG – produkt z katalogu Allegro: nazwa, parametry i zdjęcia z formularza.
 */
(function (root, factory) {
  const cjs = typeof module === 'object' && module.exports;
  const api = factory(
    cjs ? require('../rules/title.js') : root.AllegroTitleRules,
    cjs ? require('../rules/description.js') : root.AllegroDescriptionRules,
  );
  if (cjs) module.exports = api;
  else root.AllegroListing = api;
})(typeof self !== 'undefined' ? self : this, function (T, D) {
  'use strict';

  const MAX_REPAIRS = 2;
  const S = { type: 'STRING' };
  const LIST = { type: 'ARRAY', items: S };

  const LISTING_SCHEMA = {
    type: 'OBJECT',
    properties: {
      product: {
        type: 'OBJECT',
        properties: {
          name: S, brand: S, age: S, features: LIST, benefits: LIST, contents: LIST, smallParts: { type: 'BOOLEAN' },
        },
        required: ['name', 'features', 'benefits'],
      },
      keywords: LIST,
      competitorTitles: LIST,
      caseStyle: { type: 'STRING', enum: ['UPPER', 'TITLE'] },
      titles: LIST,
      description: D.DESCRIPTION_SCHEMA,
    },
    required: ['product', 'keywords', 'caseStyle', 'titles', 'description'],
  };

  function list(items) {
    return (items || []).filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n') || '(brak)';
  }

  function caseRule(input) {
    if (input.caseStyle === 'UPPER') return 'CAPSLOCK – cały tytuł wielkimi literami (ustawienie sprzedawcy).';
    if (input.caseStyle === 'TITLE') return 'Pierwsze Litery Wielkie w każdym słowie (ustawienie sprzedawcy).';
    return 'taki sam styl jak większość znalezionych tytułów konkurencji: CAPSLOCK (UPPER) albo Pierwsze Litery Wielkie (TITLE). Wybrany styl wpisz w "caseStyle".';
  }

  /**
   * Prompt „wszystko w jednym”.
   * @param {{
   *   mode: 'NEW'|'CATALOG', productName?: string, extra?: string, parameters?: Array<{name: string, value: string}>,
   *   imageCount?: number, search?: boolean, caseStyle?: 'AUTO'|'UPPER'|'TITLE',
   *   socialProof?: string, promo?: string, date?: Date|string
   * }} input
   */
  function buildListingPrompt(input) {
    const catalog = input.mode === 'CATALOG';
    const budget = D.hookBudget({ title: 'X'.repeat(T.TITLE_MAX), socialProof: input.socialProof });
    const params = (input.parameters || []).map((p) => `${p.name}: ${p.value}`);
    const research = input.search === false
      ? 'Nie masz dostępu do wyszukiwarki – dobierz frazy, którymi Polacy najczęściej szukają takiego produktu na Allegro, na podstawie swojej wiedzy.'
      : 'Użyj wyszukiwarki Google: sprawdź Google Trends, podpowiedzi wyszukiwania i oferty na allegro.pl. Znajdź frazy, którymi Polacy najczęściej szukają tego produktu.';
    return `Jesteś ekspertem od sprzedaży zabawek na Allegro: SEO i copywriting. Przygotuj kompletną ofertę.

TRYB: ${catalog
    ? 'PRODUKT Z KATALOGU ALLEGRO – nazwa i parametry poniżej pochodzą z katalogu i są prawdziwe. Opieraj się na nich.'
    : 'NOWY PRODUKT spoza katalogu – rozpoznaj go ze zdjęć i nazwy.'}

KROK 1 – PRODUKT ("product"):
Na podstawie ${input.imageCount ? `${input.imageCount} zdjęć, ` : ''}nazwy i danych ustal: nazwę, markę, wiek, cechy, korzyści, zawartość zestawu i czy ma małe elementy (smallParts – np. koraliki, drobne klocki).
Tylko fakty widoczne na zdjęciach albo podane poniżej. Nie zgaduj wymiarów, liczby elementów, materiałów ani certyfikatów, jeśli ich nie widać i nie podano.

KROK 2 – SŁOWA KLUCZOWE ("keywords", "competitorTitles", "caseStyle"):
${research}
Zwróć 5–8 fraz od najpopularniejszej. Pierwsza fraza to TOP KEYWORD – krótka nazwa produktu, jaką wpisują klienci.
Zwróć do 10 tytułów ofert konkurencji z Allegro, jeśli je znalazłeś.

KROK 3 – TYTUŁ ("titles"): 5 różnych propozycji. Każda zaczyna się od pierwszej frazy z "keywords".
${T.RULES_TEXT.replace('{{CASE_RULE}}', caseRule(input))}
Policz znaki każdego tytułu przed odpowiedzią.

KROK 4 – OPIS ("description"):
${D.RULES_TEXT}
LIMIT HOOKA: headline + benefit + cta razem max ${budget} znaków.
Okazje prezentowe: ${D.occasionsFor(input.date).occasions.join(', ')}

DANE OD SPRZEDAWCY:
Nazwa: ${input.productName || '(brak – rozpoznaj ze zdjęć)'}
${params.length ? `Parametry${catalog ? ' z katalogu' : ''}:\n${list(params)}\n` : ''}${input.socialProof ? `Social proof (wtyczka wstawi go sama): ${input.socialProof}\n` : ''}${input.extra ? `Dodatkowe informacje:\n${input.extra}\n` : ''}
Odpowiedz WYŁĄCZNIE poprawnym JSON-em w formacie:
{"product":{"name":"","brand":"","age":"","features":[""],"benefits":[""],"contents":[""],"smallParts":false},"keywords":[""],"competitorTitles":[""],"caseStyle":"UPPER","titles":[""],"description":{"hook":{"headline":"","benefit":"","cta":""},"topBenefits":[""],"gains":[{"feature":"","benefit":"","emotion":""}],"play":{"heading":"","paragraphs":[""]},"glossary":[{"term":"","explanation":""}],"contents":{"heading":"","items":[""],"sizeNote":""},"gift":{"heading":"","paragraph":""},"spec":[{"name":"","value":""}],"faq":[{"q":"","a":""}],"closing":""}}`;
  }

  function strings(arr) {
    return (Array.isArray(arr) ? arr : []).map((x) => (typeof x === 'string' ? x : x && (x.phrase || x.title || x.name))).filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  }

  /** Styl liter: ustawienie sprzedawcy > tytuły konkurencji (≥ 3) > wybór Gemini > CAPSLOCK. */
  function resolveCaseStyle(input, research) {
    if (input.caseStyle === 'UPPER' || input.caseStyle === 'TITLE') return input.caseStyle;
    if (research.competitorTitles.length >= 3) return T.detectCaseStyle(research.competitorTitles);
    return research.caseStyle === 'TITLE' ? 'TITLE' : 'UPPER';
  }

  /** Dane do reguł tytułu/opisu z odpowiedzi Gemini + danych sprzedawcy. */
  function buildRuleInputs(input, first) {
    const product = (first && first.product) || {};
    const research = {
      keywords: strings(first && first.keywords),
      competitorTitles: strings(first && first.competitorTitles).slice(0, 10),
      caseStyle: first && first.caseStyle,
    };
    const productName = input.productName || product.name || '';
    if (!research.keywords.length && productName) research.keywords = [productName];
    research.caseStyle = resolveCaseStyle(input, research);
    const titleInput = {
      productName,
      keywords: research.keywords,
      caseStyle: research.caseStyle,
      competitorTitles: research.competitorTitles,
      allowWords: input.allowWords,
      brand: product.brand,
      age: product.age,
      features: strings(product.features),
      benefits: strings(product.benefits),
      extra: input.extra,
    };
    const descInput = {
      productName,
      keywords: research.keywords,
      age: product.age,
      brand: product.brand,
      features: titleInput.features,
      benefits: titleInput.benefits,
      contents: strings(product.contents),
      parameters: input.parameters || [],
      socialProof: input.socialProof,
      promo: input.promo,
      smallParts: input.smallParts != null ? input.smallParts : !!product.smallParts,
      condition: input.condition || 'NEW',
      date: input.date,
      extra: input.extra,
    };
    return { product, research, titleInput, descInput };
  }

  function titleRuleOptions(titleInput) {
    return {
      caseStyle: titleInput.caseStyle,
      topKeyword: titleInput.keywords[0] || titleInput.productName,
      allowWords: titleInput.allowWords,
    };
  }

  /** Najmniej zły tytuł, gdy żaden nie przeszedł walidacji (żeby opis i tak powstał). */
  function leastBad(results) {
    return [...results].sort((a, b) => a.errors.length - b.errors.length || Math.abs(72 - a.length) - Math.abs(72 - b.length))[0];
  }

  /**
   * @param {object} input  patrz buildListingPrompt + images: [{mimeType, data}]
   * @param {Function} ask  ask(prompt, schema, {images, search}) z gemini.createAsk
   * @param {{maxRepairs?: number, onProgress?: (msg: string) => void}} [opts]
   */
  async function generateListing(input, ask, opts) {
    opts = opts || {};
    const maxRepairs = opts.maxRepairs ?? MAX_REPAIRS;
    const progress = opts.onProgress || (() => {});
    const images = input.images || [];

    progress(input.search === false ? 'Gemini analizuje produkt i pisze ofertę…' : 'Gemini analizuje produkt, szuka słów kluczowych i pisze ofertę…');
    const first = await ask(buildListingPrompt({ ...input, imageCount: images.length }), LISTING_SCHEMA, { images, search: input.search !== false });
    const { product, research, titleInput, descInput } = buildRuleInputs(input, first);

    // Tytuł
    const ruleOpts = titleRuleOptions(titleInput);
    let picked = T.pickBestTitle(strings(first && first.titles), ruleOpts);
    const titleResults = picked.results.map((r) => ({ ...r, attempt: 1 }));
    let titleAttempts = 1;
    while (!picked.best && titleAttempts <= maxRepairs) {
      titleAttempts++;
      progress(`Poprawiam tytuł (próba ${titleAttempts})…`);
      const failed = picked.results.length ? picked.results : [{ title: '', length: 0, errors: ['brak propozycji w odpowiedzi'] }];
      const res = await ask(T.buildTitleRepairPrompt(titleInput, failed), T.TITLE_SCHEMA);
      picked = T.pickBestTitle(res && res.candidates, ruleOpts);
      titleResults.push(...picked.results.map((r) => ({ ...r, attempt: titleAttempts })));
    }
    const fallback = !picked.best && titleResults.length ? leastBad(titleResults).title : '';
    const title = picked.best || fallback;

    // Opis
    descInput.title = title;
    let content = (first && first.description) || {};
    let desc = D.validateDescription(content, descInput);
    let descAttempts = 1;
    while (!desc.ok && title && descAttempts <= maxRepairs) {
      descAttempts++;
      progress(`Poprawiam opis (próba ${descAttempts})…`);
      content = await ask(D.buildDescriptionRepairPrompt(descInput, content, desc.errors), D.DESCRIPTION_SCHEMA);
      desc = D.validateDescription(content, descInput);
    }

    return {
      product,
      research,
      title: { value: title, ok: !!picked.best, results: titleResults, attempts: titleAttempts },
      description: { ...desc, content, attempts: descAttempts },
      descInput,
      titleInput,
    };
  }

  return { MAX_REPAIRS, LISTING_SCHEMA, buildListingPrompt, buildRuleInputs, generateListing };
});

})(NS, undefined);

// ----- src/userscript/main.js -----
(function (self, module) {
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

})(NS, undefined);
})();
