import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Strings } from "../i18n";
import { saveSettingsNow } from "../settings";
import { Dialog } from "./Dialog";
import { SyncArt } from "./icons";

const TOTAL_STEPS = 3;

/**
 * First-run onboarding — three steps, skippable, re-openable from settings.
 * SundayRec's pattern translated to React: `onboardingDone` is saved immediately on
 * finish/skip (not debounced), so quitting right after cannot lose it.
 *
 * Step 3 is the practical one: a live ffmpeg check with a re-check button, so a user
 * who installs it mid-onboarding sees the light turn green without restarting.
 */
export function Onboarding({ t, onDone }: { t: Strings; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const [ffmpegOk, setFfmpegOk] = useState<boolean | null>(null);

  const checkFfmpeg = useCallback(() => {
    setFfmpegOk(null);
    invoke<string>("check_sidecar")
      .then(() => setFfmpegOk(true))
      .catch(() => setFfmpegOk(false));
  }, []);

  useEffect(() => {
    if (step === 3) checkFfmpeg();
  }, [step, checkFfmpeg]);

  const finish = () => {
    saveSettingsNow({ onboardingDone: true });
    onDone();
  };

  return (
    <Dialog titleId="onboarding-title" onClose={finish} closeLabel={t.obSkip}>
      <div className="onboarding">
        <SyncArt />

        {step === 1 && (
          <>
            <h2 id="onboarding-title">{t.obTitle1}</h2>
            <p>{t.obBody1}</p>
          </>
        )}
        {step === 2 && (
          <>
            <h2 id="onboarding-title">{t.obTitle2}</h2>
            <p>{t.obBody2}</p>
          </>
        )}
        {step === 3 && (
          <>
            <h2 id="onboarding-title">{t.obTitle3}</h2>
            <p>{t.obBody3}</p>
            {ffmpegOk === true && (
              <p className="onboarding__status onboarding__status--ok">✓ {t.obFfmpegOk}</p>
            )}
            {ffmpegOk === false && (
              <>
                <p className="onboarding__status onboarding__status--missing">
                  {t.obFfmpegMissing}
                </p>
                <p>
                  {t.obFfmpegHow} <code>brew install ffmpeg</code>
                </p>
                <button type="button" className="secondary" onClick={checkFfmpeg}>
                  {t.obCheckAgain}
                </button>
              </>
            )}
          </>
        )}

        <div className="onboarding__dots" aria-label={t.obStep(step, TOTAL_STEPS)}>
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={`onboarding__dot${n === step ? " onboarding__dot--active" : ""}`}
              aria-current={n === step ? "step" : undefined}
            />
          ))}
        </div>

        <div className="onboarding__nav">
          <button type="button" className="ghost" onClick={finish}>
            {t.obSkip}
          </button>
          <div className="actions">
            {step > 1 && (
              <button type="button" className="secondary" onClick={() => setStep(step - 1)}>
                {t.obBack}
              </button>
            )}
            {step < TOTAL_STEPS ? (
              <button type="button" className="primary" onClick={() => setStep(step + 1)}>
                {t.obNext}
              </button>
            ) : (
              <button type="button" className="primary" onClick={finish}>
                {t.obDone}
              </button>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
