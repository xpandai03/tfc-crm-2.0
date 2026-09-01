/**
 * Field primitives for the public survey.
 *
 * Self-contained by design: nothing here imports from client/src, so the public
 * bundle cannot pull in the CRM's component tree (and through it
 * shared/access-control.ts). See main.tsx for the full reasoning.
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { PublicProvider } from "./api";

export function Label({
  htmlFor,
  children,
  required,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <label className="field__label" htmlFor={htmlFor}>
      {children}
      {required && (
        <span className="field__required" aria-hidden="true">
          {" "}
          *
        </span>
      )}
      {hint && <span className="field__hint">{hint}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  error,
  required,
  hint,
  type = "text",
  maxLength,
  autoComplete,
  inputMode,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  required?: boolean;
  hint?: string;
  type?: "text" | "email" | "date";
  maxLength?: number;
  autoComplete?: string;
  inputMode?: "text" | "email";
  placeholder?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div>
      <Label htmlFor={id} required={required} hint={hint}>
        {label}
      </Label>
      <input
        id={id}
        className="input"
        type={type}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  maxLength,
  rows,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  rows?: number;
  hint?: string;
}) {
  const id = useId();
  const remaining = maxLength - value.length;
  // Only surface the counter as the limit gets close — a visible countdown from
  // 2000 reads as a demand for length.
  const showCount = remaining <= 200;
  return (
    <div>
      <Label htmlFor={id} hint={hint}>
        {label}
      </Label>
      <textarea
        id={id}
        className="textarea"
        rows={rows ?? 4}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {showCount && (
        <span className="char-count">{remaining} characters left</span>
      )}
    </div>
  );
}

/**
 * Single-select. Rendered as native radios so keyboard and screen-reader
 * behaviour is the browser's, with the visual marker styled over the top.
 */
export function ChoiceField({
  label,
  options,
  value,
  onChange,
  required,
  name,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  name: string;
}) {
  return (
    <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <legend className="field__label" style={{ padding: 0 }}>
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </legend>
      <div className="choices">
        {options.map((option) => {
          const selected = value === option;
          return (
            <label
              key={option}
              className={`choice${selected ? " choice--selected" : ""}`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={selected}
                onChange={() => onChange(option)}
              />
              <span className="choice__marker" aria-hidden="true" />
              <span className="choice__text">{option}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * 0-10 tap row.
 *
 * DEPARTURE FROM THE SOURCE FORM, deliberate and approved as a build decision:
 * TherapyNotes renders three of these four questions as a native <select> and
 * one as an eleven-item radio list. Both hide or bury the anchor wording, which
 * is the part that tells a client what 0 and 10 actually mean. This shows both
 * anchors permanently and takes one tap. The value stored is the same integer
 * 0-10, and fullPromptText() in shared/survey-questions.ts still reproduces the
 * source's exact question text for the record.
 */
export function ScaleField({
  label,
  lowAnchor,
  highAnchor,
  value,
  onChange,
}: {
  label: string;
  lowAnchor: string;
  highAnchor: string;
  value: number | null;
  onChange: (v: number) => void;
}) {
  const groupId = useId();
  return (
    <div role="group" aria-labelledby={groupId}>
      <span className="field__label" id={groupId}>
        {label}
        <span className="field__required" aria-hidden="true">
          {" "}
          *
        </span>
      </span>
      <div className="scale__anchors">
        <span className="scale__anchor">{lowAnchor}</span>
        <span className="scale__anchor scale__anchor--high">{highAnchor}</span>
      </div>
      <div className="scale__row">
        {Array.from({ length: 11 }, (_, n) => (
          <button
            key={n}
            type="button"
            className={`scale__btn${value === n ? " scale__btn--selected" : ""}`}
            aria-pressed={value === n}
            aria-label={`${n} out of 10`}
            onClick={() => onChange(n)}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Therapist picker: a filter box over the live roster plus a single-select list.
 *
 * Client decision, 2026-08: one therapist, required. The TherapyNotes preview
 * showed an unmarked checkbox list; that is not what gets built.
 */
export function TherapistField({
  label,
  providers,
  value,
  onChange,
  loading,
  degraded,
}: {
  label: string;
  providers: PublicProvider[];
  value: string;
  onChange: (v: string) => void;
  loading: boolean;
  degraded: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return providers;
    return providers.filter((p) => p.label.toLowerCase().includes(q));
  }, [providers, query]);

  if (loading) {
    return (
      <div>
        <span className="field__label">
          {label}
          <span className="field__required" aria-hidden="true"> *</span>
        </span>
        <div className="picker__empty">Loading the list of therapists…</div>
      </div>
    );
  }

  // Honest empty state rather than a crash — the roster endpoint answers 200
  // with an empty list when the lookup fails, so this covers both "none active"
  // and "lookup degraded".
  if (providers.length === 0) {
    return (
      <div>
        <span className="field__label">
          {label}
          <span className="field__required" aria-hidden="true"> *</span>
        </span>
        <div className="picker__empty">
          {degraded
            ? "We could not load the list of therapists just now. Please reload the page, or contact the office and we will take your feedback directly."
            : "No therapists are listed at the moment. Please contact the office and we will take your feedback directly."}
        </div>
      </div>
    );
  }

  return (
    <div>
      <Label htmlFor={searchId} required>
        {label}
      </Label>
      <input
        id={searchId}
        className="input picker__search"
        type="search"
        value={query}
        placeholder="Start typing a name…"
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="picker__list" role="radiogroup" aria-label={label}>
        {filtered.length === 0 ? (
          <div className="picker__empty">No therapist matches that name.</div>
        ) : (
          filtered.map((p) => {
            const selected = value === p.label;
            return (
              <label
                key={p.label}
                className={`choice${selected ? " choice--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="therapist"
                  value={p.label}
                  checked={selected}
                  onChange={() => onChange(p.label)}
                />
                <span className="choice__marker" aria-hidden="true" />
                <span className="choice__text">{p.label}</span>
              </label>
            );
          })
        )}
      </div>
      <div className="picker__count">
        {query.trim()
          ? `${filtered.length} of ${providers.length} shown`
          : `${providers.length} therapists`}
      </div>
    </div>
  );
}

/** Animated conditional block for the source's "If no, please explain" boxes. */
export function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className="reveal"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
