/**
 * Email Snapshot Download
 *
 * Fetches stored email HTML from the API and converts to PDF
 * using html2pdf.js (client-side only, no server-side PDF generation).
 *
 * Email templates are full HTML documents with <html>/<head>/<style> tags.
 * We extract the <body> content and inline any <style> blocks so
 * html2canvas can render them correctly in a mounted DOM node.
 */

/**
 * Extract body content and style blocks from a full HTML document string.
 */
function extractEmailContent(html: string): { bodyHtml: string; styles: string } {
  // Extract all <style> blocks (from <head> or anywhere)
  const styleBlocks: string[] = [];
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(html)) !== null) {
    styleBlocks.push(styleMatch[1]);
  }

  // Extract <body> content; fall back to the full string if no <body> tag
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;

  return {
    bodyHtml,
    styles: styleBlocks.join("\n"),
  };
}

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

  // Parse the full HTML document into body content + styles
  const { bodyHtml, styles } = extractEmailContent(snapshot.bodyHtml);

  // Create a visible, off-screen container for html2canvas to render
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "0";
  container.style.width = "800px";
  container.style.background = "white";

  // Inject extracted styles as a <style> block so CSS applies within the container
  if (styles) {
    const styleEl = document.createElement("style");
    styleEl.textContent = styles;
    container.appendChild(styleEl);
  }

  // Inject the body content
  const contentDiv = document.createElement("div");
  contentDiv.innerHTML = bodyHtml;
  container.appendChild(contentDiv);

  document.body.appendChild(container);

  try {
    // Wait for next animation frame + a short delay so the browser
    // fully lays out and paints the injected content
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 100);
      });
    });

    // Build filename from subject
    const safeName = (snapshot.subject || "email-snapshot")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .substring(0, 60);

    await html2pdf()
      .set({
        margin: 10,
        filename: `${safeName}.pdf`,
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(container)
      .save();
  } finally {
    document.body.removeChild(container);
  }
}
