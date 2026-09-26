# allegro-listener
Wtyczka do wystawiania ofert na allegro

Skrypt Tampermonkey do szybkiego wystawiania ofert na Allegro. Tytuł i opis
generuje Gemini według reguł z katalogu `rules/`.

## Reguły

| Plik | Zakres | Kod (prompt + walidator) |
|------|--------|--------------------------|
| [`rules/01-tytul.md`](rules/01-tytul.md) | tytuł oferty | `src/rules/title.js` |
| [`rules/02-opis.md`](rules/02-opis.md) | opis oferty (branża zabawkowa) | `src/rules/description.js` |

## Testy

```
npm test
```
