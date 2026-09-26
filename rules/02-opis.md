# Reguły opisu oferty Allegro – opis, który sprzedaje

Branża: **zabawki**. Opis ma sprzedawać, ale spokojnie: ciepło, prosto,
bez krzyku i presji.

Źródła prawdy:

- ten dokument – reguły dla ludzi,
- `src/rules/description.js` – prompt dla Gemini (`buildDescriptionPrompt`),
  składanie opisu (`buildDescription`) i walidator (`validateDescription`).

## Jak to działa

Gemini **nie pisze HTML-a ani układu**. Zwraca sam tekst w polach JSON
(hook, korzyści, pytania…). Wtyczka składa z tego opis według stałego
szablonu:

- stałe nagłówki,
- emoji,
- opcjonalny separator (domyślnie wyłączony),
- tytuł w H1,
- zdanie „Produkt nowy…”.

Dzięki temu:

- struktura jest zawsze taka sama – model nie może jej zepsuć,
- w tekście od Gemini nie ma znaczników `<h1>`, `<h2>`, `<br>`, `<b>` – model
  zaznacza tylko pogrubienie jako `**tekst**`,
- wtyczka zamienia to na format Allegro. Allegro dopuszcza tylko tagi `h1`,
  `h2`, `p`, `ul`, `ol`, `li` i `b`, a opis dzieli na sekcje: zdjęcie po lewej,
  tekst po prawej.

## 1. Język i czytelność

| Zasada | Szczegóły | Walidator |
|--------|-----------|-----------|
| Maksymalnie prosto | zrozumiałe dla 7-latka | – |
| Krótkie zdania | max **12 słów** | ostrzeżenie |
| Mobile first | akapit max **3–4 linijki** na telefonie (≈ 200 znaków) | ostrzeżenie |
| Brak żargonu | „Pancerne pudełko” zamiast „Wzmocniona konstrukcja” | ostrzeżenie + podpowiedź |
| Trudne pojęcia | jeśli trzeba użyć (Montessori, motoryka mała, sensoryczny) – **wyjaśnij** w sekcji „ℹ️” | ostrzeżenie, gdy brak wyjaśnienia |
| Tekst ≤ zdjęcie | tekst sekcji zajmuje najwyżej tyle miejsca co zdjęcie (≈ 600 znaków) | ostrzeżenie |
| Wyróżnianie | najważniejsze słowa **pogrubione**, emoji na początku linii | – |

## 2. Ton głosu

- ✅ Ciepły, przyjazny, rodzicielski.
- ✅ Buduje zaufanie i spokój.
- ✅ Trochę entuzjazmu, ale bez przesady.
- ❌ Żadnego krzyku, presji ani manipulacji:
  - bez „OSTATNIE SZTUKI!!!”, „Kup teraz, zanim zniknie” i „Tylko dziś”,
  - bez pisania CAPSLOCKIEM w treści (nagłówki mogą być wielkimi literami),
  - bez `!!`, `??`.

## 3. Czego nie wolno

| Zakaz | Dlaczego | Walidator |
|-------|----------|-----------|
| Porównania z konkurencją („lepszy od…”, „w przeciwieństwie do innych”, „najlepszy na rynku”, „nr 1”) | regulamin Allegro | błąd |
| Wymyślone fakty: certyfikaty, wymiary, wiek, liczba elementów, opinie klientów | nieuczciwa praktyka rynkowa | – (prompt: tylko dane produktu) |
| Wymyślony social proof („tysiące zadowolonych klientów”, „hit sprzedaży”) bez danych | j.w. | błąd, gdy nie podano `socialProof` |
| Presja czasu/ilości, jeśli sprzedawca jej nie podał (`promo`) | j.w. | błąd |
| Linki, e-maile, telefony | regulamin Allegro | błąd |
| Znaczniki HTML i Markdown (poza `**pogrubieniem**`) w tekście od Gemini | patrz „Jak to działa” | błąd |
| Emoji spoza listy dozwolonych | nie wyświetlają się na Allegro | błąd |

## 4. Dozwolone emoji

Tylko te emoji:

✨ ⭐ ✅ ✔️ ❤️ ℹ️ ➡️ ⚙️ ❓ ⬇️ ☺️ ⚡ ☘️ ❇️ ❄️ ☑️ ❗ ☀️ ☹️ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣

Pełna, przetestowana lista działających emoji jest na
<https://allemoji.pl/>. W razie potrzeby rozszerzamy `ALLOWED_EMOJI` w
`src/rules/description.js`.

Emoji wstawia głównie wtyczka, w stałych miejscach:

- nagłówki,
- początki linii z korzyściami,
- numeracja zawartości zestawu.

Gemini ma ich w tekście nie dodawać.

## 5. Wyróżniki (czytelny wygląd)

- **Nagłówki H2** – WIELKIMI LITERAMI, z jednym emoji na początku. Klienci
  skanują opis po nagłówkach, więc nagłówek mówi o **zalecie** produktu, a nie
  „Opis produktu”. Przykład: „✨ ROZWIJA WYOBRAŹNIĘ I SPRAWNE PALUSZKI”.
- **Separator** – na razie **wyłączony**. W razie potrzeby można włączyć
  linię `━━━━━━━━━━━━━━━━━━━━` pod każdym nagłówkiem H2
  (`separator: SEPARATOR_LINE`).
- **Rozstrzelony tekst** – tylko nagłówek specyfikacji: `⚙️ S P E C Y F I K A C J A`.
  Rozstrzelenie psuje wyszukiwanie słów, więc nie stosujemy go w innych
  nagłówkach.
- **Pogrubienie** – cecha w parze cecha → korzyść oraz słowa kluczowe.

## 6. Struktura opisu (sekcje)

Każda sekcja Allegro to **zdjęcie po lewej + tekst po prawej**. Wyjątek:
Q&A to sam tekst na całą szerokość. Jeśli zdjęć jest mniej niż sekcji, sekcje
bez zdjęcia są tylko tekstowe.

### SEKCJA 0 – HOOK (pierwsze 200 znaków – KRYTYCZNE!)

W aplikacji Allegro widać tylko początek opisu. Pierwsze **200 znaków**
(liczone razem z tytułem H1) musi zawierać:

- ✅ nazwę produktu + cechę główną,
- ✅ główną korzyść (1 zdanie),
- ✅ social proof – **tylko jeśli sprzedawca go podał** (np. „⭐ 4,9/5 – 1200 ocen”),
- ✅ zachętę do czytania dalej ze strzałką ⬇️.

```
H1: [WYBRANY TYTUŁ – dokładnie ten z kroku „tytuł”]
[Nazwa produktu] [liczba elementów / cecha główna]
[Główna korzyść – 1 zdanie]. [Zachęta do czytania] ⬇️
```

Przykład:

> **ZESTAW DO BRANSOLETEK 500 ELEMENTÓW KORALIKI DLA DZIECI 6+ KREATYWNE HOBBY**
> Zestaw do bransoletek 500 elementów.
> Twoje dziecko stworzy nawet 50 unikalnych ozdób. Sprawdź, co jest w środku ⬇️

- **Powtórzenie tytułu:** algorytm Allegro sprawdza zgodność oferty w
  tytule, parametrach i opisie. Dlatego H1 to dokładnie tytuł oferty.
- **Promocja:** działa na emocje, ale tylko prawdziwa. Wtyczka wstawia ją
  dosłownie z pola `promo`, pod hookiem, z ❗. Przykłady:
  - limit czasowy lub ilościowy,
  - cena przedsezonowa,
  - „dla pierwszych X osób”.

  Gemini nigdy sam nie wymyśla promocji ani terminów.

### SEKCJA 1 – TOP 3 KORZYŚCI (w tym samym bloku co hook)

Pod hookiem 2–3 najważniejsze korzyści. Klient od razu widzi, co zyska.

```
✅ Godziny twórczej zabawy bez ekranu
✅ Dziecko samo tworzy prezenty dla bliskich
✅ Wszystko w mocnym pudełku z przegródkami
```

### SEKCJA 2 – ⭐ CO ZYSKUJESZ? (INTEREST)

Lista 4–6 korzyści. Schemat: **Cecha (pogrubiona)** ➡️ korzyść. Emocja.

- Korzyści dla **rodzica**: „Spokojna kawa”, „Zero zmartwień”.
- Korzyści dla **dziecka**: „Duma z osiągnięcia”.

| Cecha | Korzyść | Emocja |
|-------|---------|--------|
| Pancerne pudełko | Wytrzyma lata zabawy | Nie musisz dokupować |
| 500 elementów | Godziny kreatywności | Ty masz czas na kawę |
| Instrukcja krok po kroku | Dziecko radzi sobie samo | Buduje pewność siebie |
| Certyfikat CE* | Bezpieczne materiały | Zero zmartwień |
| Piękne opakowanie | Gotowe do wręczenia | Nie musisz pakować |
| Wielokrotnego użytku | Zabawa trwa miesiącami | Jedna zabawka, niezliczone chwile radości |

\* tylko jeśli jest w danych produktu.

Linia w opisie:
`✔️ **Pancerne pudełko** ➡️ wytrzyma lata zabawy. Nie musisz dokupować.`

### SEKCJA 3 – ✨ ZABAWA I ROZWÓJ (DESIRE)

- Nagłówek pisze Gemini – zaleta produktu, np. „✨ ROZWIJA WYOBRAŹNIĘ I
  SPRAWNE PALUSZKI”.
- Treść: jak wygląda zabawa, co dziecko ćwiczy, efekt przed → po. 1–3 krótkie
  akapity.
- Pod spodem, jeśli potrzeba, wyjaśnienia trudnych pojęć:
  `ℹ️ **Motoryka mała** – to sprawne paluszki: chwytanie, nawlekanie, rysowanie.`

### SEKCJA 4 – ☑️ CO JEST W ZESTAWIE?

- Nagłówek pisze Gemini, np. „☑️ 500 KORALIKÓW I WSZYSTKO, CZEGO POTRZEBA”.
- Zawartość: do 5 pozycji z numerami 1️⃣–5️⃣, powyżej 5 pozycji z ☑️.
- **Pokazanie wielkości:** jedno zdanie o rozmiarze w odniesieniu do dziecka
  (np. „Miś jest wysoki jak 3-latek”) – tylko jeśli znamy wymiary.

### SEKCJA 5 – ❄️ / ❤️ IDEALNY PREZENT

- Nagłówek pisze Gemini, np. „❄️ GOTOWY PREZENT POD CHOINKĘ”.
- Okazje dobierane automatycznie wg daty wystawienia (można nadpisać polem
  `occasions`):

| Okres | Okazje | Emoji |
|-------|--------|-------|
| 1 wrz – 24 gru | Boże Narodzenie (pod choinkę), Mikołajki (do 6 gru), urodziny | ❄️ |
| 25 gru – 31 sty | urodziny, imieniny, nagroda bez okazji | ❤️ |
| lut – mar | Wielkanoc (prezent od zajączka), urodziny | ❤️ |
| kwi – 1 cze | Dzień Dziecka, Komunia, urodziny | ❤️ |
| 2 cze – 31 sie | urodziny, prezent na wakacje | ☀️ |

Okno świąteczne startuje we wrześniu, bo oferta wystawiona teraz będzie
aktywna w sezonie prezentowym.

### SEKCJA 6 – ⚙️ S P E C Y F I K A C J A

- Parametry `**Nazwa:** wartość`. Pierwszeństwo mają parametry z formularza
  lub od sprzedawcy. Gemini może je uzupełnić **tylko** faktami z danych.
- Jeśli produkt ma małe elementy (`smallParts: true`), wtyczka dodaje
  ostrzeżenie:
  `❗ Nieodpowiednie dla dzieci w wieku poniżej 36 miesięcy. Zawiera małe elementy.`
- **Rozwiewanie wątpliwości:** na końcu, dla stanu „Nowy”, zawsze pojawia się
  zdanie:
  `✅ Produkt nowy, nieużywany, fabrycznie zapakowany.`

### SEKCJA 7 – ❓ PYTANIA I ODPOWIEDZI (Q&A – zawsze na końcu)

- 3–5 pytań, które rodzice naprawdę zadają. Przykłady:
  - Od ilu lat?
  - Czy potrzebne są baterie?
  - Czy nada się na prezent?
  - Jak przechowywać?
  - Czy jest bezpieczne?
- Odpowiedzi są krótkie i oparte tylko na danych. Jeśli nie znamy odpowiedzi,
  nie zadajemy pytania.
- Na koniec opcjonalnie jedno ciepłe zdanie zamykające, bez presji.

## 7. Zdjęcia (wskazówki dla sprzedawcy)

Gemini pisze tekst, zdjęcia dobiera sprzedawca. Wtyczka podpowiada, jakie
zdjęcie pasuje do której sekcji.

| Sekcja | Zdjęcie | Reguła |
|--------|---------|--------|
| 0 Hook | zdjęcie główne – cały zestaw / opakowanie | – |
| 2 Co zyskujesz | produkt **w użyciu** – dziecko podczas zabawy | pokazanie w użyciu |
| 3 Zabawa i rozwój | efekt **przed i po** (np. gotowa budowla) | przed/po |
| 4 W zestawie | wszystkie elementy rozłożone obok siebie | wiele perspektyw |
| 5 Prezent | produkt jako prezent – pod choinką, w ozdobnym opakowaniu | – |
| 6 Specyfikacja | produkt **obok dziecka lub w dłoni** + wymiary | pokazanie wielkości |

- Każda sekcja ma **inne ujęcie** – pokaż produkt tak, jak sam chciałbyś go
  zobaczyć.
- Nie powtarzaj tego samego zdjęcia.

## 8. SEO w opisie

- Tytuł jest w H1 (patrz sekcja 0).
- Druga fraza kluczowa (KEYWORD 2) pojawia się naturalnie w hooku lub w
  nagłówku.
- **Bez keyword stuffingu:** najważniejsza fraza najwyżej 4 razy w całym
  opisie (ostrzeżenie).

## 9. Checklista walidatora

| # | Reguła | Poziom |
|---|--------|--------|
| 1 | H1 = tytuł oferty, tylko jeden H1 | wymuszane przez szablon |
| 2 | hook: ⬇️ i nazwa produktu w pierwszych 200 znakach | błąd |
| 3 | 2–3 TOP korzyści, 4–6 korzyści w „Co zyskujesz?”, 3–5 pytań Q&A | błąd |
| 4 | brak HTML/Markdown w tekście od Gemini (poza `**…**`) | błąd |
| 5 | tylko dozwolone emoji | błąd |
| 6 | brak porównań z konkurencją, presji, wymyślonego social proof, linków i kontaktów | błąd |
| 7 | „Produkt nowy, nieużywany, fabrycznie zapakowany.” dla stanu Nowy | wymuszane przez szablon |
| 8 | zdania ≤ 12 słów, akapity ≤ 200 znaków, sekcja ≤ 600 znaków | ostrzeżenie |
| 9 | żargon i niewyjaśnione trudne pojęcia | ostrzeżenie |
| 10 | CAPSLOCK w treści, `!!`, fraza główna > 4 razy | błąd / ostrzeżenie |

Gdy są błędy, wtyczka odsyła je do Gemini z prośbą o poprawkę (maks. 2
próby), tak samo jak przy tytule.
