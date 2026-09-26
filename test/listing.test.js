const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/lib/listing.js');
const T = require('../src/rules/title.js');
const D = require('../src/rules/description.js');

const GOOD_TITLE = 'KLOCKI MAGNETYCZNE KONSTRUKCYJNE 3+ 100 ELEMENTÓW ZESTAW ROZWIJAJĄCY XXL';

const description = (faqCount = 3) => ({
  hook: { headline: 'Klocki magnetyczne 100 elementów', benefit: 'Dziecko zbuduje zamki i rakiety.', cta: 'Zobacz, co w środku' },
  topBenefits: ['Godziny zabawy bez ekranu', 'Mocne magnesy'],
  gains: Array.from({ length: 4 }, (_, i) => ({ feature: `Cecha ${i}`, benefit: 'Korzyść', emotion: 'Spokój' })),
  play: { heading: 'Rozwija wyobraźnię', paragraphs: ['Dziecko buduje, co chce.'] },
  contents: { heading: 'Wszystko w pudełku', items: ['100 klocków'] },
  gift: { heading: 'Prezent pod choinkę', paragraph: 'Ucieszy każde dziecko.' },
  faq: Array.from({ length: faqCount }, () => ({ q: 'Od ilu lat?', a: 'Od 3 lat.' })),
});

const answer = (over = {}) => ({
  product: { name: 'Klocki magnetyczne', age: '3+', features: ['100 elementów'], benefits: ['Rozwija wyobraźnię'], contents: ['100 klocków', 'Instrukcja'], smallParts: true },
  keywords: ['klocki magnetyczne', 'klocki konstrukcyjne'],
  competitorTitles: [],
  caseStyle: 'UPPER',
  titles: ['za krótki', GOOD_TITLE.toLowerCase()],
  description: description(),
  ...over,
});

/** Atrapa Gemini: kolejne odpowiedzi z listy, zapisuje wywołania. */
function fakeAsk(responses) {
  const calls = [];
  const ask = async (prompt, schema, opts) => {
    calls.push({ prompt, schema, opts });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  return { ask, calls };
}

const IMG = [{ mimeType: 'image/jpeg', data: 'AAA' }];
const NEW = { mode: 'NEW', productName: 'Klocki magnetyczne', images: IMG, date: '2026-11-01' };

test('jedno zapytanie ze zdjęciami i wyszukiwarką wystarcza, gdy wszystko jest poprawne', async () => {
  const { ask, calls } = fakeAsk([answer()]);
  const progress = [];
  const r = await L.generateListing(NEW, ask, { onProgress: (m) => progress.push(m) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schema, L.LISTING_SCHEMA);
  assert.deepEqual(calls[0].opts, { images: IMG, search: true });
  assert.match(calls[0].prompt, /NOWY PRODUKT/);
  assert.match(calls[0].prompt, /1 zdjęć/);
  assert.match(calls[0].prompt, /Google Trends/);
  assert.equal(r.title.value, GOOD_TITLE);
  assert.equal(r.title.ok, true);
  assert.equal(r.description.ok, true, r.description.errors.join('\n'));
  assert.equal(r.description.description.sections[0].blocks[0].text, GOOD_TITLE);
  assert.equal(r.descInput.smallParts, true); // Gemini rozpoznał małe elementy
  assert.deepEqual(r.descInput.contents, ['100 klocków', 'Instrukcja']);
  assert.deepEqual(r.research.keywords, ['klocki magnetyczne', 'klocki konstrukcyjne']);
  assert.ok(progress[0].includes('szuka słów kluczowych'));
});

test('tryb katalogu: parametry z formularza w prompcie i w specyfikacji', async () => {
  const parameters = [{ name: 'Marka', value: 'Magnetico' }, { name: 'Wiek dziecka', value: '3 lata +' }];
  const { ask, calls } = fakeAsk([answer()]);
  const r = await L.generateListing({ mode: 'CATALOG', productName: 'Klocki magnetyczne', parameters, date: '2026-11-01' }, ask);
  assert.match(calls[0].prompt, /PRODUKT Z KATALOGU/);
  assert.match(calls[0].prompt, /Parametry z katalogu:\n1\. Marka: Magnetico/);
  const spec = r.description.description.sections.find((s) => s.id === 'spec').blocks.map((b) => b.text);
  assert.ok(spec.includes('**Marka:** Magnetico'));
});

test('wyszukiwarka wyłączona w ustawieniach', async () => {
  const { ask, calls } = fakeAsk([answer()]);
  await L.generateListing({ ...NEW, search: false }, ask);
  assert.equal(calls[0].opts.search, false);
  assert.match(calls[0].prompt, /Nie masz dostępu do wyszukiwarki/);
});

test('zły tytuł → krótka poprawka samego tytułu (bez zdjęć i wyszukiwarki)', async () => {
  const { ask, calls } = fakeAsk([answer({ titles: ['KLOCKI MAGNETYCZNE HIT'] }), { candidates: [{ title: GOOD_TITLE }] }]);
  const r = await L.generateListing(NEW, ask);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].schema, T.TITLE_SCHEMA);
  assert.equal(calls[1].opts, undefined);
  assert.match(calls[1].prompt, /ODRZUCONE[\s\S]*zabronione słowa: HIT/);
  assert.equal(r.title.value, GOOD_TITLE);
  assert.equal(r.title.attempts, 2);
});

test('zły opis → poprawka samego opisu', async () => {
  const { ask, calls } = fakeAsk([answer({ description: description(1) }), description(3)]);
  const r = await L.generateListing(NEW, ask);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].schema, D.DESCRIPTION_SCHEMA);
  assert.match(calls[1].prompt, /faq \(Q&A\): 1 pozycji/);
  assert.equal(r.description.ok, true);
  assert.equal(r.description.attempts, 2);
});

test('po nieudanych poprawkach: najmniej zły tytuł, opis i tak powstaje', async () => {
  const bad = 'KLOCKI MAGNETYCZNE ZESTAW 3+ DLA DZIECI';
  const { ask, calls } = fakeAsk([answer({ titles: [bad, 'KLOCKI HIT'] }), { candidates: [] }]);
  const r = await L.generateListing(NEW, ask);
  assert.equal(calls.length, 3);
  assert.equal(r.title.ok, false);
  assert.equal(r.title.value, bad);
  assert.equal(r.description.description.sections[0].blocks[0].text, bad);
});

test('styl liter: ustawienie > tytuły konkurencji > wybór Gemini', () => {
  const comp = ['Klocki Magnetyczne Duże', 'Klocki Dla Dzieci', 'Magnetyczne Klocki 3+'];
  const base = { productName: 'Klocki', mode: 'NEW' };
  assert.equal(L.buildRuleInputs(base, answer({ competitorTitles: comp, caseStyle: 'UPPER' })).research.caseStyle, 'TITLE');
  assert.equal(L.buildRuleInputs(base, answer({ caseStyle: 'TITLE' })).research.caseStyle, 'TITLE');
  assert.equal(L.buildRuleInputs({ ...base, caseStyle: 'UPPER' }, answer({ competitorTitles: comp })).research.caseStyle, 'UPPER');
  assert.equal(L.buildRuleInputs(base, answer({ caseStyle: undefined })).research.caseStyle, 'UPPER');
});

test('brak słów kluczowych od Gemini → nazwa produktu jako TOP KEYWORD', () => {
  const r = L.buildRuleInputs({ productName: 'Klocki magnetyczne', mode: 'NEW' }, answer({ keywords: [] }));
  assert.deepEqual(r.research.keywords, ['Klocki magnetyczne']);
});

test('prompt: reguły tytułu i opisu, limit hooka, okazje, dane sprzedawcy', () => {
  const p = L.buildListingPrompt({ ...NEW, extra: 'Wymiary 20 x 10 cm', promo: 'x', socialProof: '4,9/5', imageCount: 2 });
  assert.match(p, /70–75 znaków/);
  assert.match(p, /Nie porównuj z konkurencją/);
  assert.match(p, /LIMIT HOOKA: headline \+ benefit \+ cta razem max \d+ znaków/);
  assert.match(p, /Boże Narodzenie/);
  assert.match(p, /Wymiary 20 x 10 cm/);
  assert.match(p, /Social proof \(wtyczka wstawi go sama\): 4,9\/5/);
  assert.match(p, /"caseStyle":"UPPER"/);
  assert.doesNotMatch(p, /\{\{CASE_RULE\}\}/);
});
