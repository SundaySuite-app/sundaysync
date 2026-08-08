import { useState } from "react";
import type { Strings } from "../i18n";
import { setTelemetryConsent } from "../telemetry";
import { Dialog } from "./Dialog";

/**
 * The telemetry consent prompt — E7 CONSENT-UX, copy v1 (owner-approved, docs/PLAN.md).
 *
 * Deliberately NOT folded into `Onboarding`'s step sequence: onboarding only ever runs
 * once per install (gated on `onboardingDone`), but telemetry needs to reach installs
 * that already finished onboarding before this feature existed. `App.tsx` shows this
 * standalone, driven by `telemetry_status().consentVersion === null` — true for both a
 * fresh install (after onboarding closes) and an existing install upgrading into this
 * version — and it is re-openable from Settings the same way onboarding is.
 *
 * Both choices are recorded via `set_telemetry_consent`; dismissing without choosing
 * (Escape, backdrop, ✕) records nothing; consent stays undecided and the app asks again
 * next launch — matching "opt-in", never a forced choice.
 */
export function ConsentCard({
  t,
  onDecided,
  onDismiss,
}: {
  t: Strings;
  onDecided: (granted: boolean) => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const choose = async (granted: boolean) => {
    setBusy(true);
    // Fail-soft: if the core command isn't available yet, we still let the user through —
    // there's nothing else useful to do with a "yes"/"no" that can't be recorded.
    await setTelemetryConsent(granted);
    setBusy(false);
    onDecided(granted);
  };

  return (
    <Dialog titleId="consent-title" onClose={onDismiss} closeLabel={t.close}>
      <h2 id="consent-title">{t.consentTitle}</h2>
      <p>{t.consentIntro}</p>
      <p>
        <strong>{t.consentNeverLabel}</strong>
      </p>
      <ul style={{ margin: "0 0 1rem", paddingLeft: "1.25rem", lineHeight: 1.5 }}>
        {t.consentPoints.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <p>{t.consentFooter}</p>
      <p className="subtle">{t.consentController}</p>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void choose(false)}
        >
          {t.consentDecline}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void choose(true)}>
          {t.consentAccept}
        </button>
      </div>
    </Dialog>
  );
}
