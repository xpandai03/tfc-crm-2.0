/**
 * Email Snapshot Download
 *
 * Fetches stored email HTML from the API and converts to PDF
 * using html2pdf.js (client-side only, no server-side PDF generation).
 */

export async function downloadEmailSnapshot(snapshotId: number): Promise<void> {
  // Fetch the snapshot HTML from the API
  const response = await fetch(`/api/email-snapshot/${snapshotId}`);
  if (!response.ok) {
    throw new Error("Failed to fetch email snapshot");
  }

  const snapshot = await response.json();
  if (!snapshot.bodyHtml) {
    throw new Error("Snapshot has no HTML content");
  }

  // Dynamically import html2pdf.js (only loaded when user clicks download)
  const html2pdf = (await import("html2pdf.js")).default;

  // Create a hidden container with the email HTML
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "0";
  container.style.width = "800px";
  container.innerHTML = snapshot.bodyHtml;
  document.body.appendChild(container);

  try {
    // Build filename from subject
    const safeName = (snapshot.subject || "email-snapshot")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 60);

    await html2pdf()
      .set({
        margin: [10, 10, 10, 10],
        filename: `${safeName}.pdf`,
        image: { type: "jpeg", quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(container)
      .save();
  } finally {
    document.body.removeChild(container);
  }
}
