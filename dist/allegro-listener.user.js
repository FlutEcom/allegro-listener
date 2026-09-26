// ==UserScript==
// @name         Allegro Listener – AI tytuł i opis
// @namespace    https://github.com/FlutEcom/allegro-listener
// @version      0.1.0
// @description  Szybkie wystawianie ofert: Gemini pisze tytuł i opis wg reguł z rules/
// @match        https://salescenter.allegro.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      generativelanguage.googleapis.com
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

  function buildGenerateRequest({ apiKey, model, prompt, schema, temperature }) {
    const generationConfig = { responseMimeType: 'application/json', temperature: temperature ?? 0.7 };
    if (schema) generationConfig.responseSchema = schema;
    return {
      method: 'POST',
      url: `${API_BASE}/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig }),
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
    const json = safeJson(out.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!json) {
      throw new Error(cand.finishReason === 'MAX_TOKENS' ? 'Gemini: odpowiedź ucięta (MAX_TOKENS)' : 'Gemini: odpowiedź nie jest poprawnym JSON-em');
    }
    return json;
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

  /**
   * Zwraca funkcję ask(prompt, schema) → Promise<object> używaną przez pipeline.
   * @param {{apiKey: string, model: string, transport: Function, temperature?: number}} cfg
   */
  function createAsk(cfg) {
    return async function ask(prompt, schema) {
      if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
      if (!cfg.model) throw new Error('Brak nazwy modelu Gemini – uzupełnij ją w ustawieniach.');
      const res = await cfg.transport(buildGenerateRequest({ ...cfg, prompt, schema }));
      return parseGenerateResponse(res.status, res.text);
    };
  }

  async function listModels(cfg) {
    if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
    const res = await cfg.transport(buildListModelsRequest(cfg));
    return parseListModelsResponse(res.status, res.text);
  }

  return { API_BASE, buildGenerateRequest, buildListModelsRequest, parseGenerateResponse, parseListModelsResponse, createAsk, listModels };
});

})(NS, undefined);

// ----- src/lib/pipeline.js -----
(function (self, module) {
/**
 * Generowanie tytułu i opisu: prompt → Gemini → walidacja → (poprawka) → wynik.
 * ask(prompt, schema) → Promise<object> – z gemini.createAsk() albo atrapa w testach.
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('../rules/title.js') : root.AllegroTitleRules,
    typeof module === 'object' && module.exports ? require('../rules/description.js') : root.AllegroDescriptionRules,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroPipeline = api;
})(typeof self !== 'undefined' ? self : this, function (T, D) {
  'use strict';

  const MAX_REPAIRS = 2;

  function titleRuleOptions(input) {
    return {
      caseStyle: input.caseStyle,
      competitorTitles: input.competitorTitles,
      topKeyword: (input.keywords && input.keywords[0]) || input.productName,
      allowWords: input.allowWords,
    };
  }

  /**
   * @returns {Promise<{best: string|null, results: Array<object>, attempts: number}>}
   *   results – wszystkie propozycje ze wszystkich prób (z polem attempt, errors, warnings)
   */
  async function generateTitle(input, ask, opts) {
    const maxRepairs = (opts && opts.maxRepairs) ?? MAX_REPAIRS;
    const ruleOpts = titleRuleOptions(input);
    let prompt = T.buildTitlePrompt(input);
    const all = [];
    for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
      const res = await ask(prompt, T.TITLE_SCHEMA);
      const { best, results } = T.pickBestTitle(res && res.candidates, ruleOpts);
      all.push(...results.map((r) => ({ ...r, attempt })));
      if (best) return { best, results: all, attempts: attempt };
      const failed = results.length ? results : [{ title: '', length: 0, errors: ['brak propozycji w odpowiedzi'] }];
      prompt = T.buildTitleRepairPrompt(input, failed);
    }
    return { best: null, results: all, attempts: maxRepairs + 1 };
  }

  /**
   * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], description: object, plainText: string, content: object, attempts: number}>}
   *   Gdy po poprawkach nadal są błędy – zwraca ostatnią wersję z ok: false.
   */
  async function generateDescription(input, ask, opts) {
    if (!input.title) throw new Error('Najpierw wybierz tytuł – opis zaczyna się od tytułu (H1).');
    const maxRepairs = (opts && opts.maxRepairs) ?? MAX_REPAIRS;
    let prompt = D.buildDescriptionPrompt(input);
    let last = null;
    for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
      const content = await ask(prompt, D.DESCRIPTION_SCHEMA);
      last = { ...D.validateDescription(content, input), content, attempts: attempt };
      if (last.ok) return last;
      prompt = D.buildDescriptionRepairPrompt(input, content, last.errors);
    }
    return last;
  }

  return { MAX_REPAIRS, generateTitle, generateDescription };
});

})(NS, undefined);

// ----- src/userscript/main.js -----
(function (self, module) {
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

})(NS, undefined);
})();
