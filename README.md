# allegro-listener
Wtyczka do wystawiania ofert na allegro

Skrypt Tampermonkey do szybkiego wystawiania ofert na Allegro (Sales Center).
Tytuł i opis generuje Gemini według reguł z katalogu `rules/`.

## Instalacja

1. Zainstaluj rozszerzenie [Tampermonkey](https://www.tampermonkey.net/).
2. Otwórz plik [`dist/allegro-listener.user.js`](dist/allegro-listener.user.js) → **Raw** – Tampermonkey
   zaproponuje instalację. (Albo: Tampermonkey → „Utwórz nowy skrypt” → wklej zawartość pliku.)
3. Wejdź na `https://salescenter.allegro.com/offer…` – w prawym dolnym rogu pojawi się przycisk **✨ AI oferta**.
4. Zakładka **Ustawienia**: wklej klucz API Gemini (Google AI Studio → „Get API key”) i zapisz.
   Domyślny model to `gemini-3.8-flash`; przycisk „Pobierz listę modeli” pokaże modele dostępne dla Twojego klucza.
   Klucz jest zapisywany tylko w Tampermonkey na Twoim komputerze.

## Jak używać

1. **Dane** – „Pobierz z formularza” zbiera nazwę i parametry z formularza Allegro. Uzupełnij resztę:
   frazy kluczowe (od najpopularniejszej – Google Trends), cechy, korzyści, zawartość zestawu,
   tytuły TOP 10 konkurencji (do wyboru stylu liter), prawdziwy social proof i promocję.
   Dane zapisują się automatycznie.
2. **Tytuł** – „Generuj tytuł”: Gemini daje kilka propozycji, walidator wybiera najlepszą (70–75 znaków,
   bez zakazanych słów). Możesz ją poprawić ręcznie i kliknąć „Wstaw do formularza”.
3. **Opis** – „Generuj opis”: sekcje w kolejności z `rules/02-opis.md`, z podpowiedzią, jakie zdjęcie
   dać po lewej. „Kopiuj sekcję” kopiuje sformatowany tekst do wklejenia w edytor opisu Allegro.

Jeśli Gemini zwróci tekst łamiący reguły, wtyczka sama odsyła mu listę błędów (maks. 2 poprawki).

## Reguły

| Plik | Zakres | Kod (prompt + walidator) |
|------|--------|--------------------------|
| [`rules/01-tytul.md`](rules/01-tytul.md) | tytuł oferty | `src/rules/title.js` |
| [`rules/02-opis.md`](rules/02-opis.md) | opis oferty (branża zabawkowa) | `src/rules/description.js` |

## Rozwój

```
npm run build   # składa dist/allegro-listener.user.js z src/
npm test        # build + testy
```

- `src/lib/gemini.js` – klient Gemini API (generateContent, lista modeli)
- `src/lib/pipeline.js` – prompt → Gemini → walidacja → poprawka
- `src/userscript/main.js` – panel na stronie Sales Center
- `dist/allegro-listener.user.js` – plik generowany, nie edytuj ręcznie
