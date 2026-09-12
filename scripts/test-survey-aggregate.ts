/**
 * Self-checks — survey export aggregation layer.
 *
 * Run: npx tsx scripts/test-survey-aggregate.ts
 *
 * No database and no PHI. Client names below are invented for the fixture; the
 * provider names are staff names and are the subject.
 *
 * EVERY EXPECTED VALUE IS HAND-COMPUTED from the fixture table and written as a
 * literal. Nothing here asserts that the code agrees with itself.
 */
import {
  SCALE_KEYS,
  TELEHEALTH_BUCKET,
  UNKNOWN_OFFICE,
  aggregateSurveys,
  modalityQuestionsFor,
  negativeOptionsFor,
  providerNameFromLabel,
  type AggregateInput,
  type RosterEntry,
  type SubmissionInput,
} from "../server/survey/aggregate";
import { SATISFACTION_OPTIONS, YES_NO_NA_OPTIONS } from "@shared/survey-questions";

let pass = 0, fail = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, want ${e}`);
}

// ===========================================================================
// Fixture
// ===========================================================================

const roster: RosterEntry[] = [
  { id: 1, name: "Anna Aldridge",    shortName: "Anna",     office: "ABQ", isActive: true },
  { id: 2, name: "Amanda Davison",   shortName: "Amanda D", office: "ABQ", isActive: true },
  { id: 3, name: "Jill Nantze",      shortName: "Jill",     office: "LL",  isActive: true },
  { id: 4, name: "Renee Singletary", shortName: "Renee",    office: "RR",  isActive: true },
  { id: 5, name: "Bentley Carbone",  shortName: "Bentley",  office: "ABQ", isActive: true }, // no submissions
  { id: 6, name: "Amber Merritt",    shortName: "Amber M",  office: "RR",  isActive: false }, // departed
  { id: 7, name: "Blank Office",     shortName: "Blank",    office: "",    isActive: true }, // office unset
  { id: 8, name: "Twin Name",        shortName: "Twin A",   office: "ABQ", isActive: true }, // duplicate name
  { id: 9, name: "Twin Name",        shortName: "Twin B",   office: "LL",  isActive: true }, // duplicate name
];

const IP = ["facilityClean", "greetedOnArrival", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"] as const;
const TH = ["platformSatisfaction", "techDifficultyResponse", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"] as const;

function sub(
  id: number,
  date: string,
  variant: "in-person" | "telehealth",
  therapist: string,
  choices: string[],
  ratings: [number, number, number, number] | null,
  comments?: Record<string, string>,
  extra?: Record<string, unknown>,
): SubmissionInput {
  const keys = variant === "in-person" ? IP : TH;
  const answers: Record<string, unknown> = { therapist };
  keys.forEach((k, i) => { answers[k] = choices[i]; });
  if (ratings) SCALE_KEYS.forEach((k, i) => { answers[k] = ratings[i]; });
  if (extra) Object.keys(extra).forEach((k) => { answers[k] = extra[k]; });
  const payload: Record<string, unknown> = {
    formVariant: variant,
    modality: variant === "in-person" ? "In Person" : "Telehealth",
    client: { name: `Client ${id}` },
    answers,
  };
  // comments omitted entirely when undefined — the shape all 32 stored rows have
  if (comments) payload.comments = comments;
  return { id, submittedAt: `${date}T12:00:00.000Z`, createdAt: `${date}T12:00:00.000Z`, payload };
}

//  id date        variant      provider                 facility/platform  greeted/tech  seen10  privacy  valued   ratings
const submissions: SubmissionInput[] = [
  sub(1,  "2026-07-15", "in-person",  "Anna Aldridge (ABQ)",    ["Excellent","Yes","No","Yes","Yes"],                             [8,10,6,9],
      { seenWithinTenMinutes: "Waited 20 minutes", connectionRating: "Great rapport" }),
  sub(2,  "2026-08-01", "in-person",  "Anna Aldridge (ABQ)",    ["Neutral","N/A","Yes","No","Yes"],                               [6,8,4,7]),
  // Label carries an OLD office. Must still resolve on the name portion.
  sub(3,  "2026-08-10", "telehealth", "Amanda Davison (Corp)",  ["Could be better","No","Yes","N/A","Yes"],                       [3,5,7,4],
      { platformSatisfaction: "Kept freezing" }),
  sub(4,  "2026-09-01", "in-person",  "Jill Nantze (LL)",       ["Needs improvement immediately","No","N/A","Yes","No"],          [10,10,10,10]),
  sub(5,  "2026-09-15", "telehealth", "Renee Singletary (RR)",  ["Satisfied","Yes","Yes","Yes","N/A"],                            [0,0,0,0]),
  sub(6,  "2026-08-20", "in-person",  "Amber Merritt (RR)",     ["Could be better","Yes","Yes","Yes","Yes"],                      [5,5,5,5]),
  sub(7,  "2026-08-25", "in-person",  "Ghost Provider (ABQ)",   ["Neutral","No","Yes","Yes","Yes"],                               [1,1,1,1]),
  sub(8,  "2026-08-26", "in-person",  "Twin Name (ABQ)",        ["Satisfied","Yes","Yes","Yes","Yes"],                            [1,1,1,1]),
  // Out of period on both sides. 10s would drag Jill's average up if counted.
  sub(9,  "2026-06-30", "in-person",  "Jill Nantze (LL)",       ["Excellent","Yes","Yes","Yes","Yes"],                            [10,10,10,10]),
  sub(10, "2026-10-01", "in-person",  "Jill Nantze (LL)",       ["Excellent","Yes","Yes","Yes","Yes"],                            [10,10,10,10]),
  // Exact boundaries — both inclusive.
  sub(11, "2026-07-01", "in-person",  "Jill Nantze (LL)",       ["Excellent","Yes","Yes","Yes","Yes"],                            [2,2,2,2]),
  sub(12, "2026-09-30", "in-person",  "Jill Nantze (LL)",       ["Satisfied","Yes","Yes","Yes","Yes"],                            [6,6,6,6]),
  // In-person row carrying a TELEHEALTH answer key, and a provider with no office.
  sub(13, "2026-09-05", "in-person",  "Blank Office",           ["Excellent","Yes","Yes","Yes","Yes"],                            [7,7,7,7],
      undefined, { platformSatisfaction: "Excellent" }),
];

// No formVariant and no modality — cannot be placed at all.
submissions.push({
  id: 14,
  submittedAt: "2026-08-15T12:00:00.000Z",
  createdAt: "2026-08-15T12:00:00.000Z",
  payload: { client: { name: "Client 14" }, answers: { therapist: "Anna Aldridge (ABQ)" } },
});

const input: AggregateInput = {
  submissions,
  roster,
  period: { from: "2026-07-01", to: "2026-09-30" },
};
const r = aggregateSurveys(input);

const provider = (name: string) => r.providers.filter((p) => p.name === name)[0];
const rating = (key: string, modality: string) =>
  r.ratings.filter((x) => x.key === key && x.modality === modality)[0];
const negative = (key: string, modality: string) =>
  r.negatives.filter((x) => x.key === key && x.modality === modality)[0];

// ===========================================================================
console.log("\n[1] Period scoping — submittedAt, inclusive on both ends");
// 14 rows: 9 and 10 fall outside; 14 has no variant. 11 counted.
eq("submissionsInPeriod is 11", r.submissionsInPeriod, 11);
// Jill: submissions 4 (10), 11 (2), 12 (6) -> (10+2+6)/3 = 6 exactly.
// If 9 or 10 leaked in the mean would be 7.6 or 8.5.
eq("Jill counts only the 3 in-period rows", provider("Jill Nantze").surveyCount, 3);
eq("Jill connection average is 6", provider("Jill Nantze").averages.connectionRating, 6);
eq("Jill overall average is 6", provider("Jill Nantze").averages.overallRating, 6);
eq("empty range yields nothing",
  aggregateSurveys({ ...input, period: { from: "2026-09-30", to: "2026-07-01" } }).submissionsInPeriod, 0);

// ===========================================================================
console.log("\n[2] Per-provider counts and averages — hand-computed");
// Anna: 1 -> 8,10,6,9 ; 2 -> 6,8,4,7. Means: 7, 9, 5, 8.
eq("Anna survey count is 2", provider("Anna Aldridge").surveyCount, 2);
eq("Anna connection mean is 7", provider("Anna Aldridge").averages.connectionRating, 7);
eq("Anna goals mean is 9", provider("Anna Aldridge").averages.goalsRating, 9);
eq("Anna approach mean is 5", provider("Anna Aldridge").averages.approachRating, 5);
eq("Anna overall mean is 8", provider("Anna Aldridge").averages.overallRating, 8);
eq("Anna office comes from the provider table", provider("Anna Aldridge").office, "ABQ");
eq("Anna short name is carried through", provider("Anna Aldridge").shortName, "Anna");

// ===========================================================================
console.log("\n[3] Zero is a score; absent is absent");
const bentley = provider("Bentley Carbone");
const renee = provider("Renee Singletary");
check("Bentley appears despite having no submissions", !!bentley);
eq("Bentley count is 0", bentley.surveyCount, 0);
check("Bentley averages are all null", SCALE_KEYS.every((k) => bentley.averages[k] === null));
check("Bentley averages are NOT 0", SCALE_KEYS.every((k) => bentley.averages[k] !== 0));
eq("Renee count is 1", renee.surveyCount, 1);
check("Renee averages are all 0", SCALE_KEYS.every((k) => renee.averages[k] === 0));
check("Renee averages are NOT null", SCALE_KEYS.every((k) => renee.averages[k] !== null));
check("so a 0 average and an absent average are distinguishable",
  bentley.averages.overallRating === null && renee.averages.overallRating === 0);

// ===========================================================================
console.log("\n[4] Resolving the therapist label on its name portion");
eq("strips a trailing office", providerNameFromLabel("Amanda Davison (Corp)"), "Amanda Davison");
eq("tolerates a label with no office", providerNameFromLabel("Blank Office"), "Blank Office");
eq("tolerates an empty label", providerNameFromLabel(""), "");
// Submission 3's label says (Corp); the roster says ABQ. The name matched.
eq("Amanda resolves despite a stale office in the label", provider("Amanda Davison").surveyCount, 1);
eq("...and takes her office from the roster, not the label", provider("Amanda Davison").office, "ABQ");

// ===========================================================================
console.log("\n[5] A departed provider counts but gets no tab");
const departed = r.departed.filter((p) => p.name === "Amber Merritt")[0];
check("Amber Merritt is in `departed`", !!departed);
check("...and NOT in `providers`", r.providers.every((p) => p.name !== "Amber Merritt"));
eq("...with her office from the inactive roster row", departed.office, "RR");
eq("...and her submission counted", departed.surveyCount, 1);
// Her RR row must reach the office breakdown.
eq("her response lands in the RR office bucket",
  rating("facilityClean", "In Person").byBucket["RR"]["Could be better"], 1);

// ===========================================================================
console.log("\n[6] Unresolvable labels are visible, never dropped");
const ghost = r.unresolved.filter((u) => u.label === "Ghost Provider (ABQ)")[0];
const twin = r.unresolved.filter((u) => u.label === "Twin Name (ABQ)")[0];
check("an unknown name is reported", !!ghost);
eq("...with reason 'unknown'", ghost.reason, "unknown");
eq("...and its submission id", ghost.submissionIds, [7]);
check("a name matching two providers is reported", !!twin);
eq("...with reason 'ambiguous'", twin.reason, "ambiguous");
check("neither appears as an active provider",
  r.providers.every((p) => p.name !== "Ghost Provider"));
check("both twins still appear as providers with nothing attributed",
  r.providers.filter((p) => p.name === "Twin Name").length === 2 &&
  r.providers.filter((p) => p.name === "Twin Name").every((p) => p.surveyCount === 0));
// Unplaceable rows still count on the sheets, under the unknown office.
eq("the ghost's response still counts, under the unknown office",
  rating("facilityClean", "In Person").byBucket[UNKNOWN_OFFICE]["Neutral"], 1);

// ===========================================================================
console.log("\n[7] The ten modality questions — every question, every option");
eq("ten breakdowns", r.ratings.length, 10);
eq("five per modality",
  [r.ratings.filter((x) => x.modality === "In Person").length,
   r.ratings.filter((x) => x.modality === "Telehealth").length], [5, 5]);
(["in-person", "telehealth"] as const).forEach((v) => {
  const modality = v === "in-person" ? "In Person" : "Telehealth";
  modalityQuestionsFor(v).forEach((q) => {
    const b = rating(q.key, modality);
    check(`${modality}/${q.key} has a breakdown`, !!b);
    eq(`${modality}/${q.key} carries its options verbatim`, b.options, [...q.options]);
  });
});
// facilityClean, in-person, hand-tallied from the fixture:
//   ABQ: 1 Excellent (s1), 1 Neutral (s2)
//   LL : 1 Needs improvement immediately (s4), 1 Excellent (s11), 1 Satisfied (s12)
//   RR : 1 Could be better (s6)
//   "" : 1 Neutral (s7), 1 Satisfied (s8), 1 Excellent (s13)
const fc = rating("facilityClean", "In Person").byBucket;
eq("facilityClean ABQ", fc["ABQ"], { Excellent: 1, Neutral: 1 });
eq("facilityClean LL", fc["LL"], { "Needs improvement immediately": 1, Excellent: 1, Satisfied: 1 });
eq("facilityClean RR", fc["RR"], { "Could be better": 1 });
eq("facilityClean unknown office", fc[UNKNOWN_OFFICE], { Neutral: 1, Satisfied: 1, Excellent: 1 });
// greetedOnArrival, in-person — N/A is counted even though the template has no column.
const go = rating("greetedOnArrival", "In Person").byBucket;
eq("greetedOnArrival ABQ counts an N/A", go["ABQ"], { Yes: 1, "N/A": 1 });
eq("greetedOnArrival LL", go["LL"], { No: 1, Yes: 2 });
check("N/A is produced though the template has no column for it",
  go["ABQ"]["N/A"] === 1);

// ===========================================================================
console.log("\n[8] Telehealth is one bucket, with no office split");
["platformSatisfaction", "techDifficultyResponse", "seenWithinTenMinutes", "privacyRespected", "endedFeelingValued"]
  .forEach((k) => {
    const b = rating(k, "Telehealth").byBucket;
    eq(`${k} uses only the TH bucket`, Object.keys(b), [TELEHEALTH_BUCKET]);
  });
// Telehealth rows: s3 Could be better, s5 Satisfied.
eq("platformSatisfaction TH tally", rating("platformSatisfaction", "Telehealth").byBucket[TELEHEALTH_BUCKET],
  { "Could be better": 1, Satisfied: 1 });
check("an in-person office never appears in a TH breakdown",
  ["ABQ", "LL", "RR"].every((o) => rating("privacyRespected", "Telehealth").byBucket[o] === undefined));

// ===========================================================================
console.log("\n[9] Negative listings — criteria, counts, and comment-less rows");
eq("satisfaction negatives are Neutral and below",
  negativeOptionsFor(modalityQuestionsFor("in-person")[0]), SATISFACTION_OPTIONS.slice(2));
eq("yes/no/N-A negatives are No and N/A",
  negativeOptionsFor(modalityQuestionsFor("in-person")[1]), YES_NO_NA_OPTIONS.slice(1));
// facilityClean negatives: Neutral s2 + s7 = 2; Could be better s6 = 1;
// Needs improvement immediately s4 = 1. Four rows.
const fcNeg = negative("facilityClean", "In Person");
eq("facilityClean negative counts", fcNeg.counts,
  { Neutral: 2, "Could be better": 1, "Needs improvement immediately": 1 });
eq("facilityClean negative row count", fcNeg.rows.length, 4);
check("Excellent and Satisfied are never listed",
  fcNeg.rows.every((row) => row.response !== "Excellent" && row.response !== "Satisfied"));
// The client's rule: a row belongs whether or not it carries a comment. None of
// the four facilityClean negatives (s2, s4, s6, s7) carries a facilityClean
// comment, so all four are the comment-less case and all four must be present.
const noComment = fcNeg.rows.filter((row) => row.comment === "");
check("all four rows carry no comment", noComment.length === 4, `${noComment.length}`);
check("...and all four are still listed", fcNeg.rows.length === 4);
// The other direction: a negative response that DOES carry a comment keeps it.
// Submission 3 answered platformSatisfaction "Could be better" with a comment.
const thNeg = negative("platformSatisfaction", "Telehealth");
eq("a commented negative keeps its comment",
  thNeg.rows.map((row) => [row.response, row.comment]), [["Could be better", "Kept freezing"]]);
eq("a listed row carries office, provider and response",
  fcNeg.rows.filter((row) => row.submissionId === 6)
    .map((row) => [row.office, row.providerShortName, row.response, row.comment])[0],
  ["RR", "Amber M", "Could be better", ""]);
// greetedOnArrival negatives: No s4 + s7 = 2; N/A s2 = 1.
eq("greetedOnArrival negative counts", negative("greetedOnArrival", "In Person").counts, { No: 2, "N/A": 1 });

// ===========================================================================
console.log("\n[10] Provider listing rows — the commented superset");
const anna = provider("Anna Aldridge");
// Submission 1 carried two comments; submission 2 carried no comments object.
eq("Anna has 2 listing rows", anna.listingRows.length, 2);
const rated = anna.listingRows.filter((row) => row.questionKey === "connectionRating")[0];
const unrated = anna.listingRows.filter((row) => row.questionKey === "seenWithinTenMinutes")[0];
eq("a rated row carries its score", rated.score, 8);
eq("...and no answer string", rated.answer, null);
eq("...and the comment", rated.comment, "Great rapport");
check("a NON-rated question with a comment also produces a row", !!unrated);
eq("...with no score", unrated.score, null);
eq("...but the answer text instead", unrated.answer, "No");
eq("...and its comment", unrated.comment, "Waited 20 minutes");
check("a submission with no comments object produces no rows",
  provider("Jill Nantze").listingRows.length === 0);
check("providers with no comments still have an empty array, not undefined",
  Array.isArray(bentley.listingRows) && bentley.listingRows.length === 0);

// ===========================================================================
console.log("\n[11] Warnings — nothing vanishes silently");
eq("the variant-less submission is warned and not counted",
  r.warnings.filter((w) => w.code === "no-variant").map((w) => w.submissionId), [14]);
eq("the cross-variant answer key is warned",
  r.warnings.filter((w) => w.code === "answer-outside-variant").map((w) => w.submissionId), [13]);
check("...and that answer is not counted anywhere in-person",
  rating("facilityClean", "In Person").byBucket[UNKNOWN_OFFICE]["Excellent"] === 1);
check("...nor does it reach the telehealth breakdown",
  rating("platformSatisfaction", "Telehealth").byBucket[TELEHEALTH_BUCKET]["Excellent"] === undefined);

// ===========================================================================
console.log("\n[12] Offices are derived from the data, in template order");
eq("offices present, unknown last", r.offices, ["ABQ", "LL", "RR", UNKNOWN_OFFICE]);
check("no Corp bucket is invented", r.offices.indexOf("Corp") === -1);
eq("every active provider appears", r.providers.length, 8);

// ===========================================================================
console.log("\n[13] The shape the 32 stored submissions actually have");
// Those rows predate the 2026-09-03 comment change: no `comments` object at
// all, and 14 of them carry a retired "If no, please explain" value INSIDE
// `answers` (shared/survey-questions.ts ChoiceQuestion.legacyExplain). Those
// keys are not part of any variant, so they warn rather than being counted —
// expected against real data, not a defect.
const legacy = aggregateSurveys({
  roster,
  period: { from: "2026-07-01", to: "2026-09-30" },
  submissions: [sub(
    100, "2026-08-01", "in-person", "Anna Aldridge (ABQ)",
    ["Excellent", "No", "Yes", "Yes", "Yes"], [7, 7, 7, 7],
    undefined,
    { greetedOnArrivalExplain: "No one at the front desk" },
  )],
});
eq("a legacy-shaped row is still counted", legacy.submissionsInPeriod, 1);
eq("...and its ratings still average", legacy.providers.filter((p) => p.name === "Anna Aldridge")[0].averages.overallRating, 7);
eq("...and its negative response is still listed",
  legacy.negatives.filter((x) => x.key === "greetedOnArrival" && x.modality === "In Person")[0].counts.No, 1);
eq("...and the retired explain key warns rather than counting",
  legacy.warnings.map((w) => [w.code, w.detail]),
  [["answer-outside-variant", "greetedOnArrivalExplain is not a in-person question"]]);
check("...producing no listing row, since it is not a comment",
  legacy.providers.filter((p) => p.name === "Anna Aldridge")[0].listingRows.length === 0);

// ===========================================================================
console.log("\n[14] No rollup, total or percentage is computed here");
const keys = Object.keys(r);
["total", "totals", "rollup", "officeRollup", "percentage", "completionRate"].forEach((k) => {
  check(`no '${k}' on the result`, keys.indexOf(k) === -1);
});
check("no provider carries a percentage",
  r.providers.every((p) => !("percentage" in p) && !("completionRate" in p)));
check("Total Active Clients is a declared null, not a number",
  r.providers.every((p) => p.totalActiveClients === null));

// ===========================================================================
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log(failures.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
