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
 *  1. NO ENTER-TO-ADVANCE. DrSnip registers a document keydown listener that
 *     advances the wizard on Enter. On its text-field screens that is a
 *     convenience; on a survey of radio groups it is a hazard — arrow keys move
 *     the radio selection and a stray Enter then jumps the screen, so a client
 *     can skip past questions without realising they answered. It also
 *     re-registered the listener on every render.
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

const LOGO_SRC = "/tfc-logo.jpg";

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

  if (isComplete) {
    return (
      <Shell modalityLabel={modalityLabel}>
        <div className="card">{successNode}</div>
      </Shell>
    );
  }

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
      <header className="shell__header">
        <div className="shell__header-inner">
          {/* /tfc-logo.jpg is already allow-listed for unauthenticated access in
              server/auth.ts:344-348, where it is served to email clients. */}
          <img className="shell__logo" src={LOGO_SRC} alt="The Family Connection" />
          <span className="shell__modality">{modalityLabel}</span>
        </div>
      </header>
      <main className="shell__main">{children}</main>
      <p className="footer-note">The Family Connection &middot; Albuquerque, New Mexico</p>
    </div>
  );
}
