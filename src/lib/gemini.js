/**
 * Klient Gemini API (generateContent) niezależny od transportu:
 * w Tampermonkey transportem jest GM_xmlhttpRequest, w testach – atrapa.
 *
 * transport(request) → Promise<{status: number, text: string}>
 * request = {method, url, headers, body?}
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroGemini = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /**
   * @param {{apiKey: string, model: string, prompt: string, schema?: object, temperature?: number,
   *   images?: Array<{mimeType: string, data: string}>, search?: boolean, jsonMode?: boolean}} p
   *   images – base64 bez prefiksu data:, search – wyszukiwarka Google (grounding),
   *   jsonMode: false – bez wymuszania JSON/schematu (zapasowo, gdy model nie łączy schematu z wyszukiwarką)
   */
  function buildGenerateRequest({ apiKey, model, prompt, schema, temperature, images, search, jsonMode = true }) {
    const generationConfig = {};
    if (temperature != null) generationConfig.temperature = temperature;
    if (jsonMode) {
      generationConfig.responseMimeType = 'application/json';
      if (schema) generationConfig.responseSchema = schema;
    }
    const parts = [
      ...(images || []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
      { text: prompt },
    ];
    const body = { contents: [{ role: 'user', parts }], generationConfig };
    if (search) body.tools = [{ google_search: {} }];
    return {
      method: 'POST',
      url: `${API_BASE}/models/${encodeURIComponent(String(model).replace(/^models\//, ''))}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    };
  }

  function buildListModelsRequest({ apiKey }) {
    return { method: 'GET', url: `${API_BASE}/models?pageSize=1000`, headers: { 'x-goog-api-key': apiKey } };
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  /** JSON z tekstu modelu: cały tekst, blok ```json albo fragment od pierwszej { do ostatniej }. */
  function extractJson(text) {
    const direct = safeJson(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (direct) return direct;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced && safeJson(fenced[1])) return safeJson(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? safeJson(text.slice(start, end + 1)) : null;
  }

  /** Czytelny komunikat błędu HTTP z podpowiedzią, co poprawić. */
  function httpError(status, text) {
    const body = safeJson(text);
    const msg = (body && body.error && body.error.message) || String(text || '').slice(0, 200);
    let hint = '';
    if (status === 400 && /api key/i.test(msg)) hint = 'Sprawdź klucz API w ustawieniach.';
    else if (status === 401 || status === 403) hint = 'Klucz API jest nieprawidłowy albo nie ma dostępu do Gemini API.';
    else if (status === 404) hint = 'Nie ma takiego modelu – kliknij „Pobierz listę modeli” w ustawieniach.';
    else if (status === 429) hint = 'Przekroczony limit zapytań – odczekaj chwilę.';
    else if (status >= 500) hint = 'Błąd po stronie Google – spróbuj ponownie.';
    const err = new Error(`Gemini ${status}: ${msg}${hint ? ' ' + hint : ''}`);
    err.status = status;
    return err;
  }

  /** Wyciąga JSON z odpowiedzi generateContent. */
  function parseGenerateResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text);
    if (!body) throw new Error('Gemini: odpowiedź nie jest JSON-em');
    if (body.promptFeedback && body.promptFeedback.blockReason) {
      throw new Error(`Gemini zablokował zapytanie: ${body.promptFeedback.blockReason}`);
    }
    const cand = body.candidates && body.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    const out = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    if (!out) throw new Error(`Gemini: pusta odpowiedź${cand && cand.finishReason ? ` (${cand.finishReason})` : ''}`);
    const json = extractJson(out);
    if (!json) {
      throw new Error(cand.finishReason === 'MAX_TOKENS' ? 'Gemini: odpowiedź ucięta (MAX_TOKENS)' : 'Gemini: odpowiedź nie jest poprawnym JSON-em');
    }
    return json;
  }

  /** Czego Gemini szukał w Google (grounding) – do pokazania w panelu. */
  function parseSearchQueries(text) {
    const body = safeJson(text) || {};
    const meta = body.candidates && body.candidates[0] && body.candidates[0].groundingMetadata;
    return (meta && meta.webSearchQueries) || [];
  }

  /** Lista modeli obsługujących generateContent, np. ['gemini-…-flash', …]. */
  function parseListModelsResponse(status, text) {
    if (status < 200 || status >= 300) throw httpError(status, text);
    const body = safeJson(text) || {};
    return (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort();
  }

  // Model odrzucił połączenie wyszukiwarki z wymuszonym JSON-em → ponów bez schematu.
  const SCHEMA_WITH_TOOLS_ERROR = /mime|json|schema|tool/i;

  /**
   * Zwraca funkcję ask(prompt, schema, {images, search}) → Promise<object> używaną przez pipeline.
   * @param {{apiKey: string, model: string, transport: Function, temperature?: number,
   *   onSearch?: (queries: string[]) => void}} cfg
   */
  function createAsk(cfg) {
    return async function ask(prompt, schema, opts) {
      opts = opts || {};
      if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
      if (!cfg.model) throw new Error('Brak nazwy modelu Gemini – uzupełnij ją w ustawieniach.');
      const request = (jsonMode) => buildGenerateRequest({ ...cfg, prompt, schema, images: opts.images, search: opts.search, jsonMode });
      let res = await cfg.transport(request(true));
      if (opts.search && res.status === 400 && SCHEMA_WITH_TOOLS_ERROR.test(res.text)) res = await cfg.transport(request(false));
      const json = parseGenerateResponse(res.status, res.text);
      if (cfg.onSearch && opts.search) cfg.onSearch(parseSearchQueries(res.text));
      return json;
    };
  }

  async function listModels(cfg) {
    if (!cfg.apiKey) throw new Error('Brak klucza API Gemini – uzupełnij go w ustawieniach.');
    const res = await cfg.transport(buildListModelsRequest(cfg));
    return parseListModelsResponse(res.status, res.text);
  }

  return {
    API_BASE,
    buildGenerateRequest,
    buildListModelsRequest,
    parseGenerateResponse,
    parseSearchQueries,
    parseListModelsResponse,
    createAsk,
    listModels,
  };
});
