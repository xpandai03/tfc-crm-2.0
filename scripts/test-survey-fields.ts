/**
 * Self-checks for the 2026-09-03 client-review changes to the survey.
 *
 * Run: npx tsx scripts/test-survey-fields.ts
 *
 * Covers: the four required identity fields, the legal-name label, one comment
 * mechanism per question, the stored shape, the protections that must still
 * hold, backward compatibility with submissions taken before the change, and
 * (2026-09-28) the Spanish form: every string in both languages, and a payload
 * that does not change with the language it was filled in.
 *
 * NO PHI. Every identity below is invented for this file.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  CLIENT_PHONE_MAX,
  COMMENT_MAX,
  COMMENT_PROMPT,
  LEGAL_NAME_HINT,
  SURVEY_VARIANTS,
  SURVEY_VERSION,
  commentKeysFor,
  emailProblem,
  isCommentable,
  legalNameProblem,
  pairedComments,
  phoneDigits,
  phoneProblem,
  questionsFor,
  type SurveyVariant,
} from "../shared/survey-questions";
import {
  SURVEY_MAX_BODY_BYTES,
  SURVEY_MIN_COMPLETION_MS,
  buildSurveyPayload,
  completionTimingProblem,
  honeypotTripped,
  serverIdentityProblem,
  surveySubmissionSchema,
} from "../server/survey/schema";
import { buildSurveyDocument } from "../server/pdf/survey-template";
import {
  ANCHOR_COPY,
  CONFIRMATION_COPY,
  MESSAGE_COPY,
  MODALITY_COPY,
  OPTION_COPY,
  QUESTION_COPY,
  UI_COPY,
  type Copy,
} from "../shared/survey-copy.es";
import {
  anchorsFor,
  languageFromSearch,
  message,
  optionLabel,
  promptFor,
} from "../client-survey/src/i18n";
import { buildSubmitBody, type Draft } from "../client-survey/src/submit-body";
import {
  DEFAULT_SURVEY_LANGUAGE,
  MODALITY_FOR_VARIANT,
  dateOfBirthProblem,
  type ChoiceQuestion,
  type ScaleQuestion,
  type SurveyLanguage,
} from "../shared/survey-questions";
import type { FormSubmission } from "../server/sync/db";

let pass = 0, fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const eq = (name: string, a: unknown, b: unknown) =>
  ok(name, JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);

/** A complete, valid submission body. Synthetic identity throughout. */
function validBody(variant: SurveyVariant, opts: { comments?: Record<string, string> } = {}) {
  const answers: Record<string, unknown> = {};
  for (const q of questionsFor(variant)) {
    if (q.kind === "scale") answers[q.key] = 7;
    else if (q.kind === "choice") answers[q.key] = q.options[0];
    else if (q.kind === "therapist") answers[q.key] = "Example Therapist (ABQ)";
  }
  return {
    surveyVersion: SURVEY_VERSION,
    client: {
      name: "Sample Testperson",
      dateOfBirth: "1990-04-12",
      email: "sample@example.invalid",
      phone: "(505) 555-0142",
    },
    answers,
    ...(opts.comments ? { comments: opts.comments } : {}),
    formLoadedAt: Date.now() - 60_000,
  };
}

// ---------------------------------------------------------------------------
console.log("\n[1] All four identity fields required; a rejection names the field");
for (const variant of SURVEY_VARIANTS) {
  const schema = surveySubmissionSchema(variant);
  ok(`${variant}: a complete submission parses`, schema.safeParse(validBody(variant)).success);
  for (const missing of ["name", "dateOfBirth", "email", "phone"] as const) {
    const body = validBody(variant) as Record<string, any>;
    delete body.client[missing];
    const r = schema.safeParse(body);
    ok(`${variant}: missing ${missing} is rejected`, !r.success);
    if (!r.success) {
      const named = r.error.issues.some((i) => i.path.join(".").includes(missing));
      ok(`${variant}: the rejection names "${missing}"`, named,
        r.error.issues.map((i) => i.path.join(".")).join(","));
    }
  }
  // Present-but-empty must fail too — a blank string is not an answer.
  for (const blank of ["name", "email", "phone"] as const) {
    const body = validBody(variant) as Record<string, any>;
    body.client[blank] = "   ";
    ok(`${variant}: blank ${blank} is rejected`, !schema.safeParse(body).success);
  }
}
// The server re-runs the shared rules and reports which field failed.
const now = new Date();
eq("server names the email field",
  serverIdentityProblem({ name: "A Person", dateOfBirth: "1990-04-12", email: "not-an-email", phone: "5055550142" }, now)?.field,
  "email");
eq("server names the phone field",
  serverIdentityProblem({ name: "A Person", dateOfBirth: "1990-04-12", email: "a@b.co", phone: "12345" }, now)?.field,
  "phone");
eq("a complete identity has no problem",
  serverIdentityProblem({ name: "A Person", dateOfBirth: "1990-04-12", email: "a@b.co", phone: "+1 (505) 555-0142" }, now),
  null);
ok("email is no longer optional", emailProblem("") !== null);
ok("legal name is required", legalNameProblem("  ") !== null);

console.log("\n[1b] Phone accepts how people actually type numbers");
for (const good of [
  "5055550142", "505-555-0142", "(505) 555-0142", "505.555.0142",
  "+1 505 555 0142", "1 (505) 555-0142", "+44 20 7946 0958", " 505 555 0142 ",
]) {
  ok(`accepts ${JSON.stringify(good)}`, phoneProblem(good) === null, String(phoneProblem(good)));
  ok(`  fits CLIENT_PHONE_MAX`, good.length <= CLIENT_PHONE_MAX);
}
for (const bad of ["", "   ", "555-0142", "12345", "abcdefghij", "1234567890123456789"]) {
  ok(`refuses ${JSON.stringify(bad)}`, phoneProblem(bad) !== null);
}
eq("phoneDigits strips punctuation", phoneDigits("(505) 555-0142"), "5055550142");
eq("phoneDigits keeps a country code", phoneDigits("+1 505-555-0142"), "+15055550142");

// ---------------------------------------------------------------------------
console.log("\n[2] The name label says legal name and explains why");
const formSrc = readFileSync(join(process.cwd(), "client-survey", "src", "SurveyForm.tsx"), "utf8");
const submitSrc = readFileSync(join(process.cwd(), "client-survey", "src", "submit-body.ts"), "utf8");
// The words moved to shared/survey-copy.es.ts on 2026-09-28; the form renders
// them by key. Same assertions, read through the copy file.
ok("the name field renders the legal-name label", formSrc.includes('label={ui("legalNameLabel", lang)}'));
eq('the label reads "Your legal name"', UI_COPY.legalNameLabel.en, "Your legal name");
ok("no \"full name\" label remains",
  !formSrc.includes("Your full name") && !JSON.stringify(UI_COPY).includes("Your full name"));
ok("the legal-name hint is rendered", formSrc.includes('hint={ui("legalNameHint", lang)}'));
eq("the rendered English hint IS LEGAL_NAME_HINT", UI_COPY.legalNameHint.en, LEGAL_NAME_HINT);
ok("the Spanish hint also says legal name and why",
  /nombre legal/.test(UI_COPY.legalNameHint.es) && /expediente/.test(UI_COPY.legalNameHint.es));
ok("the Spanish hint does not mention insurance either", !/seguro|identificaci/i.test(UI_COPY.legalNameHint.es));
ok('the hint says "not a preferred"', /not a preferred/i.test(LEGAL_NAME_HINT));
ok("the hint says why", /find your record/i.test(LEGAL_NAME_HINT));
ok('the hint says "legal name"', /legal name/i.test(LEGAL_NAME_HINT));
eq("the hint is the client's exact wording (2026-09-23, no em dash)", LEGAL_NAME_HINT,
  "Please use your legal name, not a preferred or shortened name, so we can find your record.");
// Client request, 2026-09-23: one legal-name instruction, no insurance card.
ok("the hint no longer mentions insurance or an ID card", !/insurance|\bID\b/i.test(LEGAL_NAME_HINT));
ok("the identity screen mentions insurance nowhere a client can read it",
  !/insurance/i.test(formSrc.slice(formSrc.indexOf('id: "identity"'), formSrc.indexOf('id: "therapist"'))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")));

// ---------------------------------------------------------------------------
console.log("\n[3] A comment box on every question, never blocking");
for (const variant of SURVEY_VARIANTS) {
  const qs = questionsFor(variant);
  const commentable = qs.filter(isCommentable);
  eq(`${variant}: every question but the free-text one is commentable`,
    commentable.length, qs.length - 1);
  ok(`${variant}: the one exclusion is "Additional Comments"`,
    qs.filter((q) => !isCommentable(q)).every((q) => q.kind === "text"));
  eq(`${variant}: 11 comment keys`, commentKeysFor(variant).length, 11);

  // Never required, whatever the answer. Parse with every choice answer set to
  // each of its options and NO comments at all.
  const schema = surveySubmissionSchema(variant);
  for (const opt of [0, 1]) {
    const body = validBody(variant) as Record<string, any>;
    for (const q of qs) if (q.kind === "choice") body.answers[q.key] = q.options[Math.min(opt, q.options.length - 1)];
    ok(`${variant}: no comments needed with option index ${opt}`, schema.safeParse(body).success);
  }
  // ...and an empty comments object is fine.
  ok(`${variant}: an empty comments object parses`,
    schema.safeParse({ ...validBody(variant), comments: {} }).success);
}
ok("the comment prompt is an invitation, not an instruction", COMMENT_PROMPT.endsWith("?"));
eq("the rendered English comment prompt IS COMMENT_PROMPT (the PDF prints it)",
  UI_COPY.commentPrompt.en, COMMENT_PROMPT);
ok("...and the Spanish one is a question too", /^¿.*\?$/.test(UI_COPY.commentPrompt.es));
const fieldsSrc = readFileSync(join(process.cwd(), "client-survey", "src", "fields.tsx"), "utf8");
ok("the comment box is always rendered, never behind a Reveal",
  !/Reveal[\s\S]{0,400}CommentField/.test(formSrc) && formSrc.includes("showsCommentBox(q) && ("));
// Client request, 2026-09-23: step 2 (the therapist pick) has no open comment
// box. The server still ACCEPTS comments.therapist, so earlier rows and an open
// tab on the previous bundle are unaffected; only the form stops writing it.
// showsCommentBox and the submit loop moved to submit-body.ts (2026-09-28) so
// the body can be tested without a browser.
ok("step 2 hides the therapist comment box",
  /showsCommentBox = \(q: SurveyQuestion\): boolean =>\s*isCommentable\(q\) && q\.kind !== "therapist"/.test(submitSrc));
ok("the form imports that rule rather than redefining it",
  /import \{[^}]*showsCommentBox[^}]*\} from "\.\/submit-body"/.test(formSrc) && !/const showsCommentBox/.test(formSrc));
ok("the submit loop skips keys whose box is not shown",
  /for \(const key of commentKeysFor\(variant\)\) \{[\s\S]{0,200}showsCommentBox\(q\)\) continue;/.test(submitSrc));
for (const variant of SURVEY_VARIANTS) {
  ok(`${variant}: the server still accepts a stored therapist comment`,
    surveySubmissionSchema(variant).safeParse({ ...validBody(variant), comments: { therapist: "ZZTEST comment" } }).success);
}
ok("advancing is gated on answers only, never on comments",
  !/isValid[\s\S]{0,200}comment/i.test(formSrc));

// ---------------------------------------------------------------------------
console.log("\n[4] One comment mechanism per question, not two");
ok("the form never renders the retired explain box", !formSrc.includes("legacyExplain"));
ok("the form imports no Reveal", !/\bReveal,\n/.test(formSrc));
ok("CommentField is rendered exactly once in the tree",
  (formSrc.match(/<CommentField/g) ?? []).length === 1);
for (const variant of SURVEY_VARIANTS) {
  // The schema cannot accept a retired explain key any more.
  const body = validBody(variant) as Record<string, any>;
  body.answers.privacyRespectedExplain = "text under the old mechanism";
  ok(`${variant}: a retired explain key is rejected outright`,
    !surveySubmissionSchema(variant).safeParse(body).success);
  // And an unknown comment key is rejected too — the comments object is closed.
  ok(`${variant}: an unknown comment key is rejected`,
    !surveySubmissionSchema(variant).safeParse({ ...validBody(variant), comments: { nope: "x" } }).success);
}

// ---------------------------------------------------------------------------
console.log("\n[5] The stored shape pairs each comment with its question");
{
  const variant: SurveyVariant = "in-person";
  const comments = { greetedOnArrival: "Front desk was lovely.", overallRating: "Best session yet." };
  const parsed = surveySubmissionSchema(variant).safeParse(validBody(variant, { comments }));
  ok("a submission with comments parses", parsed.success);
  if (parsed.success) {
    const payload = buildSurveyPayload(variant, parsed.data, "2026-09-08T00:00:00.000Z") as Record<string, any>;
    eq("comments is a sibling of answers, keyed by question key",
      payload.comments, comments);
    ok("answers holds no comment text",
      !JSON.stringify(payload.answers).includes("Front desk"));
    eq("all four identity fields are stored", Object.keys(payload.client).sort(),
      ["dateOfBirth", "email", "name", "phone"]);
    // Pairing is a key lookup, which is the whole point of the shape.
    const paired = pairedComments(variant, payload.comments);
    eq("pairing yields question text with its comment", paired.length, 2);
    ok("the pair carries the source prompt",
      paired[0].prompt === "We're you greeted upon arrival?", paired[0].prompt);
  }
  // No comments at all -> no key.
  const bare = surveySubmissionSchema(variant).safeParse(validBody(variant));
  if (bare.success) {
    const payload = buildSurveyPayload(variant, bare.data, "2026-09-08T00:00:00.000Z");
    ok("a submission with no comments stores no comments key", !("comments" in payload));
  }
  // An empty string is dropped rather than stored.
  const blank = surveySubmissionSchema(variant).safeParse(
    validBody(variant, { comments: { greetedOnArrival: "   " } }),
  );
  if (blank.success) {
    const payload = buildSurveyPayload(variant, blank.data, "2026-09-08T00:00:00.000Z");
    ok("a whitespace-only comment is not stored", !("comments" in payload));
  }
}

// ---------------------------------------------------------------------------
console.log("\n[6] Protections still hold, with more free text than before");
{
  const variant: SurveyVariant = "telehealth";
  const schema = surveySubmissionSchema(variant);
  // Length caps: every comment key is capped.
  const over = validBody(variant, { comments: { therapist: "x".repeat(COMMENT_MAX + 1) } });
  ok("a comment over COMMENT_MAX is rejected", !schema.safeParse(over).success);
  ok("a comment at exactly COMMENT_MAX is accepted",
    schema.safeParse(validBody(variant, { comments: { therapist: "x".repeat(COMMENT_MAX) } })).success);
  // Every commentable question is capped, not just the first.
  for (const key of commentKeysFor(variant)) {
    ok(`  ${key} is capped`, !schema.safeParse(validBody(variant, { comments: { [key]: "x".repeat(COMMENT_MAX + 1) } })).success);
  }
  // The worst realistic full submission must still fit the body cap.
  const full: Record<string, string> = {};
  for (const key of commentKeysFor(variant)) full[key] = "é".repeat(COMMENT_MAX);
  const fullBody = validBody(variant, { comments: full }) as Record<string, any>;
  const textQ = questionsFor(variant).find((q) => q.kind === "text")!;
  fullBody.answers[textQ.key] = "é".repeat((textQ as { maxLength: number }).maxLength);
  const bytes = Buffer.byteLength(JSON.stringify(fullBody), "utf8");
  ok(`every box filled to the cap fits SURVEY_MAX_BODY_BYTES (${bytes} of ${SURVEY_MAX_BODY_BYTES})`,
    bytes < SURVEY_MAX_BODY_BYTES);
  ok("...and it still parses", schema.safeParse(fullBody).success);

  // Honeypot.
  const hp = schema.safeParse({ ...validBody(variant), company: "Acme" });
  ok("honeypot value parses", hp.success);
  if (hp.success) ok("honeypot trips", honeypotTripped(hp.data));
  const clean = schema.safeParse(validBody(variant));
  if (clean.success) ok("an unfilled honeypot does not trip", !honeypotTripped(clean.data));

  // Completion time.
  const t = Date.now();
  eq("too fast is refused", completionTimingProblem(t, t + SURVEY_MIN_COMPLETION_MS - 1), "too-fast");
  eq("a clock ahead is refused", completionTimingProblem(t + 10_000, t), "too-fast");
  eq("a plausible fill is accepted", completionTimingProblem(t, t + 60_000), null);
  eq("a stale load is refused", completionTimingProblem(t, t + 13 * 60 * 60 * 1000), "stale");

  // Rate limit untouched.
  const rl = readFileSync(join(process.cwd(), "server", "survey", "rate-limit.ts"), "utf8");
  ok("the rate limiter still exports its two windows",
    /SURVEY_MAX_PER_HOUR/.test(rl) && /SURVEY_MAX_PER_DAY/.test(rl));
  const routeSrc = readFileSync(join(process.cwd(), "server", "survey", "routes.ts"), "utf8");
  for (const guard of [
    "SURVEY_MAX_BODY_BYTES", "honeypotTripped", "completionTimingProblem",
    "checkSurveyRateLimit", "recordSurveySubmission", "serverIdentityProblem",
  ]) {
    ok(`the route still calls ${guard}`, routeSrc.includes(guard));
  }
  ok("the route logs the failing field name, never a value",
    routeSrc.includes("identity field failed validation (${identity.field})"));
}

// ---------------------------------------------------------------------------
console.log("\n[7] Old submissions still render — no phone, no comments");
function asSubmission(payload: unknown): FormSubmission {
  return {
    id: 1, createdAt: "2026-08-20T10:00:00.000Z", source: "client_survey_v1",
    formType: "survey", submittedAt: "2026-08-20T10:00:00.000Z", contactId: null,
    name: "Sample Testperson", payload,
  } as unknown as FormSubmission;
}
// Exactly the pre-2026-09-03 shape, including a legacy explain value.
const legacyPayload = {
  surveyVersion: 1, formVariant: "in-person", modality: "In Person",
  submittedAt: "2026-08-20T10:00:00.000Z",
  client: { name: "Sample Testperson", dateOfBirth: "1990-04-12" },
  answers: {
    therapist: "Example Therapist (ABQ)", facilityClean: "Excellent",
    greetedOnArrival: "No", greetedOnArrivalExplain: "Nobody was at the desk.",
    seenWithinTenMinutes: "Yes", privacyRespected: "Yes", endedFeelingValued: "Yes",
    connectionRating: 9, goalsRating: 8, approachRating: 8, overallRating: 9,
    followUpRequested: "No",
  },
};
let legacyDoc: Record<string, unknown> | null = null;
try { legacyDoc = buildSurveyDocument(asSubmission(legacyPayload)); } catch (e) {
  ok("legacy submission renders", false, String(e));
}
ok("a legacy submission renders without throwing", legacyDoc !== null);
if (legacyDoc) {
  const text = JSON.stringify(legacyDoc);
  ok("the retired explain text is still rendered", text.includes("Nobody was at the desk."));
  ok("its original prompt labels it", text.includes("If no, please explain"));
  ok("no phone line is invented", !text.includes('"phone"'));
  ok("no comment prompt appears where there are no comments", !text.includes(COMMENT_PROMPT));
}
// A row with a client object missing entirely, and one with no answers.
for (const [label, payload] of [
  ["no client object", { formVariant: "telehealth", answers: {} }],
  ["no answers object", { formVariant: "in-person", client: { name: "X" } }],
  ["empty payload", { formVariant: "in-person" }],
] as const) {
  let threw = false;
  try { buildSurveyDocument(asSubmission(payload)); } catch { threw = true; }
  ok(`renders with ${label}`, !threw);
}

console.log("\n[7b] The Submissions page keeps comments out of the list row");
const subsSrc = readFileSync(join(process.cwd(), "client", "src", "pages", "submissions.tsx"), "utf8");
const surveyBranch = subsSrc.slice(
  subsSrc.indexOf("if (isSurveySubmission(sub)) {"),
  subsSrc.indexOf("// Feedback forms"),
);
ok("the survey list branch never reads p.comments", !surveyBranch.includes("p.comments"));
ok("the survey list branch reads no *Explain key", !/Explain/.test(surveyBranch));
ok("the raw-payload viewer is still gated on survey rows",
  /RawPayloadModal[\s\S]{0,900}if \(isSurveySubmission\(submission\)\) return null;/.test(subsSrc));

// ---------------------------------------------------------------------------
console.log("\n[8] The PDF renders a comment on every question and paginates");
{
  const variant: SurveyVariant = "telehealth";
  const comments: Record<string, string> = {};
  for (const key of commentKeysFor(variant)) comments[key] = `A full-length comment. ${"word ".repeat(180)}`.slice(0, COMMENT_MAX);
  const parsed = surveySubmissionSchema(variant).safeParse(validBody(variant, { comments }));
  ok("the every-box-filled submission parses", parsed.success);
  if (parsed.success) {
    const payload = buildSurveyPayload(variant, parsed.data, "2026-09-08T00:00:00.000Z");
    const doc = buildSurveyDocument(asSubmission(payload));
    const text = JSON.stringify(doc);
    eq("the comment prompt appears once per commentable question",
      (text.match(new RegExp(COMMENT_PROMPT.replace(/[?]/g, "\\?"), "g")) ?? []).length,
      commentKeysFor(variant).length);
    ok("phone appears in the header", text.includes("(505) 555-0142"));
    ok("email appears in the header", text.includes("sample@example.invalid"));
    // Pagination: no comment block may be unbreakable, or a long one is clipped.
    const content = (doc as { content: Record<string, unknown>[] }).content;
    const commentBlocks = content.filter((c) =>
      JSON.stringify(c).includes(COMMENT_PROMPT));
    ok("every comment block is free to break across pages",
      commentBlocks.length > 0 && commentBlocks.every((c) => c.unbreakable !== true));
    ok("the document has a footer with page numbers",
      typeof (doc as { footer?: unknown }).footer === "function");
  }
}

// ---------------------------------------------------------------------------
console.log("\n[11] Spanish: every client-facing string exists in both languages");
{
  const nonEmpty = (c: Copy | undefined) => !!c && c.en.trim() !== "" && c.es.trim() !== "";
  const vars = (t: string) => (t.match(/\{\w+\}/g) ?? []).sort().join(",");

  for (const variant of SURVEY_VARIANTS) {
    const byVariant = QUESTION_COPY.byVariant[variant];
    for (const q of questionsFor(variant)) {
      const copy = byVariant[q.key] ?? QUESTION_COPY.shared[q.key];
      ok(`${variant}/${q.key}: has a prompt in both languages`, nonEmpty(copy));
      // The en: line is a reference copy for the translator. If the English
      // wording changes, this fails until the Spanish line is looked at too.
      eq(`${variant}/${q.key}: the copy file's en: line matches the instrument`, copy?.en, q.prompt);
      ok(`${variant}/${q.key}: the Spanish prompt is what renders`,
        promptFor(variant, q, "es") === copy?.es && promptFor(variant, q, "en") === q.prompt);

      if (q.kind === "scale") {
        const sq = q as ScaleQuestion;
        const a = ANCHOR_COPY[sq.key];
        ok(`${variant}/${q.key}: both anchors in both languages`, nonEmpty(a?.low) && nonEmpty(a?.high));
        eq(`${variant}/${q.key}: anchor en: lines match the instrument`,
          [a?.low.en, a?.high.en], [sq.lowAnchor, sq.highAnchor]);
        ok(`${variant}/${q.key}: Spanish anchors keep the 0 and the 10`,
          a?.low.es.startsWith("0") === true && a?.high.es.startsWith("10") === true);
        eq(`${variant}/${q.key}: English anchors render unchanged`,
          anchorsFor(sq, "en"), { low: sq.lowAnchor, high: sq.highAnchor });
      }
      if (q.kind === "choice") {
        for (const o of (q as ChoiceQuestion).options) {
          ok(`${variant}/${q.key}: option "${o}" has a Spanish label`, nonEmpty(OPTION_COPY[o]));
          eq(`  its en: line is the stored value`, OPTION_COPY[o]?.en, o);
          eq(`  English shows the value itself`, optionLabel(o, "en"), o);
        }
      }
    }
    ok(`${variant}: the modality label has both languages`,
      nonEmpty(MODALITY_COPY[MODALITY_FOR_VARIANT[variant]]));
  }

  // No orphans: every entry in the question/anchor maps belongs to a real
  // question, so a stale line cannot sit in the file looking authoritative.
  const allKeys = new Set(SURVEY_VARIANTS.flatMap((v) => questionsFor(v).map((q) => q.key)));
  for (const key of Object.keys(QUESTION_COPY.shared)) ok(`shared copy "${key}" is a real question`, allKeys.has(key));
  for (const variant of SURVEY_VARIANTS) {
    const keys = new Set(questionsFor(variant).map((q) => q.key));
    for (const key of Object.keys(QUESTION_COPY.byVariant[variant])) {
      ok(`${variant} copy "${key}" is a question on that form`, keys.has(key));
    }
  }
  for (const key of Object.keys(ANCHOR_COPY)) ok(`anchor copy "${key}" is a real question`, allKeys.has(key));

  for (const [name, group] of [
    ["UI", UI_COPY], ["confirmation", CONFIRMATION_COPY], ["modality", MODALITY_COPY], ["option", OPTION_COPY],
  ] as const) {
    for (const [key, c] of Object.entries(group as Record<string, Copy>)) {
      ok(`${name}.${key}: neither language is empty`, nonEmpty(c));
      eq(`${name}.${key}: the same {placeholders} in both`, vars(c.es), vars(c.en));
    }
  }
  for (const [en, es] of Object.entries(MESSAGE_COPY)) {
    ok(`message "${en.slice(0, 40)}": Spanish is not empty`, es.trim() !== "");
  }

  // The confirmation's English is the practice's final copy, verbatim.
  eq("confirmation title is verbatim", CONFIRMATION_COPY.title.en,
    "Thank you — your feedback has been recorded!");
  eq("confirmation closing line is verbatim", CONFIRMATION_COPY.closingLine.en,
    "Thank you for trusting The Family Connection to be part of your journey.");

  // The practice name is never translated.
  for (const c of [UI_COPY.privacyNote, UI_COPY.footer, UI_COPY.pageTitle, CONFIRMATION_COPY.paragraph2, CONFIRMATION_COPY.closingLine]) {
    ok(`"The Family Connection" survives in Spanish: ${c.es.slice(0, 30)}…`, c.es.includes("The Family Connection"));
  }
}

console.log("\n[12] Spanish: every error a client can see has a translation");
{
  // Every message the four shared identity rules can return, produced by
  // asking them — not by copying their text here.
  const today = new Date("2026-09-28T12:00:00Z");
  const produced = [
    legalNameProblem(""), legalNameProblem("x".repeat(500)),
    dateOfBirthProblem("", today), dateOfBirthProblem("1990-02-31", today),
    dateOfBirthProblem("2030-01-01", today), dateOfBirthProblem("1850-01-01", today),
    emailProblem(""), emailProblem("nope"), emailProblem(`${"a".repeat(170)}@b.co`),
    phoneProblem(""), phoneProblem("12345"), phoneProblem("1".repeat(20)),
  ].filter((m): m is string => m !== null);
  eq("the rules produced all eleven distinct messages", new Set(produced).size, 11);
  for (const m of new Set(produced)) {
    ok(`validation "${m}" has Spanish`, !!MESSAGE_COPY[m]);
    ok(`  and renders it`, message(m, "es") === MESSAGE_COPY[m] && message(m, "en") === m);
  }

  // Every error string the server can send back, read from the route source so
  // a new one fails here until it is translated.
  const routeSrc = readFileSync(join(process.cwd(), "server", "survey", "routes.ts"), "utf8");
  const serverMsgs = [...routeSrc.matchAll(/error:\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
  ok(`found the route's error strings (${serverMsgs.length})`, serverMsgs.length >= 7);
  for (const m of serverMsgs) ok(`server "${m}" has Spanish`, !!MESSAGE_COPY[m]);

  // And the two fixed fallbacks the bundle itself shows.
  const apiSrc = readFileSync(join(process.cwd(), "client-survey", "src", "api.ts"), "utf8");
  const stepSrc = readFileSync(join(process.cwd(), "client-survey", "src", "MultiStepForm.tsx"), "utf8");
  const fallbacks = [
    ...[...apiSrc.matchAll(/GENERIC_FAILURE =\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]),
    ...[...stepSrc.matchAll(/setError\("([^"]+)"\)/g)].map((m) => m[1]),
  ];
  eq("found both fallbacks", fallbacks.length, 2);
  for (const m of fallbacks) ok(`fallback "${m}" has Spanish`, !!MESSAGE_COPY[m]);
  ok("the banner translates what it shows", /\{message\(error, lang\)\}/.test(stepSrc));
  ok("field errors are translated", /value\.trim\(\) \? message\(problem, lang\) : null/.test(formSrc));

  eq("an unknown message is shown as it came, never blank", message("Something new.", "es"), "Something new.");
}

console.log("\n[13] Spanish: the language changes nothing that is stored except `language`");
{
  for (const variant of SURVEY_VARIANTS) {
    // A draft filled in exactly as a client would, answering every question
    // and writing a couple of comments. ZZTEST identity only.
    const draft: Draft = {
      client: { name: " ZZTEST Persona ", dateOfBirth: "1990-04-12", email: "zztest@example.invalid", phone: "(505) 555-0142" },
      answers: {},
      comments: {},
    };
    for (const q of questionsFor(variant)) {
      if (q.kind === "scale") draft.answers[q.key] = 6;
      else if (q.kind === "choice") draft.answers[q.key] = (q as ChoiceQuestion).options[1];
      else if (q.kind === "therapist") draft.answers[q.key] = "Example Therapist (ABQ)";
      else draft.answers[q.key] = "ZZTEST closing comment";
    }
    const firstChoice = questionsFor(variant).find((q) => q.kind === "choice")!;
    draft.comments[firstChoice.key] = "ZZTEST comment";
    draft.comments.overallRating = "ZZTEST another";

    const bodies = (["en", "es"] as SurveyLanguage[]).map((lang) =>
      buildSubmitBody(variant, { ...draft, language: lang }, lang, Date.now() - 60_000, ""));
    const [en, es] = bodies;
    eq(`${variant}: en body says en`, en.language, "en");
    eq(`${variant}: es body says es`, es.language, "es");
    const strip = (b: Record<string, unknown>) => { const { language: _l, formLoadedAt: _f, ...rest } = b; return rest; };
    eq(`${variant}: the bodies are identical apart from language`,
      strip(es as unknown as Record<string, unknown>), strip(en as unknown as Record<string, unknown>));
    ok(`${variant}: answers hold the English stored values`,
      Object.values(es.answers).every((v) => typeof v === "number" || !Object.values(OPTION_COPY).some((c) => c.es === v && c.es !== c.en)));

    // Through the real server schema and the real stored-row builder.
    const schema = surveySubmissionSchema(variant);
    const payloads = bodies.map((b) => {
      const parsed = schema.safeParse(b);
      ok(`${variant}/${b.language}: the body parses on the server`, parsed.success,
        parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3)));
      return parsed.success ? buildSurveyPayload(variant, parsed.data, "2026-09-28T00:00:00.000Z") as Record<string, unknown> : {};
    });
    eq(`${variant}: stored language is recorded`, [payloads[0].language, payloads[1].language], ["en", "es"]);
    const { language: _a, ...storedEn } = payloads[0];
    const { language: _b, ...storedEs } = payloads[1];
    eq(`${variant}: the stored rows are identical apart from language`, storedEs, storedEn);

    // A tab still running the English-only bundle sends no language at all.
    const legacy = schema.safeParse(validBody(variant));
    if (legacy.success) {
      eq(`${variant}: no language sent -> stored as "en"`,
        (buildSurveyPayload(variant, legacy.data, "2026-09-28T00:00:00.000Z") as Record<string, unknown>).language,
        DEFAULT_SURVEY_LANGUAGE);
    }
    ok(`${variant}: an unknown language is refused`,
      !schema.safeParse({ ...validBody(variant), language: "fr" }).success);

    // Belt and braces: Spanish ANSWER text can never be stored, because the
    // server only accepts the English option values.
    const spanishAnswer = validBody(variant) as Record<string, any>;
    spanishAnswer.answers.followUpRequested = "Sí";
    ok(`${variant}: a Spanish label sent as an answer is rejected`, !schema.safeParse(spanishAnswer).success);
  }

  // Switching language on step 3 keeps steps 1 and 2: the answers live in the
  // draft by key and value, and the switch only sets draft.language.
  ok("switching language only sets draft.language",
    /setDraft\(\(d\) => \(\{ \.\.\.d, language \}\)\)/.test(formSrc));
  const fieldsSrc2 = readFileSync(join(process.cwd(), "client-survey", "src", "fields.tsx"), "utf8");
  ok("a choice stores the option value and only shows the label",
    /value=\{option\}/.test(fieldsSrc2) && /onChange=\{\(\) => onChange\(option\)\}/.test(fieldsSrc2)
      && /\{optionLabel\(option, lang\)\}/.test(fieldsSrc2));
}

console.log("\n[14] Spanish: one form per modality, a ?lang=es link, and a badge for staff");
{
  eq("still exactly two form routes", [...SURVEY_VARIANTS], ["in-person", "telehealth"]);
  eq("?lang=es opens in Spanish", languageFromSearch("?lang=es"), "es");
  eq("?lang=ES too", languageFromSearch("?lang=ES"), "es");
  eq("?lang=en is English", languageFromSearch("?lang=en"), "en");
  eq("an unknown ?lang is ignored", languageFromSearch("?lang=fr"), null);
  eq("no ?lang is no preference", languageFromSearch(""), null);
  ok("the form reads ?lang from the page URL", /languageFromSearch\(window\.location\.search\)/.test(formSrc));
  const stepSrc = readFileSync(join(process.cwd(), "client-survey", "src", "MultiStepForm.tsx"), "utf8");
  ok("the switch is in the shell, so it is on every step and the confirmation",
    /function Shell[\s\S]{0,1500}<LanguageSwitch lang=\{lang\} onChange=\{onLanguageChange\} \/>/.test(stepSrc));
  ok("the confirmation is rendered in the chosen language", formSrc.includes("successNode={<Confirmation lang={lang} />}"));

  const copySrc = readFileSync(join(process.cwd(), "shared", "survey-copy.es.ts"), "utf8");
  const imports = [...copySrc.matchAll(/^import .*$/gm)].map((m) => m[0]);
  ok("the copy file imports types only (it ships in the public bundle)",
    imports.length > 0 && imports.every((l) => l.startsWith("import type ")));

  const subsSrc2 = readFileSync(join(process.cwd(), "client", "src", "pages", "submissions.tsx"), "utf8");
  ok("the Submissions row shows a language badge for a non-English survey",
    /surveyLanguage\(sub\) !== "en" && \(\s*<Badge[\s\S]{0,600}\{surveyLanguage\(sub\)\.toUpperCase\(\)\}/.test(subsSrc2));
  ok("the badge reads the language code only, never an answer",
    /function surveyLanguage\(sub: FormSubmission\) \{\s*return languageFromParam\(sub\.payload\?\.language\) \?\? DEFAULT_SURVEY_LANGUAGE;\s*\}/.test(subsSrc2));
}

// ---------------------------------------------------------------------------
console.log("\n[15] Spanish: the client's own wording is what ships (2026-09-28)");
{
  // The practice supplied their Spanish for the questions, options and 0-10
  // labels. Pinned here so a later retranslation cannot quietly replace it.
  // Only spelling, accents and opening ¿ were corrected; see the PR.
  const CLIENT: Record<string, Record<string, string>> = {
    "in-person": {
      therapist: "Terapeuta Tratante",
      facilityClean: "¿La agencia estaba limpia y acogedora?",
      greetedOnArrival: "¿Fuistes recibido a tu llegada?",
      seenWithinTenMinutes: "¿Fue llamado de nuevo de los 10 minutos de su cita?",
      privacyRespected: "¿Su privacidad fue tratado con respeto?",
      endedFeelingValued: "¿Te fuiste sintiendo que eres un valor para nosotros?",
      connectionRating: "Relación",
      goalsRating: "Metas y Temas",
      approachRating: "Enfoque o Método",
      overallRating: "En General",
      followUpRequested: "¿Quieres que te hagamos un seguimiento?",
      additionalComments: "Comentarios Adicionales",
    },
    telehealth: {
      therapist: "Terapeuta Tratante",
      platformSatisfaction: "¿Qué tan satisfecho estuvo con la plataforma de telesalud o el teléfono para la sesión de hoy?",
      techDifficultyResponse: "Si tuvo dificultades técnicas, ¿recibió una pronta respuesta al llamar?",
      seenWithinTenMinutes: "¿La sesión comenzó dentro de los 10 minutos de la hora programada?",
      privacyRespected: "¿Sentiste que se respetó tu privacidad en este formato de tratamiento?",
      endedFeelingValued: "¿Te fuiste sintiendo que eres un valor para nosotros?",
      connectionRating: "Relación",
      goalsRating: "Metas y Temas",
      approachRating: "Enfoque o Método",
      overallRating: "En General",
      followUpRequested: "¿Quieres que te hagamos un seguimiento?",
      additionalComments: "Comentarios Adicionales",
    },
  };
  for (const variant of SURVEY_VARIANTS) {
    const qs = questionsFor(variant);
    eq(`${variant}: the client's text covers every question on the form`,
      qs.map((q) => q.key).sort(), Object.keys(CLIENT[variant]).sort());
    for (const q of qs) {
      eq(`${variant}/${q.key}: client wording`, promptFor(variant, q, "es"), CLIENT[variant][q.key]);
      eq(`${variant}/${q.key}: English unchanged`, promptFor(variant, q, "en"), q.prompt);
    }
  }
  // One pair of 0-10 labels for all four ratings, as the client's form has it.
  for (const key of ["connectionRating", "goalsRating", "approachRating", "overallRating"]) {
    eq(`${key}: client 0-10 labels`, [ANCHOR_COPY[key].low.es, ANCHOR_COPY[key].high.es],
      ["0-No me sentí escuchado, entendido y respetado", "10-Me sentí escuchado, entendido y respetado"]);
  }
  eq("rating options, client wording", ["Excellent", "Satisfied", "Neutral", "Could be better", "Needs improvement immediately"]
    .map((o) => optionLabel(o, "es")), ["Excelente", "Satisfecho", "Neutral", "Podría ser mejor", "Necesita mejorar de inmediato"]);
  eq("Yes / No, client wording", [optionLabel("Yes", "es"), optionLabel("No", "es")], ["Sí", "No"]);
  eq("N/A has no client text and keeps the earlier label", optionLabel("N/A", "es"), "No aplica");
  ok("no machine gender form survives on the options", !Object.values(OPTION_COPY).some((c) => c.es.includes("(a)")));
}

// ---------------------------------------------------------------------------
console.log("\n[10] The public bundle carries no staff data");
// script/assert-survey-bundle.ts is the real gate and runs in `npm run build`.
// Asserted here so this suite fails if it is ever removed from the build.
const buildSrc = readFileSync(join(process.cwd(), "script", "build.ts"), "utf8");
ok("the build still runs the survey-bundle assertion",
  /assert-survey-bundle/.test(buildSrc) || /assertSurveyBundle/.test(buildSrc));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
