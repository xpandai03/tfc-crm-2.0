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
  SURVEY_VERSION,
  dateOfBirthProblem,
  emailProblem,
  languageFromParam,
  legalNameProblem,
  phoneProblem,
  questionsFor,
  type ChoiceQuestion,
  type ScaleQuestion,
  type SurveyLanguage,
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
import {
  DEFAULT_SURVEY_LANGUAGE,
  anchorsFor,
  confirmation,
  languageFromSearch,
  message,
  modalityLabel,
  promptFor,
  ui,
} from "./i18n";
import { buildSubmitBody, showsCommentBox, type AnswerValue, type Draft } from "./submit-body";

/** Which slots share a screen. Client asked for two to three questions each. */
const SCREEN_SLOTS: number[][] = [
  [2, 3], // screen 3 — modality specific
  [4, 5, 6], // screen 4
  [7, 8], // screen 5
  [9, 10], // screen 6
  [11, 12], // screen 7
];

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
      language: languageFromParam(parsed.language) ?? undefined,
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

  // Language: the client's own choice if this tab has one, else ?lang=es on
  // the link (a Spanish QR code), else English. It sits on the draft, so a
  // reload keeps it and submitting clears it with everything else. Switching
  // only changes labels: answers are stored by value, and every value is the
  // same in both languages.
  const [linkLanguage] = useState<SurveyLanguage | null>(() =>
    languageFromSearch(window.location.search),
  );
  const lang: SurveyLanguage = draft.language ?? linkLanguage ?? DEFAULT_SURVEY_LANGUAGE;
  const setLanguage = useCallback((language: SurveyLanguage) => {
    setDraft((d) => ({ ...d, language }));
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = ui("pageTitle", lang);
  }, [lang]);
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
    value.trim() ? message(problem, lang) : null;

  // --- renderers ------------------------------------------------------------

  /**
   * One question plus its comment box.
   *
   * The comment is rendered HERE, once, around whatever the question itself
   * renders — not inside each branch. That is what makes "one mechanism per
   * question" structural rather than a thing to remember: there is a single
   * place a comment box can come from, and showsCommentBox() is the only thing
   * that decides whether it appears.
   */
  const renderQuestion = (q: SurveyQuestion) => (
    <div key={q.key} className="question">
      {renderQuestionBody(q)}
      {showsCommentBox(q) && (
        <CommentField
          prompt={ui("commentPrompt", lang)}
          maxLength={COMMENT_MAX}
          value={commentOf(q.key)}
          onChange={(v) => setComment(q.key, v)}
          lang={lang}
        />
      )}
    </div>
  );

  const renderQuestionBody = (q: SurveyQuestion) => {
    const label = promptFor(variant, q, lang);
    switch (q.kind) {
      case "therapist":
        return (
          <TherapistField
            key={q.key}
            label={label}
            providers={providers}
            value={answerOf(q.key)}
            onChange={(v) => setAnswer(q.key, v)}
            loading={rosterLoading}
            degraded={rosterDegraded}
            lang={lang}
          />
        );

      case "choice": {
        const cq = q as ChoiceQuestion;
        return (
          <ChoiceField
            name={cq.key}
            label={label}
            options={cq.options}
            value={answerOf(cq.key)}
            onChange={(v) => setAnswer(cq.key, v)}
            required={cq.required}
            lang={lang}
          />
        );
      }

      case "scale": {
        const sq = q as ScaleQuestion;
        const anchors = anchorsFor(sq, lang);
        return (
          <ScaleField
            key={sq.key}
            label={label}
            lowAnchor={anchors.low}
            highAnchor={anchors.high}
            value={scaleOf(sq.key)}
            onChange={(v) => setAnswer(sq.key, v)}
            lang={lang}
          />
        );
      }

      case "text": {
        const tq = q as TextQuestion;
        return (
          <TextAreaField
            key={tq.key}
            label={label}
            hint={ui("optional", lang)}
            maxLength={tq.maxLength}
            value={answerOf(tq.key)}
            onChange={(v) => setAnswer(tq.key, v)}
            lang={lang}
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
      title: ui("identityTitle", lang),
      description: ui("identityDescription", lang),
      render: () => (
        <>
          <p className="privacy-note">{ui("privacyNote", lang)}</p>
          {/* LEGAL name, said plainly on the label. The practice sees clients
              whose preferred name is the one they would type by reflex, while
              the record carries their legal name — and a preferred name
              matches nothing, silently. The hint says which name and why in one
              sentence, without naming any reason someone might go by another.
              It no longer mentions an insurance card (client request,
              2026-09-23). */}
          <TextField
            label={ui("legalNameLabel", lang)}
            hint={ui("legalNameHint", lang)}
            required
            value={draft.client.name}
            maxLength={CLIENT_NAME_MAX}
            autoComplete="name"
            onChange={(v) => setClient({ name: v })}
            error={shown(draft.client.name, nameProblem)}
          />
          <TextField
            label={ui("dateOfBirthLabel", lang)}
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
            label={ui("emailLabel", lang)}
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
            label={ui("phoneLabel", lang)}
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
      title: ui("therapistTitle", lang),
      render: () => <>{renderQuestion(bySlot.get(1)!)}</>,
      isValid: () => slotIsAnswered(1),
    },
    ...SCREEN_SLOTS.map((slots, i): FormScreen => {
      const qs = slots.map((s) => bySlot.get(s)).filter(Boolean) as SurveyQuestion[];
      return {
        id: `slots-${slots.join("-")}`,
        title: ui(SCREEN_TITLES[i], lang),
        description: SCREEN_DESCRIPTIONS[i] && ui(SCREEN_DESCRIPTIONS[i]!, lang),
        render: () => <>{qs.map(renderQuestion)}</>,
        isValid: () => slots.every(slotIsAnswered),
      };
    }),
  ];

  const onSubmit = async () => {
    // The language goes in the body as its own field and nowhere else: the
    // answers are the stored English values whichever language was showing.
    const result = await submitSurvey(
      variant,
      buildSubmitBody(variant, draft, lang, formLoadedAt.current, company),
    );

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
      modalityLabel={modalityLabel(variant, lang)}
      lang={lang}
      onLanguageChange={setLanguage}
      onSubmit={onSubmit}
      isComplete={complete}
      successNode={<Confirmation lang={lang} />}
    />
  );
}

/** Titles for screens 3 to 7. The words are in shared/survey-copy.es.ts. */
const SCREEN_TITLES = [
  "screen3Title",
  "screen4Title",
  "screen5Title",
  "screen6Title",
  "screen7Title",
] as const;

const SCREEN_DESCRIPTIONS = [
  undefined,
  undefined,
  "screen5Description",
  "screen6Description",
  undefined,
] as const;

/**
 * Confirmation.
 *
 * THE ENGLISH IS THE PRACTICE'S, VERBATIM. It was written internally,
 * discussed, and handed over as final copy on 2026-09-12. Do not tighten,
 * reflow or re-punctuate it. It now lives in shared/survey-copy.es.ts
 * (CONFIRMATION_COPY) beside its Spanish equivalent.
 *
 * ONE MESSAGE FOR EVERYONE. The follow-up line used to render only when the
 * client had asked to be contacted; their copy says "If you requested a
 * follow-up" and is written to cover both cases, so the conditional is gone
 * rather than dormant and the screen no longer reads any answer at all.
 *
 * No answers, no name, no scores, no submission id: a lobby device is shared,
 * and whatever is on this screen is visible to whoever picks the phone up next.
 */
function Confirmation({ lang }: { lang: SurveyLanguage }) {
  return (
    <div className="done">
      <div className="done__mark" aria-hidden="true">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </div>
      <h1 className="done__title">{confirmation("title", lang)}</h1>
      <p className="done__body">{confirmation("paragraph1", lang)}</p>
      <p className="done__body">{confirmation("paragraph2", lang)}</p>
      <p className="done__body">{confirmation("paragraph3", lang)}</p>
      <p className="done__body done__body--strong">{confirmation("closingLine", lang)}</p>
      <p className="done__body">{confirmation("closePage", lang)}</p>
    </div>
  );
}
