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
