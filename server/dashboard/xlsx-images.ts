/**
 * Embed PNG images into a SheetJS-produced .xlsx.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The client asked to see the dashboard's graphs inside the Excel file, and his
 * own suggestion was to embed them as pictures so nothing recalculates when the
 * file is opened. That instinct is right — a chart backed by live formulas can
 * be made to say 17 when the pull said 15, and the whole point of a snapshot is
 * that it cannot drift.
 *
 * SheetJS (community) writes worksheets but cannot embed media. An .xlsx is
 * just a ZIP of XML parts, so this module opens the workbook SheetJS produced,
 * adds the OOXML drawing plumbing by hand, and rezips it with fflate.
 *
 * THE PARTS A PICTURE NEEDS, and why each one:
 *   xl/media/imageN.png            the bytes
 *   xl/drawings/drawingN.xml       where the picture sits on the sheet
 *   xl/drawings/_rels/…​.rels        drawing -> media
 *   xl/worksheets/_rels/…​.rels      sheet -> drawing
 *   xl/worksheets/sheetN.xml        a <drawing r:id="…"/> element
 *   [Content_Types].xml            a default entry for the png extension
 * Miss any one and Excel reports the file as corrupt, so all six are written.
 *
 * The anchor is twoCellAnchor with editAs="oneCell": the picture keeps its size
 * when rows around it resize, which is what you want for a static snapshot.
 *
 * NO RECALCULATION IS POSSIBLE. These are raster pictures. There is no chart
 * part, no cached series, no formula — nothing for Excel to recompute.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";

export interface SheetImage {
  /** 1-based index of the worksheet, matching SheetJS's sheet order. */
  sheetIndex: number;
  /** Raw PNG bytes. */
  png: Uint8Array;
  /** Top-left cell anchor. */
  fromCol: number;
  fromRow: number;
  /** Rendered size. */
  widthPx: number;
  heightPx: number;
}

/** English Metric Units — OOXML's internal unit. 914400 EMU = 1 inch = 96 px. */
const EMU_PER_PX = 9525;

function drawingXml(images: SheetImage[]): string {
  const anchors = images.map((img, i) => `
  <xdr:twoCellAnchor editAs="oneCell">
    <xdr:from><xdr:col>${img.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${img.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
    <xdr:ext cx="${img.widthPx * EMU_PER_PX}" cy="${img.heightPx * EMU_PER_PX}"/>
    <xdr:pic>
      <xdr:nvPicPr>
        <xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/>
        <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
      </xdr:nvPicPr>
      <xdr:blipFill>
        <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${i + 1}"/>
        <a:stretch><a:fillRect/></a:stretch>
      </xdr:blipFill>
      <xdr:spPr>
        <a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.widthPx * EMU_PER_PX}" cy="${img.heightPx * EMU_PER_PX}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
      </xdr:spPr>
    </xdr:pic>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`).join("");

  // twoCellAnchor requires a <to>; using ext with editAs="oneCell" is the
  // simpler oneCellAnchor form, so emit that instead — Excel accepts both and
  // oneCellAnchor is what keeps the picture a fixed size.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${
    anchors.replace(/twoCellAnchor editAs="oneCell"/g, "oneCellAnchor").replace(/<\/xdr:twoCellAnchor>/g, "</xdr:oneCellAnchor>")
  }
</xdr:wsDr>`;
}

function drawingRels(count: number): string {
  const rels = Array.from({ length: count }, (_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

/**
 * Insert `images` into the workbook `buf`, grouped by their target sheet.
 *
 * Returns the rewritten workbook. Throws only on a malformed input workbook —
 * the caller is expected to fall back to the image-free file rather than fail
 * the whole export, since a table that reconciles is worth more than a picture.
 */
export function embedImages(buf: Uint8Array, images: SheetImage[]): Uint8Array {
  if (images.length === 0) return buf;

  const zip = unzipSync(buf);
  const out: Record<string, Uint8Array> = { ...zip };

  // Group by sheet: each worksheet gets exactly one drawing part.
  const bySheet = new Map<number, SheetImage[]>();
  for (const img of images) {
    const list = bySheet.get(img.sheetIndex) ?? [];
    list.push(img);
    bySheet.set(img.sheetIndex, list);
  }

  let mediaSeq = 0;
  let drawingSeq = 0;

  for (const [sheetIndex, sheetImages] of Array.from(bySheet.entries())) {
    const sheetPath = `xl/worksheets/sheet${sheetIndex}.xml`;
    if (!out[sheetPath]) continue; // sheet absent — skip rather than corrupt

    drawingSeq += 1;
    const drawingPath = `xl/drawings/drawing${drawingSeq}.xml`;

    // Media, and the drawing -> media relationships, numbered per drawing.
    const localRels: string[] = [];
    sheetImages.forEach((img, i) => {
      mediaSeq += 1;
      out[`xl/media/image${mediaSeq}.png`] = img.png;
      localRels.push(
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${mediaSeq}.png"/>`,
      );
    });

    out[drawingPath] = strToU8(drawingXml(sheetImages));
    out[`xl/drawings/_rels/drawing${drawingSeq}.xml.rels`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${localRels.join("")}</Relationships>`,
    );

    // Sheet -> drawing relationship. SheetJS may not have written a rels part.
    const sheetRelsPath = `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`;
    const relId = "rIdDrawing1";
    const drawingRel = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingSeq}.xml"/>`;
    if (out[sheetRelsPath]) {
      const existing = strFromU8(out[sheetRelsPath]);
      out[sheetRelsPath] = strToU8(existing.replace("</Relationships>", `${drawingRel}</Relationships>`));
    } else {
      out[sheetRelsPath] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${drawingRel}</Relationships>`,
      );
    }

    // The <drawing/> element must be the LAST child of <worksheet>, per the
    // schema; Excel rejects the file if it appears earlier.
    const sheetXml = strFromU8(out[sheetPath]);
    if (!sheetXml.includes("<drawing ")) {
      out[sheetPath] = strToU8(
        sheetXml.replace("</worksheet>", `<drawing r:id="${relId}"/></worksheet>`),
      );
    }
  }

  // PNG must be declared in [Content_Types].xml or Excel calls the file corrupt.
  const ctPath = "[Content_Types].xml";
  if (out[ctPath]) {
    let ct = strFromU8(out[ctPath]);
    if (!ct.includes('Extension="png"')) {
      ct = ct.replace("<Types ", '<Types ').replace(
        /(<Types[^>]*>)/,
        '$1<Default Extension="png" ContentType="image/png"/>',
      );
    }
    if (!ct.includes("spreadsheetml.drawing")) {
      const parts = Array.from({ length: drawingSeq }, (_, i) =>
        `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
      ).join("");
      ct = ct.replace("</Types>", `${parts}</Types>`);
    }
    out[ctPath] = strToU8(ct);
  }

  return zipSync(out);
}

/** Exported for the self-check harness. */
export { drawingRels };
