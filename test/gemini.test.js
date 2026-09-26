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

test('parsowanie odpowiedzi: JSON, bloki ```json, pomijanie myśli modelu', () => {
  assert.deepEqual(G.parseGenerateResponse(200, ok({ a: 1 }).text), { a: 1 });
  const fenced = { candidates: [{ content: { parts: [{ text: 'myślę…', thought: true }, { text: '```json\n{"a":2}\n```' }] } }] };
  assert.deepEqual(G.parseGenerateResponse(200, JSON.stringify(fenced)), { a: 2 });
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

test('lista modeli: tylko obsługujące generateContent', async () => {
  const body = { models: [
    { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
  ] };
  const models = await G.listModels({ apiKey: 'K', transport: async () => ({ status: 200, text: JSON.stringify(body) }) });
  assert.deepEqual(models, ['gemini-3.8-flash']);
});
