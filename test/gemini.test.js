const { test } = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/lib/gemini.js');

const ok = (obj) => ({ status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }) });

test('żądanie generateContent: model, klucz w nagłówku, tryb JSON ze schematem', () => {
  const req = G.buildGenerateRequest({ apiKey: 'KEY', model: 'models/gemini-3.8-flash', prompt: 'P', schema: { type: 'OBJECT' } });
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(req.headers['x-goog-api-key'], 'KEY');
  assert.ok(!req.url.includes('KEY'));
  const body = JSON.parse(req.body);
  assert.equal(body.contents[0].parts[0].text, 'P');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, { type: 'OBJECT' });
});

test('żądanie ze zdjęciami i wyszukiwarką Google; bez temperatury domyślnej', () => {
  const req = G.buildGenerateRequest({ apiKey: 'K', model: 'm', prompt: 'P', images: [{ mimeType: 'image/jpeg', data: 'AAA' }], search: true });
  const body = JSON.parse(req.body);
  assert.deepEqual(body.contents[0].parts, [{ inlineData: { mimeType: 'image/jpeg', data: 'AAA' } }, { text: 'P' }]);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
  assert.equal(body.generationConfig.temperature, undefined);
  const plain = JSON.parse(G.buildGenerateRequest({ apiKey: 'K', model: 'm', prompt: 'P', schema: {}, jsonMode: false }).body);
  assert.deepEqual(plain.generationConfig, {});
  assert.equal(plain.tools, undefined);
});

test('parsowanie odpowiedzi: JSON, bloki ```json, pomijanie myśli modelu', () => {
  assert.deepEqual(G.parseGenerateResponse(200, ok({ a: 1 }).text), { a: 1 });
  const fenced = { candidates: [{ content: { parts: [{ text: 'myślę…', thought: true }, { text: '```json\n{"a":2}\n```' }] } }] };
  assert.deepEqual(G.parseGenerateResponse(200, JSON.stringify(fenced)), { a: 2 });
});

test('JSON otoczony tekstem (tryb bez schematu) i zapytania wyszukiwarki', () => {
  const body = { candidates: [{ content: { parts: [{ text: 'Oto oferta:\n{"a":3}\nPowodzenia!' }] }, groundingMetadata: { webSearchQueries: ['klocki magnetyczne trends'] } }] };
  assert.deepEqual(G.parseGenerateResponse(200, JSON.stringify(body)), { a: 3 });
  assert.deepEqual(G.parseSearchQueries(JSON.stringify(body)), ['klocki magnetyczne trends']);
  assert.deepEqual(G.parseSearchQueries(ok({}).text), []);
});

test('błędy z podpowiedzią co zrobić', () => {
  const err = (status, message) => JSON.stringify({ error: { message } });
  assert.throws(() => G.parseGenerateResponse(404, err(404, 'models/x is not found')), /404.*Pobierz listę modeli/);
  assert.throws(() => G.parseGenerateResponse(400, err(400, 'API key not valid')), /klucz API/);
  assert.throws(() => G.parseGenerateResponse(429, err(429, 'quota')), /limit/);
  assert.throws(() => G.parseGenerateResponse(200, JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })), /SAFETY/);
  const cut = { candidates: [{ content: { parts: [{ text: '{"a":' }] }, finishReason: 'MAX_TOKENS' }] };
  assert.throws(() => G.parseGenerateResponse(200, JSON.stringify(cut)), /MAX_TOKENS/);
});

test('createAsk: brak klucza, wywołanie transportu', async () => {
  await assert.rejects(G.createAsk({ apiKey: '', model: 'm', transport: async () => ok({}) })('p'), /klucza API/);
  let seen;
  const ask = G.createAsk({ apiKey: 'K', model: 'gemini-3.8-flash', transport: async (req) => ((seen = req), ok({ x: 1 })) });
  assert.deepEqual(await ask('prompt', null), { x: 1 });
  assert.match(seen.url, /gemini-3\.8-flash:generateContent/);
});

test('wyszukiwarka + schemat odrzucone → ponowienie bez schematu', async () => {
  const reqs = [];
  const transport = async (req) => {
    reqs.push(JSON.parse(req.body));
    if (reqs.length === 1) return { status: 400, text: JSON.stringify({ error: { message: 'Tool use with a response mime type: application/json is unsupported' } }) };
    return { status: 200, text: JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n{"ok":1}\n```' }] }, groundingMetadata: { webSearchQueries: ['q1'] } }] }) };
  };
  let queries;
  const ask = G.createAsk({ apiKey: 'K', model: 'm', transport, onSearch: (q) => { queries = q; } });
  assert.deepEqual(await ask('p', { type: 'OBJECT' }, { search: true }), { ok: 1 });
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].generationConfig.responseMimeType, 'application/json');
  assert.equal(reqs[1].generationConfig.responseMimeType, undefined);
  assert.deepEqual(reqs[1].tools, [{ google_search: {} }]);
  assert.deepEqual(queries, ['q1']);
  // bez wyszukiwarki błąd 400 nie jest ponawiany
  reqs.length = 0;
  await assert.rejects(ask('p', { type: 'OBJECT' }), /Gemini 400/);
  assert.equal(reqs.length, 1);
});

test('lista modeli: tylko obsługujące generateContent', async () => {
  const body = { models: [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
  ] };
  const models = await G.listModels({ apiKey: 'K', transport: async () => ({ status: 200, text: JSON.stringify(body) }) });
  assert.deepEqual(models, ['gemini-3.8-flash']);
});
