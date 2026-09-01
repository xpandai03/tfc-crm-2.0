/**
 * Multi-step shell for the public survey.
 * ============================================================================
 *
 * Ported from the DrSnip intake app's components/MultiStepForm.tsx (read-only
 * reference), which is itself the refined version of the CJC intake pattern.
 * What transferred: the FormScreen contract ({ id, title, description?, render,
 * isValid }), the single stepIndex + direction + submitState machine, the
 * step-counter-plus-bar progress, free unconditional Back, and a success screen
 * that replaces the wizard.
 *
 * THREE DELIBERATE CHANGES FROM THE SIBLING:
 *
 *  1. ENTER ADVANCES, BUT NEVER SUBMITS. DrSnip's Enter handler advances the
 *     wizard AND submits on the last screen. Advancing is what was asked for
 *     here; submitting is not, and it is the one action on this form that
 *     cannot be taken back — a stray Enter on the last screen would file a
 *     response to the client's record. So Enter is inert on the final screen
 *     and Submit stays an explicit press.
 *
 *     The skip-a-screen hazard that argued against Enter at all is handled by
 *     the same guard the Continue button uses: Enter calls advance() only when
 *     current.isValid() is true, which requires EVERY question on the screen to
 *     be answered. It cannot move past an unanswered question. e.repeat is
 *     ignored so a held key cannot walk several screens at once.
 *
 *     Registered ONCE against a ref holding the latest state, rather than
 *     DrSnip's dependency-free effect that re-attached a document listener on
 *     every render.
 *
 *  2. FOOTER IS NOT FIXED ON SMALL SCREENS. DrSnip pins its nav to the bottom
 *     of the viewport. A lobby QR code means most submissions here are on a
 *     phone, and a pinned bar sits under or over the software keyboard when the
 *     comments field has focus. See .nav in survey.css.
 *
 *  3. INLINE ERROR BANNER, NOT A TOAST. DrSnip uses `sonner`, which is not a
 *     dependency of this repo, and the CRM's Radix toaster lives under
 *     client/src — off limits to this bundle. A banner above the card is also
 *     simply better here: it stays on screen while the client retries.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";

export type FormScreen = {
  id: string;
  title: string;
  description?: string;
  render: () => ReactNode;
  isValid: () => boolean;
};

/**
 * White-on-transparent wordmark, imported so it goes through THIS bundle's
 * asset pipeline and is emitted to /survey-assets/. Previously the header
 * pointed at /tfc-logo.jpg — the blue-on-white file the CRM serves via
 * server/auth.ts's publicAssets list — which rendered as a white rectangle on
 * the navy banner. Importing it also means the survey no longer depends on that
 * allow-list entry at all; nothing was added to auth.ts.
 */
import logoUrl from "./assets/tfc-logo-white.png";

const variants = {
  enter: (direction: number) => ({ x: direction > 0 ? 28 : -28, opacity: 0 }),
  center: { x: 0, opacity: 1 },
  exit: (direction: number) => ({ x: direction < 0 ? 28 : -28, opacity: 0 }),
};

export function MultiStepForm({
  screens,
  modalityLabel,
  onSubmit,
  successNode,
  isComplete,
}: {
  screens: FormScreen[];
  modalityLabel: string;
  /** Resolves true when the response was stored. */
  onSubmit: () => Promise<{ ok: true } | { ok: false; message: string }>;
  successNode: ReactNode;
  /** Lifted so the parent can clear its saved draft exactly once. */
  isComplete: boolean;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [direction, setDirection] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingRef = useRef<HTMLDivElement | null>(null);

  const total = screens.length;
  const current = screens[stepIndex];
  const isLast = stepIndex === total - 1;

  // Move focus to the new screen's heading on every step change so a keyboard
  // or screen-reader user is not left at the bottom of the previous screen.
  // Skipped on first paint.
  const firstPaint = useRef(true);
  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    headingRef.current?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [stepIndex]);

  const canProceed = current.isValid() && !submitting;

  const handleNext = async () => {
    if (!canProceed) return;
    if (!isLast) {
      setError(null);
      setDirection(1);
      setStepIndex((i) => i + 1);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSubmit();
      if (!result.ok) setError(result.message);
    } catch {
      setError("We could not save your response just now. Please try again.");
    } finally {
      // Left on the last screen with every answer intact when a submit fails.
      // Losing twelve answers to a network blip means the client does not start
      // again.
      setSubmitting(false);
    }
  };

  const handleBack = () => {
    if (stepIndex === 0 || submitting) return;
    setError(null);
    setDirection(-1);
    setStepIndex((i) => i - 1);
  };

  // Enter advances the screen once its questions are answered, so the Continue
  // button is optional rather than mandatory. See change (1) in the header note
  // for why it stops short of submitting.
  //
  // The listener is attached once and reads through a ref, so it always sees
  // the current screen without re-registering on every render.
  const latest = useRef({ canProceed, isLast, submitting, handleNext });
  latest.current = { canProceed, isLast, submitting, handleNext };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat) return;
      // Modifier combinations belong to the browser and the OS.
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;

      const active = document.activeElement as HTMLElement | null;
      // Enter in the comments box is a newline, not navigation.
      if (active?.tagName === "TEXTAREA") return;
      // Only the NAVIGATION controls are excluded, not every button: a focused
      // Back/Continue already acts on Enter and would otherwise fire twice.
      //
      // Scoping this to .nav matters. Guarding on tagName === "BUTTON" instead
      // would break the two scale screens, where the last thing the client
      // touches is a 0-10 button — focus rests on it, and Enter would silently
      // do nothing on exactly the screens where "pick an option, press Enter"
      // is the natural gesture. preventDefault() below also suppresses the
      // browser's synthesized click, so the focused scale button is not
      // re-activated on the way past.
      if (active?.closest(".nav")) return;

      const s = latest.current;
      if (s.submitting) return;
      // Never submit on Enter — the last screen requires a deliberate press.
      if (s.isLast) return;
      // Same gate as the Continue button: every question on this screen must be
      // answered, so Enter can never skip past one.
      if (!s.canProceed) return;

      e.preventDefault();
      void s.handleNext();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Placed AFTER every hook, not before them: an early return above a hook call
  // changes the hook order between renders, which React forbids.
  if (isComplete) {
    return (
      <Shell modalityLabel={modalityLabel}>
        <div className="card">{successNode}</div>
      </Shell>
    );
  }

  return (
    <Shell modalityLabel={modalityLabel}>
      <div className="progress">
        <div className="progress__label">
          <span>
            Step {stepIndex + 1} of {total}
          </span>
          <span>{Math.round(((stepIndex + 1) / total) * 100)}%</span>
        </div>
        <div
          className="progress__track"
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={total}
          aria-valuenow={stepIndex + 1}
          aria-label="Survey progress"
        >
          <motion.div
            className="progress__fill"
            initial={false}
            animate={{ width: `${((stepIndex + 1) / total) * 100}%` }}
            transition={{ duration: 0.35, ease: "easeInOut" }}
          />
        </div>
      </div>

      {error && (
        <div className="banner" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        <AnimatePresence mode="wait" custom={direction} initial={false}>
          <motion.div
            key={current.id}
            custom={direction}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <div ref={headingRef} tabIndex={-1} style={{ outline: "none" }}>
              <h1 className="card__title">{current.title}</h1>
            </div>
            {current.description && (
              <p className="card__description">{current.description}</p>
            )}
            <div className="fields">{current.render()}</div>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="nav">
        {stepIndex > 0 ? (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={handleBack}
            disabled={submitting}
          >
            Back
          </button>
        ) : (
          <span className="nav__spacer" />
        )}
        <button
          type="button"
          className="btn btn--primary"
          onClick={handleNext}
          disabled={!canProceed}
        >
          {submitting ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Sending…
            </>
          ) : isLast ? (
            "Submit"
          ) : (
            "Continue"
          )}
        </button>
      </div>
    </Shell>
  );
}

function Shell({
  modalityLabel,
  children,
}: {
  modalityLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      {/* Centred masthead: wordmark, then the modality beneath it. The label
          sat right of a left-aligned logo before; against a CENTRED logo an
          off-centre label reads as a mistake, and on a 390px screen the two
          nearly touch. Stacking keeps one axis of symmetry at every width and
          keeps the modality legible, which matters — it is how a client can
          tell they are filling in the right form. */}
      <header className="shell__header">
        <div className="shell__header-inner">
          <img className="shell__logo" src={logoUrl} alt="The Family Connection" />
          <span className="shell__modality">{modalityLabel}</span>
        </div>
      </header>
      <main className="shell__main">{children}</main>
      <p className="footer-note">The Family Connection &middot; Albuquerque, New Mexico</p>
    </div>
  );
}
