import type { Banner as BannerModel } from "../state";
import type { Strings } from "../i18n";

/**
 * Status banners, announced to assistive tech.
 *
 * The live region exists even when empty — screen readers only announce changes inside
 * a region that was already in the accessibility tree, so conditionally mounting the
 * region itself would silence the very first message.
 */
export function BannerRegion({
  t,
  banner,
  onDismiss,
}: {
  t: Strings;
  banner: BannerModel | null;
  onDismiss: () => void;
}) {
  return (
    <div aria-live="polite">
      {banner && (
        <p className={`banner banner--${banner.kind}`} role={banner.kind === "error" ? "alert" : undefined}>
          <span>{banner.text}</span>
          <button
            type="button"
            className="iconbtn banner__dismiss"
            onClick={onDismiss}
            aria-label={t.close}
          >
            ✕
          </button>
        </p>
      )}
    </div>
  );
}
