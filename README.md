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
   Domyślny model to `gemini-3.8-flash`. Przycisk „Pobierz listę modeli” pokaże modele dostępne dla Twojego klucza.
   Klucz jest zapisywany tylko w Tampermonkey na Twoim komputerze.

## Jak używać

Wystawienie oferty to kilka sekund pracy. Resztę robi Gemini:

- rozpoznaje produkt ze zdjęć,
- wyszukuje w Google słowa kluczowe i tytuły konkurencji,
- pisze tytuł i opis według reguł.

Wtyczka sprawdza wynik i sama prosi Gemini o poprawki (maks. 2).

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
- Opis: „Kopiuj cały opis” albo „Kopiuj sekcję”, do wklejenia w edytor opisu Allegro. Każda sekcja ma
  podpowiedź, jakie zdjęcie dać po lewej.
- Zmiana tytułu albo przełączników „Małe elementy” / „Produkt nowy” od razu przelicza opis, bez pytania Gemini.

W **Ustawieniach** można:
- wyłączyć wyszukiwanie w Google (szybciej, ale mniej dokładne słowa kluczowe),
- ustawić stały styl liter w tytule.

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
- `src/lib/listing.js` – jedno zapytanie „wszystko w jednym” → walidacja → poprawki
- `src/userscript/main.js` – panel na stronie Sales Center
- `dist/allegro-listener.user.js` – plik generowany, nie edytuj ręcznie
