/**
 * The seven survey screens.
 *
 * Both variants are built from the SAME question definition
 * (shared/survey-questions.ts). Nothing about a question's wording, its options
 * or its conditional explanation box is written here — this file only decides
 * which slots share a screen. Two hand-written forms would drift; one
 * definition with a modality-swapped middle block cannot.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLIENT_EMAIL_MAX,
  CLIENT_NAME_MAX,
  MODALITY_FOR_VARIANT,
  SURVEY_VERSION,
  dateOfBirthProblem,
  questionsFor,
  type ChoiceQuestion,
  type ScaleQuestion,
  type SurveyQuestion,
  type SurveyVariant,
  type TextQuestion,
} from "@shared/survey-questions";
import { MultiStepForm, type FormScreen } from "./MultiStepForm";
import {
  ChoiceField,
  Reveal,
  ScaleField,
  TextAreaField,
  TextField,
  TherapistField,
} from "./fields";
import { fetchRoster, submitSurvey, type PublicProvider } from "./api";

/** Which slots share a screen. Client asked for two to three questions each. */
const SCREEN_SLOTS: number[][] = [
  [2, 3], // screen 3 — modality specific
  [4, 5, 6], // screen 4
  [7, 8], // screen 5
  [9, 10], // screen 6
  [11, 12], // screen 7
];

type AnswerValue = string | number;

interface Draft {
  client: { name: string; dateOfBirth: string; email: string };
  answers: Record<string, AnswerValue>;
}

const emptyDraft = (): Draft => ({
  client: { name: "", dateOfBirth: "", email: "" },
  answers: {},
});

/**
 * In-progress answers live in React state, mirrored to sessionStorage so an
 * accidental reload does not lose the run.
 *
 * sessionStorage, NOT the server and NOT localStorage: it is scoped to the tab
 * and cleared when the tab closes, so a shared lobby phone does not hand the
 * next person the previous client's half-finished answers. Nothing partial is
 * ever sent — storing partials would mean holding identified PHI for people who
 * chose not to submit.
 */
function draftKey(variant: SurveyVariant): string {
  return `tfc-survey-draft-${variant}-v${SURVEY_VERSION}`;
}

function loadDraft(variant: SurveyVariant): Draft {
  try {
    const raw = sessionStorage.getItem(draftKey(variant));
    if (!raw) return emptyDraft();
    const parsed = JSON.parse(raw) as Partial<Draft>;
    return {
      client: {
        name: String(parsed.client?.name ?? ""),
        dateOfBirth: String(parsed.client?.dateOfBirth ?? ""),
        email: String(parsed.client?.email ?? ""),
      },
      answers:
        parsed.answers && typeof parsed.answers === "object"
          ? (parsed.answers as Record<string, AnswerValue>)
          : {},
    };
  } catch {
    // Private browsing, disabled storage, or corrupt JSON. Start clean rather
    // than break the form.
    return emptyDraft();
  }
}

function saveDraft(variant: SurveyVariant, draft: Draft): void {
  try {
    sessionStorage.setItem(draftKey(variant), JSON.stringify(draft));
  } catch {
    /* storage unavailable — the form still works, it just won't survive a reload */
  }
}

function clearDraft(variant: SurveyVariant): void {
  try {
    sessionStorage.removeItem(draftKey(variant));
  } catch {
    /* nothing to do */
  }
}

export function SurveyForm({ variant }: { variant: SurveyVariant }) {
  const questions = useMemo(() => questionsFor(variant), [variant]);
  const bySlot = useMemo(() => {
    const map = new Map<number, SurveyQuestion>();
    for (const q of questions) map.set(q.slot, q);
    return map;
  }, [questions]);

  const [draft, setDraft] = useState<Draft>(() => loadDraft(variant));
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterDegraded, setRosterDegraded] = useState(false);
  const [complete, setComplete] = useState(false);

  /** Captured once, at first paint — the server's minimum-completion check. */
  const formLoadedAt = useRef<number>(Date.now());
  /** Honeypot. Never labelled, never focusable by a person. */
  const [company, setCompany] = useState("");

  useEffect(() => {
    let live = true;
    fetchRoster()
      .then((r) => {
        if (!live) return;
        setProviders(r.providers);
        setRosterDegraded(r.degraded);
      })
      .catch(() => {
        if (live) setRosterDegraded(true);
      })
      .finally(() => {
        if (live) setRosterLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    saveDraft(variant, draft);
  }, [variant, draft]);

  const setAnswer = useCallback((key: string, value: AnswerValue) => {
    setDraft((d) => ({ ...d, answers: { ...d.answers, [key]: value } }));
  }, []);

  const setClient = useCallback(
    (patch: Partial<Draft["client"]>) => {
      setDraft((d) => ({ ...d, client: { ...d.client, ...patch } }));
    },
    [],
  );

  const answerOf = (key: string): string =>
    typeof draft.answers[key] === "string" ? (draft.answers[key] as string) : "";
  const scaleOf = (key: string): number | null =>
    typeof draft.answers[key] === "number" ? (draft.answers[key] as number) : null;

  // --- identity validation --------------------------------------------------
  //
  // dateOfBirthProblem is the SAME function the server re-runs
  // (server/survey/schema.ts -> serverDateOfBirthProblem), so the form and the
  // endpoint cannot disagree about what counts as a valid date.
  //
  // A message is shown only once a field has something in it. An empty required
  // field is already communicated by the disabled Continue button and the
  // required marker; an error under a field the client has not reached yet
  // reads as an accusation. A future or implausibly old date DOES get a
  // message, because there the client typed something and needs to know why it
  // is being refused.
  const nameProblem = draft.client.name.trim() ? null : "Please enter your name.";
  const dobProblem = dateOfBirthProblem(draft.client.dateOfBirth, new Date());
  const emailProblem =
    draft.client.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.client.email.trim())
      ? "Please check that email address."
      : null;
  const shown = (value: string, problem: string | null) =>
    value.trim() ? problem : null;

  // --- renderers ------------------------------------------------------------

  const renderQuestion = (q: SurveyQuestion) => {
    switch (q.kind) {
      case "therapist":
        return (
          <TherapistField
            key={q.key}
            label={q.prompt}
            providers={providers}
            value={answerOf(q.key)}
            onChange={(v) => setAnswer(q.key, v)}
            loading={rosterLoading}
            degraded={rosterDegraded}
          />
        );

      case "choice": {
        const cq = q as ChoiceQuestion;
        const value = answerOf(cq.key);
        return (
          <div key={cq.key}>
            <ChoiceField
              name={cq.key}
              label={cq.prompt}
              options={cq.options}
              value={value}
              onChange={(v) => setAnswer(cq.key, v)}
              required={cq.required}
            />
            {cq.explain && (
              // Stays OPTIONAL, matching the source form. A required-looking box
              // the client's instrument does not require is a change to the
              // instrument.
              <Reveal show={value === cq.explain.revealOn}>
                <TextAreaField
                  label={cq.explain.prompt}
                  hint="Optional"
                  rows={3}
                  maxLength={cq.explain.maxLength}
                  value={answerOf(cq.explain.key)}
                  onChange={(v) => setAnswer(cq.explain!.key, v)}
                />
              </Reveal>
            )}
          </div>
        );
      }

      case "scale": {
        const sq = q as ScaleQuestion;
        return (
          <ScaleField
            key={sq.key}
            label={sq.prompt}
            lowAnchor={sq.lowAnchor}
            highAnchor={sq.highAnchor}
            value={scaleOf(sq.key)}
            onChange={(v) => setAnswer(sq.key, v)}
          />
        );
      }

      case "text": {
        const tq = q as TextQuestion;
        return (
          <TextAreaField
            key={tq.key}
            label={tq.prompt}
            hint="Optional"
            maxLength={tq.maxLength}
            value={answerOf(tq.key)}
            onChange={(v) => setAnswer(tq.key, v)}
          />
        );
      }
    }
  };

  const slotIsAnswered = (slot: number): boolean => {
    const q = bySlot.get(slot);
    if (!q) return true;
    if (!q.required) return true;
    if (q.kind === "scale") return scaleOf(q.key) !== null;
    return answerOf(q.key).trim() !== "";
  };

  // --- screens --------------------------------------------------------------

  const screens: FormScreen[] = [
    {
      id: "identity",
      title: "First, who are you?",
      description:
        "So we can connect your feedback to your record. We only use it for that.",
      render: () => (
        <>
          <p className="privacy-note">
            Your answers go to The Family Connection&rsquo;s care team. They are
            not shared outside the practice.
          </p>
          <TextField
            label="Your full name"
            required
            value={draft.client.name}
            maxLength={CLIENT_NAME_MAX}
            autoComplete="name"
            onChange={(v) => setClient({ name: v })}
            error={shown(draft.client.name, nameProblem)}
          />
          <TextField
            label="Date of birth"
            required
            type="date"
            value={draft.client.dateOfBirth}
            onChange={(v) => setClient({ dateOfBirth: v })}
            error={shown(draft.client.dateOfBirth, dobProblem)}
          />
          <TextField
            label="Email address"
            hint="Optional — only if you would like us to be able to reach you."
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={CLIENT_EMAIL_MAX}
            value={draft.client.email}
            onChange={(v) => setClient({ email: v })}
            error={emailProblem}
          />
          {/* Honeypot. Hidden from sight and from the tab order; a person never
              reaches it, a form-filling bot does. The server answers a filled
              value with success and stores nothing. */}
          <div className="hp" aria-hidden="true">
            <label htmlFor="company-hp">Company</label>
            <input
              id="company-hp"
              name="company"
              type="text"
              tabIndex={-1}
              autoComplete="off"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
            />
          </div>
        </>
      ),
      isValid: () => !nameProblem && !dobProblem && !emailProblem,
    },
    {
      id: "therapist",
      title: "Who did you see?",
      render: () => <>{renderQuestion(bySlot.get(1)!)}</>,
      isValid: () => slotIsAnswered(1),
    },
    ...SCREEN_SLOTS.map((slots, i): FormScreen => {
      const qs = slots.map((s) => bySlot.get(s)).filter(Boolean) as SurveyQuestion[];
      return {
        id: `slots-${slots.join("-")}`,
        title: SCREEN_TITLES[i],
        description: SCREEN_DESCRIPTIONS[i],
        render: () => <>{qs.map(renderQuestion)}</>,
        isValid: () => slots.every(slotIsAnswered),
      };
    }),
  ];

  const onSubmit = async () => {
    const answers: Record<string, AnswerValue> = {};
    for (const q of questions) {
      const v = draft.answers[q.key];
      if (v !== undefined && v !== "") answers[q.key] = v;
      if (q.kind === "choice" && q.explain) {
        const explain = draft.answers[q.explain.key];
        // Only send an explanation that still belongs to the answer revealing
        // it, so switching "No" back to "Yes" cannot leave orphaned free text.
        if (v === q.explain.revealOn && typeof explain === "string" && explain.trim()) {
          answers[q.explain.key] = explain;
        }
      }
    }

    const result = await submitSurvey(variant, {
      surveyVersion: SURVEY_VERSION,
      client: {
        name: draft.client.name.trim(),
        dateOfBirth: draft.client.dateOfBirth.trim(),
        ...(draft.client.email.trim() ? { email: draft.client.email.trim() } : {}),
      },
      answers,
      formLoadedAt: formLoadedAt.current,
      ...(company ? { company } : {}),
    });

    if (result.ok) {
      clearDraft(variant);
      setComplete(true);
      return { ok: true as const };
    }
    return { ok: false as const, message: result.message };
  };

  // Whether the client asked to be contacted — the only answer the confirmation
  // screen reflects, and only as a sentence about what happens next.
  const followUpRequested = answerOf("followUpRequested") === "Yes";

  return (
    <MultiStepForm
      screens={screens}
      modalityLabel={MODALITY_FOR_VARIANT[variant]}
      onSubmit={onSubmit}
      isComplete={complete}
      successNode={<Confirmation followUpRequested={followUpRequested} />}
    />
  );
}

const SCREEN_TITLES = [
  "Getting started",
  "Your time and privacy",
  "You and your therapist",
  "Approach and overall",
  "Anything else",
];

const SCREEN_DESCRIPTIONS: (string | undefined)[] = [
  undefined,
  undefined,
  "Zero to ten, whatever feels right.",
  "Two more, then you are done.",
  undefined,
];

/**
 * Confirmation.
 *
 * Thanks, and a line about follow-up only when it was asked for. No answers, no
 * name, no scores, no submission id: a lobby device is shared, and whatever is
 * on this screen is visible to whoever picks the phone up next.
 */
function Confirmation({ followUpRequested }: { followUpRequested: boolean }) {
  return (
    <div className="done">
      <div className="done__mark" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h1 className="done__title">Thank you &mdash; your feedback has been recorded.</h1>
      <p className="done__body">
        We read every response. It helps us take better care of the people we see.
      </p>
      {followUpRequested && (
        <p className="done__body">
          You asked us to follow up, and someone from our team will reach out.
        </p>
      )}
      <p className="done__body">You can close this page now.</p>
    </div>
  );
}
