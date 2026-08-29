# Changelog

## Ikke sluppet ennå

- **Et klipp er en tegning nå, ikke en farget kloss.** Hver eneste boks på tidslinja er en tynn
  ramme i fargen sin, en svak tone av den samme fargen bak, og bølgeformen tegnet oppå — grønn
  når motoren har plassert fila, blå mens analysen er ferdig men synken ikke, amber når det er
  noe å si, dempet grå mens den venter. Før var boksen fylt helt: en rad med klipp leste som én
  sammenhengende grønn stripe med filnavn utover, og bildet av lyden — det eneste på skjermen du
  faktisk kan bedømme en synk med øyet på — var en litt mørkere grønn flekk inni en litt lysere
  grønn boks. Banene er mørke nå, og klippene er tegnet på dem. Underveis fant vi at bølgeformen
  aldri hadde ligget der den skulle: `<canvas>` er et erstattet element, så høyden kom fra
  bufferet (150 px) og ikke fra boksen, og det du så var toppen av søylene klemt mot underkanten
  av klippet. I hvert eneste klipp, hele tiden. Nå fyller bølgeformen boksen (D-091).
- **Ingen klipp tegnes lenger oppå naboen sin.** På et bryllup med fire hundre filer var hvert
  klipp tre piksler bredt — men `.clip` hadde 12,8 piksler polstring og arket regner
  `border-box`, så boksen ble lagt ut fire ganger for bred. På en tett kortstokk lå **476 av 476
  naboer oppå hverandre**, og et klikk midt på det klippet du siktet på traff *det neste*.
  Appen ga deg feil fil. Polstringa er flyttet inn i klippet, boksen klippes mot der neste klipp
  begynner — starten er hellig, bredden viker — og under seks piksler tegnes klippet som et
  tydelig to-pikslers merke i statusfargen sin i stedet. 476 av 476 → **0** (D-091).
- **Banene vokser inn i rommet.** Radhøyden var fast 40 piksler, så tre kameraer i et helt vindu
  etterlot 81 % av tidslinja som tom, mørk plass. Nå deler radene høyden mellom seg — 40 piksler
  som gulv når det er mange av dem, opp til 90 når det er få. Tre enheter: 81 % tomt → 58 %.
  Seks enheter: 62 % → 15 %. Et bryllup med seksten enheter fyller flata som før (D-091).

## v0.6.0-beta.3

- **Klippene stokker seg, reiser og spretter på plass — og blir grønne i det de lander.** Når
  synken treffer, hopper filene litt rundt på tidslinjen først, som om de finner seg selv;
  så setter de av gårde mot der lyden sier de hører hjemme, går et lite hakk forbi og
  spretter tilbake på plass. Hvert klipp starter på sitt eget lille forsprang, så tidslinja
  koker et øyeblikk og faller til ro igjen — omtrent ett sekund fra ende til ende. Fargen
  følger bevegelsen: et klipp er blått så lenge det er i lufta, og blir grønt i landingen.
  Grønt betyr «motoren har plassert denne», og et klipp som fortsatt flyr har ikke landet
  noe sted å stå inne for. Ett tak i tidslinja underveis — dra, rull, zoom — og alt står
  ferdig og grønt i samme frame. Har du bedt om mindre bevegelse i systemet, skjer ingenting
  av dette: resultatet står grønt og riktig med én gang, som før (D-090).
- **Kvitteringene fra Innstillinger leses over dialogen, ikke bak den.** «Buffer tømt»,
  «data slettet» og de andre svarene fra panelet lå bak den mørke sperren og var knapt
  synlige før dialogen ble lukket; nå ligger de over, og leses i det de fortjenes (D-089).
  Popovere som står åpne når fasen skifter blir stående — det er et valg, ikke en glipp.

## v0.6.0-beta.2

Etter en kontroll-for-kontroll gjennomgang av «Ett rom» (hver eneste knapp, i hver fase, trykket
og etterprøvd — `app/e2e/control-sweep.spec.ts`):

- **Tastaturet mister ikke plassen sin når du lukker en dialog ved å trykke utenfor den.** ✕ og
  Escape ga fokus tilbake til knappen du åpnet fra; et trykk på bakgrunnen la det på toppen av
  dokumentet i stedet. Én av tre utganger som stille sendte tastaturbrukeren tilbake til start.
- **Feil fra Innstillinger sies på norsk.** «Tøm buffer», størrelsestaket og «Eksporter
  diagnostikk» viste motorens egen engelske feiltekst rå — `busy: sync in progress` — mens alt
  annet i appen oversetter den. Nå går de tre gjennom samme oversetting som resten (D-030), og
  en ukjent melding beholder fortsatt sin egen tekst inni setninga.

## v0.6.0-beta.1

**v0.6 — «Ett rom».** SundaySync var en side. Du slapp inn en mappe og slippfeltet krympet; du
trykket Synkroniser og knappen ble til en framdriftslinje; resultatet kom og det dukket opp en
eksportrad under en tidslinje som nettopp hadde skiftet høyde. Hver eneste gang programmet svarte
på noe, flyttet det på det du satt og så på. v0.6 gjør appen om til **ett rom**: en topplinje, en
tidslinje, en kolonne til høyre og en stripe langs bunnen — like store i alle faser, fra tomt
vindu til ferdig eksport. Det er ikke pynt. På et bryllup med fire hundre filer er hvert klipp tre
piksler bredt, og et rom som rykker er et rom du bommer i.

### Ingenting flytter seg

- **De fire flatene står stille.** 44 px topplinje med navnet, «Legg til», én setning om hva du
  har sluppet inn og **den ene tingen du skal trykke på nå**. Tidslinja fyller alt under den. En
  300 px kolonne til høyre viser klippet du har merket. En tynn stripe langs bunnen bærer
  avspillinga. Vinduet er 1280×800 og kan dras ned til 1024×600; ingenting i rommet endrer
  størrelse fordi noe inni det fikk mer å si.
- **Framdrift er det eneste som får lov til å flytte tidslinja**, og bare mens appen faktisk
  jobber: en 34 px stripe under topplinja mens den leser kildene eller kjører synken, og den
  dytter tidslinja ned nøyaktig så mye. Den blir stående gjennom hoppet, så tidslinja og klippene
  aldri beveger seg samtidig — for øyet klarer ikke skille et klipp som flyttet seg fra et rom som
  flyttet seg under klippet.
- **Meldinger legger seg over i stedet for å dytte.** En advarsel, et oppdateringsvarsel eller en
  eksportfeil legger seg oppå tidslinja. «Kildene er endret siden forrige synkronisering» er én
  stille linje langs bunnen. Kvitteringa etter en eksport er ugjennomsiktig og lar deg klikke rett
  gjennom seg på klippene under — den er noe programmet sier, ikke noe som stenger av rommet.
- **Ingenting står lenger over tidslinja.** Zoom-knappene har flyttet inn i linjalens egen celle
  rett over klippene, forklaringslinja og setninga om hva du ser på står i bunnstripa ved siden av
  avspillinga, og advarsler fra synken er blitt til «2 advarsler» oppe på topplinja. Tidslinje-ramma
  begynner på nøyaktig samme sted i alle faser: å trykke Synkroniser flytter ikke lenger på en
  eneste piksel.
- **Én hovedhandling, alltid på samme sted.** Den gylne knappen står sist på topplinja, rett før
  tannhjulet — «Vis i Finder» og «Synk på nytt» legger seg til venstre for den. Før dukket «Vis i
  Finder» opp til høyre for den og skjøv den 110 piksler sidelengs i samme øyeblikk som du skulle
  til å trykke på den igjen.

### Blått når lyden er lest

- **Klippene blir blå med én gang lyden i dem er analysert.** Når du slipper inn et kort begynner
  programmet å analysere lyden i bakgrunnen med det samme. Det har det gjort lenge — men den eneste
  måten å se hvor langt det var kommet, var at bølgeformen i et klipp dukket opp, og den ser du bare
  hvis du har zoomet langt nok inn på akkurat det klippet. Nå sier fargen det i stedet: **grå
  venter, blå er analysert, grønn er plassert av synken.** Du ser hele slippet gå fra grå til blå
  mens du sitter og ser på kildelista. Skjermleseren får det samme sagt med ord, og et klipp som
  allerede sier noe om seg selv — at tidspunktet er anslått, at rekkefølgen kommer fra filnavnet, at
  fila er stemplet en annen dag — sier det fortsatt: kanten er uendret, det er fyllet som skifter.
- **Sporhodet er enhetens hjem.** Til venstre for hvert spor står det nå to linjer: hvem enheten er
  (ikon, navn, «Referanse», M/S) og hva den har med seg — «3 filer · 1 t 42 min» og **én prikk** som
  sier hvor langt hele raden er kommet, i samme grå-blå-grønn. Raden er det eneste på skjermen som
  er stort nok til å leses fra andre siden av rommet. Sporene er 40 px høye nå, så begge linjene får
  plass. En rad der lyden ikke lot seg lese sier det rett ut — «Lyden er ikke analysert» — i stedet
  for å påstå at den fortsatt holder på.

### Kildene i stripa

- **Kildelista er borte fra skjermen, og alt den kunne står igjen.** Panelet under tidslinja tok
  40 % av rommet hele tida for å svare på fem ulike spørsmål samtidig. Nå henger lista bak linja som
  teller den — «386 filer · 7 enheter» er selve knappen som åpner mappene, enhetene og hver enkelt
  fil, og en filrad merker klippet og lukker panelet igjen. Å finne én fil på navn i et 386-klipps
  opptak er det tidslinja ikke kan, så lista blir — men den ligger **over** rommet i stedet for å ta
  av det.
- **Stjerne, «Flytt til enhet» og ✕ står på klippet du ser på.** Før satt alle tre på hver eneste
  rad — 386 stjerner, 386 nedtrekk, 386 kryss. Nå står det ett av hvert, i høyre kolonne, under det
  fila faktisk er. Filer som ikke kunne leses beholder sin egen ✕ i sitt eget panel.
- **Problemer, fjernede og oversprungne filer er brikker du kan åpne.** Den røde problembrikka
  teller både det skanninga ikke fikk lest og det motoren ikke fikk plassert — for derfra du står er
  det ett spørsmål. «Ikke synkronisert»-hylla ligger inni den. «Fjernet (N)» og «… ble hoppet over»
  er brikker langs bunnen, og hver av dem er borte når den ikke har noe å si.
- **Panelene lukker hverandre.** Det er alltid bare ett åpent om gangen, enten du åpner det med
  musa eller med tastaturet.
- **Stillbildet er nesten fire ganger så stort.** I høyrekolonna er en forhåndsvisning 268×151 i
  stedet for 140×79 — forskjellen på å kjenne igjen en kameravinkel og å gjette.

### «Tilpass» tilpasser faktisk

- **Et bryllup på 15,5 timer får plass på skjermen.** «Tilpass» kunne før vise omtrent ti timer, og
  ikke en time mer uansett hvor mange ganger du trykket: 40 av 386 klipp lå utenfor høyre kant med
  ingen måte å hente dem inn på annet enn å dra seg dit. Nå rekker «Tilpass» **rundt 19,5 timer** —
  fra frisøren om morgenen til siste dans etter midnatt, med natta til overs.
- **Linjalen sier «1:00:00», ikke «1:00:00.000».** Når det er en time mellom hver strek, er de fire
  siste tegnene fire tegn med ingenting i — og det var akkurat de som gjorde at det siste klokkeslettet
  på linjalen ble kappet midt i et siffer.

### Internt

- «Ett rom»-skallet er et fast CSS-rutenett (D-074); det merkede klippet og avspillinga havner der
  designet vil ha dem uten å flytte på hvor dataene deres bor (D-075); forhåndsvisninga er en kolonne
  (D-076); én hovedhandling per fase (D-081); framdriftsstripa og meldingslaget er to ulike slags ting
  og er bygget ulikt (D-082); «Legg til» er en topplinje-kontroll (D-086). Kildepanelet hang under
  tidslinja som en bevisst bro (D-087) og ble fjernet i R2a: de fjorten tingene panelet kunne er
  fordelt på fire steder i rommet (D-077), de fire panelene er `<details>` som legger seg over rommet
  (D-078), og hylla flyttet med dem (D-079). Sporhodet, linjalens zoom-celle og bunnstripas ord er
  R2b (D-083). Zoom-golvet halveres til 1e-5 px/ms (D-084), spec-migreringsregelen for hele runden er
  skrevet ned med den endelige locator-tabellen (D-085), og finpussen mot lerretet — hva en rad gir
  fra seg først, hvorfor en melding som svever må være ugjennomsiktig, og hva som *ikke* ble endret —
  er D-088.
- `app/e2e/ett-rom.spec.ts` måler rommet i piksler i to vindusstørrelser, sampler hver eneste ramme
  av hoppet for å bevise at framdriftsstripa aldri blinker vekk under det, åpner alle fire panelene
  for å bevise at ingen av dem flytter en eneste boks, og går gjennom hvert eneste element i
  topplinja og bunnstripa i den travleste tilstanden appen kan nå for å bevise at ingenting tegnes
  oppå noe annet. `timeline-scale.spec.ts` har fått et 16-timers opptak som beviser at «Tilpass»
  faktisk tilpasser.


## v0.5.0-beta.1

**v0.5 — the app stops claiming things it cannot support.** v0.4 put your files on the
timeline before the sync. v0.5 is about everything the app was *saying* about them while they
sat there: which files are footage at all, when each one was recorded and how confidently, and
what is happening to them right now. Every stage of this round started from something on the
owner's own screen — a 386-file wedding — and every measurement in it was taken on that
material. It also stops spending work on pixels that cannot show anything, which is why a
wedding-sized drop now lands instantly instead of asking the engine four hundred questions in
one breath.

### New

- **You can see the clip you are marking (D-070).** Click any clip and the panel under the
  timeline shows a still frame from it, what the file actually is — length, video codec and
  size, audio codec and rate, and when it was recorded, with the app still saying how it
  knows — and, once you have synced, everything the engine worked out about it: the offset to
  the millisecond, how sure it is, the signal strength against the threshold, measured drift
  and any warnings. Those last ones are exactly the numbers the old clip dialog showed, in
  exactly the same words; what changed is that they no longer sit in a box you have to close
  before you can look at the next clip. Reassigning a clip to another camera happens right
  there too.
- **Clips can be marked before you sync.** Previously a clip you had not synced yet could not
  be clicked at all — there was nothing to open. Now there is: the picture and the file's own
  details are there from the moment you drop the folder, so you can go through a card and see
  what is on it before asking the app to do any work. Nothing is invented — a clip the engine
  has not placed says nothing about position or confidence, because there is nothing to say.
- **Files with no picture in them say so, quietly.** A WAV from the recorder, or a photograph
  that travelled in the same folder, simply has no frame to show — on a normal card that is
  about one file in twelve. It reads «Ingen bilde», not a broken image and not an error. A
  frame that is still being fetched says that too: pulling one out of a 45-minute file on a
  NAS takes a few seconds, and the app would rather tell you than blink.
- **The timeline no longer jumps under your finger.** The panel is always there and always the
  same height, whether or not a clip is marked. On a wedding-sized drop the clips are three
  pixels wide, and a panel that appeared when you clicked would have moved the timeline in the
  same instant — sending your next click somewhere you did not aim.
- **The timeline knows when your files were recorded, even when the camera did not write it
  down (D-067).** On the owner's 386-file wedding, 174 files used to land in one pile at the
  very start of the timeline under a single line: "174 filer mangler opptakstidspunkt". Almost
  all of them did have a recording time — just not in the one place the app was looking. It
  now reads four kinds of evidence, in order of how much they can be trusted: the camera's own
  timestamp; a recorder's date and clock written as two separate tags (the Zoom F6 does this);
  a timestamp spelled into the filename (`uirec-20260725_125533.wav`); and, when a file
  carries no tags at all — every one of the 136 AVCHD `.MTS` files on that drop — the file's
  own modification time, minus its length, because that is when the recording *finished*. On
  that drop it places **375 files where 212 were placed before**.
- **Every clip says which of those it is.** A start the app *measured* looks different from a
  start it *worked out*: an estimated one gets a dashed top edge, and its spoken description
  says where the number came from — «anslått fra filens endringstidspunkt». The line above the
  timeline is now several counts instead of one; on the owner's drop it reads «212 plassert fra
  tidsstempel · 163 anslått · 11 utenfor økta.», and those numbers add up to every file on
  screen.
- **Files nothing can time are laid out in the order the camera numbered them (D-068).** They
  used to stack at position zero — fourteen Zoom takes drawn on top of each other, which said
  nothing about any of them. They now sit end to end on their own device's row, after that
  device's last placed clip. The app does not know when they started; it does know what
  followed what, and that is what it draws. The stack of lanes goes with it.
- **A folder from another day is named, not silently mixed in (D-071).** A recorder whose
  clock was never set and reports 2020, or a handful of clips that travelled in from a
  different shoot, is not placed by its clock — and the app says so *with the date*: «11 filer
  er tidsstemplet 25.04.2013, 01.01.2020 og 3 andre datoer, utenfor denne økta, og er ikke
  plassert etter klokka.» Nothing is removed on your behalf; you already have per-file removal
  if you want it.
- **Groundwork: the app can now pull a single video frame out of a clip (D-069).** The first
  half of being able to *see* the clip you are marking; the panel that puts it on screen is the
  entry at the top. What landed here is the part that had to be right first: one frame, decoded
  on demand at whatever second you point at, handed to the screen as a picture and never
  written to disk. It needed no new permission of any kind — the app is exactly as locked down
  as it was yesterday, which is the reason this shape was chosen over the obvious ones. Getting
  a frame out of a 45-minute AVCHD file on a NAS in two-thirds of a second rather than nine
  took a seek arrangement that looks odd and is not: the numbers behind it, and the way the
  fast-looking version quietly fails on all 136 of the owner's `.MTS` files, are written down
  in D-069 so nobody tidies it away. Files with no picture in them at all — the WAVs, the
  stills — come back as "no picture" rather than as an error, because on a normal card that is
  about one file in twelve and it is not a fault.

### Fixed

- **The scanner no longer mistakes a drone's preview files for footage, and tells you what
  it left out (D-066).** DJI writes a small `.LRF` alongside every clip — the same
  low-resolution proxy as the `.LRV` the app already knew to ignore, just spelled
  differently — so a drone folder was being read as twice as many recordings as it held,
  with the previews competing against the real clips for a place on the timeline. Orphaned
  previews, whose originals are not in the folder at all, had nothing to lose that fight to.
  Photographs are skipped too, and now *before* the app opens them: a `.HEIC` or a raw next
  to your video used to be read, found to have no audio, and reported on the red "could not
  sync" shelf — an error message about a photograph.
- **Nothing disappears quietly any more.** Whatever the scan walked past is counted in one
  quiet line under the sources list — «8 følgefiler og 1 stillbilde ble hoppet over» — with
  the file names one click away. Skipping a preview file was safe to do in silence while its
  original sat right there in the list; a photograph has no such neighbour, and a file that
  vanishes with nothing on screen to say why is the app asking to be distrusted.
- **The clips stop offering to rebuild a waveform the sync is already building (D-064).**
  Press Sync while the app is still pre-analysing your files and every clip on the timeline
  used to sprout a «Bygg bølgeform på nytt» button — on a 386-file wedding, all 386 of them,
  offering an action that could only answer "opptatt". The background pass had been pushed
  aside by your Sync press, exactly as it should be, and the app read that as "the pass
  finished and never got to these files" rather than "the pass was interrupted". A pass that
  was interrupted has nothing to say about the files it never reached, and the app now says
  nothing on its behalf. While the sync runs, the clips say what is actually happening:
  *Analyserer …* — because the sync is doing that analysis itself.
- **The waveforms the sync builds now appear when it finishes (D-064).** They were being
  built and written correctly; no clip ever went back to look. Every clip was still holding
  the "there is nothing here yet" answer it got before the run started. When a run ends —
  finished, cancelled or failed — every clip reads again, once, and shows what is really
  there.
- **A clip shows what fits in it (D-065).** The filename and the waveform's status used to
  be drawn on top of each other, at every zoom level; in a three-pixel box that meant an
  unreadable smear with a button in it that could not be aimed at. They share one row now,
  the name truncates with an ellipsis instead of shoving anything aside, and a clip too
  narrow for both keeps whichever one matters: the button when there is something to press,
  the filename when there is not. A control that shrinks to an icon keeps its full name for
  screen readers and its detail on hover — only the pixels are rationed. A three-pixel clip
  stays a coloured tick, as it should.
- **The timeline stops growing the page when you drop a lot of devices.** Twelve devices used
  to push the sources panel and the Sync button off the bottom of a laptop screen. The tracks
  now scroll inside their own box, with the time ruler stuck to the top of it so you can still
  read what the clips line up against.
- **A wedding-sized drop no longer asks the engine four hundred questions at once (D-072).**
  Every clip used to ask for its waveform's shape the instant it appeared, so dropping the
  owner's card fired off 386 requests in a single breath — every one of them answered "there
  is nothing cached yet", because nothing had been analysed. Those requests are queued now,
  six at a time, and the app waits for a quiet moment before starting: the clips, the ruler and
  the panel are on screen first. A request for a clip you have already scrolled past is thrown
  away rather than sent. And a clip narrower than about a quarter of an inch does not ask at
  all — a waveform three pixels wide is a smudge, not a shape, so there is nothing there worth
  fetching, drawing, or waiting for. It comes back the moment you zoom in far enough to read
  it. On the real 386-file drop that is **no requests instead of 386**.
- **Clicking away from a clip and straight back shows its picture again.** If you clicked one
  clip, then another, then back to the first before its frame had finished loading, the first
  clip would say «Ingen bilde» from then on — for a file with a perfectly good picture in it.
  Over a network share that window is several seconds wide, which is exactly how long a
  4K frame takes to arrive.

## v0.4.0-beta.1

**v0.4 — the picture comes first, and it moves.** v0.3 made the *result* something you could
look at. v0.4 makes everything before the result something you can look at too: drop a
folder and the timeline is there, with your clips on it, while the app quietly gets on with
the analysis in the background. Take out what does not belong. Then press Sync — and watch
the clips hop from where the cameras claimed they were to where their own audio says they
actually were.

### New

- **Your files are on the timeline the moment you drop them (D-061).** No more list of
  filenames you have to sync before you can see anything. One track per device, each clip
  where its own recording timestamp says it belongs — because the picture is what tells you
  whether the app read your card properly, and that should not have to wait. Those pre-sync
  clips are drawn in a muted grey, never the placed green: they are the *files'* claim about
  when they were recorded, not the engine's.
- **The app analyses your media while you are still choosing it (D-059, D-062).** Dropping a
  folder used to do nothing but read each file's metadata, so the whole decode happened after
  you pressed Sync and every waveform stayed blank until it finished. It now decodes in the
  background while you read the sources list, and each clip draws its waveform the moment
  *that* file is done rather than all of them at once at the end. The sync then finds the
  work already made. It is the same analysis the sync would have done, into the same cache,
  so nothing about the result changes — only the waiting. Press Sync whenever you like and
  the background pass steps aside within a second or two. Its progress is one quiet line in
  the sources panel, deliberately not a progress bar: this is not something you are waiting
  for.
- **Clips can be left out of a run (D-060, D-062).** The camera that recorded ten seconds of
  lens cap, the board dump that duplicates a device, the file that belongs to a different
  service. Every row in the sources list has a ✕ — including the files the app could not read
  and the ones that would not sync — and the file leaves the timeline, its device group and
  the counts at once. It is not decoded, not placed, and not reported as a failure; it is
  simply not part of the run. Nothing is deleted: «Fjernet (N)» at the foot of the panel has
  an «Angre» on every row, so one misclick costs one click rather than re-dropping the whole
  card. Remove the file you had starred as reference and the star goes with it, so the app
  chooses again instead of naming something it was told to skip. Removing anything makes an
  existing result stale exactly as changing the sources does, so an export can never quietly
  contain a file you took out.
- **The clips hop into place when the sync lands (D-063).** The one moment where the app has
  something to *show* you — this is where your camera's clock said it was; this is where its
  own audio says it was — used to go by as a cut between two frames. Now every clip travels
  there, in about half a second, on a timeline that deliberately holds still while they do:
  the view only re-frames itself once they have arrived, so what you see is the correction and
  not a shuffle. Clips the run could not place fade out and reappear on the "not synced"
  shelf. Touch the timeline at any point — pan, zoom, fit — and the animation gets out of the
  way immediately, leaving everything on its final position. If your system asks for reduced
  motion, there is no animation at all: the clips are simply already where they belong.

### Changed

- **The timeline stays on screen while the sync runs.** Pressing Sync no longer replaces
  everything with a progress bar on an empty screen: the progress and its Cancel appear above
  the clips, which stay visible and dimmed until the result lands in their place. Nothing you
  were looking at moves out from under you — and you can still pan and zoom it while you wait.
- **The file list is now a compact panel under the timeline.** Everything it did before it
  still does — starring a reference, moving a file to another device, the badges, the summary
  chips — it just no longer has to be the main event. Unusable files fold into one collapsed
  group; the count still shows, on its own chip and on the group's own line, but the list of
  them is one click away instead of being the loudest block on the screen when the drop went
  fine.
- **The window does not say its name twice (D-058).** The built-in macOS title bar wrote
  "SundaySync" directly above the app's own wordmark. The title text is hidden in the window
  now; the name is still in Mission Control, the Dock and ⌘-tab, where the system needs it.
  The title bar itself is untouched — the buttons are exactly where they always were.
- **The icon belongs to the family (D-058).** The cross in the SundaySync icon is now the same
  shape as SundayRec's, the waves are drawn thinner, and the gold is the two-stop gradient the
  rest of the suite uses. Purple background and the hairline white ring as before. The whole
  icon set was regenerated from the source SVG, and the two commands that do it are documented
  inside the SVG itself.

### Fixed

- **A camera with a flat battery no longer wrecks the pre-sync picture (D-063).** A camera
  that lost its clock comes back reporting 1970, and writes that into its files as confidently
  as any other date. The app believed it, which set the drop's start fifty-six years early and
  pushed the actual shoot clean off the right-hand edge of the timeline — leaving what looked
  like an app that had failed to read the card. A recording time that cannot belong to the
  same session as the rest of the drop is now treated as no recording time at all: the clip
  joins the others at the start, and the note above the timeline counts it.
- **The timeline no longer claims positions it did not compute (D-063).** Drop a folder of
  field-recorder WAVs — none of which carries a timestamp — and the line above the clips still
  read "Provisional positions from the files' own timestamps" over a pile of clips at zero
  that had been positioned by nothing whatsoever. It now says what is true: there are no usable
  timestamps, and the clips sit at the start until the sync places them.
- **Dropping a second folder no longer leaves it without background analysis (D-063).** The
  pass running against the first folder held the analysis slot, so the second drop's pass was
  refused — silently — and got nothing, while the abandoned pass kept reading the folder you
  had just replaced (over the network, if it lives on a NAS) and kept reporting its progress
  against a file list that was no longer on screen. A new drop now stops the old pass.
- **The timeline can be panned and zoomed with the mouse while a sync runs (D-063).** The
  keyboard's `+`/`−`/`0` and arrows always worked during a sync; the mouse did not, because the
  dimming that marks the timeline as "not an answer yet" also made it ignore the pointer
  entirely. Looking at your material is not a decision that could disturb a run.

## v0.3.0-beta.1

**v0.3 — see it, and hear it, before you export.** The result screen stops being a report
you have to take on trust and becomes something you can actually inspect: a real timeline
with waveforms, at any zoom, that you can play.

### New

- **The result view is a real timeline (D-051).** The old per-device lanes drew every clip
  as a percentage of the widest span, so a four-second offset inside a ninety-minute
  service was a sliver too small to judge. The new view has a zoom: fit the whole day on
  screen, then wind in until the millisecond the engine is claiming is visible as a
  millisecond. ⌘/Ctrl-scroll or `+`/`−` zooms around the cursor, `0` or `F` fits, a
  sideways (or shift-) scroll pans, dragging the background pans, dragging the ruler moves
  the playhead. Clips from one device that cover the same instant (a multitrack board dump)
  stack into separate rows instead of hiding behind each other, and a device that synced
  nothing still gets its own track, still saying so. The clip-detail dialog, the red "not
  synced" shelf with its move-to-device fix, the green/orange colour language and the
  dimming of a stale result are all unchanged — this is the same information, finally at a
  readable scale. Still a viewer, not an editor: clips do not drag.
- **Every clip draws its own waveform (D-052, D-054).** A faint peak outline behind a solid
  RMS body, at whatever detail the current zoom can actually show. It is drawn from the
  analysis audio the sync already cached, so it costs **no ffmpeg spawns and no second
  decode** of your media — and it is a picture of the very signal the offsets were computed
  from, not an independent approximation of it. Waveforms are anchored to real time, so if a
  camera's audio ends before its video the last stretch of the clip is simply left
  unpainted, which is the truth. A clip whose cached analysis has been swept (or was never
  built) shows a small "Rebuild waveform" control in place of the canvas; one click brings
  it back. If a sync or another cache-maintenance pass is running, the same control
  relabels with why and stays retryable rather than dead-ending.
- **You can hear whether the sync is right, before exporting (D-055).** The timeline has a
  transport: press play (or Space) and every clip sounds at once, at the offsets the engine
  worked out. Two recordings of the same room that are correctly aligned sound *phasey* — a
  hollow, chorus-like doubling, which is what two copies of one sound a few samples apart
  do. A distinct echo means something is wrong, and now you find that out in ten seconds
  instead of after an export and a round trip through Resolve. Each device gets **M** (mute)
  and **S** (solo) buttons in its track gutter, so "which one of these is late?" is a
  question you can answer by ear. Click the ruler to seek while playing. The audio is the
  **12 kHz mono analysis audio the sync engine itself listened to** — dull and lo-fi on
  purpose, and the transport says so: it is there to prove alignment, not to be a mix. No
  re-decoding, no second copy of your media, no network. A clip whose cache entry has been
  swept says so and is skipped; the rest keeps playing.
- **Drift correction during playback is now switchable in Settings (D-055, D-057).**
  Measured clock drift is corrected in playback exactly as it will be on export, and the
  new toggle turns that off so you can hear the difference. Separate from the export
  setting on purpose — comparing the two is the point — and it takes effect immediately,
  mid-playback, rather than at the next launch.
- **The timeline works from the keyboard (D-057).** `←`/`→` nudge the playhead a second at
  a time (ten with shift), `Home`/`End` jump to the ends, Space plays and pauses, `+`/`−`
  zoom, `0`/`F` fit. The scrollbar is a proper tab stop with arrow, page, Home and End keys.
  The clip the playhead is standing in is announced as the current one. None of these fire
  while you are typing in a field or adjusting the volume slider.

### Fixed

- **The waveform inside each clip is drawn against real time (D-056).** It used to be
  stretched to fill the clip's box exactly, which sounds harmless and is not: the box's
  width comes from the container's duration and the waveform's bins come from the decoded
  audio, and those two disagree by anything from a few milliseconds to most of a second on
  a normal camera file. Closing that gap by stretching moved everything in the middle of
  the clip too — up to 400 ms out of place on a one-hour clip, and by a different amount on
  each camera. On a view whose whole job is letting you see whether clips line up, that
  meant correctly-synced material could be drawn looking misaligned.
- **Waveform bars no longer smear together on a non-retina display (D-056).** At some zoom
  levels each bar was drawn twice as wide as its slot and painted over its neighbour —
  invisible on a built-in retina screen, plainly visible on an external monitor. Detail is
  now chosen against the screen's actual pixels, so a retina display also gets the finer
  waveform it can genuinely show.
- **The timeline scrollbar no longer freezes before the end (D-056), and grabbing the thumb
  no longer jumps the view (D-057).** Zoomed in far on a long service, the thumb used to
  stop moving over the last few minutes of material while the timeline underneath kept
  scrolling. Separately, pressing the thumb anywhere but its exact middle threw the view
  half a screen sideways before the drag had even begun; the thumb now stays under your
  finger, and clicking the empty track still jumps.
- **Scrolling the page over the timeline works again (D-057).** The timeline swallowed every
  scroll and turned it into a sideways pan, so the export bar and the "not synced" shelf
  below it could not be reached by scrolling over the thing filling the screen. A plain
  scroll is the page's again; sideways and shift-scroll still pan.
- **A waveform that fails to load is no longer stuck for the session (D-056).** A one-off
  read failure used to leave that clip permanently blank; changing the zoom now gives it
  another go. A clip with an unreadable waveform can also still be clicked to open its
  details — the "unavailable" line no longer swallows the click.
- **"Already busy" now says so in Norwegian (D-056).** Asking to rebuild a waveform while a
  sync is running showed the engine's own English message dressed up as a crash («Noe gikk
  galt: busy: sync in progress»). It now reads as what it is — an expected wait — with the
  technical detail on hover.
- **The end of a clip is no longer drawn louder than it is (D-056).** The last bin of every
  zoom level averaged a short trailing piece of audio as if it were full length, which could
  show the final fraction of a second up to ~58 % too loud.
- **Zoomed all the way out on a multi-hour shoot, the timeline was doing far more work than
  it drew (D-056).** The waveform detail ladder now goes coarse enough for the widest zoom,
  so a 3-hour clip stops computing ~19 bars for every pixel it paints.
- **Rebuilding a waveform can no longer leave the old one on screen (D-057).** A read that
  landed in the wrong moment could put the stale picture back into memory *while* the entry
  was being rebuilt, and it would then be shown for the rest of the session — in exactly the
  case the rebuild button exists for.
- **A clip whose length the app does not know now says so (D-057).** It used to be drawn as
  a three-pixel sliver, indistinguishable from a camera that recorded half a second.
- **Fixed export hint: media-pool-first Resolve import order.** Owner-verified A/B testing
  traced the "clip was not found" failure on large exports to Resolve's Load XML media
  *matcher*, not media ingest or our FCPXML. The in-app hint now instructs importing the
  media files into Resolve's Media Pool first, then File → Import Timeline (Load XML) — the
  matcher then binds against the already-imported clips, which is required for large files.
  `docs/KNOWN_LIMITATIONS.md` corrected to describe the matcher mechanism and the workaround
  instead of the earlier "scripted import refuses multi-GB media" framing.

### Faster

- **Opening a result no longer reads gigabytes it does not need (D-057).** Every clip on
  screen asked the engine to describe its waveform, and answering meant streaming the whole
  cached analysis for that clip — on an eight-camera hour-long shoot, over a gigabyte of
  disk reads the instant the results appeared, including for clips just off the edge of the
  screen. The answer is now arithmetic, and the audio is read only for waveforms actually
  drawn.

### QA

- **Scale, memory and the owner's listening protocol (V03-S7).** A Playwright suite proves
  the interactive timeline stays responsive at real-service scale — six devices, 302
  placements across an exact 3-hour span, several overlapping per device — by checking
  that only the clips near the visible window ever get a DOM node
  (`app/e2e/timeline-scale.spec.ts`). A vitest simulation drives the playback chunk
  planner across a 3-hour, 10-device sweep and confirms resident audio never exceeds the
  documented 256 MB budget, and that nothing needed is evicted while still needed
  (`app/src/audio/playbackMemory.simulation.test.ts`). `docs/QA_TIMELINE_LISTENING.md` is
  the practical, Norwegian checklist for running all of this against real multicam footage
  by ear — sync a real shoot, listen for the comb-filtered doubling that means "in sync"
  versus the distinct echo that means "bug," check drift correction and mute/solo, and
  confirm Resolve agrees with what was heard.

### Internal

- **Waveform peaks pipeline (D-052).** `crates/core/src/peaks.rs` — a streamed
  multi-resolution peak+RMS pyramid built from the analysis audio the sync engine has
  *already* cached. Thirteen levels span 10 ms to 40.96 s per bin (D-056 raised the ceiling
  from 2.56 s); level data reaches the UI as raw bytes (an `ArrayBuffer`), not JSON. Three
  shell commands (`waveform_meta`, `waveform_level`, `regenerate_analysis`) with a 64-entry
  in-memory cache. Reading a waveform is read-only and deliberately does not block, or get
  blocked by, a running sync (D-046). `peaks::meta_from_sample_count` derives the ladder's
  shape from a sample count alone, held bin-for-bin equal to the fold by test (D-057).
- **Timeline math foundation (D-051).** `app/src/timeline/` — pure, unit-tested modules for
  time↔pixel mapping, zoom-around-anchor, ruler ticks, clip virtualization, multi-row
  overlap layout, a shared playhead store, and the scrollbar's forward and inverse mappings.
  Adapted from SundayEdit's NLE timeline math (same owner) rather than a shared package for
  now.
- **Playback engine (D-055).** `app/src/audio/` — a sample-accurate Web Audio scheduler over
  windowed PCM reads from the analysis cache (`read_audio_window`), with its schedule
  mirrored for the Playwright tier so every timing claim is asserted rather than assumed.
- **`THIRD-PARTY-NOTICES` added (D-053)**, carrying Clypra's MIT licence for the bucket
  peak/RMS math adapted in `peaks.rs`. Their `HTMLAudioElement` playback transport
  (0.5–2.0 s drift tolerance), per-zoom ffmpeg waveform extraction and unvirtualized
  timeline were reviewed and deliberately not adopted.

## v0.2.0-beta.4 — 2026-08-09

The corpus-calibration beta: three more real multicam projects (2013–2023) taught the
engine how real material actually behaves.

- **Far better recall, same zero-false record (D-049).** Matches with enough segments to
  measure a clock are now judged by physics first: a credible drift regression admits a
  clip down to a lower PSR bar, because on real material one quiet stretch between songs
  used to drag a true 23-minute clip below the old flat threshold. Every previously
  refused *false* match stays refused (they all carried impossible clocks). Measured:
  a 5-camera living-room session went from 2 placeable snippets to the real takes;
  a 2013 audition corpus went from 2 to 9 placements.
- **Multitrack recordings survive (D-050).** A folder of per-channel board exports
  (Ch01…Ch16) no longer collapses to one channel — three or more clips that cover each
  other almost entirely are physically impossible from one camera and are kept, each on
  its own lane.
- **Cleaner scans (D-050).** GoPro/DSLR thumbnails and the AVCHD index family
  (`.thm`/`.cpi`/`.bdm`/`.mpl`/`.tdt`/`.tid`) no longer show up as "broken media".
- **Drift measurements validated against PluralEyes** on a real project: agreement to
  ±2 ppm with its drift-corrected output — and drift correction (timeMap) engaged on
  real footage for the first time.

## v0.2.0-beta.3 — 2026-08-09

The night-review beta: a four-reviewer full-code audit found and fixed **20 confirmed
defects** (6 high). If you only read three:

- **Windows exports work now** — every `file://` URL in a Windows-built FCPXML was
  unrelinkable in Resolve.
- **Better placements** — the transitive pass kept the *last* acceptable anchor instead
  of the strongest, and one long clip could hide overlapping shorter ones from the
  same-camera eviction.
- **Telemetry that actually arrives** — the path scrubber was narrower than the
  server's screen, so some payloads were silently rejected wholesale; the entire wire
  contract is now pinned as tests. Consent revocation now halts an in-flight send, and
  two app instances can no longer corrupt each other's state.

Also: a camera chosen as the sync reference now exports **with** picture; cache
maintenance and a running sync are mutually exclusive (no more mid-sync cache
evictions); `--min-psr` rejects values that would have disabled the acceptance gate;
scanning shows real progress; macOS builds are **code-signed** (from beta.2); telemetry
build metadata is stamped correctly; `npm audit` is clean including dev dependencies.
(D-046–D-048.)

## v0.2.0-beta.1 — 2026-08-08

The "Solid in Use" release: everything the v0.2 program (docs/V02-PROGRAM.md, stages
E1–E10) built, in one beta. Decision log references in parentheses.

### Nothing to install
- **ffmpeg is bundled.** Download → open → sync. The v0.1.0 "ffmpeg ble ikke funnet"
  bug (macOS gives GUI apps a minimal PATH) is gone; a system ffmpeg is only a fallback.
  Installer grew accordingly — honestly documented in KNOWN_LIMITATIONS. (D-031)

### Sync quality — the headline
- **Drift correction.** Clips on a fast/slow camera clock now stay in sync to the last
  second: the exporter writes a per-clip `<timeMap>` retime into the FCPXML (no media is
  touched; DaVinci Resolve applies it exactly, verified live against Resolve Studio 21).
  On by default for clips drifting more than half a frame; toggleable in Settings.
  A 90-minute 40 ppm camera lands both ends on the reference instead of ~108 ms out.
  (D-042, closes D-016)
- **The credibility gate.** Learned from the first real corpus: a match must now be
  *physically believable* — segment offsets that cannot be one rigid recording against
  another (an edited mix used as a reference, sidelobe hits) are refused instead of
  placed-with-a-warning, and short clips with no segment evidence must clear a higher
  PSR bar. All three false placements observed on real footage are refused; the real
  placement and every synthetic accuracy gate survive unchanged. (D-045)
- **`.lrv` proxy files are skipped** during folder scans (Insta360/GoPro low-res
  duplicates of a sibling original) — no more duplicate content on one device. (D-045)

### Speed & footprint
- **Correlation is ~4× faster**: the reference's FFT is finally computed once and cached
  (a 3-hour service drops from ~3.5 min to ~1 min of correlation), with placements
  proven bit-for-bit identical. (D-038)
- **Memory ceiling proven**: a long-service sync peaks at ~2.4 GB, under the 4 GB
  promise (was over it before the fix). (D-034)
- **Probing is parallel** (byte-identical results), the scan shows live progress, and
  the analysis cache now cleans itself: entries untouched for 90 days are swept at
  startup, with an optional size cap in Settings. (D-040, D-041, closes D-013)

### Trust & privacy
- **Security hardening**: ffmpeg/ffprobe run behind a protocol whitelist (a hostile
  "media" file can no longer make them fetch URLs or read arbitrary files), a strict
  CSP, scrubbed support diagnostics (no paths, names, or labels leave the machine),
  supply-chain gates in CI, and a fuzzing suite. (D-032, D-033)
- **Anonymous, opt-in telemetry** — off until you say yes. Versioned consent at first
  launch, a random install-id, deletion on request, and a payload of counts and coarse
  buckets only: never filenames, folders, device names, or anything from your content.
  "Show what we send" in Settings displays the exact payload. Data controller:
  SundaySuite. *(The server side ships separately; until then the app sends nothing.)*
  (D-043)
- **In-app auto-updater** with a stable and a beta channel (Settings → System). Updates
  are cryptographically signed; the update check sends no version or system information
  in the URL. (D-044)

### Robustness
- Adversarial-media suite (truncated files, lying headers, exotic rates/layouts), a
  100-run cancellation storm, two-instance concurrency safety, uniform poison-recovery
  in the app shell, an export-staleness guard, and 36 end-to-end UI tests now gate every
  change. (D-036, D-037)

### Known limitations worth reading
- A produced/edited mix is **not** a valid sync reference — the app now refuses it
  honestly instead of guessing. Use a raw recorder file or the longest camera.
- Short clips (< ~45 s) clear a higher confidence bar and may be refused where v0.1
  would have gambled.
- macOS builds are not yet notarized (right-click → Open on first launch); Windows
  SmartScreen will warn.

## v0.1.2 — 2026-08-08
- Bundled ffmpeg/ffprobe (fixes "ffmpeg ble ikke funnet" on machines where it IS
  installed — the GUI-PATH bug), GUI-invisible PATH fallbacks, onboarding self-test.

## v0.1.0 — 2026-07-28
- First test release: GCC-PHAT engine (−0.01 ms on the accuracy suite,
  Resolve-verified), scan → sync → FCPXML for DaVinci Resolve, dark UI, onboarding.
