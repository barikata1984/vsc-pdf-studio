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
  const module = await import(moduleId);
  return module.default ?? module;
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

test('buffered page selection clamps boundaries and removes duplicates', async () => {
  const { getBufferedPageNumbers } = await importMedia('pdfRenderer.js');

  assert.deepEqual(getBufferedPageNumbers([], 5), []);
  assert.deepEqual(getBufferedPageNumbers([1], 5), [1, 2]);
  assert.deepEqual(getBufferedPageNumbers([5], 5), [4, 5]);
  assert.deepEqual(getBufferedPageNumbers([2, 3], 5), [1, 2, 3, 4]);
});

test('render session parses one document and caches page dimensions', async () => {
  const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
  const originalPdfjs = (globalThis as any).pdfjsLib;
  let documentLoads = 0;
  let documentDestroys = 0;
  const pageSizes = [
    [612, 792],
    [842, 595],
  ];
  const pdf = {
    numPages: pageSizes.length,
    async getPage(pageNumber: number) {
      const [width, height] = pageSizes[pageNumber - 1];
      return {
        getViewport({ scale }: { scale: number }) {
          return { width: width * scale, height: height * scale, scale };
        },
      };
    },
    async getOutline() {
      return [];
    },
    async destroy() {
      documentDestroys += 1;
    },
  };

  (globalThis as any).pdfjsLib = {
    getDocument() {
      documentLoads += 1;
      return { promise: Promise.resolve(pdf) };
    },
  };

  try {
    const session = await createPdfRenderSession('QQ==');

    assert.equal(documentLoads, 1);
    assert.equal(session.pageCount, 2);
    assert.deepEqual(session.pageSizes, [
      { width: 612, height: 792 },
      { width: 842, height: 595 },
    ]);

    await session.destroy();
    assert.equal(documentDestroys, 1);
  } finally {
    (globalThis as any).pdfjsLib = originalPdfjs;
  }
});

test('render session creates page shells and draws only requested pages', async () => {
  const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
  const originalDocument = (globalThis as any).document;
  const originalPdfjs = (globalThis as any).pdfjsLib;
  const originalPdfjsViewer = (globalThis as any).pdfjsViewer;
  let renderCalls = 0;
  let textCalls = 0;
  let cancelCalls = 0;
  let holdNextRender = false;

  class FakeElement {
    children: FakeElement[] = [];
    className = '';
    width = 0;
    height = 0;
    style: Record<string, any> = {
      setProperty(name: string, value: string) {
        this[name] = value;
      },
    };
    classList = {
      add: (...names: string[]) => {
        this.className = [this.className, ...names].filter(Boolean).join(' ');
      },
    };

    append(...children: FakeElement[]) {
      this.children.push(...children);
    }

    getContext() {
      return {};
    }
  }

  class FakeTextLayerBuilder {
    div = new FakeElement();
    textDivs: unknown[] = [];
    textContentItemsStr: string[] = [];

    setTextContentSource(textContent: { items: Array<{ str: string }> }) {
      this.textContentItemsStr = textContent.items.map((item) => item.str);
    }

    async render() {}
  }

  const sizes = [
    [612, 792],
    [842, 595],
  ];
  const pages = sizes.map(([width, height]) => ({
    getViewport({ scale }: { scale: number }) {
      return { width: width * scale, height: height * scale, scale };
    },
    render() {
      renderCalls += 1;
      let rejectRender: (error: Error) => void = () => {};
      const promise = holdNextRender
        ? new Promise<void>((_resolve, reject) => {
            rejectRender = reject;
          })
        : Promise.resolve();
      return {
        promise,
        cancel() {
          cancelCalls += 1;
          const error = new Error('cancelled');
          error.name = 'RenderingCancelledException';
          rejectRender(error);
        },
      };
    },
    async getTextContent() {
      textCalls += 1;
      return { items: [{ str: `page-${width}` }] };
    },
  }));
  const pdf = {
    numPages: pages.length,
    async getPage(pageNumber: number) {
      return pages[pageNumber - 1];
    },
    async getOutline() {
      return [];
    },
    async destroy() {},
  };

  (globalThis as any).document = {
    createDocumentFragment: () => new FakeElement(),
    createElement: () => new FakeElement(),
  };
  (globalThis as any).pdfjsLib = {
    getDocument: () => ({ promise: Promise.resolve(pdf) }),
  };
  (globalThis as any).pdfjsViewer = {
    TextLayerBuilder: FakeTextLayerBuilder,
  };

  try {
    const session = await createPdfRenderSession('QQ==');
    const layout = session.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );

    assert.equal(layout.pages.length, 2);
    assert.equal(layout.fragment.children.length, 2);
    assert.equal(layout.pages[0].pageShell.style.width, '612px');
    assert.equal(layout.pages[1].pageShell.style.height, '595px');
    assert.equal(layout.pages[0].drawingCanvas.width, 1);
    assert.equal(layout.pages[0].drawingCanvas.style.width, '612px');
    assert.equal(renderCalls, 0);

    assert.equal(await session.renderPage(layout.pages[1]), true);
    assert.equal(renderCalls, 1);
    assert.equal(layout.pages[1].renderState, 'rendered');
    assert.deepEqual(layout.pages[1].textContentItemsStr, ['page-842']);
    assert.equal(textCalls, 1);

    assert.equal(await session.renderPage(layout.pages[1]), true);
    assert.equal(renderCalls, 1);

    assert.equal(await session.ensureTextLayers(layout.pages), true);
    assert.equal(renderCalls, 1);
    assert.equal(textCalls, 2);

    holdNextRender = true;
    const obsoleteRender = session.renderPage(layout.pages[0]);
    session.cancelRendering();
    assert.equal(await obsoleteRender, false);
    assert.equal(cancelCalls, 1);
    assert.equal(layout.pages[0].renderState, 'idle');
    await session.destroy();
  } finally {
    (globalThis as any).document = originalDocument;
    (globalThis as any).pdfjsLib = originalPdfjs;
    (globalThis as any).pdfjsViewer = originalPdfjsViewer;
  }
});

test('drawing layer expands a lazy canvas before pointer coordinates are used', async () => {
  const { createDrawingLayer } = await importMedia('drawingLayer.js');
  const context = { clearRect() {} };
  const drawingCanvas = {
    width: 1,
    height: 1,
    addEventListener() {},
    getContext: () => context,
  };
  const pageEntry = {
    pageNumber: 1,
    width: 612,
    height: 792,
    drawingCanvas,
    pageShell: { addEventListener() {} },
  };
  const layer = createDrawingLayer([pageEntry], {
    getHighlights: () => [],
  });

  layer.ensurePageCanvas(pageEntry);

  assert.equal(drawingCanvas.width, 612);
  assert.equal(drawingCanvas.height, 792);
});
