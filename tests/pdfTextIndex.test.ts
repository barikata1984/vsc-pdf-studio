import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const PAGE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const PAGE_SIZES: Array<[number, number]> = [
  [612, 792],
  [612, 792],
  [842, 595],
  [400, 400],
  [612, 792],
];

// Both modules are plain ES modules under media/, which TypeScript does not
// type-check. Import through a variable so the compiler treats them as `any`.
async function importMedia(fileName: string): Promise<any> {
  const fileUrl = pathToFileURL(
    path.resolve(__dirname, '../../media', fileName)
  ).href;
  return import(fileUrl);
}

async function importPdfjs(): Promise<any> {
  const moduleId = 'pdfjs-dist/legacy/build/pdf.js';
  return import(moduleId);
}

async function createSamplePdf(): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  PAGE_WORDS.forEach((word, index) => {
    const [width, height] = PAGE_SIZES[index];
    const page = pdfDoc.addPage([width, height]);
    page.drawText(word, { x: 40, y: height - 80, size: 24, font });
  });

  return pdfDoc.save();
}

async function loadPageTextContents(data: Uint8Array) {
  const pdfjs = await importPdfjs();
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages = [];
  const viewportRatios: number[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    viewportRatios.push(viewport.width / viewport.height);
    pages.push({ pageNumber, textContent: await page.getTextContent() });
  }

  await pdf.destroy();
  return { pageCount: pdf.numPages, pages, viewportRatios };
}

test('every page word is found on its own page through the text index', async () => {
  const { buildTextIndex, findInTextIndex } = await importMedia('textIndex.js');
  const { pageCount, pages } = await loadPageTextContents(
    await createSamplePdf()
  );

  assert.equal(pageCount, PAGE_WORDS.length);

  const index = buildTextIndex(pages);

  PAGE_WORDS.forEach((word, pageIndex) => {
    const matches = findInTextIndex(index, word.toUpperCase());
    assert.equal(matches.length, 1, `expected one match for ${word}`);
    assert.equal(matches[0].pageNumber, pageIndex + 1);
    assert.equal(
      index[pageIndex].text.slice(matches[0].start, matches[0].end),
      word
    );
  });

  assert.deepEqual(findInTextIndex(index, 'foxtrot'), []);
});

test('page viewport aspect ratios match the generated page sizes', async () => {
  const { viewportRatios } = await loadPageTextContents(
    await createSamplePdf()
  );

  viewportRatios.forEach((ratio, pageIndex) => {
    const [width, height] = PAGE_SIZES[pageIndex];
    assert.ok(
      Math.abs(ratio - width / height) < 1e-6,
      `page ${pageIndex + 1} ratio ${ratio} != ${width / height}`
    );
  });
});
