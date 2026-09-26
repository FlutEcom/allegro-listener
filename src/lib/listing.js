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
