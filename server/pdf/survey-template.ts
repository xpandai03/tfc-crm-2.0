/**
 * Client Survey PDF Template
 *
 * Builds a pdfmake document definition from a survey `form_submissions` row.
 * Follows the house pattern established by ./intake-template.ts and
 * ./email-snapshot-template.ts: Helvetica (a PDF built-in, no font files), an
 * A4 page, the same header/section/footer styling, and the same
 * `Record<string, unknown>` doc-definition return shape the routes hand to
 * `pdfmake.createPdf`.
 *
 * THIS DOCUMENT GOES INTO A CLINICAL RECORD. It is written as a record of what
 * the client submitted, not as a report: every question the form asked appears,
 * in the order it was asked, in the practice's own wording, with the client's
 * answer beneath it.
 *
 * QUESTION TEXT IS NEVER HARDCODED HERE. Every prompt, option list and anchor
 * label is read from shared/survey-questions.ts, which is the same definition
 * that drives the public form and the server's validation schema. A second copy
 * would drift from the instrument, and the instrument is the client's, typos
 * included ("We're you greeted", "an technical difficulties", "of value" vs
 * "a value"). Anything that looks like a typo below came from that file.
 *
 * NOT ASKED vs NOT ANSWERED. The four "If no, please explain" boxes are only
 * shown on the form when the preceding answer is "No". So:
 *   - answer is not the revealing one  -> the box was never presented, and it
 *     is omitted from the PDF entirely
 *   - answer is "No" but the box was left empty -> it WAS presented and skipped,
 *     and the PDF says so explicitly
 * A reader of a chart can therefore tell a question that was never put to the
 * client from one they declined to answer. "Additional Comments" is always
 * presented, so a blank one always renders as not answered.
 */

import type { FormSubmission } from "../sync/db";
import {
  questionsFor,
  variantFromPath,
  type ChoiceQuestion,
  type ScaleQuestion,
  type SurveyQuestion,
  type SurveyVariant,
} from "@shared/survey-questions";

type Content = Record<string, unknown>;

/** Shown where the form asked something and the client left it blank. */
const NOT_ANSWERED = "— Not answered —";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

/** ISO date of birth -> MM/DD/YYYY, matching intake-template's formatDob. */
function formatDob(iso: string | null): string | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

interface SurveyPayload {
  formVariant?: unknown;
  modality?: unknown;
  submittedAt?: unknown;
  client?: { name?: unknown; dateOfBirth?: unknown; email?: unknown };
  answers?: Record<string, unknown>;
}

/** True when this row is a survey this builder can render. */
export function isSurveyPayload(payload: unknown): boolean {
  const p = payload as SurveyPayload | null;
  if (!p || typeof p !== "object") return false;
  return typeof p.formVariant === "string" && variantFromPath(p.formVariant) !== null;
}

const asString = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};

/**
 * One question block: the prompt, then the answer indented beneath it.
 *
 * A stack rather than a two-column label/value row (which is what
 * intake-template uses for its short field names). Survey prompts run to two
 * lines and the comment runs to many, and a fixed-width column would either
 * squeeze the text or clip it. A stack lets pdfmake wrap and break across pages
 * on its own, which is what keeps the ~1,400-character comment intact.
 */
function questionBlock(prompt: string, answer: Content[], answered: boolean): Content {
  return {
    stack: [
      { text: prompt, style: "question" },
      ...answer,
    ],
    // Keep a prompt from being orphaned at the foot of a page away from its
    // answer. Deliberately NOT applied to the comments block, which must be
    // free to break across pages.
    unbreakable: answered ? false : true,
    margin: [0, 0, 0, 11],
  };
}

const answerText = (value: string): Content => ({
  text: value, style: "answer", margin: [12, 2, 0, 0],
});

const notAnswered = (): Content => ({
  text: NOT_ANSWERED, style: "answerMuted", margin: [12, 2, 0, 0],
});

function sectionHeader(title: string): Content[] {
  return [
    { text: title, style: "sectionHeader", margin: [0, 14, 0, 4] },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#CBD5E1" }],
      margin: [0, 0, 0, 8],
    },
  ];
}

/**
 * Render one question and, where applicable, its conditional explanation.
 * Returns the blocks in the order they should appear.
 */
function renderQuestion(q: SurveyQuestion, answers: Record<string, unknown>): Content[] {
  const out: Content[] = [];
  const raw = answers[q.key];

  switch (q.kind) {
    case "therapist":
    case "choice": {
      const value = asString(raw);
      out.push(questionBlock(q.prompt, value ? [answerText(value)] : [notAnswered()], !!value));

      // The conditional box, only if the form actually presented it.
      const cq = q as ChoiceQuestion;
      if (cq.explain && value === cq.explain.revealOn) {
        const detail = asString(answers[cq.explain.key]);
        out.push({
          stack: [
            { text: cq.explain.prompt, style: "subQuestion" },
            detail
              ? { text: detail, style: "answer", margin: [12, 2, 0, 0] }
              : { text: NOT_ANSWERED, style: "answerMuted", margin: [12, 2, 0, 0] },
          ],
          margin: [16, 0, 0, 11],
        });
      }
      break;
    }

    case "scale": {
      const sq = q as ScaleQuestion;
      // A 0 is a real answer and the lowest possible score. Compare against
      // null/undefined, never truthiness, or "0 out of 10" renders as blank —
      // the difference between a client who rated the session zero and one who
      // did not rate it at all.
      const n = typeof raw === "number" ? raw : null;
      out.push(
        questionBlock(
          sq.prompt,
          n === null
            ? [notAnswered()]
            : [
                { text: `${n} out of 10`, style: "answerScale", margin: [12, 2, 0, 0] },
                // The anchors are part of the source question text; showing
                // them is what lets a reader know what a 3 meant.
                {
                  text: `${sq.lowAnchor}  ·  ${sq.highAnchor}`,
                  style: "anchors",
                  margin: [12, 1, 0, 0],
                },
              ],
          n !== null,
        ),
      );
      break;
    }

    case "text": {
      const value = asString(raw);
      out.push({
        stack: [
          { text: q.prompt, style: "question" },
          value
            ? { text: value, style: "answer", margin: [12, 2, 0, 0] }
            : { text: NOT_ANSWERED, style: "answerMuted", margin: [12, 2, 0, 0] },
        ],
        // No `unbreakable` here on purpose: a long comment must be allowed to
        // flow onto the next page rather than being pushed whole or clipped.
        margin: [0, 0, 0, 11],
      });
      break;
    }
  }

  return out;
}

export function buildSurveyDocument(submission: FormSubmission): Record<string, unknown> {
  const payload = (submission.payload ?? {}) as SurveyPayload;
  const variant = (variantFromPath(String(payload.formVariant ?? "")) ??
    "in-person") as SurveyVariant;
  const questions = questionsFor(variant);
  const answers = (payload.answers ?? {}) as Record<string, unknown>;

  const modality = asString(payload.modality) ?? (variant === "telehealth" ? "Telehealth" : "In Person");
  const clientName = asString(payload.client?.name) ?? submission.name ?? "";
  const dob = formatDob(asString(payload.client?.dateOfBirth));
  const email = asString(payload.client?.email);

  const submittedDate =
    formatDate(asString(payload.submittedAt) ?? submission.submittedAt) ??
    formatDate(submission.createdAt);

  const generatedAt = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });

  // --- Header: mirrors intake-template's shape ---------------------------
  const header: Content[] = [
    { text: "THE FAMILY CONNECTION", style: "orgName", margin: [0, 0, 0, 2] },
    { text: `Client Survey — ${modality}`, style: "docTitle", margin: [0, 0, 0, 12] },
    {
      columns: [
        {
          width: "*",
          stack: [
            { text: clientName, style: "contactName" },
            ...(dob ? [{ text: `Date of Birth: ${dob}`, style: "contactMeta" }] : []),
            ...(email ? [{ text: email, style: "contactMeta" }] : []),
          ],
        },
        {
          width: "auto",
          alignment: "right" as const,
          stack: [
            { text: `Submission #${submission.id}`, style: "contactMeta" },
            ...(submittedDate ? [{ text: `Date Submitted: ${submittedDate}`, style: "contactMeta" }] : []),
            { text: `Modality: ${modality}`, style: "contactMeta" },
          ],
        },
      ],
      margin: [0, 0, 0, 6],
    },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 1, lineColor: "#7C3AED" }],
      margin: [0, 4, 0, 0],
    },
  ];

  // --- Responses: every question, in the order the form asked them -------
  const responses: Content[] = [];
  for (const q of questions) {
    responses.push(...renderQuestion(q, answers));
  }

  const content: Content[] = [
    ...header,
    ...sectionHeader("SURVEY RESPONSES"),
    ...responses,
  ];

  return {
    content,
    defaultStyle: { font: "Helvetica", fontSize: 10, lineHeight: 1.3 },
    styles: {
      orgName: { fontSize: 16, bold: true, color: "#7C3AED" },
      docTitle: { fontSize: 12, color: "#64748B" },
      contactName: { fontSize: 14, bold: true, color: "#1E293B" },
      contactMeta: { fontSize: 9, color: "#64748B", margin: [0, 1, 0, 0] },
      sectionHeader: { fontSize: 10, bold: true, color: "#475569", characterSpacing: 1 },
      question: { fontSize: 9.5, bold: true, color: "#334155" },
      subQuestion: { fontSize: 9, bold: true, color: "#64748B", italics: true },
      answer: { fontSize: 10, color: "#1E293B" },
      answerScale: { fontSize: 11, bold: true, color: "#1E293B" },
      answerMuted: { fontSize: 10, color: "#94A3B8", italics: true },
      anchors: { fontSize: 8, color: "#94A3B8", italics: true },
    },
    pageSize: "A4" as const,
    pageMargins: [40, 40, 40, 60],
    footer: (currentPage: number, pageCount: number): Content => ({
      columns: [
        { text: `Generated: ${generatedAt}  ·  TFC CRM 2.0`, fontSize: 7, color: "#94A3B8", margin: [40, 0, 0, 0] },
        { text: `Page ${currentPage} of ${pageCount}`, fontSize: 7, color: "#94A3B8", alignment: "right" as const, margin: [0, 0, 40, 0] },
      ],
      margin: [0, 20, 0, 0],
    }),
  };
}
