import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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

test('search finds an unrendered page and renders it only when revealed', async () => {
  const { createSearchController } = await importMedia('search.js');
  const originalDocument = (globalThis as any).document;
  const originalWindow = (globalThis as any).window;
  let scrolledTo: Record<string, number> | null = null;
  const requestedPages: number[] = [];

  class FakeLayer {
    children: unknown[] = [];

    replaceChildren() {
      this.children = [];
    }

    append(...children: unknown[]) {
      this.children.push(...children);
    }
  }

  const pageEntries: any[] = [1, 2].map((pageNumber) => ({
    pageNumber,
    width: 600,
    height: 800,
    searchLayer: new FakeLayer(),
    textLayer: {
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        width: 600,
        height: 800,
      }),
    },
    textDivs: [],
  }));
  const state: any = {
    pageEntries,
    searchQuery: 'bravo',
    searchTextIndex: [
      { pageNumber: 1, text: 'alpha', items: [{ index: 0, start: 0, end: 5 }] },
      { pageNumber: 2, text: 'bravo', items: [{ index: 0, start: 0, end: 5 }] },
    ],
    searchMatches: [],
    activeSearchMatchIndex: -1,
    pageJumpInProgress: false,
    currentPage: 1,
  };
  const classList = { toggle() {} };
  const searchCount = { textContent: '' };
  let controller: any;

  (globalThis as any).document = {
    createElement: () => ({ className: '', style: {} }),
    createRange: () => ({
      setStart() {},
      setEnd() {},
      getClientRects: () => [{ left: 40, top: 60, width: 80, height: 20 }],
    }),
  };
  (globalThis as any).window = {
    setTimeout(callback: () => void) {
      callback();
    },
  };

  try {
    controller = createSearchController({
      state,
      workspaceEl: {
        scrollTo(position: Record<string, number>) {
          scrolledTo = position;
        },
      },
      searchPanelEl: { hidden: true },
      searchButtonEl: { classList },
      searchInputEl: { focus() {}, select() {} },
      searchCountEl: searchCount,
      searchPrevEl: { disabled: false },
      searchNextEl: { disabled: false },
      findTextNode: (node: unknown) => node ?? null,
      getPageScrollTop: (pageEntry: { pageNumber: number }) =>
        pageEntry.pageNumber * 1000,
      updateCurrentPageFromScroll() {},
      updatePageIndicator() {},
      async ensurePageRendered(pageNumber: number) {
        requestedPages.push(pageNumber);
        pageEntries[pageNumber - 1].textDivs = [{}];
        controller.updateSearchResults({ preserveActive: true });
        return true;
      },
    });

    controller.updateSearchResults();
    assert.equal(state.searchMatches.length, 1);
    assert.equal(state.searchMatches[0].pageNumber, 2);
    assert.deepEqual(state.searchMatches[0].rects, []);
    assert.deepEqual(requestedPages, []);

    await controller.revealSearchMatch(0);

    assert.deepEqual(requestedPages, [2]);
    assert.equal(state.searchMatches[0].rects.length, 1);
    assert.deepEqual(scrolledTo, { top: 2028, left: 16, behavior: 'auto' });
    assert.equal(searchCount.textContent, '1 / 1');
  } finally {
    (globalThis as any).document = originalDocument;
    (globalThis as any).window = originalWindow;
  }
});

test('page thumbnails are requested only while the page list is open', async () => {
  const { createSidebarController } = await importMedia('sidebar.js');
  let thumbnailRequests = 0;
  const classList = { add() {}, remove() {}, toggle() {} };
  const emptyContainer = {
    hidden: false,
    classList,
    querySelector: () => null,
    querySelectorAll: () => [],
    replaceChildren() {},
  };
  const state = {
    activeOutlineKey: '',
    collapsedOutline: {},
    currentPage: 1,
    outline: [],
    pageEntries: [],
    sidebarOpen: false,
    sidebarTab: 'pages',
  };
  const sidebar = { ...emptyContainer, hidden: true };
  const controller = createSidebarController({
    state,
    contentShellEl: { classList },
    sidebarEl: sidebar,
    sidebarToggleEl: { classList, setAttribute() {} },
    sidebarTabsEl: emptyContainer,
    outlineTabEl: { hidden: false, textContent: '' },
    pagesPanelEl: { hidden: false },
    outlinePanelEl: { hidden: false },
    pageListEl: emptyContainer,
    outlineListEl: emptyContainer,
    workspaceEl: { scrollTop: 0 },
    escapeHtml: (text: string) => text,
    icons: {},
    jumpToPage() {},
    getPageScrollTop: () => 0,
    preparePageThumbnails() {
      thumbnailRequests += 1;
    },
  });

  controller.setSidebarOpen(true);
  assert.equal(thumbnailRequests, 1);
  controller.setSidebarOpen(false);
  controller.setSidebarTab('outline');
  controller.setSidebarOpen(true);
  assert.equal(thumbnailRequests, 1);
  controller.setSidebarTab('pages');
  assert.equal(thumbnailRequests, 2);
  assert.equal(sidebar.hidden, false);
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
  const { getBufferedPageNumbers, getPrioritizedPageNumbers } =
    await importMedia('pdfRenderer.js');

  assert.deepEqual(getBufferedPageNumbers([], 5), []);
  assert.deepEqual(getBufferedPageNumbers([1], 5), [1, 2]);
  assert.deepEqual(getBufferedPageNumbers([5], 5), [4, 5]);
  assert.deepEqual(getBufferedPageNumbers([2, 3], 5), [1, 2, 3, 4]);
  assert.deepEqual(getPrioritizedPageNumbers([3], 5, 1), [3, 4, 2]);
  assert.deepEqual(getPrioritizedPageNumbers([3], 5, -1), [3, 2, 4]);
  assert.deepEqual(getPrioritizedPageNumbers([2, 3], 5, 1), [3, 2, 4, 1]);
});

test('render session parses one document and caches page dimensions', async () => {
  const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
  const originalPdfjs = (globalThis as any).pdfjsLib;
  let documentLoads = 0;
  let documentDestroys = 0;
  let documentOptions: Record<string, unknown> = {};
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
    getDocument(options: Record<string, unknown>) {
      documentLoads += 1;
      documentOptions = options;
      return { promise: Promise.resolve(pdf) };
    },
  };

  try {
    const session = await createPdfRenderSession('QQ==');

    assert.equal(documentLoads, 1);
    assert.equal(
      Object.prototype.hasOwnProperty.call(documentOptions, 'disableWorker'),
      false
    );
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

test('webview configures the bundled PDF worker without loading it as a script', () => {
  const providerSource = fs.readFileSync(
    path.resolve(__dirname, '../../src/PdfEditorProvider.ts'),
    'utf8'
  );

  assert.match(providerSource, /GlobalWorkerOptions\.workerSrc/);
  assert.match(providerSource, /worker-src \$\{webview\.cspSource\} blob:/);
  assert.doesNotMatch(providerSource, /src=.*pdfWorkerUri/);
  assert.doesNotMatch(providerSource, /<script[^>]+pdf\.worker\.min\.js/);
});

test('render session creates page shells and draws only requested pages', async () => {
  const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
  const originalDocument = (globalThis as any).document;
  const originalPdfjs = (globalThis as any).pdfjsLib;
  const originalPdfjsViewer = (globalThis as any).pdfjsViewer;
  let renderCalls = 0;
  let textCalls = 0;
  let textLayerRenderCalls = 0;
  let cancelCalls = 0;
  let holdNextRender = false;
  let activeRenderCalls = 0;
  let maxActiveRenderCalls = 0;
  let pendingRenders: Array<{ resolve: () => void }> = [];
  let holdNextTextContent = false;
  const pendingTextContents: Array<{ resolve: () => void }> = [];
  let holdNextTextLayer = false;
  let activeTextLayerRender: { reject: (error: Error) => void } | null = null;
  let lastRenderedWidth = 0;
  const renderStartWidths: number[] = [];

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

    toDataURL() {
      return `data:image/png;base64,${this.width}x${this.height}`;
    }
  }

  class FakeTextLayerBuilder {
    div = new FakeElement();
    textDivs: unknown[] = [];
    textContentItemsStr: string[] = [];

    setTextContentSource(textContent: { items: Array<{ str: string }> }) {
      this.cancel();
      this.textContentItemsStr = textContent.items.map((item) => item.str);
    }

    async render() {
      textLayerRenderCalls += 1;
      if (holdNextTextLayer) {
        await new Promise<void>((resolve, reject) => {
          activeTextLayerRender = { reject };
        });
      }
    }

    cancel() {
      if (activeTextLayerRender) {
        const error = new Error('cancelled text layer');
        error.name = 'RenderingCancelledException';
        const { reject } = activeTextLayerRender;
        activeTextLayerRender = null;
        reject(error);
      }
    }
  }

  const sizes = [
    [612, 792],
    [842, 595],
    [400, 400],
  ];
  const pages = sizes.map(([width, height]) => ({
    getViewport({ scale }: { scale: number }) {
      return { width: width * scale, height: height * scale, scale };
    },
    render({ viewport }: { viewport: { width: number } }) {
      renderCalls += 1;
      lastRenderedWidth = viewport.width;
      renderStartWidths.push(viewport.width);
      let rejectRender: (error: Error) => void = () => {};
      const promise = holdNextRender
        ? new Promise<void>((resolve, reject) => {
            activeRenderCalls += 1;
            maxActiveRenderCalls = Math.max(
              maxActiveRenderCalls,
              activeRenderCalls
            );
            let settled = false;
            const finish = (complete: () => void) => {
              if (settled) {
                return;
              }
              settled = true;
              activeRenderCalls -= 1;
              pendingRenders = pendingRenders.filter(
                (pending) => pending.resolve !== resolveRender
              );
              complete();
            };
            const resolveRender = () => finish(resolve);
            rejectRender = (error) => finish(() => reject(error));
            pendingRenders.push({ resolve: resolveRender });
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
      const textContent = { items: [{ str: `page-${width}` }] };
      if (!holdNextTextContent) {
        return textContent;
      }
      return new Promise<typeof textContent>((resolve) => {
        pendingTextContents.push({
          resolve: () => resolve(textContent),
        });
      });
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

    assert.equal(layout.pages.length, 3);
    assert.equal(layout.fragment.children.length, 3);
    assert.equal(layout.pages[0].pageShell.style.width, '612px');
    assert.equal(layout.pages[1].pageShell.style.height, '595px');
    assert.equal(layout.pages[0].drawingCanvas.width, 1);
    assert.equal(layout.pages[0].drawingCanvas.style.width, '612px');
    assert.equal(renderCalls, 0);
    assert.equal(textLayerRenderCalls, 0);

    const textIndex = await session.prepareTextIndex(layout.pages);
    assert.equal(renderCalls, 0);
    assert.equal(textCalls, 3);
    assert.equal(textLayerRenderCalls, 0);
    assert.equal(textIndex[0].text, 'page-612');
    assert.equal(await session.prepareTextIndex(layout.pages), textIndex);
    assert.equal(textCalls, 3);

    assert.equal(await session.renderPage(layout.pages[1]), true);
    assert.equal(renderCalls, 1);
    assert.equal(layout.pages[1].renderState, 'rendered');
    assert.deepEqual(layout.pages[1].textContentItemsStr, ['page-842']);
    assert.equal(textCalls, 3);
    assert.equal(textLayerRenderCalls, 1);

    assert.equal(await session.renderPage(layout.pages[1]), true);
    assert.equal(renderCalls, 1);

    holdNextRender = true;
    const obsoleteRender = session.renderPage(layout.pages[0]);
    session.cancelRendering();
    assert.equal(await obsoleteRender, false);
    assert.equal(cancelCalls, 1);
    assert.equal(layout.pages[0].renderState, 'idle');

    const nextLayout = session.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );
    maxActiveRenderCalls = 0;
    const renders = nextLayout.pages.map((pageEntry: unknown) =>
      session.renderPage(pageEntry)
    );
    await Promise.resolve();
    assert.equal(activeRenderCalls, 2);
    assert.equal(maxActiveRenderCalls, 2);
    pendingRenders.slice().forEach((pending) => pending.resolve());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeRenderCalls, 1);
    pendingRenders.slice().forEach((pending) => pending.resolve());
    assert.deepEqual(await Promise.all(renders), [true, true, true]);
    assert.equal(maxActiveRenderCalls, 2);

    const priorityLayout = session.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );
    renderStartWidths.length = 0;
    const firstTwo = priorityLayout.pages
      .slice(0, 2)
      .map((pageEntry: unknown) => session.renderPage(pageEntry));
    await Promise.resolve();
    const pendingThumbnail = session.renderThumbnail(1, 92);
    const pendingForeground = session.renderPage(priorityLayout.pages[2]);
    pendingRenders[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(renderStartWidths.at(-1), 400);
    pendingRenders.slice().forEach((pending) => pending.resolve());
    await new Promise((resolve) => setImmediate(resolve));
    pendingRenders.slice().forEach((pending) => pending.resolve());
    await Promise.all([...firstTwo, pendingForeground, pendingThumbnail]);

    const supersededLayout = session.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );
    const oldRequest = session.prioritizePages([1, 2, 3]);
    const oldRenders = supersededLayout.pages.map((pageEntry: unknown) =>
      session.renderPage(pageEntry, undefined, oldRequest)
    );
    await Promise.resolve();
    const currentRequest = session.prioritizePages([3]);
    const currentRender = session.renderPage(
      supersededLayout.pages[2],
      undefined,
      currentRequest
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeRenderCalls, 1);
    pendingRenders[0].resolve();
    assert.deepEqual(await Promise.all(oldRenders), [false, false, true]);
    assert.equal(await currentRender, true);

    holdNextRender = false;
    const renderCallsBeforeThumbnail = renderCalls;
    const thumbnail = await session.renderThumbnail(2, 92);
    assert.match(thumbnail, /^data:image\/png;base64,/);
    assert.equal(lastRenderedWidth, 92);
    assert.equal(renderCalls, renderCallsBeforeThumbnail + 1);
    assert.equal(await session.renderThumbnail(2, 92), thumbnail);
    assert.equal(renderCalls, renderCallsBeforeThumbnail + 1);
    const thumbnailLayout = session.createLayout(
      { mode: 'custom', scale: 2, layout: 'single' },
      { width: 900, height: 700 }
    );
    assert.equal(thumbnailLayout.pages[1].thumbnailDataUrl, thumbnail);

    const staleSession = await createPdfRenderSession('QQ==');
    const rawTextLayout = staleSession.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );
    holdNextTextContent = true;
    const rawTextRequest = staleSession.prioritizePages([1]);
    const staleRawTextRender = staleSession.renderPage(
      rawTextLayout.pages[0],
      undefined,
      rawTextRequest
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pendingTextContents.length, 1);
    holdNextTextContent = false;
    const nextRawTextRequest = staleSession.prioritizePages([2]);
    const currentRawTextRender = staleSession.renderPage(
      rawTextLayout.pages[1],
      undefined,
      nextRawTextRequest
    );
    pendingTextContents.shift()?.resolve();
    assert.equal(await staleRawTextRender, false);
    assert.equal(await currentRawTextRender, true);
    assert.equal(rawTextLayout.pages[0].renderState, 'idle');

    const staleTextLayerLayout = staleSession.createLayout(
      { mode: 'actual-size', scale: 1, layout: 'single' },
      { width: 900, height: 700 }
    );
    holdNextTextLayer = true;
    const textLayerRequest = staleSession.prioritizePages([1]);
    const staleTextLayerRender = staleSession.renderPage(
      staleTextLayerLayout.pages[0],
      undefined,
      textLayerRequest
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(activeTextLayerRender);
    holdNextTextLayer = false;
    const nextTextLayerRequest = staleSession.prioritizePages([3]);
    const currentTextLayerRender = staleSession.renderPage(
      staleTextLayerLayout.pages[2],
      undefined,
      nextTextLayerRequest
    );
    assert.equal(await staleTextLayerRender, false);
    assert.equal(await currentTextLayerRender, true);
    assert.equal(staleTextLayerLayout.pages[0].renderState, 'idle');
    await staleSession.destroy();
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
