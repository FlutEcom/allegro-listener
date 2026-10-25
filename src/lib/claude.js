/**
 * Klient Claude (Messages API) do pisania opisu – bezpośrednio do api.anthropic.com albo przez bramkę (proxy)
 * zgodną z formatem Anthropic. Transport jak w gemini.js: w Tampermonkey GM_xmlhttpRequest, w testach atrapa.
 *
 * transport(request) → Promise<{status: number, text: string}>
 * request = {method, url, headers, body?}
 */
(function (root, factory) {
  const cjs = typeof module === 'object' && module.exports;
  const api = factory(cjs ? require('./gemini.js') : root.AllegroGemini);
  if (cjs) module.exports = api;
  else root.AllegroClaude = api;
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  const DEFAULT_BASE_URL = 'https://api.anthropic.com';
  const DEFAULT_MODEL = 'claude-opus-5-5';
  const DEFAULT_EFFORT = 'medium';
  const API_VERSION = '2026-10-21';
  const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  const MAX_TOKENS = 16000;
  // Modele, które przyjmują fallbacks: "default" (ponowienie odrzuconego zapytania na innym modelu).
  const FALLBACK_MODELS = /claude-(fable-5|opus-5|sonnet-5-5)/;

  /** Adres bramki → endpoint Messages: „https://x”, „https://x/v1” i „https://x/v1/messages” są równoważne. */
  function messagesUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
    if (/\/messages$/.test(base)) return base;
    return /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }

  function modelsUrl(baseUrl) {
    return messagesUrl(baseUrl).replace(/\/messages$/, '/models');
  }

  /** auth: 'X_API_KEY' (Anthropic) albo 'BEARER' (Authorization: Bearer – część bramek); 'AUTO' zaczyna od x-api-key. */
  function authHeaders(apiKey, auth) {
    return auth === 'BEARER' ? { Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey };
  }

  /** Schemat w stylu Gemini (type: 'OBJECT'…) → JSON Schema dla structured outputs (obiekty z additionalProperties: false). */
  function toJsonSchema(s) {
    const out = {};
    if (s.type) out.type = String(s.type).toLowerCase();
    if (s.enum) out.enum = s.enum;
    if (s.items) out.items = toJsonSchema(s.items);
    if (s.properties) {
      out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
      out.required = s.required || [];
      out.additionalProperties = false;
    }
    return out;
  }

  /**
   * @param {{apiKey: string, model: string, baseUrl?: string, auth?: string, prompt: string, schema?: object,
   *   images?: Array<{mimeType: string, data: string}>, effort?: string, plain?: boolean}} p
   *   plain: true – samo model + wiadomość (zapasowo, gdy bramka nie zna myślenia, effort, schematu albo fallbacks)
   */
  function buildMessagesRequest({ apiKey, model, baseUrl, auth, prompt, schema, images, effort, plain }) {
    const content = [
      ...(images || []).map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.data } })),
      { type: 'text', text: prompt },
    ];
    const body = { model, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] };
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': API_VERSION, ...authHeaders(apiKey, auth) };
    if (!plain) {
      body.thinking = { type: 'adaptive' };
      body.output_config = { effort: effort || DEFAULT_EFFORT };
      if (schema) body.output_config.format = { type: 'json_schema', schema: toJsonSchema(schema) };
      if (FALLBACK_MODELS.test(model)) {
        body.fallbacks = 'default';
        headers['anthropic-beta'] = FALLBACK_BETA;
      }
    }
    return { method: 'POST', url: messagesUrl(baseUrl), headers, body: JSON.stringify(body) };
  }

  function buildListModelsRequest({ apiKey, baseUrl, auth }) {
    return { method: 'GET', url: `${modelsUrl(baseUrl)}?limit=1000`, headers: { 'anthropic-version': API_VERSION, ...authHeaders(apiKey, auth) } };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /** Czytelny komunikat błędu HTTP z podpowiedzią, co poprawić. */
  function httpError(status, text) {
    const body = safeJson(text);
    const msg = (body && body.error && (body.error.message || body.error)) || String(text || '').slice(0, 200);
    let hint = '';
    if (status === 401 || status === 403) hint = 'Klucz API jest nieprawidłowy albo bramka chce innego nagłówka – zmień „Logowanie do bramki” w ustawieniach.';
    else if (status === 404) hint = 'Sprawdź adres bramki i nazwę modelu (przycisk „Pobierz modele Claude”).';
    else if (status === 429) hint = 'Przekroczony limit zapytań – odczekaj chwilę.';
    else if (status === 529 || status === 503) hint = 'Claude jest teraz przeciążony – spróbuj za chwilę.';
    else if (status >= 500) hint = 'Błąd po stronie bramki albo Anthropic – spróbuj ponownie.';
    const err = new Error(`Claude ${status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}${hint ? ' ' + hint : ''}`);
    err.status = status;
    return err;
  }

  /** Wyciąga JSON z odpowiedzi Messages API (bloki text; bloki thinking są pomijane). */
  function parseMessagesResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text);
    if (!body) throw new Error('Claude: odpowiedź bramki nie jest JSON-em – sprawdź adres bramki.');
    if (body.type === 'error') throw httpError(status, text);
    if (body.stop_reason === 'refusal') {
      const details = body.stop_details && body.stop_details.category;
      throw new Error(`Claude odmówił odpowiedzi${details ? ` (${details})` : ''}.`);
    }
    const out = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('').trim();
    if (!out) throw new Error(`Claude: pusta odpowiedź${body.stop_reason ? ` (${body.stop_reason})` : ''}`);
    const json = G.extractJson(out);
    if (!json) {
      throw new Error(body.stop_reason === 'max_tokens' ? 'Claude: odpowiedź ucięta (max_tokens)' : 'Claude: odpowiedź nie jest poprawnym JSON-em');
    }
    return json;
  }

  /** Lista identyfikatorów modeli z GET /v1/models, np. ['claude-opus-5-5', …]. */
  function parseListModelsResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text) || {};
    return (body.data || []).map((m) => m.id).filter(Boolean).sort();
  }

  const isAuthError = (res) => res.status === 401 || res.status === 403;

  /**
   * Zwraca funkcję ask(prompt, schema, {images}) → Promise<object>, zgodną z gemini.createAsk.
   * auth 'AUTO': przy 401/403 ponawia z Authorization: Bearer i zapamiętuje, który nagłówek działa.
   * 400: ponawia raz w trybie plain (bramka może nie znać nowszych parametrów).
   * @param {{apiKey: string, model: string, baseUrl?: string, auth?: string, effort?: string, transport: Function,
   *   onAuth?: (auth: string) => void}} cfg
   */
  function createAsk(cfg) {
    let auth = cfg.auth || 'AUTO';
    return async function ask(prompt, schema, opts) {
      opts = opts || {};
      if (!cfg.apiKey) throw new Error('Brak klucza API Claude – uzupełnij go w ustawieniach.');
      if (!cfg.model) throw new Error('Brak nazwy modelu Claude – uzupełnij ją w ustawieniach.');
      const send = (plain, a) => cfg.transport(buildMessagesRequest({ ...cfg, auth: a, prompt, schema, images: opts.images, plain }));
      let res = await send(false, auth);
      if (isAuthError(res) && auth === 'AUTO') {
        const bearer = await send(false, 'BEARER');
        if (!isAuthError(bearer)) {
          auth = 'BEARER';
          res = bearer;
          if (cfg.onAuth) cfg.onAuth(auth);
        }
      }
      if (res.status === 400) res = await send(true, auth);
      return parseMessagesResponse(res.status, res.text);
    };
  }

  async function listModels(cfg) {
    if (!cfg.apiKey) throw new Error('Brak klucza API Claude – uzupełnij go w ustawieniach.');
    let res = await cfg.transport(buildListModelsRequest(cfg));
    if (isAuthError(res) && (cfg.auth || 'AUTO') === 'AUTO') res = await cfg.transport(buildListModelsRequest({ ...cfg, auth: 'BEARER' }));
    return parseListModelsResponse(res.status, res.text);
  }

  return {
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    DEFAULT_EFFORT,
    API_VERSION,
    messagesUrl,
    toJsonSchema,
    buildMessagesRequest,
    buildListModelsRequest,
    parseMessagesResponse,
    parseListModelsResponse,
    createAsk,
    listModels,
  };
});
