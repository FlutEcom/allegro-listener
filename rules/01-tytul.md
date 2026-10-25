# Reguły tytułu oferty Allegro

Tytuł to najważniejszy element oferty – od niego zależy, czy oferta w ogóle
pojawi się w wynikach wyszukiwania. Poniższe reguły są źródłem prawdy dla
promptu Gemini (`src/rules/title.js` → `buildTitlePrompt`) oraz dla walidatora,
który sprawdza każdy wygenerowany tytuł przed wstawieniem go do formularza
(`validateTitle`).

## 1. Długość – wykorzystaj wszystkie znaki

| Parametr          | Wartość |
|-------------------|---------|
| Limit Allegro     | 75 znaków |
| Cel               | **70–75 znaków** |
| Poniżej 70 znaków | tytuł odrzucony – dopisz kolejną cechę lub korzyść |
| Powyżej 75 znaków | tytuł odrzucony – Allegro go nie przyjmie |

- Liczą się wszystkie znaki, łącznie ze spacjami. Polskie znaki (ą, ę, ś…) to 1 znak.
- Nie używamy znaków `&`, `<`, `>`, `"` – Allegro liczy je jako encje HTML
  (np. `&` = 5 znaków), co psuje limit. Zamiast `&` piszemy `I`.

## 2. Początek tytułu – najważniejsza fraza

- Tytuł **zaczyna się od frazy, którą klienci najczęściej wpisują w
  wyszukiwarkę** – zwykle nazwa produktu + wyróżniająca go cecha lub korzyść.
- Najpopularniejsze słowo kluczowe jest **pierwszym słowem** tytułu.
- Popularność fraz sprawdza **Gemini z wyszukiwarką Google**: porównuje warianty
  w Google Trends (np. „klocki konstrukcyjne” vs „klocki dla dzieci”), podpowiedzi
  wyszukiwania i oferty na allegro.pl. Zwraca 5–8 fraz od najpopularniejszej;
  pierwsza to TOP KEYWORD. Panel pokazuje, czego Gemini szukał, więc można to
  sprawdzić. Wyszukiwanie można wyłączyć w ustawieniach (szybciej, ale frazy
  pochodzą wtedy tylko z wiedzy modelu).

## 3. Struktura

```
[TOP KEYWORD] + [KEYWORD 2] + [WIEK] + [CECHA] + [KORZYŚĆ]
```

| Element         | Opis | Przykład |
|-----------------|------|----------|
| TOP KEYWORD     | najczęściej wyszukiwana fraza (nazwa produktu) | KLOCKI MAGNETYCZNE |
| KEYWORD 2       | druga fraza / synonim, **inny** niż pierwszy | KONSTRUKCYJNE |
| WIEK            | przedział wiekowy – tylko gdy ma sens (zabawki, odzież dziecięca) | 3+ |
| CECHA           | konkretny parametr: ilość, rozmiar, materiał, model | 100 ELEMENTÓW |
| KORZYŚĆ         | co klient zyskuje | ROZWIJAJĄ WYOBRAŹNIĘ |

Przykład (73 znaki):
`KLOCKI MAGNETYCZNE KONSTRUKCYJNE 3+ 100 ELEMENTÓW ZESTAW ROZWIJAJĄCY XXL`

- Jeśli produkt nie ma sensownego wieku – pomijamy `[WIEK]` i wydłużamy
  `[CECHA]`/`[KORZYŚĆ]`.
- Marka i model – gdy klienci ich szukają (np. `LEGO`, `iPhone 15`), trafiają
  do `[TOP KEYWORD]`. Nie używamy cudzych marek, których produkt nie jest
  (zakaz „typu X”, „jak X”, „a'la X”).

## 4. Wielkość liter

- Styl dobieramy do **TOP 10 konkurencji** dla głównej frazy i naśladujemy go:
  - `UPPER` – CAPSLOCK: `KLOCKI MAGNETYCZNE 3+`
  - `TITLE` – Pierwsze Litery Wielkie: `Klocki Magnetyczne 3+`
- Tryb `AUTO` (domyślny): jeśli ≥ 50% tytułów konkurencji jest pisanych
  CAPSLOCKIEM → `UPPER`, w przeciwnym razie → `TITLE`.
  Brak danych o konkurencji → `UPPER`.
- Tytuły konkurencji wyszukuje Gemini (do 10). Gdy znajdzie co najmniej 3,
  styl liczy walidator; w przeciwnym razie przyjmujemy styl wskazany przez
  Gemini. Styl można też ustawić na stałe w ustawieniach wtyczki.
- Oznaczenia modeli/jednostek zachowują swój zapis w trybie `TITLE`
  (`USB-C`, `LED`, `XXL`, `cm`, `ml`).

## 5. Zabronione słowa i znaki

Regulamin Allegro zabrania w tytule informacji niezwiązanych z opisem
produktu. Walidator odrzuca tytuł, który zawiera:

- **słowa promocyjne**: HIT, PROMOCJA, PROMO, OKAZJA, OKAZYJNIE, WYPRZEDAŻ,
  SALE, SUPER CENA, NAJTANIEJ, NAJTAŃSZY, TANIO, TANI, RABAT, ZNIŻKA, GRATIS,
  BESTSELLER, NOWOŚĆ, WOW, NAJLEPSZY, LIKWIDACJA, OFERTA;
- **informacje o dostawie i sprzedaży**: WYSYŁKA, DOSTAWA, DARMOWA, 24H,
  FAKTURA, FV, VAT, KURIER, PACZKOMAT, ODBIÓR OSOBISTY, SKLEP, ALLEGRO
  (też „Allegro Smart”), SPRZEDAM;
- **dane kontaktowe i linki**: adresy WWW, e-maile, numery telefonów;
- **porównania z cudzymi markami**: TYPU, A'LA, PODOBNY DO, ZAMIAST;
- **znaki specjalne i ozdobniki**: `!`, `?`, `*`, `#`, `@`, `$`, `%`, `~`,
  `|`, `_`, emoji, powtórzone znaki (`!!!`, `---`), `&`, `<`, `>`, `"`.

Pełna lista jest w `src/rules/title.js` (`FORBIDDEN_WORDS`,
`FORBIDDEN_PATTERNS`) i można ją rozszerzać. Gdy zakazane słowo jest częścią
nazwy produktu lub marki (np. „Hit” w nazwie serii), przekazujemy je w
`allowWords`, a walidator je przepuści.

Celowo **nie** blokujemy słów, które bywają częścią nazw produktów:
SMART (Smart TV), TOP (crop top), SUPER/MEGA (Super Mario, Mega Bloks),
JAK (stan „jak nowy”).

## 6. Zakaz keyword stuffingu (Allegro karze!)

Allegro obniża pozycję ofert „upchanych” słowami kluczowymi. Dlatego:

- **każde słowo znaczące występuje w tytule tylko raz** – identyczne
  powtórzenie to błąd; to samo słowo w innej odmianie (`KLOCKI` i `KLOCKÓW`)
  to ostrzeżenie (wykrywane po wspólnym rdzeniu, więc możliwe fałszywe alarmy);
- nie wymieniamy po przecinku listy synonimów
  (❌ `KLOCKI, ZABAWKA, ZESTAW, GRA, PREZENT…`) – maksymalnie 2 separatory
  (`,`, `/`, `-` oddzielone spacjami) w tytule;
- nie wpisujemy słów niezwiązanych z produktem tylko dlatego, że są popularne;
- tytuł ma się dać przeczytać jak nazwa produktu, nie jak lista tagów.

## 7. Checklista (walidator)

| # | Reguła | Poziom |
|---|--------|--------|
| 1 | długość 70–75 znaków | błąd |
| 2 | pierwsza fraza = TOP KEYWORD | błąd |
| 3 | brak słów/znaków zabronionych | błąd |
| 4 | brak powtórzeń słów (keyword stuffing) | błąd (odmiana – ostrzeżenie) |
| 5 | wielkość liter zgodna z wybranym stylem | poprawiane automatycznie |
| 6 | ≤ 2 separatory | ostrzeżenie |
| 7 | brak podwójnych spacji, spacji na początku/końcu | poprawiane automatycznie |

Gemini generuje kilka propozycji tytułu. Wtyczka wybiera pierwszą, która
przechodzi walidację; jeśli żadna nie przechodzi – wysyła do Gemini listę
błędów i prosi o poprawkę (maks. 2 próby).
