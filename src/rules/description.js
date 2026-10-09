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

  // ---------- specyfikacja ----------

  // Jedyne wiersze specyfikacji, w tej kolejności. Klucze nazw: małe litery, bez polskich znaków.
  const SPEC_FIELDS = [
    { label: 'Wymiary', match: [/^(wymiary|rozmiar)\b/], parts: /^(dlugosc|szerokosc|wysokosc|glebokosc)\b/ },
    { label: 'Liczba sztuk', match: [/^(liczba|ilosc) (sztuk|elementow|czesci)\b/] },
    { label: 'Wiek dziecka', match: [/^wiek( dziecka)?\b/, /^minimalny wiek\b/], age: true },
  ];

  function specKey(name) {
    return searchKey(name).trim().replace(/ opcjonalnie$/, '');
  }

  /** Sam numer wieku („3”) → „od 3 lat”. */
  function formatAge(value) {
    const v = String(value).trim();
    if (!/^\d+$/.test(v)) return v;
    return v === '1' ? 'od 1 roku' : `od ${v} lat`;
  }

  function findSpecValue(field, list) {
    for (const re of field.match) {
      const hit = list.find((p) => re.test(specKey(p.name)));
      if (hit) return field.age ? formatAge(hit.value) : String(hit.value).trim();
    }
    if (field.parts) {
      const parts = list.filter((p) => field.parts.test(specKey(p.name)));
      if (parts.length >= 2) return parts.map((p) => String(p.value).trim()).join(' × ');
    }
    return '';
  }

  /**
   * Wiersze specyfikacji: wymiary, liczba sztuk, wiek dziecka – nic więcej.
   * @param {Array<Array<{name: string, value: string}>|undefined>} sources  od najważniejszego (formularz, potem Gemini)
   * @param {string} [age]  wiek rozpoznany przez Gemini – gdy żadne źródło go nie podaje
   */
  function pickSpec(sources, age) {
    const lists = sources.map((s) => (s || []).filter((p) => p && p.name && p.value && String(p.value).trim()));
    const rows = [];
    for (const field of SPEC_FIELDS) {
      let value = '';
      for (const list of lists) {
        value = findSpecValue(field, list);
        if (value) break;
      }
      if (!value && field.age && age) value = formatAge(age);
      if (value) rows.push({ name: field.label, value });
    }
    return rows;
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

    // SEKCJA 6: specyfikacja – tylko wymiary, liczba sztuk i wiek dziecka
    const specRows = pickSpec([input.parameters, content.spec], input.age);
    const specBlocks = [...heading('⚙️', spaced('SPECYFIKACJA')), ...specRows.map((p) => h('p', `**${p.name}:** ${p.value}`))];
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
- spec: tylko 3 parametry, z nazwami dokładnie: „Wymiary” (np. 6,5 cm x 4 cm x 4 cm), „Liczba sztuk” (ile sztuk lub elementów w opakowaniu), „Wiek dziecka” (np. 3 lata +). Nic więcej. Pomiń parametr, którego nie znasz z danych.
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
    pickSpec,
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
