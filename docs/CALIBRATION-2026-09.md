# Kalibrering mot ekte produksjoner — september 2026

Runde K. Spørsmålet er det D-015 har latt stå åpent: **PSR-golvet er kalibrert mot syntetisk
materiale, og barene bygget oppå det (D-045, D-049) er utledet fra fire små korpus og ett
bryllup.** Holder de mot en bredere spredning av ekte produksjoner?

Kortversjonen: **vernene holder — golvet gjør det trolig ikke.**

D-045s troverdighetsport avviste ekte redigerte filmer riktig, tre ganger på rad med tre ulike
referanser, og drepte i den runden et treff på **PSR 131,39** som et hvilket som helst PSR-golv
ville plassert grovt feil (§5). Det er tesen bak D-045 bevist med det sterkeste tallet i korpuset.

Men den strenge baren for korte klipp står nesten helt sikkert for høyt, og hele D-049s
bevisgraderte vei er strukturelt utilgjengelig for materialet et bryllup består av (§4).
Ingen terskel er rørt — det er eierklasse — men §4 sier med tall hva som bør måles først.

## 1. Disiplin og metode

NAS-en (`/Volumes/Delt Fossland/`) er behandlet som **strengt lesebeskyttet**: ingen fil er
skrevet, flyttet eller omdøpt der. Analysehurtigbufferen lå på en eksplisitt lokal sti
(`--cache-dir` under `/private/tmp/…`), verifisert til `/dev/disk3s1` og ikke til
monteringspunktet før første kjøring. Ett prosjekt om gangen.

Kommandoen er i alle tilfeller `sundaysync sync --cache-dir <lokal> -v <mapper>`. Rådumpene
ligger under `calibration/<prosjekt>/`; `calibration/report.py` leser dem og skriver tabellene
under. Den er et leseverktøy ved siden av dataene, ikke en del av produktet.

Omfanget per prosjekt er valgt for å reprodusere forrige runde nøyaktig, så tallene er
sammenlignbare. For `LINNEA&SIGURD` er det bryllupsdagens mapper (`01_FILM/DRONE`,
`01_FILM/FUJI/XT4`, `01_FILM/JOHNNY BRYLLUP`, `01_FILM/STEINAR`, `02_LYD`) — 180 filer, ikke
hele prosjektmappa på 1 028.

## 2. Funnet som måtte fikses før spørsmålet kunne besvares

Oppdraget ba om PSR-fordelinga for **både** plasserte og avviste klipp. Den for avviste fantes
ikke. `Unsynced` bar en sti og ett ord:

```json
{ "file": ".../02106.MTS", "reason": "low_confidence" }
```

På grunnlinja dekket det ordet 166 av 180 filer. Ingenting skilte «urelatert materiale» fra
«bommet på baren med 0,4». Man kan ikke avgjøre om en terskel er riktig uten å se fordelinga av
det den avviste — så dette var ikke bare et produktavvik, det var *blokkeringa for runden selv*.

`Unsynced.evidence` bærer nå `psr`, `offset_seconds`, `segments` og `required_psr` — baren
treffet faktisk ble holdt til. Se D-098. Alt i §4 under er utledet **uten** det feltet, fra
det som allerede lot seg lese; feltet er det som gjør neste runde kort.

## 3. Prosjektene

| Prosjekt | Filer | Plassert | Avvist (grunn) | PSR plassert | PSR avvist (min/median/maks) | Drift målt | Kald / varm |
|---|---|---|---|---|---|---|---|
| `LINNEA&SIGURD` (bryllup, flerkamera) | 180 | **8** | 166 `low_confidence`, 5 `no_audio`, 1 `device_overlap` | 25,33 / 30,25 / 82,77 | *ikke målt — se §7* | **0 av 8** | 2 462 s / — |
| `Johnny Hansen/Marie og Fredrik` (arkiv av ferdige klipp) | 10 | 1 (kun referansen) | 8 `low_confidence`, 1 `decode_error` (en PDF) | — | **8,16 / 9,62 / 131,39** | 0 | 624 s / 212 s |
| ↳ samme, `--reference` = kirkedelen | 10 | 1 (kun referansen) | 8 `low_confidence`, 1 `decode_error` | — | *før fiksen* | 0 | varm |
| ↳ samme, `--reference` = 40-minutteren | 10 | 1 (kun referansen) | 8 `low_confidence`, 1 `decode_error` | — | *før fiksen* | 0 | varm |
| `LINDLAND 2016` (dronemateriale) | 7 | 0 | 7 `no_audio` | — | — (nådde aldri korrelatoren) | — | 8 s |

`LINDLAND 2016` er verdt å lese som det den er: sju stille dronefiler, og motoren sier ærlig at
det ikke finnes lyd å korrelere på. Ingen `evidence` følger med, og det er riktig — fila nådde
aldri korrelatoren.

Fordelinga av **avviste** for redigeringsarkivet, som er den §2 gjorde mulig å lese i det hele
tatt:

| Fil | PSR | Krevd bar | Segmenter | Ville plassert på |
|---|---|---|---|---|
| `Marie og Fredrik 40 minutt.mp4` | **131,39** | *ingen — klokka* | 5 | 3 645,200 s |
| `Marie og Fredrik 40m 30s.mp4` | 11,07 | *ingen — klokka* | 5 | 3 645,200 s |
| `Marie og Fredrik Bryllupsfest 1 av 3.mp4` | 9,51 | *ingen — klokka* | 5 | 1 662,430 s |
| `Marie og Fredrik Bryllupsfest 2 av 3.mp4` | 8,16 | *ingen — klokka* | 5 | 2 812,327 s |
| `Marie og Fredrik Bryllupsfest 3 av 3.mp4` | 8,70 | *ingen — klokka* | 4 | 965,677 s |
| `Kirken Marie og Fredrik Bryllup.mp4` | 8,76 | *ingen — klokka* | 4 | 5 535,334 s |
| `IMG_4420.MOV` | 10,03 | 25,00 | 1 | 1 640,631 s |
| `Dans.mp4` | 9,72 | 25,00 | 1 | 5 787,122 s |

Seks avvist av troverdighetsporten, to av PSR-baren — og **null** som skåret over 15 og likevel
falt på PSR-baren. I dette prosjektet gjør golvet altså ingen skade; det er §4s bryllup som er
saken.

## 4. Kanten: baren er 25, ikke 15 — og de plasserte klumper seg på den

`min_psr` er 15 i grensesnittet og i dokumentasjonen. Det er ikke baren de fleste klipp møter.

§4.3 korrelerer et klipp kortere enn 45 s **helt** — ett segment. Med færre enn tre segmenter
finnes ingen driftregresjon å bedømme troverdigheten på, så D-045 sender klippet til den strenge
baren `min_psr × 5/3` = **25**. Den lave baren fra D-049 (`× 2/3` = 10) krever tre segmenter og
en troverdig klokke, og er derfor **strukturelt uoppnåelig** for ethvert klipp under 45 s.

I dette bryllupet er hvert eneste klipp fra hovedkameraet mellom **3,8 s og 30,7 s** (målt med
`ffprobe` på tvers av `02106`–`02160`). Alle 136 ble altså dømt på 25.

Det avgjørende er hvor de overlevende ligger:

```
plassert PSR:  25,33  25,49  29,95  30,25  38,28  70,64  82,77
bar:           25,00
```

**To av sju plasseringer ligger innenfor 0,5 av baren.** Det er formen man ser når en terskel
skjærer *inn i* populasjonen den skal skille, ikke når den ligger i et tomrom mellom sanne og
falske treff. KNOWN_LIMITATIONS har hittil sagt at «et ekte matchende kort klipp i samme rom
skårer langt over dette» — den setningen er ikke forenlig med denne fordelinga. Om treffene lå
trygt over, ville sannsynligheten for å se to av sju klistret til baren vært svært liten.

Legg til at **ingen av de åtte plasseringene har målt drift og ingen har en kjede**: hele D-049s
bevisgraderte vei — den som ble innført nettopp fordi PSR-områdene til sanne og falske treff
overlapper — fyrte ikke én eneste gang på ekte materiale. Motoren gikk gjennom hele dette
bryllupet på den strengeste av sine tre porter.

**Dette er et forslag, ikke en endring.** Terskeljustering er eierklasse, og runden har ikke
rørt en eneste konstant. To ting bør skje, i rekkefølge:

1. **Mål først.** Kjør grunnlinja på nytt med `evidence`-feltet og les fordelinga av de 166
   avviste. Hypotesen som skal falsifiseres: at en betydelig del ligger mellom 15 og 25, på
   plausible forskyvninger. Det er nå én kommando, og §2 er grunnen til at det ikke var det.
2. **Vurder segmentering under 45 s når referansen er lang.** Rotårsaken er ikke tallet 25, men
   at et kort klipp *ikke får lov* til å skaffe seg bevis. Et 20 s klipp mot en 3-times referanse
   kunne segmenteres i tre à ~7 s; da ville D-049s troverdighetsport kunne uttale seg, og klippet
   dømmes på bevis framfor på ett tall. Det ville også gjøre `NO_DRIFT_EVIDENCE_PSR_FACTOR`
   mindre bærende, framfor å senke den blindt.

## 5. Den redigerte miksen — D-045 i felt, og nå i CI

`Johnny Hansen/Marie og Fredrik` er ikke et opptak i det hele tatt, men **et arkiv av seks ferdige
klipp av ett bryllup**: en lang film, en 40-minutters, en tredelt fest, en kirkedel. Hver fil *er*
hendelsen, med høy PSR. Det er den farligste formen ekte materiale har, og nøyaktig den D-045 ble
skrevet for.

Motoren plasserte **ingenting**. Og det holdt seg da hver av tre ulike redigeringer ble tvunget som
referanse etter tur — den lange filmen (2,21 t), kirkedelen (0,78 t), 40-minutteren (0,67 t):
fortsatt ingenting plassert, hver gang. Tre uavhengige referanser, samme riktige svar.

**Det ene tallet som er verdt hele runden:** `Marie og Fredrik 40 minutt.mp4` ble avvist med
**PSR 131,39**. Det er ikke et svakt treff — det er et av de sterkeste tallene som finnes i noe
korpus i dette prosjektet, fem ganger over den strengeste baren og nesten ni ganger over golvet.
Fila korrelerer så voldsomt fordi den *er* det samme bryllupet, klippet på nytt. Et hvilket som
helst PSR-golv — 15, 25, 50 — ville plassert den umiddelbart, og plassert den grovt feil: det
finnes ingen enkelt forskyvning som er riktig for en redigert film.

Den ble avvist fordi de fem segmentene ikke beskriver noen klokke. `required_psr: null`, altså
ingen PSR ville vært nok. **Dette er D-045s tese demonstrert med det sterkeste mulige tallet på
ekte materiale:** der bedre bevis finnes, er PSR ikke dommeren. Uten troverdighetsporten hadde
dette vært rundens verste feilplassering; med den er det en linje i `unsynced`.

Merk også at fila og dens søster `40m 30s` (PSR 11,07) begge peker på **nøyaktig samme
forskyvning, 3 645,200 s** — to ulike eksportvarianter av samme klipp, enige om hvor de ville
havnet. Konsistent, plausibelt, og likevel riktig avvist. Det er verdt å ha sett, for det er
akkurat den formen som ser overbevisende ut for et øye som bare leser toppstyrke.

Dette er også en indirekte transitivitetsprøve, og den beste dataene tillot: hadde porten sluppet
gjennom ett feilaktig treff, ville valget av referanse endret hva som ble plassert. Det gjorde det
ikke. (En egentlig transitivitetsmåling — parvise forskyvninger for overlappende klipp, samstemte
innenfor noen få ms — krever et prosjekt der klipp *blir* plassert langs en kjede. Grunnlinja ga
åtte plasseringer, alle direkte mot referansen og ingen med kjede, så det fantes ingen kjede å
prøve. Det er i seg selv et resultat, og det peker på samme rotårsak som §4.)

Fram til nå var dette et svar bare NAS-en kunne gi. `emit_edited_mix` i `fixturegen` — påbegynt av
forgjengeren i denne runden, nå ferdig og tatt i bruk — gjør formen syntetisk: kutt av masteren i
hendelsesrekkefølge med materiale fjernet mellom dem, altså det en klipper faktisk gjør. Prøven
`a_produced_edit_is_refused_for_its_scatter_not_its_volume` fester **grunnen** og ikke bare
avvisninga: `required_psr: None`, drept av troverdighetsporten framfor av PSR-golvet. Å avvise
fila for å være svak ville vært flaks; å avvise den for spredning er D-045 som virker. Den kjører
i CI, uten NAS.

## 6. Ytelse: den utsatte avgjørelsen har forfalt

KNOWN_LIMITATIONS sier at korrelasjonskostnaden skalerer med referanselengden (~160
transformblokker for en tre-timers referanse mot ~10 for ti minutter), at §10s seks-minutters mål
forutsetter en dekode-bundet kjøring, og at den kjente fiksen — grovsøk på desimert signal, så en
smal finpuss — er **«utsatt til Phase 6-korpuset viser om det biter i praksis»**.

Korpuset er her, og det biter. Grunnlinja brukte **2 462 s (41 min)** på 180 filer mot en
3,11-times referanse. Redigeringsarkivet brukte 624 s kaldt på ti filer mot en 2,21-times referanse
— og 212 s varmt, altså er ca. 70 % av den kalde tida ren uthenting fra NAS, mens resten er
korrelasjon som ikke blir raskere av en varm buffer.

Tallene er nedre grenser og ikke rene målinger: maskinen delte CPU med annet arbeid (målt
`load average` over 200 i deler av runden), så de sier «minst så tregt», ikke «nøyaktig så tregt».
Retninga er uansett entydig, og avgjørelsen er ikke lenger utsatt av mangel på data.

## 7. Hva runden ikke rakk

Ærlighet om egne hull, etter samme regel som resten av dokumentet:

- **Grunnlinja er ikke kjørt på nytt med `evidence`-feltet.** Kjøringa ble startet og kom gjennom
  135 av 175 uthentinger før den måtte avbrytes; maskinen var samtidig lastet til over 200 i
  `load average` av parallelt arbeid, og gjenstående tid var flere timer. Bufferen er bevart, så
  neste forsøk er i hovedsak varmt. **Alt i §4 er derfor utledet fra fordelinga av de *plasserte*
  klippene og fra målte klippvarigheter — ingenting der hviler på tall som ikke finnes.**
- **Fordelinga av avviste PSR-er er dermed fortsatt umålt.** Det er den ene målinga som ville gjort
  §4s forslag til en konklusjon, og den er nå ett kall unna.
- **Tre ekte prosjekter, ikke fire–fem.** `MARY&FREDDY` (1 310 filer) og `FARMOR OG FARFAR`
  (178 filer, 176 GB, familiearkiv over flere tiår framfor ett opptak) ble kartlagt og valgt bort
  på tid. Sistnevnte er verdt en runde som **negativ kontroll**: materiale som *ikke* hører sammen,
  der ethvert plassert klipp er et falskt positiv.

## 8. Dommen

**Vernene holder. Golvet gjør det trolig ikke.**

D-045s troverdighetsport gjorde nøyaktig jobben sin på det verste ekte materialet som finnes i
arkivet, tre ganger, med tre forskjellige referanser — og er nå festet i CI uten NAS. `no_audio`
og `decode_error` er ærlige og riktige. Ingen falsk plassering er observert i noen kjøring i denne
runden.

Men **den strenge baren for korte klipp står med all sannsynlighet for høyt**, og hele den
bevisgraderte veien D-049 innførte er utilgjengelig for materialet et bryllup faktisk består av.
Ett bryllup ga åtte plasseringer av 180 filer, og de to svakeste lå 0,33 og 0,49 over baren.
Motoren er ikke *feil* her — den er ærlig, som lovet — men den er sannsynligvis for forsiktig, og
prisen er dekning.

Det er en eierbeslutning, og den bør tas på målingen i §7 første kule, ikke på dette dokumentet
alene.

## §8 — Etterkjøringen: de avvistes PSR-fordeling (2026-09-06)

Baseline-bryllupet ble kjørt på nytt med bevis-feltet (varm cache, samme mapper, motor fra
main `2d5cabb`): fortsatt **8 plasserte**, og nå bærer **166 av 172 avviste** korrelasjonsbevis.

Fordelingen (PSR for avviste): min **8,21** · median **13,92** · maks **24,96**.
Histogram 5–10 / 10–15 / 15–20 / 20–25 / ≥25: **24 / 82 / 47 / 13 / 0**.

- **Ikke én eneste avvist når 25** — og toppen ligger på 24,6 / 24,8 / **25,0**. Populasjonen
  presser mot taket; terskelen skjærer nøyaktig langs den, ikke i et gap over den.
- **60 av 166** ville passert terskelen brukeren faktisk har satt (15); **142** ville passert
  den bevisgraderte tieren (10) — som de i dag er strukturelt utestengt fra (§4).
- Dette beviser IKKE at de 60/142 er sanne treff: D-015 målte falske treff på 15,2–19,0,
  midt i denne massen. Å senke gulvet rått ville sluppet inn falske. Svaret dataene peker på
  er det samme som §4s forslag: **segmentering under 45 s**, slik at korte klipp kan tjene
  bevis og dømmes av troverdighetsgaten (D-045) på graded tier — diskriminatoren som beviste
  seg med PSR-131-avvisningen, og som i dag aldri får kjøre på dem.

Beslutningen er eierens; tallene over er hele grunnlaget.
