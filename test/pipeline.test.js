const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/pipeline.js');
const T = require('../src/rules/title.js');
const D = require('../src/rules/description.js');

const GOOD_TITLE = 'KLOCKI MAGNETYCZNE KONSTRUKCYJNE 3+ 100 ELEMENTÓW ZESTAW ROZWIJAJĄCY XXL';
const INPUT = { productName: 'Klocki magnetyczne', keywords: ['klocki magnetyczne'], caseStyle: 'UPPER' };

/** Atrapa Gemini: kolejne odpowiedzi z listy, zapisuje prompty i schematy. */
function fakeAsk(responses) {
  const calls = [];
  const ask = async (prompt, schema) => {
    calls.push({ prompt, schema });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  return { ask, calls };
}

test('tytuł: pierwsza próba udana', async () => {
  const { ask, calls } = fakeAsk([{ candidates: [{ title: 'za krótki' }, { title: GOOD_TITLE.toLowerCase() }] }]);
  const r = await P.generateTitle(INPUT, ask);
  assert.equal(r.best, GOOD_TITLE);
  assert.equal(r.attempts, 1);
  assert.equal(r.results.length, 2);
  assert.equal(calls[0].schema, T.TITLE_SCHEMA);
});

test('tytuł: poprawka z listą błędów, potem sukces', async () => {
  const { ask, calls } = fakeAsk([{ candidates: [{ title: 'KLOCKI HIT' }] }, { candidates: [{ title: GOOD_TITLE }] }]);
  const r = await P.generateTitle(INPUT, ask);
  assert.equal(r.best, GOOD_TITLE);
  assert.equal(r.attempts, 2);
  assert.match(calls[1].prompt, /ODRZUCONE[\s\S]*KLOCKI HIT[\s\S]*zabronione słowa: HIT/);
});

test('tytuł: po 3 nieudanych próbach best = null, ale wyniki są', async () => {
  const { ask, calls } = fakeAsk([{ candidates: [] }]);
  const r = await P.generateTitle(INPUT, ask);
  assert.equal(r.best, null);
  assert.equal(calls.length, 3);
  assert.match(calls[1].prompt, /brak propozycji/);
});

const DESC_INPUT = { ...INPUT, title: GOOD_TITLE, date: '2026-11-01' };
const content = (faqCount) => ({
  hook: { headline: 'Klocki magnetyczne 100 elementów', benefit: 'Dziecko zbuduje zamki i rakiety.', cta: 'Zobacz, co w środku' },
  topBenefits: ['Godziny zabawy bez ekranu', 'Mocne magnesy'],
  gains: Array.from({ length: 4 }, (_, i) => ({ feature: `Cecha ${i}`, benefit: 'Korzyść', emotion: 'Spokój' })),
  play: { heading: 'Rozwija wyobraźnię', paragraphs: ['Dziecko buduje, co chce.'] },
  contents: { heading: 'Wszystko w pudełku', items: ['100 klocków'] },
  gift: { heading: 'Prezent pod choinkę', paragraph: 'Ucieszy każde dziecko.' },
  faq: Array.from({ length: faqCount }, () => ({ q: 'Od ilu lat?', a: 'Od 3 lat.' })),
});

test('opis: brak tytułu → czytelny błąd', async () => {
  await assert.rejects(P.generateDescription({ ...DESC_INPUT, title: '' }, fakeAsk([{}]).ask), /Najpierw wybierz tytuł/);
});

test('opis: poprawka po błędach walidatora', async () => {
  const { ask, calls } = fakeAsk([content(1), content(3)]);
  const r = await P.generateDescription(DESC_INPUT, ask);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(calls[0].schema, D.DESCRIPTION_SCHEMA);
  assert.match(calls[1].prompt, /faq \(Q&A\): 1 pozycji/);
  assert.equal(r.description.sections[0].blocks[0].text, GOOD_TITLE);
});

test('opis: po 3 próbach zwraca ostatnią wersję z ok: false', async () => {
  const r = await P.generateDescription(DESC_INPUT, fakeAsk([content(0)]).ask);
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.ok(r.errors.length);
});
