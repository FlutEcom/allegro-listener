const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/rules/title.js');

const GOOD = 'KLOCKI MAGNETYCZNE KONSTRUKCYJNE 3+ 100 ELEMENTÓW ZESTAW ROZWIJAJĄCY XXL'; // 72

test('poprawny tytuł przechodzi walidację', () => {
  const r = R.validateTitle(GOOD, { topKeyword: 'klocki magnetyczne' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.length, 72);
});

test('długość 70–75', () => {
  assert.match(R.validateTitle('KLOCKI MAGNETYCZNE 3+').errors[0], /za krótki/);
  assert.match(R.validateTitle(GOOD + ' KOLOROWE').errors[0], /za długi/);
  assert.equal(R.validateTitle('Ą'.repeat(75)).length, 75); // polskie znaki = 1 znak
});

test('tytuł musi zaczynać się od TOP KEYWORD', () => {
  const r = R.validateTitle(GOOD, { topKeyword: 'zabawki kreatywne' });
  assert.ok(r.errors.some((e) => e.includes('zaczynać się')));
});

test('zabronione słowa – całe słowa, bez względu na polskie znaki', () => {
  const t = 'KLOCKI MAGNETYCZNE NAJTANSZY ZESTAW 3+ 100 ELEMENTÓW WYSYŁKA 24H GRATIS';
  const r = R.validateTitle(t);
  const hit = r.errors.find((e) => e.startsWith('zabronione')) || '';
  for (const w of ['NAJTAŃSZY', 'WYSYŁKA', '24H', 'GRATIS']) assert.ok(hit.includes(w), w);
  // słowa zawierające zakazany fragment nie są blokowane
  assert.deepEqual(R.validateTitle('SMARTWATCH HITACHI TELEWIZOR SMART TV CROP TOP SUPER MARIO').errors.filter((e) => e.startsWith('zabronione')), []);
});

test('allowWords przepuszcza słowo z nazwy produktu', () => {
  const t = 'GRA PLANSZOWA HIT ROKU'.padEnd(72, ' X');
  assert.ok(R.validateTitle(t).errors.some((e) => e.includes('HIT')));
  assert.ok(!R.validateTitle(t, { allowWords: ['hit'] }).errors.some((e) => e.includes('HIT')));
});

test('zabronione znaki, linki, kontakty, emoji', () => {
  const r = R.validateTitle('KLOCKI!! www.x.pl a@b.pl 600 700 800 & 🔥');
  for (const m of ['WWW', 'e-mail', 'telefonu', 'emoji', 'znak specjalny', 'znak &', 'powtórzony']) {
    assert.ok(r.errors.some((e) => e.includes(m)), m);
  }
});

test('keyword stuffing', () => {
  const r = R.validateTitle('KLOCKI MAGNETYCZNE KLOCKI DLA DZIECI KLOCKÓW, ZABAWKA, ZESTAW, GRA, PREZENT');
  assert.ok(r.errors.some((e) => e.includes('powtórzone słowa: KLOCKI')));
  assert.ok(r.warnings.some((w) => w.includes('KLOCKI/KLOCKOW')));
  assert.ok(r.warnings.some((w) => w.includes('separatorów')));
  // różne słowa o wspólnym początku nie są powtórzeniem
  assert.deepEqual(R.validateTitle('SAMOCHÓD SAMOLOT').warnings, []);
});

test('wielkość liter wg konkurencji', () => {
  assert.equal(R.detectCaseStyle([]), 'UPPER');
  assert.equal(R.detectCaseStyle(['KLOCKI XXL', 'KLOCKI 3+', 'Klocki Magnetyczne']), 'UPPER');
  assert.equal(R.detectCaseStyle(['Klocki Magnetyczne', 'Klocki Duże', 'KLOCKI']), 'TITLE');
  assert.equal(R.applyCase('klocki LED usb-c 100 ml zestaw', 'UPPER'), 'KLOCKI LED USB-C 100 ML ZESTAW');
  assert.equal(R.applyCase('KLOCKI MAGNETYCZNE 3+ LED USB-C 100 ML ZESTAW', 'TITLE'), 'Klocki Magnetyczne 3+ LED USB-C 100 ml Zestaw');
});

test('pickBestTitle wybiera poprawny, najdłuższy', () => {
  const { best, results } = R.pickBestTitle(
    ['klocki za krótkie', { title: GOOD.toLowerCase() }, 'KLOCKI MAGNETYCZNE DLA DZIECI 3+ 100 ELEMENTÓW ZESTAW KREATYWNY ROZWIJAJĄCY'],
    { caseStyle: 'UPPER', topKeyword: 'klocki magnetyczne' },
  );
  assert.equal(results.length, 3);
  assert.equal(best, 'KLOCKI MAGNETYCZNE DLA DZIECI 3+ 100 ELEMENTÓW ZESTAW KREATYWNY ROZWIJAJĄCY');
  assert.equal(R.pickBestTitle(['za krótki']).best, null);
});

test('prompt zawiera reguły i dane produktu', () => {
  const input = {
    productName: 'Klocki magnetyczne',
    keywords: ['klocki magnetyczne', 'klocki konstrukcyjne'],
    age: '3+',
    features: ['100 elementów'],
    benefits: ['rozwijają wyobraźnię'],
    competitorTitles: ['Klocki Magnetyczne Duże'],
  };
  const p = R.buildTitlePrompt(input);
  assert.match(p, /70–75 znaków/);
  assert.match(p, /Pierwsze Litery Wielkie/);
  assert.match(p, /MUSI się od niego zaczynać\): klocki magnetyczne/);
  assert.match(p, /"candidates"/);
  const repair = R.buildTitleRepairPrompt(input, [{ title: 'KLOCKI', errors: ['za krótki'] }]);
  assert.match(repair, /ODRZUCONE[\s\S]*"KLOCKI" \(6 znaków\): za krótki/);
});
