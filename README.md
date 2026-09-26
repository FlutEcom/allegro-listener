# allegro-listener
Wtyczka do wystawiania ofert na allegro

Skrypt Tampermonkey do szybkiego wystawiania ofert na Allegro. Tytuł i opis
generuje Gemini według reguł z katalogu `rules/`.

## Reguły

| Plik | Zakres | Kod (prompt + walidator) |
|------|--------|--------------------------|
| [`rules/01-tytul.md`](rules/01-tytul.md) | tytuł oferty | `src/rules/title.js` |

## Testy

```
npm test
```
