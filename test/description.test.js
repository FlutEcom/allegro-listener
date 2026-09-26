const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/rules/description.js');

const INPUT = {
  title: 'ZESTAW DO BRANSOLETEK 500 ELEMENTÓW KORALIKI DLA DZIECI 6+ KREATYWNE HOBBY',
  productName: 'Zestaw do bransoletek',
  keywords: ['zestaw do bransoletek', 'koraliki dla dzieci'],
  age: '6+',
  contents: ['500 kolorowych koralików', 'Gumka do nawlekania', 'Pudełko z przegródkami'],
  parameters: [{ name: 'Wiek dziecka', value: '6 lat +' }],
  smallParts: true,
  date: '2026-11-10',
};

const good = () => ({
  hook: {
    headline: 'Zestaw do bransoletek 500 elementów',
    benefit: 'Twoje dziecko stworzy nawet 50 ozdób.',
    cta: 'Sprawdź, co jest w środku',
  },
  topBenefits: ['Godziny zabawy bez ekranu', 'Własne prezenty dla bliskich', 'Mocne pudełko z przegródkami'],
  gains: [
    { feature: 'Pancerne pudełko', benefit: 'Wytrzyma lata zabawy', emotion: 'Nie musisz dokupować' },
    { feature: '500 elementów', benefit: 'Godziny kreatywności', emotion: 'Ty masz czas na kawę' },
    { feature: 'Instrukcja krok po kroku', benefit: 'Dziecko radzi sobie samo', emotion: 'Buduje pewność siebie' },
    { feature: 'Piękne opakowanie', benefit: 'Gotowe do wręczenia', emotion: 'Nie musisz pakować' },
  ],
  play: {
    heading: 'Rozwija wyobraźnię i sprawne paluszki',
    paragraphs: ['Dziecko nawleka koraliki i tworzy wzory. Ćwiczy przy tym motorykę małą.'],
  },
  glossary: [{ term: 'Motoryka mała', explanation: 'To sprawne paluszki: chwytanie i nawlekanie.' }],
  contents: { heading: '500 koralików i wszystko, czego potrzeba', items: [], sizeNote: '' },
  gift: { heading: 'Gotowy prezent pod choinkę', paragraph: 'Pięknie zapakowany zestaw ucieszy każdą małą artystkę.' },
  spec: [{ name: 'Liczba elementów', value: '500' }, { name: 'Wiek dziecka', value: '5 lat' }],
  faq: [
    { q: 'Od ilu lat?', a: 'Od 6 lat.' },
    { q: 'Czy potrzebne są baterie?', a: 'Nie, to zabawka bez baterii.' },
    { q: 'Czy nada się na prezent?', a: 'Tak, pudełko jest gotowe do wręczenia.' },
  ],
  closing: 'Dziękujemy, że wybierasz nasze zabawki.',
});

test('poprawna treść przechodzi walidację', () => {
  const r = D.validateDescription(good(), INPUT);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('szablon: H1 = tytuł, stałe nagłówki, specyfikacja, Q&A na końcu', () => {
  const { sections } = D.buildDescription(good(), INPUT);
  assert.deepEqual(sections.map((s) => s.id), ['hook', 'gains', 'play', 'contents', 'gift', 'spec', 'faq']);
  assert.deepEqual(sections[0].blocks[0], { type: 'h1', text: INPUT.title });
  assert.equal(sections.flatMap((s) => s.blocks).filter((b) => b.type === 'h1').length, 1);
  for (const s of sections.slice(1)) assert.equal(s.blocks[0].type, 'h2', s.id);
  assert.equal(sections[1].blocks[0].text, '⭐ CO ZYSKUJESZ?');
  assert.equal(sections[1].blocks[2].text, '✔️ **Pancerne pudełko** ➡️ Wytrzyma lata zabawy. Nie musisz dokupować.');
  assert.equal(sections[2].blocks[0].text, '✨ ROZWIJA WYOBRAŹNIĘ I SPRAWNE PALUSZKI');
  assert.equal(sections[3].blocks[2].text, '1️⃣ 500 kolorowych koralików'); // zawartość od sprzedawcy
  assert.equal(sections[4].blocks[0].text, '❄️ GOTOWY PREZENT POD CHOINKĘ');
  const spec = sections[5].blocks.map((b) => b.text);
  assert.equal(spec[0], '⚙️ S P E C Y F I K A C J A');
  assert.ok(spec.includes('**Wiek dziecka:** 6 lat +')); // parametr sprzedawcy wygrywa z Gemini
  assert.ok(!spec.includes('**Wiek dziecka:** 5 lat'));
  assert.ok(spec.includes('**Liczba elementów:** 500'));
  assert.ok(spec.some((t) => t.includes('poniżej 36 miesięcy')));
  assert.equal(spec.at(-1), '✅ Produkt nowy, nieużywany, fabrycznie zapakowany.');
  assert.equal(sections[6].layout, 'TEXT');
  assert.equal(sections[6].blocks.at(-1).text, '❤️ Dziękujemy, że wybierasz nasze zabawki.');
});

test('hook: social proof i promocja od sprzedawcy, ⬇️ w pierwszych 200 znakach', () => {
  const input = { ...INPUT, socialProof: '4,9/5 – 1200 ocen', promo: 'Cena przedsezonowa do 30.11' };
  const r = D.validateDescription(good(), input);
  assert.deepEqual(r.errors, []);
  const hook = r.description.sections[0].blocks.map((b) => b.text);
  assert.deepEqual(hook.slice(1, 5), [
    'Zestaw do bransoletek 500 elementów',
    '⭐ 4,9/5 – 1200 ocen',
    'Twoje dziecko stworzy nawet 50 ozdób. Sprawdź, co jest w środku ⬇️',
    '❗ Cena przedsezonowa do 30.11',
  ]);
  assert.ok([...r.plainText].slice(0, 200).join('').includes('⬇️'));

  const long = good();
  long.hook.benefit = 'Twoje dziecko stworzy nawet pięćdziesiąt unikalnych, kolorowych ozdób dla całej rodziny i przyjaciół.';
  assert.ok(D.validateDescription(long, input).errors.some((e) => e.startsWith('hook: tytuł + hook')));
});

test('hookBudget uwzględnia tytuł i social proof', () => {
  const budget = D.hookBudget(INPUT);
  const c = good();
  c.hook.headline = 'x'.repeat(budget - [...c.hook.benefit].length - [...c.hook.cta].length);
  assert.deepEqual(D.validateDescription(c, INPUT).errors, []);
  c.hook.headline += 'x';
  assert.equal(D.validateDescription(c, INPUT).errors.length, 1);
  assert.ok(D.hookBudget({ ...INPUT, socialProof: '4,9/5' }) < budget);
});

test('liczności sekcji', () => {
  const c = good();
  c.topBenefits = ['Jedna'];
  c.gains = c.gains.slice(0, 2);
  c.faq = [];
  delete c.gift.heading;
  const errors = D.validateDescription(c, INPUT).errors.join('\n');
  for (const m of ['topBenefits', 'gains', 'faq', 'gift.heading']) assert.match(errors, new RegExp(m));
});

test('zakazane: HTML, Markdown, emoji spoza listy, linki, kontakty', () => {
  const c = good();
  c.play.paragraphs = ['<b>Super</b> zabawa 🎁', '# Nagłówek', 'Zobacz www.sklep.pl lub napisz a@b.pl, tel. 600 700 800.'];
  const errors = D.validateDescription(c, INPUT).errors.join('\n');
  for (const m of ['znacznik HTML', 'Markdown', 'niedozwolone emoji: 🎁', 'link', 'e-mail', 'telefonu']) assert.match(errors, new RegExp(m));
  assert.deepEqual(D.findDisallowedEmoji('✨ ⭐ ✅ ✔️ ❤ ℹ️ 1️⃣ 5️⃣ ❄️ LEGO®'), []);
  assert.deepEqual(D.findDisallowedEmoji('6️⃣ 🎄 😀'), ['6️⃣', '🎄', '😀']);
});

test('zakazane: porównania, presja, wymyślony social proof, krzyk', () => {
  const c = good();
  c.gift.paragraph = 'Lepszy od konkurencji! Ostatnie sztuki, kup teraz!! Tysiące zadowolonych klientów.';
  c.faq[0].a = 'TO NAJFAJNIEJSZY ZESTAW DLA KAŻDEGO DZIECKA.';
  const errors = D.validateDescription(c, INPUT).errors.join('\n');
  for (const m of ['porównanie', 'presja', 'social proof', '!!', 'CAPSLOCK']) assert.ok(errors.includes(m), m);
  // presja podana przez sprzedawcę w promo nie jest błędem, social proof podany – też nie
  c.gift.paragraph = 'Ostatnie sztuki w cenie przedsezonowej. Tysiące zadowolonych klientów.';
  c.faq[0].a = 'Od 6 lat.';
  assert.deepEqual(
    D.validateDescription(c, { ...INPUT, promo: 'Ostatnie sztuki w cenie przedsezonowej', socialProof: '1200 ocen' }).errors,
    [],
  );
});

test('ostrzeżenia: długie zdania, akapity, żargon, trudne pojęcia, keyword stuffing', () => {
  const c = good();
  c.glossary = [];
  c.play.paragraphs = [
    'Ergonomiczny zestaw wysokiej jakości wspiera motorykę małą i koordynację ręka oko u każdego dziecka w każdym wieku.',
    'Zestaw do bransoletek. '.repeat(10),
  ];
  const w = D.validateDescription(c, INPUT).warnings.join('\n');
  for (const m of ['słów', 'akapit', 'żargon „ergonomiczn', 'żargon „wysokiej jakosci', 'trudne pojęcie „motoryk', 'keyword stuffing']) {
    assert.ok(w.includes(m), m);
  }
});

test('eksport do Allegro: dozwolone tagi, zdjęcie po lewej, Q&A bez zdjęcia', () => {
  const desc = D.buildDescription(good(), INPUT);
  const api = D.toAllegroApiDescription(desc, ['img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'img7']);
  assert.equal(api.sections.length, 7);
  assert.deepEqual(api.sections[0].items[0], { type: 'IMAGE', url: 'img1' });
  assert.equal(api.sections[0].items[1].type, 'TEXT');
  assert.deepEqual(api.sections[6].items.map((i) => i.type), ['TEXT']);
  const html = api.sections.map((s) => s.items.at(-1).content).join('');
  assert.deepEqual([...new Set(html.match(/<\/?([a-z0-9]+)/g).map((t) => t.replace(/[</]/g, '')))].sort(), ['b', 'h1', 'h2', 'p']);
  assert.match(html, /<p>✔️ <b>Pancerne pudełko<\/b> ➡️/);
  assert.equal(D.toAllegroHtml([{ type: 'p', text: 'A & <B>' }]), '<p>A &amp; &lt;B&gt;</p>');
  // mniej zdjęć niż sekcji → reszta tylko tekst
  assert.deepEqual(D.toAllegroApiDescription(desc, ['a']).sections[1].items.map((i) => i.type), ['TEXT']);
});

test('okazje wg daty', () => {
  assert.equal(D.occasionsFor('2026-09-26').emoji, '❄️');
  assert.ok(D.occasionsFor('2026-12-01').occasions.some((o) => o.includes('Mikołajki')));
  assert.ok(!D.occasionsFor('2026-12-10').occasions.some((o) => o.includes('Mikołajki')));
  assert.ok(!D.occasionsFor('2026-12-27').occasions.some((o) => o.includes('choinkę')));
  assert.ok(D.occasionsFor('2026-05-10').occasions.some((o) => o.includes('Dzień Dziecka')));
  assert.equal(D.occasionsFor('2026-07-10').emoji, '☀️');
});

test('prompt zawiera reguły, limit hooka, okazje i schemat JSON', () => {
  const p = D.buildDescriptionPrompt(INPUT);
  assert.match(p, new RegExp(`razem max ${D.hookBudget(INPUT)} znaków`));
  assert.match(p, /Boże Narodzenie/);
  assert.match(p, /Nie porównuj z konkurencją/);
  assert.match(p, /"topBenefits"/);
  const repair = D.buildDescriptionRepairPrompt(INPUT, good(), ['faq: 0 pozycji']);
  assert.match(repair, /ODRZUCONA[\s\S]*- faq: 0 pozycji/);
});
