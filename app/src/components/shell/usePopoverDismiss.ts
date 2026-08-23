import { useEffect, type RefObject } from "react";

/**
 * The two ways a popover closes that the browser does not give a `<details>` for free
 * (V06-R2a, D-078): **Escape**, and a **pointer press outside it**.
 *
 * Everything else about the disclosure is the element's own — the summary is the toggle, it
 * is a tab stop, Enter and Space open it, the open state is announced. That is the whole
 * reason these are `<details>` and not a hand-rolled menu: four popovers, none of which had
 * to re-implement keyboard behaviour.
 *
 * ## `composedPath()`, and why a plain `contains()` is wrong here
 *
 * The «Kilder» panel holds one `<select>` per file row and the shelf holds one per unplaced
 * clip. A native `<select>` renders its option list in the browser's own popup layer, NOT as
 * a descendant of the `<select>` in the document — so `el.contains(event.target)` answers
 * "outside" for a press on an option and the panel closes underneath the operator's hand,
 * mid-choice, in the one interaction the popover exists to support. `composedPath()` is the
 * event's real journey, which includes the host element the popup belongs to, so the press
 * resolves as inside.
 *
 * `pointerdown` rather than `click`: the press is what the operator experiences as
 * "dismissing", and a `click` listener fires after `mouseup`, which is late enough that a
 * press-drag-release starting inside the panel and ending outside it would be read as a
 * dismissal of a gesture that never left.
 *
 * The listeners are attached for the popover's whole life and read `open` themselves, rather
 * than being added and removed as it opens. Two document listeners per popover with an early
 * return is cheaper than a `toggle`-driven subscription, and it cannot get out of step with
 * an element the browser is also toggling on its own.
 */
export function usePopoverDismiss(ref: RefObject<HTMLDetailsElement | null>): void {
  useEffect(() => {
    const close = () => {
      const el = ref.current;
      if (el && el.open) el.open = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      const el = ref.current;
      if (!el || !el.open) return;
      if (event.composedPath().includes(el)) return;
      el.open = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const el = ref.current;
      if (!el || !el.open) return;
      // The summary gets focus back, so the next Tab continues from the control the
      // operator opened rather than from the top of the document.
      const summary = el.querySelector("summary");
      close();
      if (summary instanceof HTMLElement) summary.focus();
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref]);
}
