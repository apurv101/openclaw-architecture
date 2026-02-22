/**
 * PDF text extraction using pdfjs-dist.
 *
 * Uses the legacy build so we don't need a canvas dependency in Node.
 */

export interface PdfExtractionResult {
  text: string;
  numPages: number;
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<PdfExtractionResult> {
  // Dynamic import to avoid loading WASM when unused
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .filter((item: any) => "str" in item)
      .map((item: any) => item.str)
      .join(" ");
    if (text.trim()) {
      pageTexts.push(text.trim());
    }
  }

  return { text: pageTexts.join("\n\n"), numPages };
}
