/**
 * The seven survey screens.
 *
 * Both variants are built from the SAME question definition
 * (shared/survey-questions.ts). Nothing about a question's wording, its options
 * or whether it carries a comment box is written here — this file only decides
 * which slots share a screen. Two hand-written forms would drift; one
 * definition with a modality-swapped middle block cannot.
 *
 * IDENTITY STAYS ON ONE SCREEN. The 2026-09-03 review took the first screen
 * from two required fields to four, which was worth reconsidering. It stays as
 * one screen: name, email and phone are exactly the trio a browser or phone
 * autofills in a single gesture, and splitting them across a step boundary
 * breaks that — the client's own note was that phones autofill both and it is
 * "not a big burden". A second screen would also make eight steps of seven,
 * and the step counter is the thing telling someone in a waiting room that
 * this is short.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CLIENT_EMAIL_MAX,
  CLIENT_NAME_MAX,
  CLIENT_PHONE_MAX,
  COMMENT_MAX,
  COMMENT_PROMPT,
  LEGAL_NAME_HINT,
  MODALITY_FOR_VARIANT,
  SURVEY_VERSION,
  commentKeysFor,
  dateOfBirthProblem,
  emailProblem,
  isCommentable,
  legalNameProblem,
  phoneProblem,
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
  CommentField,
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
  client: { name: string; dateOfBirth: string; email: string; phone: string };
  answers: Record<string, AnswerValue>;
  /** Per-question free text, keyed by question key. Mirrors the stored shape. */
  comments: Record<string, string>;
}

const emptyDraft = (): Draft => ({
  client: { name: "", dateOfBirth: "", email: "", phone: "" },
  answers: {},
  comments: {},
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
        // Absent from any draft saved before 2026-09-03. Defaults to empty, and
        // the identity screen then simply asks for it.
        phone: String(parsed.client?.phone ?? ""),
      },
      answers:
        parsed.answers && typeof parsed.answers === "object"
          ? (parsed.answers as Record<string, AnswerValue>)
          : {},
      comments:
        parsed.comments && typeof parsed.comments === "object"
          ? (parsed.comments as Record<string, string>)
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

  const setComment = useCallback((key: string, value: string) => {
    setDraft((d) => ({ ...d, comments: { ...d.comments, [key]: value } }));
  }, []);

  const answerOf = (key: string): string =>
    typeof draft.answers[key] === "string" ? (draft.answers[key] as string) : "";
  const scaleOf = (key: string): number | null =>
    typeof draft.answers[key] === "number" ? (draft.answers[key] as number) : null;
  const commentOf = (key: string): string =>
    typeof draft.comments[key] === "string" ? draft.comments[key] : "";

  // --- identity validation --------------------------------------------------
  //
  // Every rule here is the SAME function the server re-runs
  // (server/survey/schema.ts -> serverIdentityProblem), so the form and the
  // endpoint cannot disagree about what is acceptable. All four are required as
  // of the 2026-09-03 review — see the identity section of the shared module.
  //
  // A message is shown only once a field has something in it. An empty required
  // field is already communicated by the disabled Continue button and the
  // required marker; an error under a field the client has not reached yet
  // reads as an accusation. A malformed value DOES get a message, because there
  // the client typed something and needs to know why it is being refused.
  const nameProblem = legalNameProblem(draft.client.name);
  const dobProblem = dateOfBirthProblem(draft.client.dateOfBirth, new Date());
  const emailIssue = emailProblem(draft.client.email);
  const phoneIssue = phoneProblem(draft.client.phone);
  const shown = (value: string, problem: string | null) =>
    value.trim() ? problem : null;

  // --- renderers ------------------------------------------------------------

  /**
   * One question plus its comment box.
   *
   * The comment is rendered HERE, once, around whatever the question itself
   * renders — not inside each branch. That is what makes "one mechanism per
   * question" structural rather than a thing to remember: there is a single
   * place a comment box can come from, and isCommentable() is the only thing
   * that decides whether it appears.
   */
  const renderQuestion = (q: SurveyQuestion) => (
    <div key={q.key} className="question">
      {renderQuestionBody(q)}
      {isCommentable(q) && (
        <CommentField
          prompt={COMMENT_PROMPT}
          maxLength={COMMENT_MAX}
          value={commentOf(q.key)}
          onChange={(v) => setComment(q.key, v)}
        />
      )}
    </div>
  );

  const renderQuestionBody = (q: SurveyQuestion) => {
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
        return (
          <ChoiceField
            name={cq.key}
            label={cq.prompt}
            options={cq.options}
            value={answerOf(cq.key)}
            onChange={(v) => setAnswer(cq.key, v)}
            required={cq.required}
          />
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
          {/* LEGAL name, said plainly on the label. The practice sees clients
              whose preferred name is the one they would type by reflex, while
              the record carries the legal name from their insurance — and a
              preferred name matches nothing, silently. The hint says which name
              and why in one sentence, without naming any reason someone might
              go by another. */}
          <TextField
            label="Your legal name"
            hint={LEGAL_NAME_HINT}
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
          {/* Required as of 2026-09-03 — it is a matching field, not a way to
              reach the client, so the old "optional, only if you want us to
              contact you" hint would now be inaccurate as well as wrong. */}
          <TextField
            label="Email address"
            required
            type="email"
            inputMode="email"
            autoComplete="email"
            maxLength={CLIENT_EMAIL_MAX}
            value={draft.client.email}
            onChange={(v) => setClient({ email: v })}
            error={shown(draft.client.email, emailIssue)}
          />
          {/* type="tel" + inputMode="tel" bring up the phone keypad rather than
              the alphabetic keyboard, and autoComplete="tel" lets the browser
              fill it alongside name and email in one gesture — which is the
              whole reason four fields on one screen is not a burden. No input
              masking: a mask fights anyone typing an extension or a country
              code, and phoneProblem() counts digits rather than caring how they
              are punctuated. */}
          <TextField
            label="Phone number"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={CLIENT_PHONE_MAX}
            value={draft.client.phone}
            onChange={(v) => setClient({ phone: v })}
            error={shown(draft.client.phone, phoneIssue)}
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
      isValid: () => !nameProblem && !dobProblem && !emailIssue && !phoneIssue,
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
    }

    // Only comments that were actually written. An empty box sends nothing, so
    // a client who wrote none sends no `comments` key at all — which is the
    // common case and keeps the row the size it was before.
    //
    // Keyed by commentKeysFor(), not by Object.keys(draft.comments): a stale
    // sessionStorage draft could hold a key for a question this variant does
    // not ask, and the server's .strict() would reject the whole submission for
    // it. Sending only what this variant can carry means a client's answers
    // survive a form change mid-run.
    const comments: Record<string, string> = {};
    for (const key of commentKeysFor(variant)) {
      const text = (draft.comments[key] ?? "").trim();
      if (text) comments[key] = text;
    }

    const result = await submitSurvey(variant, {
      surveyVersion: SURVEY_VERSION,
      client: {
        name: draft.client.name.trim(),
        dateOfBirth: draft.client.dateOfBirth.trim(),
        email: draft.client.email.trim(),
        phone: draft.client.phone.trim(),
      },
      answers,
      ...(Object.keys(comments).length > 0 ? { comments } : {}),
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

  return (
    <MultiStepForm
      screens={screens}
      modalityLabel={MODALITY_FOR_VARIANT[variant]}
      onSubmit={onSubmit}
      isComplete={complete}
      successNode={<Confirmation />}
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
 * THE WORDS BELOW ARE THE PRACTICE'S, VERBATIM. They were written internally,
 * discussed, and handed over as final copy on 2026-09-12. Do not tighten,
 * reflow or re-punctuate them.
 *
 * ONE MESSAGE FOR EVERYONE. The follow-up line used to render only when the
 * client had asked to be contacted; their copy says "If you requested a
 * follow-up" and is written to cover both cases, so the conditional is gone
 * rather than dormant and the screen no longer reads any answer at all.
 *
 * No answers, no name, no scores, no submission id: a lobby device is shared,
 * and whatever is on this screen is visible to whoever picks the phone up next.
 */
function Confirmation() {
  return (
    <div className="done">
      <div className="done__mark" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h1 className="done__title">Thank you &mdash; your feedback has been recorded!</h1>
      <p className="done__body">
        We truly appreciate you taking the time to share your experience with us.
        We read every response, and your feedback helps us learn, grow, and
        continue providing the best possible care and support to the individuals
        and families we serve.
      </p>
      <p className="done__body">
        Your voice matters and helps us continue making The Family Connection a
        place where clients feel heard, supported, and connected.
      </p>
      <p className="done__body">
        If you requested a follow-up, a member of our team will reach out to you
        soon.
      </p>
      <p className="done__body done__body--strong">
        Thank you for trusting The Family Connection to be part of your journey.
      </p>
      <p className="done__body">You may now close this page.</p>
    </div>
  );
}
