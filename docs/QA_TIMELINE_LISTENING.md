# Lyttetest for tidslinjen (v0.3, S7)

Praktisk sjekkliste for å kjøre en ekte synkronisering på ekte opptak — gudstjeneste eller
konsert, flere kameraer + lydopptaker/mikser — og avgjøre om det som vises og det som
høres faktisk stemmer. Bygget for å kjøres litt sliten en sen kveld: korte steg, ett
tydelig **BESTÅTT/IKKE BESTÅTT** hvert sted, ingen gjetting om hva som er en feil.

**Bruk ekte opptak**, ikke testfiksturer — f.eks. en av mappene under
`/Volumes/home/Photos/02 PROSJEKTER/…` eller `/Volumes/FOSSLAND MEDIA/…`. Flere kameraer
+ én lyd-/mikserkilde er den viktigste kombinasjonen; en konsert med hard/tett lyd og en
gudstjeneste med tale er fint å ha begge deler av.

## 0. Klargjøring

1. Slipp inn hele opptaksmappen (**Velg mappe**), la den skanne, trykk **Synkroniser**.
2. Vent til resultatvisningen (tidslinjen) kommer opp. Hvis synkroniseringen feiler eller
   henger — det er ikke denne testens skyld, men noter det under §7 og stopp der.

## 1. Ser klippene synkroniserte ut?

1. Zoom helt inn (`+`-tasten, eller Ctrl/Cmd+scroll) på et sted der to eller flere spor
   overlapper i tid. `0` eller `F` tilpasser tidslinjen til vinduet igjen når du vil ut.
2. Se på bølgeformene side ved side. Tydelige transienter — en klapp, en trommeslag, en
   konsonant — skal treffe på **samme x-posisjon** på tvers av sporene, til under en
   pikselbredde ved makszoom.
3. **Viktig, IKKE en feil:** en bølgeform som slutter litt før klippboksens høyre kant er
   riktig oppførsel (v0.3-fiksen — se D-056). Boksen tegnes etter filens *container*-
   varighet (det ffprobe sier), men bølgeformen tegnes etter hvor mye lyd som faktisk ble
   dekodet — de to tallene er ikke alltid like (AAC-encoder-priming, avrundede
   containervarigheter, lyd som rett og slett slutter før bildet). Et par hundre
   millisekunder utmalt hale er normalt, spesielt på lange klipp. **Feil** er hvis
   bølgeformen ser *strukket* eller *forskjøvet* ut i midten av klippet, ikke bare kuttet i
   halen.
4. **BESTÅTT:** transienter treffer visuelt på tvers av spor ved høy zoom, og eventuelle
   uferdige haler er bare i klippets siste del. **IKKE BESTÅTT:** synlig forskyvning
   midt i klippet, eller transienter som tydelig ikke treffer noe sted du zoomer inn.

## 2. Selve lyttetesten

Dette er den viktigste testen i hele lista — bildet kan lyve, øret gjør det sjeldnere.

1. Finn et sted der to spor overlapper (fra §1 er du sannsynligvis der allerede).
2. Trykk **Play** (transportfeltet nederst). Lytt på **tre punkter** i overlappen:
   start, midt i, og slutt.
3. **Husk før du dømmer noe som galt:** lyden du hører er bevisst **12 kHz
   analyselyd** («Lyd for kontroll av synk» står rett ved siden av avspillingsknappen) —
   samme lyd motoren selv lyttet på for å synkronisere. Den er grum og lo-fi med vilje.
   Det er ikke en eksportfeil; det er poenget.
4. **BESTÅTT — mild kam-/kor-farging:** to nesten-identiske kilder som summeres høres ut
   som en hul, litt «svevende» eller fase-aktig dobling (kamfiltrering — frekvenser
   forsterker og kansellerer hverandre på tvers av spekteret). Dette er riktig, og er selve
   beviset på at synken stemmer.
5. **IKKE BESTÅTT — en tydelig EKKO:** hvis du kan skille de to lydene som to separate
   hendelser (mer enn ca. 20 ms fra hverandre — «dobbelt-anslag», ikke «hul lyd»), er det
   en reell feil. **Stopp og rapporter** (§7) — ikke fortsett til neste steg på det samme
   klippet.
6. Gjenta på minst to overlapp-punkter til (ulike enheter/klippar) før du går videre.

## 3. Drift

1. Åpne et langt klipp sin detaljboks (klikk på klippet). Se etter feltet **Drift** — et
   tall i ppm. Klipp med `null`/ingen drift-verdi er ikke aktuelle her; finn et som har en
   ekte verdi (helst et som varer lenge — jo lengre klipp, jo mer hører du effekten).
2. Gå til **Innstillinger → «Driftkorreksjon ved avspilling»**. Spol til **slutten** av
   det lange, driftende klippet (piltast **→**, hold **Shift** for 10 sekunder om gangen,
   eller **End** for å hoppe til slutten av hele resultatet) og lytt der — drift er nesten
   usynlig i starten og størst mot slutten, det er poenget med å måle det. Slå bryteren
   AV → PÅ og lytt på nytt på nøyaktig samme sted (bryteren virker med det samme, også
   midt i avspilling — ingen restart nødvendig).
3. **BESTÅTT:** med korrigering PÅ er lyden stram/synkron helt til slutten av klippet,
   samme kvalitet som i §2. Med korrigering AV hører du sporene tydelig **gli fra
   hverandre** mot slutten — først kam-farging, så en økende, hørbar forskyvning.
   **IKKE BESTÅTT:** korrigert avspilling er fortsatt hørbart ute av synk mot slutten, eller
   det er ingen hørbar forskjell mellom PÅ og AV i det hele tatt på et klipp med tydelig
   ppm-verdi.

> **Snarveier som gjør dette raskere:** `Mellomrom` spiller av/pauser, piltastene ±1 s
> (Shift ±10 s), `Home`/`End` hopper til start/slutt av resultatet, `0` eller `F` tilpasser
> tidslinjen til vinduet igjen. Alle virker uten å måtte klikke i selve tidslinjen først —
> bare unngå å ha fokus i et tekstfelt eller på volumknappen når du trykker dem.

## 4. Demp/solo

1. På et resultat med flere enheter: trykk **M** (demp) på én sporrad. Spill av.
2. **BESTÅTT:** den dempede enheten er helt stille, resten spiller som normalt.
3. Slå av demping igjen. Trykk **S** (solo) på én enhet mens en ANNEN er dempet.
4. **BESTÅTT — demping vinner over solo:** den dempede enheten skal forbli stille selv om
   den ikke er den soloerte. Solo bestemmer kun blant enheter som *ikke* er dempet.
5. Slå av alt igjen; bekreft at alle enheter høres som normalt.

## 5. Tøm analyse-bufferen midt i økta

1. Med resultatvisningen fortsatt åpen (bølgeformer tegnet, kanskje under avspilling):
   gå til **Innstillinger → Tøm buffer**, bekreft.
2. Klipp som *allerede* er tegnet, endrer seg normalt **ikke** med det samme — det er
   forventet, ikke en feil (grensesnittet re-henter ikke det som allerede er lastet, bare
   fordi disken ble tømt). For å faktisk teste dette: **zoom** til et nytt nivå, eller
   **panorer** til et klipp som ikke har blitt vist ennå — noe grensesnittet MÅ hente på
   nytt fra disk.
3. **BESTÅTT:** det ferske forsøket på å hente en bølgeform viser i stedet knappen «Bygg
   bølgeform på nytt», ikke et krasj, ikke en evig spinner. Trykk knappen →
   bølgeformen kommer tilbake.
4. Fortsett avspilling av lyd som allerede var lastet inn: **BESTÅTT** hvis den bare
   fortsetter å spille (evt. til den når et sted som ikke var bufret — da skal KLIPPET
   (ikke appen) markeres utilgjengelig i transportfeltet, aldri en krasjet app).
   **IKKE BESTÅTT:** appen fryser, krasjer, eller spinner uendelig noe sted i dette steget.

## 6. Eksport → Resolve

1. Trykk **Eksporter til DaVinci Resolve**, lagre FCPXML-en.
2. **Viktig importrekkefølge (v0.3):** dra mediefilene inn i Resolves **Media Pool**
   FØRST. Bruk deretter **Fil → Importer → Tidslinje** for å hente FCPXML-fila.
   Load XML-matcheren i Resolve feiler på store filer hvis du importerer tidslinjen
   FØR mediet er i mediemappen — rekkefølgen er ikke valgfri.
3. I Resolve: se/hør de samme punktene du sjekket i §1–§3 (samme overlapp, samme drift-
   klipp om det er korrigert).
4. **BESTÅTT:** det du hørte/så i appen stemmer med det du hører/ser i Resolve — ingen
   nye forskyvninger, ingen klipp som mangler. **IKKE BESTÅTT:** Resolve viser noe synlig
   annerledes enn appens tidslinje, eller import-matchingen feiler selv med riktig
   rekkefølge.

## 7. Hva jeg trenger fra deg ved IKKE BESTÅTT

For hvert steg som feiler, ta med:

- **Hvilket steg** (§-nummer og linje, f.eks. «§2, punkt 5 — ekko»).
- **Hva du hørte/så**, med tidspunkt i tidslinjen om relevant (f.eks. «ekko rundt 00:14:20,
  spor Kamera B mot lydopptaker»).
- **Hvilke filer** — enhetsnavn og filnavn fra klippdetaljen holder, du trenger ikke lete
  fram hele stien.
- **Skjermbilde** for alt visuelt (§1, feilplassering, Resolve-avvik) — lyd trenger ikke
  et bilde, bare tidspunktet og hva som var galt.
- Om appen krasjet eller hang: hva du gjorde rett før (steg, knapp, evt. hvor lenge den
  hang før du ga opp).
