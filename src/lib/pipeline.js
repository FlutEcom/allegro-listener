/**
 * Generowanie tytułu i opisu: prompt → Gemini → walidacja → (poprawka) → wynik.
 * ask(prompt, schema) → Promise<object> – z gemini.createAsk() albo atrapa w testach.
 */
(function (root, factory) {
  const api = factory(
    typeof module === 'object' && module.exports ? require('../rules/title.js') : root.AllegroTitleRules,
    typeof module === 'object' && module.exports ? require('../rules/description.js') : root.AllegroDescriptionRules,
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AllegroPipeline = api;
})(typeof self !== 'undefined' ? self : this, function (T, D) {
  'use strict';

  const MAX_REPAIRS = 2;

  function titleRuleOptions(input) {
    return {
      caseStyle: input.caseStyle,
      competitorTitles: input.competitorTitles,
      topKeyword: (input.keywords && input.keywords[0]) || input.productName,
      allowWords: input.allowWords,
    };
  }

  /**
   * @returns {Promise<{best: string|null, results: Array<object>, attempts: number}>}
   *   results – wszystkie propozycje ze wszystkich prób (z polem attempt, errors, warnings)
   */
  async function generateTitle(input, ask, opts) {
    const maxRepairs = (opts && opts.maxRepairs) ?? MAX_REPAIRS;
    const ruleOpts = titleRuleOptions(input);
    let prompt = T.buildTitlePrompt(input);
    const all = [];
    for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
      const res = await ask(prompt, T.TITLE_SCHEMA);
      const { best, results } = T.pickBestTitle(res && res.candidates, ruleOpts);
      all.push(...results.map((r) => ({ ...r, attempt })));
      if (best) return { best, results: all, attempts: attempt };
      const failed = results.length ? results : [{ title: '', length: 0, errors: ['brak propozycji w odpowiedzi'] }];
      prompt = T.buildTitleRepairPrompt(input, failed);
    }
    return { best: null, results: all, attempts: maxRepairs + 1 };
  }

  /**
   * @returns {Promise<{ok: boolean, errors: string[], warnings: string[], description: object, plainText: string, content: object, attempts: number}>}
   *   Gdy po poprawkach nadal są błędy – zwraca ostatnią wersję z ok: false.
   */
  async function generateDescription(input, ask, opts) {
    if (!input.title) throw new Error('Najpierw wybierz tytuł – opis zaczyna się od tytułu (H1).');
    const maxRepairs = (opts && opts.maxRepairs) ?? MAX_REPAIRS;
    let prompt = D.buildDescriptionPrompt(input);
    let last = null;
    for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
      const content = await ask(prompt, D.DESCRIPTION_SCHEMA);
      last = { ...D.validateDescription(content, input), content, attempts: attempt };
      if (last.ok) return last;
      prompt = D.buildDescriptionRepairPrompt(input, content, last.errors);
    }
    return last;
  }

  return { MAX_REPAIRS, generateTitle, generateDescription };
});
