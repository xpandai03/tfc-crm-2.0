/**
 * Field primitives for the public survey.
 *
 * Self-contained by design: nothing here imports from client/src, so the public
 * bundle cannot pull in the CRM's component tree (and through it
 * shared/access-control.ts). See main.tsx for the full reasoning.
 */

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  DOB_PART_MAX,
  composeDob,
  dobPartInput,
  dobParts,
  type DobParts,
} from "@shared/survey-questions";
import type { UiKey } from "@shared/survey-copy.es";
import type { PublicProvider } from "./api";
import { optionLabel, ui, type SurveyLanguage } from "./i18n";

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
  type?: "text" | "email" | "tel";
  maxLength?: number;
  autoComplete?: string;
  inputMode?: "text" | "email" | "tel";
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

/**
 * Date of birth as three number boxes (month, day, year), not <input type="date">.
 * See the "three boxes" note in shared/survey-questions.ts for why.
 *
 * The boxes keep their own text. A change from the parent (a restored draft)
 * replaces them only when it differs from what they already make, so a partly
 * typed year is never rewritten mid-entry. A language switch re-renders the
 * labels and leaves the boxes alone.
 *
 * An error shows once focus leaves all three boxes, or once every box is full.
 * A message under a year that is two digits in would only interrupt.
 */
export function DateOfBirthField({
  label,
  value,
  onChange,
  error,
  required,
  lang,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  required?: boolean;
  lang: SurveyLanguage;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [parts, setParts] = useState<DobParts>(() => dobParts(value));
  const [left, setLeft] = useState(() => value.trim() !== "");
  const refs = { month: useRef<HTMLInputElement>(null), day: useRef<HTMLInputElement>(null), year: useRef<HTMLInputElement>(null) };

  useEffect(() => {
    if (value !== composeDob(parts)) setParts(dobParts(value));
    // Only an outside change to `value` should reach the boxes.
  }, [value]);

  const full = (Object.keys(DOB_PART_MAX) as (keyof DobParts)[])
    .every((k) => parts[k].length === DOB_PART_MAX[k]);
  const shownError = error && (left || full) ? error : null;

  const set = (part: keyof DobParts, raw: string) => {
    const next = { ...parts, [part]: dobPartInput(part, raw) };
    setParts(next);
    onChange(composeDob(next));
    // A full month or day moves on to the next box, as a printed form would.
    if (next[part].length === DOB_PART_MAX[part] && next[part] !== parts[part]) {
      if (part === "month") refs.day.current?.focus();
      if (part === "day") refs.year.current?.focus();
    }
  };

  const box = (part: keyof DobParts, labelKey: UiKey, placeholderKey: UiKey, autoComplete: string) => (
    <div className={`dob__part dob__part--${part}`}>
      <label className="dob__label" htmlFor={`${id}-${part}`}>{ui(labelKey, lang)}</label>
      <input
        ref={refs[part]}
        id={`${id}-${part}`}
        name={`dob-${part}`}
        className="input"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        placeholder={ui(placeholderKey, lang)}
        // No maxLength: it would cut a paste such as "1985." before the
        // digits are picked out. dobPartInput enforces the length instead.
        value={parts[part]}
        aria-invalid={shownError ? "true" : undefined}
        aria-describedby={shownError ? errorId : undefined}
        onChange={(e) => set(part, e.target.value)}
      />
    </div>
  );

  return (
    <fieldset
      className="dob"
      data-dob
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLeft(true);
      }}
    >
      <legend className="field__label">
        {label}
        {required && (
          <span className="field__required" aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </legend>
      <div className="dob__row">
        {box("month", "dobMonthLabel", "dobMonthPlaceholder", "bday-month")}
        {box("day", "dobDayLabel", "dobDayPlaceholder", "bday-day")}
        {box("year", "dobYearLabel", "dobYearPlaceholder", "bday-year")}
      </div>
      {shownError && (
        <span className="field__error" id={errorId} role="alert">
          {shownError}
        </span>
      )}
    </fieldset>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  maxLength,
  rows,
  hint,
  lang,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  rows?: number;
  hint?: string;
  lang: SurveyLanguage;
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
        <span className="char-count">{ui("charactersLeft", lang, { remaining })}</span>
      )}
    </div>
  );
}

/**
 * Single-select. Rendered as native radios so keyboard and screen-reader
 * behaviour is the browser's, with the visual marker styled over the top.
 *
 * VALUE AND LABEL ARE SEPARATE. `options` are the stored values (the English
 * wording); only the text a client reads goes through optionLabel(). A client
 * reading "Sí" stores "Yes", and switching language mid-form cannot change an
 * answer already given.
 */
export function ChoiceField({
  label,
  options,
  value,
  onChange,
  required,
  name,
  lang,
}: {
  label: string;
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  name: string;
  lang: SurveyLanguage;
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
              <span className="choice__text">{optionLabel(option, lang)}</span>
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
  lang,
}: {
  label: string;
  lowAnchor: string;
  highAnchor: string;
  value: number | null;
  onChange: (v: number) => void;
  lang: SurveyLanguage;
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
            aria-label={ui("scaleButtonLabel", lang, { n })}
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
  lang,
}: {
  label: string;
  providers: PublicProvider[];
  value: string;
  onChange: (v: string) => void;
  loading: boolean;
  degraded: boolean;
  lang: SurveyLanguage;
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
        <div className="picker__empty">{ui("therapistLoading", lang)}</div>
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
          {degraded ? ui("therapistDegraded", lang) : ui("therapistNone", lang)}
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
        placeholder={ui("therapistSearchPlaceholder", lang)}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="picker__list" role="radiogroup" aria-label={label}>
        {filtered.length === 0 ? (
          <div className="picker__empty">{ui("therapistNoMatch", lang)}</div>
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
          ? ui("therapistShownCount", lang, { shown: filtered.length, total: providers.length })
          : ui("therapistTotalCount", lang, { total: providers.length })}
      </div>
    </div>
  );
}

/**
 * The optional comment box that sits under every question.
 *
 * ONE MECHANISM. This REPLACED the conditional "If no, please explain" reveal
 * that used to appear under four of the Yes/No/N/A questions — that component is
 * gone, not hidden, so there is no arrangement of answers that can put two
 * comment boxes on one question.
 *
 * ALWAYS VISIBLE, never animated in. The old box slid open on a "No", which is
 * what told the client it was tied to that answer. Something that appears when
 * you say No reads as "justify yourself"; the client asked for this so people
 * can leave praise, so it has to already be there when they say Yes.
 *
 * Smaller and quieter than the question above it: two rows, the label in the
 * hint weight rather than the field weight. It should read as an offer that can
 * be walked past, which is also literally true — nothing here gates Continue.
 */
export function CommentField({
  prompt,
  value,
  onChange,
  maxLength,
  lang,
}: {
  prompt: string;
  value: string;
  onChange: (v: string) => void;
  maxLength: number;
  lang: SurveyLanguage;
}) {
  const id = useId();
  const remaining = maxLength - value.length;
  const showCount = remaining <= 150;
  return (
    <div className="comment">
      <label className="comment__label" htmlFor={id}>
        {prompt}
        <span className="comment__optional">{ui("optional", lang)}</span>
      </label>
      <textarea
        id={id}
        className="textarea textarea--comment"
        rows={2}
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
      />
      {showCount && (
        <span className="char-count">{ui("charactersLeft", lang, { remaining })}</span>
      )}
    </div>
  );
}

/**
 * Animated conditional block.
 *
 * RETAINED but currently UNUSED: the "If no, please explain" boxes it was built
 * for were retired at the 2026-09-03 client review in favour of CommentField
 * above. Kept because it is a general-purpose primitive and costs nothing;
 * AnimatePresence is already in the bundle for the step transition.
 */
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
