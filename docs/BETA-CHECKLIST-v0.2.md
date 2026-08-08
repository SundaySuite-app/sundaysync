# v0.2.0-beta.1 — eierens testsjekkliste (E11)

Kjøres på ekte maskin med den nedlastede DMG-en/instielleren — ikke `tauri dev`.
Funn → patch-release på beta-ringen til lista er ren → promoter `v0.2.0` til stable.

## Før release (én gang, ~2 min)

- [ ] **Sett updater-signeringssecretene.** Ferskt nøkkelpar ligger klart (privatnøkkelen
      har aldri vært i noen logg): fila `sundaysync-updater.key` i øktas scratchpad
      (`…/scratchpad/e9-signing/`). Kjør:
      ```
      gh secret set TAURI_SIGNING_PRIVATE_KEY --repo SundaySuite-app/sundaysync < sundaysync-updater.key
      ```
      (Nøkkelen er uten passord — `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` kan stå tom/usatt.)
      Vil du heller ha en nøkkel ingen agent har generert: `npm run tauri signer generate`,
      bytt `pubkey` i `app/src-tauri/tauri.conf.json`, sett secreten fra din fil.
      **Arkivér privatnøkkelen trygt** — scratchpad overlever ikke rydding.
- [ ] **Tag:** `git tag v0.2.0-beta.1 && git push origin v0.2.0-beta.1` → release.yml
      bygger DMG (mac) + NSIS (win, beta-only) + signert updater-JSON.

## Installasjon (macOS)

> **beta.2+ er kodesignert** (Developer ID Richard Fossland, verifisert med codesign/spctl
> 2026-08-08 natt): appen åpnes via høyreklikk → Åpne eller Systeminnstillinger →
> «Åpne likevel». Den gamle `xattr -cr`-workarounden trengs KUN for den usignerte beta.1.
> Notarisering gjenstår (Apple-avtalen — felles suite-blokker).

- [ ] Fersk nedlasting på en maskin **uten** ffmpeg i PATH (eller
      `sudo mv /opt/homebrew/bin/ffmpeg{,.bak}` midlertidig) → appen åpner
      (høyreklikk → Åpne) → onboarding steg 3 viser grønt «innebygd».
- [ ] **UI rendrer under CSP** (E3-resten): ingen blank/hvit flate noe sted —
      onboarding, kilder, innstillinger, resultat.

## Samtykke (E7)

- [ ] Samtykkekortet vises ved første oppstart (etter onboarding), «Nei takk» →
      ingenting sendes, kortet kommer ikke tilbake.
- [ ] Innstillinger → telemetri: slå på → «Vis hva vi sender» viser payload uten
      noen filnavn/stier/enhetsnavn. «Slett mine data» svarer pent (Worker er ikke
      deployet ennå → forvent ren feilmelding, ikke krasj).

## Ekte synk (E10-korpuset eller nyere opptak)

- [ ] Slipp en hel opptaksmappe → enheter grupperes riktig, `.lrv`-filer dukker IKKE opp.
- [ ] Synk med langt kamera som referanse → ekte klipp plasseres, resten refuseres
      ærlig (ingen ville plasseringer — sjekk at drift-ppm på plasserte klipp er
      ensifret/tosifret, aldri tusener).
- [ ] Prøv den produserte miksen som referanse → alt refuseres med lav-konfidens
      (ikke feilplassert).

## Drift-korrigert eksport i Resolve (E6-resten)

- [ ] Eksporter FCPXML av en synk med et klipp > halv frame drift → importer i Resolve →
      sjekk synk ved klipp-START **og** -SLUTT (lytt/se på waveform begge steder).
- [ ] Slå av «Korriger klokkedrift» → eksporter igjen → fila er byte-identisk med
      v0.1-oppførsel (ingen `<timeMap>`).

## Updater (E9) — krever Worker-deploy først

- [ ] *(Etter at sunday-telemetry-Workeren med app-registeret er deployet og
      `WRITE_KEY_SUNDAYSYNC` mintet)*: promoter `v0.2.0-beta.1` på sundaysync-beta-ringen,
      slå på betakanal i appen → «Se etter oppdatering» svarer «à jour».
- [ ] Tag en `v0.2.0-beta.2` → promoter → appen finner, laster ned, installerer og
      relanserer (beta→beta-selvoppdatering).
- [ ] **Kill-switch-øvelse:** pause ringen → appen sier «à jour» innen 60 s; gjenoppta →
      samme bytes serveres.

## Vedlikehold

- [ ] «Tøm buffer» frigjør og rapporterer riktig; størrelsestak evicter når satt.
- [ ] Papirkurv-/angre-flyter (om relevant) og avbryt midt i synk → notis, aldri rød feil.

Når alt er grønt: `git tag v0.2.0 && git push origin v0.2.0` → promoter til stable-ringen.
