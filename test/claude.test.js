const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/lib/claude.js');

const ok = (obj, extra) => ({
  status: 200,
  text: JSON.stringify({ type: 'message', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }], stop_reason: 'end_turn', ...extra }),
});
const fail = (status, message) => ({ status, text: JSON.stringify({ type: 'error', error: { type: 'x', message } }) });

test('adres bramki → endpoint Messages', () => {
  assert.equal(C.messagesUrl(''), 'https://api.anthropic.com/v1/messages');
  assert.equal(C.messagesUrl('https://bramka.example/'), 'https://bramka.example/v1/messages');
  assert.equal(C.messagesUrl('https://bramka.example/anthropic/v1'), 'https://bramka.example/anthropic/v1/messages');
  assert.equal(C.messagesUrl('https://bramka.example/v1/messages'), 'https://bramka.example/v1/messages');
});

test('schemat Gemini → JSON Schema z additionalProperties: false', () => {
  const s = C.toJsonSchema({
    type: 'OBJECT',
    properties: { a: { type: 'STRING' }, list: { type: 'ARRAY', items: { type: 'OBJECT', properties: { q: { type: 'STRING' } }, required: ['q'] } } },
    required: ['a'],
  });
  assert.deepEqual(s, {
    type: 'object',
    properties: { a: { type: 'string' }, list: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } } },
    required: ['a'],
    additionalProperties: false,
  });
});

test('żądanie: Opus, klucz w nagłówku, myślenie adaptacyjne, effort, schemat, fallback, zdjęcia przed tekstem', () => {
  const req = C.buildMessagesRequest({
    apiKey: 'KEY', model: 'claude-opus-5-5', baseUrl: 'https://bramka.example', prompt: 'P',
    schema: { type: 'OBJECT', properties: { a: { type: 'STRING' } }, required: ['a'] }, images: [{ mimeType: 'image/webp', data: 'AAA' }],
  });
  assert.equal(req.url, 'https://bramka.example/v1/messages');
  assert.equal(req.headers['x-api-key'], 'KEY');
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(req.headers['anthropic-version'], C.API_VERSION);
  assert.equal(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.ok(!req.url.includes('KEY'));
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config.effort, 'medium');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.messages[0].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'AAA' } },
    { type: 'text', text: 'P' },
  ]);
});

test('żądanie: Bearer, tryb plain, fallback tylko dla modeli, które go obsługują', () => {
  const bearer = C.buildMessagesRequest({ apiKey: 'K', model: 'claude-opus-5-5', auth: 'BEARER', prompt: 'P' });
  assert.equal(bearer.headers.Authorization, 'Bearer K');
  assert.equal(bearer.headers['x-api-key'], undefined);
  const plain = C.buildMessagesRequest({ apiKey: 'K', model: 'claude-opus-5-5', prompt: 'P', schema: { type: 'OBJECT' }, plain: true });
  const body = JSON.parse(plain.body);
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(plain.headers['anthropic-beta'], undefined);
  const older = C.buildMessagesRequest({ apiKey: 'K', model: 'claude-opus-4-8', prompt: 'P' });
  assert.equal(JSON.parse(older.body).fallbacks, undefined);
  assert.equal(older.headers['anthropic-beta'], undefined);
});

test('parsowanie: tekst z JSON-em, pomijanie bloków thinking, odmowa, ucięcie, błędy z podpowiedzią', () => {
  assert.deepEqual(C.parseMessagesResponse(200, ok({ a: 1 }).text), { a: 1 });
  const fenced = { content: [{ type: 'text', text: 'Proszę:\n```json\n{"a":2}\n```' }], stop_reason: 'end_turn' };
  assert.deepEqual(C.parseMessagesResponse(200, JSON.stringify(fenced)), { a: 2 });
  assert.throws(() => C.parseMessagesResponse(200, ok({}, { stop_reason: 'refusal', stop_details: { category: 'cyber' } }).text), /odmówił.*cyber/);
  const cut = { content: [{ type: 'text', text: '{"a":' }], stop_reason: 'max_tokens' };
  assert.throws(() => C.parseMessagesResponse(200, JSON.stringify(cut)), /max_tokens/);
  assert.throws(() => C.parseMessagesResponse(200, '<html>bramka</html>'), /adres bramki/);
  assert.throws(() => C.parseMessagesResponse(401, fail(401, 'invalid x-api-key').text), /401.*Logowanie do bramki/);
  assert.throws(() => C.parseMessagesResponse(404, fail(404, 'model not found').text), /404.*nazwę modelu/);
  assert.throws(() => C.parseMessagesResponse(529, fail(529, 'Overloaded').text), /przeciążony/);
});

test('createAsk: brak klucza; AUTO przełącza na Bearer i to zapamiętuje', async () => {
  await assert.rejects(C.createAsk({ apiKey: '', model: 'm', transport: async () => ok({}) })('p'), /klucza API Claude/);
  const seen = [];
  const remembered = [];
  const transport = async (req) => {
    seen.push(req.headers);
    return req.headers.Authorization === 'Bearer K' ? ok({ x: 1 }) : fail(401, 'unauthorized');
  };
  const ask = C.createAsk({ apiKey: 'K', model: 'claude-opus-5-5', transport, onAuth: (a) => remembered.push(a) });
  assert.deepEqual(await ask('p', null), { x: 1 });
  assert.deepEqual(await ask('p', null), { x: 1 });
  assert.equal(seen.length, 3); // drugie zapytanie od razu z Bearer
  assert.deepEqual(remembered, ['BEARER']);
});

test('createAsk: bramka odrzuca nowsze parametry (400) → jedno ponowienie w trybie plain', async () => {
  const bodies = [];
  const transport = async (req) => {
    const body = JSON.parse(req.body);
    bodies.push(body);
    return body.output_config ? fail(400, 'Unknown field: output_config') : ok({ y: 2 });
  };
  const ask = C.createAsk({ apiKey: 'K', model: 'claude-opus-5-5', auth: 'X_API_KEY', transport });
  assert.deepEqual(await ask('p', { type: 'OBJECT' }, { images: [{ mimeType: 'image/jpeg', data: 'B' }] }), { y: 2 });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].messages[0].content[0].type, 'image');
});

test('lista modeli z bramki', async () => {
  let url;
  const models = await C.listModels({
    apiKey: 'K', baseUrl: 'https://bramka.example/v1',
    transport: async (req) => ((url = req.url), { status: 200, text: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] }) }),
  });
  assert.equal(url, 'https://bramka.example/v1/models?limit=1000');
  assert.deepEqual(models, ['claude-opus-5-5', 'claude-sonnet-5-5']);
});
