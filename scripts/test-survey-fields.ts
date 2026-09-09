/**
 * Self-checks for the 2026-09-03 client-review changes to the survey.
 *
 * Run: npx tsx scripts/test-survey-fields.ts
 *
 * Covers: the four required identity fields, the legal-name label, one comment
 * mechanism per question, the stored shape, the protections that must still
 * hold, and backward compatibility with submissions taken before the change.
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
ok('the label reads "Your legal name"', formSrc.includes('label="Your legal name"'));
ok("no \"full name\" label remains", !formSrc.includes('label="Your full name"'));
ok("the legal-name hint is rendered", formSrc.includes("hint={LEGAL_NAME_HINT}"));
ok('the hint says "not a preferred"', /not a preferred/i.test(LEGAL_NAME_HINT));
ok("the hint says why", /find your record/i.test(LEGAL_NAME_HINT));
ok('the hint points at insurance or ID', /insurance or ID/i.test(LEGAL_NAME_HINT));

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
const fieldsSrc = readFileSync(join(process.cwd(), "client-survey", "src", "fields.tsx"), "utf8");
ok("the comment box is always rendered, never behind a Reveal",
  !/Reveal[\s\S]{0,400}CommentField/.test(formSrc) && formSrc.includes("isCommentable(q) && ("));
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
console.log("\n[10] The public bundle carries no staff data");
// script/assert-survey-bundle.ts is the real gate and runs in `npm run build`.
// Asserted here so this suite fails if it is ever removed from the build.
const buildSrc = readFileSync(join(process.cwd(), "script", "build.ts"), "utf8");
ok("the build still runs the survey-bundle assertion",
  /assert-survey-bundle/.test(buildSrc) || /assertSurveyBundle/.test(buildSrc));

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
