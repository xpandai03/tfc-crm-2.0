/**
 * Email Snapshot Download
 *
 * Fetches stored email HTML from the API and converts to PDF
 * using html2pdf.js (client-side only, no server-side PDF generation).
 *
 * The stored HTML is a complete document (<!DOCTYPE html>...).
 * We render it in a hidden iframe to preserve the full document
 * structure, then clone the rendered content into the main document
 * for html2canvas to capture.
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

  // Step 1: Render the full HTML document in a hidden iframe.
  // This preserves <html>, <head>, <body> structure and all inline styles.
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:0;top:0;width:800px;height:600px;opacity:0;pointer-events:none;z-index:-1;border:none;";
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    throw new Error("Failed to create iframe document");
  }

  iframeDoc.open();
  iframeDoc.write(snapshot.bodyHtml);
  iframeDoc.close();

  // Wait for iframe content to fully render (images, fonts, layout)
  await new Promise<void>((resolve) => {
    iframe.onload = () => resolve();
    setTimeout(resolve, 800); // fallback if onload doesn't fire
  });

  // Step 2: Clone the rendered body into a container in the main document.
  // html2canvas works best with elements in the current document at
  // normal viewport coordinates (negative offsets cause blank captures).
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:0;top:0;width:800px;z-index:-1;background:white;";

  // Copy the body's inline styles (font-family, margin, padding, etc.)
  const bodyStyle = iframeDoc.body.getAttribute("style");
  if (bodyStyle) {
    container.style.cssText += bodyStyle;
    // Re-apply positioning (body styles may override position/width)
    container.style.position = "fixed";
    container.style.left = "0";
    container.style.top = "0";
    container.style.width = "800px";
    container.style.zIndex = "-1";
  }

  // Deep-clone the body content
  container.innerHTML = iframeDoc.body.innerHTML;
  document.body.appendChild(container);

  // Remove iframe now that we've cloned content
  document.body.removeChild(iframe);

  try {
    // Wait for the cloned content to be painted in the main document
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 250));
    });

    // Debug: log container dimensions
    const rect = container.getBoundingClientRect();
    console.log("[email-snapshot] Container dimensions:", {
      width: rect.width,
      height: rect.height,
      childCount: container.childElementCount,
      innerHTMLLength: container.innerHTML.length,
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
        html2canvas: { scale: 2, useCORS: true, logging: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(container)
      .save();
  } finally {
    document.body.removeChild(container);
  }
}
