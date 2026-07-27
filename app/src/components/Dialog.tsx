import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Minimal accessible modal: focus moves in on open, Tab wraps, Escape and backdrop
 * close, and focus returns to the opener on close. No library — the trap is ~20 lines,
 * and a dependency would be the only thing in the app needing an audit for it.
 */
export function Dialog({
  titleId,
  onClose,
  closeLabel,
  dismissable = true,
  children,
}: {
  titleId: string;
  onClose: () => void;
  closeLabel: string;
  /** Onboarding sets false for its final step navigation (skip is its own button). */
  dismissable?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const node = ref.current;
    if (!node) return;

    // Move focus to the first focusable thing inside, or the dialog itself.
    const focusables = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled"));
    (focusables()[0] ?? node).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, [onClose, dismissable]);

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {dismissable && (
          <button type="button" className="iconbtn dialog__close" onClick={onClose} aria-label={closeLabel}>
            ✕
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
