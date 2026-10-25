# allegro-listener
Wtyczka do wystawiania ofert na allegro

Skrypt Tampermonkey do szybkiego wystawiania ofert na Allegro (Sales Center).
Gemini rozpoznaje produkt, szuka słów kluczowych i pisze tytuł. Opis pisze Claude Opus (przez bramkę API)
albo – bez klucza Claude – Gemini. Wszystko według reguł z katalogu `rules/`.

## Instalacja

1. Zainstaluj rozszerzenie [Tampermonkey](https://www.tampermonkey.net/).
2. Otwórz plik [`dist/allegro-listener.user.js`](dist/allegro-listener.user.js) → **Raw** – Tampermonkey
   zaproponuje instalację. (Albo: Tampermonkey → „Utwórz nowy skrypt” → wklej zawartość pliku.)
3. Wejdź na `https://salescenter.allegro.com/offer…` – w prawym dolnym rogu pojawi się przycisk **✨ AI oferta**.
4. Zakładka **Ustawienia**: wklej klucz API Gemini (Google AI Studio → „Get API key”) i zapisz.
   Domyślny model to `gemini-3.8-flash`. Przycisk „Pobierz listę modeli” pokaże modele dostępne dla Twojego klucza.
   Klucz jest zapisywany tylko w Tampermonkey na Twoim komputerze.
5. Sekcja **Claude Opus – opis** (opcjonalnie):
   - wklej klucz API Claude (albo klucz bramki, np. vivo),
   - w „Adres bramki” wpisz adres bramki (np. `https://…/v1`); puste pole = bezpośrednio `https://api.anthropic.com`,
   - model domyślnie `claude-opus-5-5` („Pobierz modele Claude” pokaże modele dostępne w bramce),
   - „Logowanie do bramki” zostaw na AUTO – wtyczka sama sprawdzi, czy bramka chce `x-api-key`, czy `Authorization: Bearer`,
   - kliknij „Sprawdź połączenie z Claude”, potem **Zapisz**.
   Przy pierwszym połączeniu z bramką Tampermonkey zapyta o zgodę na nową domenę – wybierz „Zawsze zezwalaj”.
   Bramka musi przyjmować zapytania w formacie Anthropic Messages API (`/v1/messages`).

## Jak używać

Wystawienie oferty to kilka sekund pracy. Resztę robią modele AI:

- Gemini rozpoznaje produkt ze zdjęć, wyszukuje w Google słowa kluczowe i tytuły konkurencji, pisze tytuł,
- Claude Opus pisze opis na podstawie gotowego tytułu, słów kluczowych, danych produktu i zdjęć.
  Jeśli Claude nie odpowie (np. zły klucz albo bramka nie działa), opis napisze Gemini, a panel pokaże błąd.

Wtyczka sprawdza wynik i sama prosi o poprawki (maks. 2): tytuł poprawia Gemini, opis – model, który go napisał.

**Nowy produkt** (spoza katalogu):
1. Dodaj zdjęcie: kliknij, przeciągnij albo wklej Ctrl+V (max 4). Zdjęcia wgrane już do formularza
   Allegro wtyczka dołącza sama.
2. Wpisz nazwę produktu. Opcjonalnie dodaj informacje, których nie widać na zdjęciu
   (wymiary, wiek, zawartość).
3. **⚡ Generuj tytuł i opis**.

**Z katalogu:**
1. Wybierz produkt z katalogu w formularzu Allegro.
2. Otwórz panel. Nazwa, parametry i zdjęcia z formularza wczytają się same.
3. **⚡ Generuj tytuł i opis**.

**Wynik:**
- Tytuł: kliknij „Wstaw do formularza”.
- Opis: przy nagłówku „Opis” widać, który model go napisał. „Wstaw opis do formularza” podmienia opis
  w edytorze Allegro (np. opis z katalogu) na wygenerowany:
  sekcja 1 trafia do pierwszego pola tekstu, sekcja 2 do drugiego itd.; nadmiarowe sekcje trafiają do ostatniego
  pola, a nadmiarowe stare pola są czyszczone. Puste sekcje i stare zdjęcia usuwasz w edytorze Allegro.
  Jeśli wstawianie nie zadziała, opis zostaje skopiowany do schowka (Ctrl+V w edytorze), a w Ustawieniach
  „Skopiuj budowę edytora opisu” kopiuje strukturę edytora (bez treści) – do dopasowania wtyczki.
- Każda sekcja ma podpowiedź, jakie zdjęcie dać po lewej, i przyciski „Kopiuj sekcję” / „Kopiuj tekst”.
- Zmiana tytułu albo przełączników „Małe elementy” / „Produkt nowy” od razu przelicza opis, bez pytania AI.

W **Ustawieniach** można:
- wyłączyć wyszukiwanie w Google (szybciej, ale mniej dokładne słowa kluczowe),
- ustawić stały styl liter w tytule,
- wyłączyć Claude (opis pisze wtedy Gemini) albo zmienić staranność opisu (szybko / standard / dokładnie).

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
- `src/lib/claude.js` – klient Claude (Messages API przez bramkę albo api.anthropic.com, lista modeli)
- `src/lib/listing.js` – Gemini: produkt, frazy, tytuł → Claude: opis → walidacja → poprawki
- `src/userscript/main.js` – panel na stronie Sales Center
- `dist/allegro-listener.user.js` – plik generowany, nie edytuj ręcznie
