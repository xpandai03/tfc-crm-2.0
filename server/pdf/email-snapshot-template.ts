/**
 * Email Snapshot PDF Template
 *
 * Builds a pdfmake document definition from a stored email_snapshot row
 * (the rendered HTML of a sent email — e.g. the Initial Appointment
 * Confirmation). Mirrors the structure/styles of intake-template.ts and uses
 * Helvetica (PDF built-in) — no custom fonts, no Puppeteer.
 *
 * The HTML → text conversion is intentionally naive: emails from the CRM
 * templates are simple (headings, paragraphs, the odd table/list), and the PDF
 * only needs to capture readable CONTENT for TFC staff, not reproduce styling.
 */

import type { EmailSnapshot } from "../email-snapshots/types";

type Content = Record<string, unknown>;

function formatDateTime(iso: string | null): string {
  if (!iso) return "Unknown date";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

// Decode the handful of HTML entities that show up in our email templates.
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

/**
 * Convert email HTML into an ordered list of plain-text paragraphs.
 * - Drops <head>/<style>/<script> blocks entirely.
 * - Turns block boundaries (</p>, </div>, <br>, </h1..6>, list items, table
 *   rows) into newlines; list items get a bullet.
 * - Strips remaining tags, decodes entities, normalizes whitespace.
 * - Splits on blank lines into paragraphs.
 */
export function htmlToParagraphs(html: string): string[] {
  if (!html) return [];

  let s = html;
  // Remove non-content blocks
  s = s.replace(/<(head|style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Comments
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // List items → bullet on a new line
  s = s.replace(/<li[^>]*>/gi, "\n• ");
  // Line breaks
  s = s.replace(/<br\s*\/?>/gi, "\n");
  // Block-closing tags → newline
  s = s.replace(/<\/(p|div|h[1-6]|tr|li|ul|ol|table|section|header|footer|blockquote)>/gi, "\n");
  // Table cell separators → space
  s = s.replace(/<\/(td|th)>/gi, "  ");
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode entities
  s = decodeEntities(s);
  // Normalize whitespace: collapse horizontal runs, trim lines
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n");
  // Collapse 3+ newlines to a paragraph break
  s = s.replace(/\n{3,}/g, "\n\n");

  return s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Build a pdfmake docDefinition from a stored email snapshot.
 */
export function buildEmailSnapshotDocument(snapshot: EmailSnapshot): Record<string, unknown> {
  const generatedAt = formatDateTime(new Date().toISOString());
  const sentAt = formatDateTime(snapshot.sentAt);
  const recipient = snapshot.recipientEmail || "unknown recipient";

  const paragraphs = htmlToParagraphs(snapshot.bodyHtml);
  const bodyContent: Content[] = paragraphs.length > 0
    ? paragraphs.map((p): Content => ({ text: p, style: "body", margin: [0, 0, 0, 8] }))
    : [{ text: "(No text content could be extracted from the email HTML.)", style: "body", italics: true }];

  const content: Content[] = [
    { text: "The Family Connection", style: "orgName" },
    { text: "Email Record", style: "docTitle", margin: [0, 0, 0, 12] },
    { text: snapshot.subject || "(no subject)", style: "subject", margin: [0, 0, 0, 4] },
    {
      text: `Sent on ${sentAt} to ${recipient}`,
      style: "meta",
      margin: [0, 0, 0, 2],
    },
    {
      text: `Template: ${snapshot.templateId}`,
      style: "meta",
      margin: [0, 0, 0, 10],
    },
    {
      canvas: [{ type: "line", x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 0.5, lineColor: "#CBD5E1" }],
      margin: [0, 0, 0, 12],
    },
    ...bodyContent,
  ];

  return {
    content,
    defaultStyle: {
      font: "Helvetica",
      fontSize: 10,
      lineHeight: 1.3,
    },
    styles: {
      orgName: { fontSize: 16, bold: true, color: "#7C3AED" },
      docTitle: { fontSize: 12, color: "#64748B" },
      subject: { fontSize: 14, bold: true, color: "#1E293B" },
      meta: { fontSize: 9, color: "#64748B" },
      body: { fontSize: 10, color: "#1E293B" },
    },
    pageSize: "A4" as const,
    pageMargins: [40, 40, 40, 60],
    footer: (currentPage: number, pageCount: number): Content => ({
      columns: [
        {
          text: `Generated: ${generatedAt}  ·  TFC CRM 2.0`,
          fontSize: 7,
          color: "#94A3B8",
          margin: [40, 0, 0, 0],
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          fontSize: 7,
          color: "#94A3B8",
          alignment: "right",
          margin: [0, 0, 40, 0],
        },
      ],
    }),
  };
}
