"use client";

import { useEffect, useId, useRef } from "react";

/**
 * A question mark that opens a plain-language explanation of the thing next
 * to it.
 *
 * Built on the native popover API rather than a hand-rolled dropdown, which
 * buys three things worth having: Escape and click-outside both dismiss it,
 * focus returns to the question mark when it closes, and the panel renders in
 * the browser's top layer — so it is not clipped by the `overflow-hidden` on
 * the stage, which is exactly where the first of these lives.
 *
 * The browser will not move focus into a popover on its own, so the toggle
 * handler does it: without that, opening this with a screen reader would
 * announce nothing at all.
 */
export function Explainer({
  label,
  title,
  children,
}: {
  /** The question this answers — the trigger's accessible name. */
  label: string;
  title: string;
  children: React.ReactNode;
}) {
  const reactId = useId();
  const popId = `explain-${reactId.replace(/[^a-zA-Z0-9-]/g, "")}`;
  const titleId = `${popId}-title`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pop = popRef.current;
    const trigger = triggerRef.current;
    if (!pop || !trigger) return;

    const place = () => {
      // Cheap guard: scroll fires constantly and the panel is usually closed.
      if (!pop.matches(":popover-open")) return;

      const anchor = trigger.getBoundingClientRect();
      const { offsetWidth: width, offsetHeight: height } = pop;
      const gap = 10;
      const edge = 12;

      const centred = anchor.left + anchor.width / 2 - width / 2;
      const left = Math.max(edge, Math.min(centred, window.innerWidth - width - edge));

      // Below the dot when it fits, flipped above when it does not.
      const below = anchor.bottom + gap;
      const top =
        below + height <= window.innerHeight - edge
          ? below
          : Math.max(edge, anchor.top - height - gap);

      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
    };

    const onToggle = (event: Event) => {
      if ((event as Event & { newState?: string }).newState !== "open") return;
      place();
      pop.focus();
    };

    pop.addEventListener("toggle", onToggle);
    window.addEventListener("resize", place);
    // Capture phase, so scrolling any ancestor keeps the panel on its anchor.
    window.addEventListener("scroll", place, true);
    return () => {
      pop.removeEventListener("toggle", onToggle);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, []);

  return (
    <>
      <button ref={triggerRef} type="button" popoverTarget={popId} className="explain-dot">
        {/* The name goes in the hidden span rather than aria-label: a visible
            "?" with a different accessible name would put the two out of step
            for anyone speaking the label out loud. */}
        <span aria-hidden>?</span>
        <span className="sr-only">{label}</span>
      </button>

      <div
        ref={popRef}
        id={popId}
        popover="auto"
        tabIndex={-1}
        role="dialog"
        aria-labelledby={titleId}
        className="explain-pop"
      >
        {/* Styled as a heading but deliberately a <p>: a real heading here
            would land out of order in the document outline. */}
        <p id={titleId} className="explain-pop-title">
          {title}
        </p>
        {children}
      </div>
    </>
  );
}
