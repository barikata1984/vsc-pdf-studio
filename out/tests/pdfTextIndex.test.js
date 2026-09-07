"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_url_1 = require("node:url");
const pdf_lib_1 = require("pdf-lib");
const PAGE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
const PAGE_SIZES = [
    [612, 792],
    [612, 792],
    [842, 595],
    [400, 400],
    [612, 792],
];
// Both modules are plain ES modules under media/, which TypeScript does not
// type-check. Import through a variable so the compiler treats them as `any`.
async function importMedia(fileName) {
    const fileUrl = (0, node_url_1.pathToFileURL)(path.resolve(__dirname, '../../media', fileName)).href;
    return import(fileUrl);
}
async function importPdfjs() {
    const moduleId = 'pdfjs-dist/legacy/build/pdf.js';
    const module = await import(moduleId);
    return module.default ?? module;
}
async function createSamplePdf() {
    const pdfDoc = await pdf_lib_1.PDFDocument.create();
    const font = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    PAGE_WORDS.forEach((word, index) => {
        const [width, height] = PAGE_SIZES[index];
        const page = pdfDoc.addPage([width, height]);
        page.drawText(word, { x: 40, y: height - 80, size: 24, font });
    });
    return pdfDoc.save();
}
async function loadPageTextContents(data) {
    const pdfjs = await importPdfjs();
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages = [];
    const viewportRatios = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });
        viewportRatios.push(viewport.width / viewport.height);
        pages.push({ pageNumber, textContent: await page.getTextContent() });
    }
    await pdf.destroy();
    return { pageCount: pdf.numPages, pages, viewportRatios };
}
(0, node_test_1.default)('every page word is found on its own page through the text index', async () => {
    const { buildTextIndex, findInTextIndex } = await importMedia('textIndex.js');
    const { pageCount, pages } = await loadPageTextContents(await createSamplePdf());
    strict_1.default.equal(pageCount, PAGE_WORDS.length);
    const index = buildTextIndex(pages);
    PAGE_WORDS.forEach((word, pageIndex) => {
        const matches = findInTextIndex(index, word.toUpperCase());
        strict_1.default.equal(matches.length, 1, `expected one match for ${word}`);
        strict_1.default.equal(matches[0].pageNumber, pageIndex + 1);
        strict_1.default.equal(index[pageIndex].text.slice(matches[0].start, matches[0].end), word);
    });
    strict_1.default.deepEqual(findInTextIndex(index, 'foxtrot'), []);
});
(0, node_test_1.default)('search finds an unrendered page and renders it only when revealed', async () => {
    const { createSearchController } = await importMedia('search.js');
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    let scrolledTo = null;
    const requestedPages = [];
    class FakeLayer {
        children = [];
        replaceChildren() {
            this.children = [];
        }
        append(...children) {
            this.children.push(...children);
        }
    }
    const pageEntries = [1, 2].map((pageNumber) => ({
        pageNumber,
        width: 600,
        height: 800,
        renderState: 'idle',
        textReady: false,
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
    const state = {
        pageEntries,
        searchQuery: 'bravo',
        searchTextIndex: [
            { pageNumber: 1, text: 'alpha', items: [{ index: 0, start: 0, end: 5 }] },
            { pageNumber: 2, text: 'bravo', items: [{ index: 0, start: 0, end: 5 }] },
        ],
        searchMatches: [],
        activeSearchMatchIndex: -1,
        currentPage: 1,
    };
    const classList = { toggle() { } };
    const searchCount = { textContent: '' };
    let controller;
    globalThis.document = {
        createElement: () => ({ className: '', style: {} }),
        createRange: () => ({
            setStart() { },
            setEnd() { },
            getClientRects: () => [{ left: 40, top: 60, width: 80, height: 20 }],
        }),
    };
    globalThis.window = {
        setTimeout(callback) {
            callback();
        },
    };
    try {
        controller = createSearchController({
            state,
            workspaceEl: {
                scrollTo(position) {
                    scrolledTo = position;
                },
            },
            searchPanelEl: { hidden: true },
            searchButtonEl: { classList },
            searchInputEl: { focus() { }, select() { } },
            searchCountEl: searchCount,
            searchPrevEl: { disabled: false },
            searchNextEl: { disabled: false },
            findTextNode: (node) => node ?? null,
            getPageScrollTop: (pageEntry) => pageEntry.pageNumber * 1000,
            updatePageIndicator() { },
            async ensurePageRendered(pageNumber) {
                requestedPages.push(pageNumber);
                pageEntries[pageNumber - 1].renderState = 'rendered';
                pageEntries[pageNumber - 1].textReady = true;
                pageEntries[pageNumber - 1].textDivs = [{}];
                controller.updateSearchResults({ preserveActive: true });
                return true;
            },
        });
        controller.updateSearchResults();
        strict_1.default.equal(state.searchMatches.length, 1);
        strict_1.default.equal(state.searchMatches[0].pageNumber, 2);
        strict_1.default.deepEqual(state.searchMatches[0].rects, []);
        strict_1.default.deepEqual(requestedPages, []);
        await controller.revealSearchMatch(0);
        strict_1.default.deepEqual(requestedPages, [2]);
        strict_1.default.equal(state.searchMatches[0].rects.length, 1);
        strict_1.default.deepEqual(scrolledTo, { top: 2028, left: 16, behavior: 'auto' });
        strict_1.default.equal(searchCount.textContent, '1 / 1');
        state.searchMatches[0].rects = [{ stale: true }];
        pageEntries[1].renderState = 'idle';
        pageEntries[1].textReady = false;
        requestedPages.length = 0;
        await controller.revealSearchMatch(0);
        strict_1.default.deepEqual(requestedPages, [2]);
    }
    finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
    }
});
(0, node_test_1.default)('page thumbnails are requested only while the page list is open', async () => {
    const { createSidebarController } = await importMedia('sidebar.js');
    let thumbnailRequests = 0;
    const classList = { add() { }, remove() { }, toggle() { } };
    const emptyContainer = {
        hidden: false,
        classList,
        querySelector: () => null,
        querySelectorAll: () => [],
        replaceChildren() { },
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
        sidebarToggleEl: { classList, setAttribute() { } },
        sidebarTabsEl: emptyContainer,
        outlineTabEl: { hidden: false, textContent: '' },
        pagesPanelEl: { hidden: false },
        outlinePanelEl: { hidden: false },
        pageListEl: emptyContainer,
        outlineListEl: emptyContainer,
        workspaceEl: { scrollTop: 0 },
        escapeHtml: (text) => text,
        icons: {},
        jumpToPage() { },
        getPageScrollTop: () => 0,
        preparePageThumbnails() {
            thumbnailRequests += 1;
        },
    });
    controller.setSidebarOpen(true);
    strict_1.default.equal(thumbnailRequests, 1);
    controller.setSidebarOpen(false);
    controller.setSidebarTab('outline');
    controller.setSidebarOpen(true);
    strict_1.default.equal(thumbnailRequests, 1);
    controller.setSidebarTab('pages');
    strict_1.default.equal(thumbnailRequests, 2);
    strict_1.default.equal(sidebar.hidden, false);
});
(0, node_test_1.default)('page viewport aspect ratios match the generated page sizes', async () => {
    const { viewportRatios } = await loadPageTextContents(await createSamplePdf());
    viewportRatios.forEach((ratio, pageIndex) => {
        const [width, height] = PAGE_SIZES[pageIndex];
        strict_1.default.ok(Math.abs(ratio - width / height) < 1e-6, `page ${pageIndex + 1} ratio ${ratio} != ${width / height}`);
    });
});
(0, node_test_1.default)('buffered page selection clamps boundaries and removes duplicates', async () => {
    const { getBufferedPageNumbers, getPrioritizedPageNumbers } = await importMedia('pdfRenderer.js');
    strict_1.default.deepEqual(getBufferedPageNumbers([], 5), []);
    strict_1.default.deepEqual(getBufferedPageNumbers([1], 5), [1, 2]);
    strict_1.default.deepEqual(getBufferedPageNumbers([5], 5), [4, 5]);
    strict_1.default.deepEqual(getBufferedPageNumbers([2, 3], 5), [1, 2, 3, 4]);
    strict_1.default.deepEqual(getPrioritizedPageNumbers([3], 5, 1), [3, 4, 2]);
    strict_1.default.deepEqual(getPrioritizedPageNumbers([3], 5, -1), [3, 2, 4]);
    strict_1.default.deepEqual(getPrioritizedPageNumbers([2, 3], 5, 1), [3, 2, 4, 1]);
});
(0, node_test_1.default)('render session parses one document and caches page dimensions', async () => {
    const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
    const originalPdfjs = globalThis.pdfjsLib;
    let documentLoads = 0;
    let documentDestroys = 0;
    let documentOptions = {};
    const pageSizes = [
        [612, 792],
        [842, 595],
    ];
    const pdf = {
        numPages: pageSizes.length,
        async getPage(pageNumber) {
            const [width, height] = pageSizes[pageNumber - 1];
            return {
                getViewport({ scale }) {
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
    globalThis.pdfjsLib = {
        getDocument(options) {
            documentLoads += 1;
            documentOptions = options;
            return { promise: Promise.resolve(pdf) };
        },
    };
    try {
        const session = await createPdfRenderSession('QQ==');
        strict_1.default.equal(documentLoads, 1);
        strict_1.default.equal(Object.prototype.hasOwnProperty.call(documentOptions, 'disableWorker'), false);
        strict_1.default.equal(session.pageCount, 2);
        strict_1.default.deepEqual(session.pageSizes, [
            { width: 612, height: 792 },
            { width: 842, height: 595 },
        ]);
        await session.destroy();
        strict_1.default.equal(documentDestroys, 1);
    }
    finally {
        globalThis.pdfjsLib = originalPdfjs;
    }
});
(0, node_test_1.default)('webview configures the bundled PDF worker without loading it as a script', () => {
    const providerSource = fs.readFileSync(path.resolve(__dirname, '../../src/PdfEditorProvider.ts'), 'utf8');
    strict_1.default.match(providerSource, /GlobalWorkerOptions\.workerSrc/);
    strict_1.default.match(providerSource, /worker-src \$\{webview\.cspSource\} blob:/);
    strict_1.default.doesNotMatch(providerSource, /src=.*pdfWorkerUri/);
    strict_1.default.doesNotMatch(providerSource, /<script[^>]+pdf\.worker\.min\.js/);
});
(0, node_test_1.default)('main tracks the current page with intersections and skips unchanged responsive layouts', () => {
    const mainSource = fs.readFileSync(path.resolve(__dirname, '../../media/main.js'), 'utf8');
    strict_1.default.match(mainSource, /rootMargin: getCurrentPageRootMargin\(workspaceEl\.clientHeight\)/);
    strict_1.default.doesNotMatch(mainSource, /workspaceEl\.addEventListener\('scroll', updateCurrentPageFromScroll/);
    strict_1.default.match(mainSource, /session\.resolveScale\([\s\S]+state\.renderedZoom/);
    strict_1.default.match(mainSource, /Math\.abs\(nextScale - state\.renderedZoom\)[\s\S]+observeCurrentPage\(session\)/);
    strict_1.default.match(mainSource, /\.\.\.targetPageNumbers, \.\.\.retainedRenderPageNumbers/);
});
(0, node_test_1.default)('current page observer uses a vertical pixel band and normalizes spreads', async () => {
    const { getCurrentPageNumber, getCurrentPageRootMargin } = await importMedia('viewport.js');
    strict_1.default.equal(getCurrentPageRootMargin(800), '-360px 0px -360px 0px');
    strict_1.default.equal(getCurrentPageNumber([], 'single'), null);
    strict_1.default.equal(getCurrentPageNumber([2], 'single'), 2);
    strict_1.default.equal(getCurrentPageNumber([2], 'double'), 1);
    strict_1.default.equal(getCurrentPageNumber([4, 3], 'double'), 3);
});
(0, node_test_1.default)('render session creates page shells and draws only requested pages', async () => {
    const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
    const originalDocument = globalThis.document;
    const originalPdfjs = globalThis.pdfjsLib;
    const originalPdfjsViewer = globalThis.pdfjsViewer;
    let renderCalls = 0;
    let textCalls = 0;
    let textLayerRenderCalls = 0;
    let cancelCalls = 0;
    let holdNextRender = false;
    let activeRenderCalls = 0;
    let maxActiveRenderCalls = 0;
    let pendingRenders = [];
    let holdNextTextContent = false;
    const pendingTextContents = [];
    let holdNextTextLayer = false;
    let activeTextLayerRender = null;
    let lastRenderedWidth = 0;
    const renderStartWidths = [];
    const cleanupCalls = [0, 0, 0];
    class FakeElement {
        children = [];
        className = '';
        width = 0;
        height = 0;
        style = {
            setProperty(name, value) {
                this[name] = value;
            },
        };
        classList = {
            add: (...names) => {
                this.className = [this.className, ...names].filter(Boolean).join(' ');
            },
            remove: (...names) => {
                this.className = this.className
                    .split(' ')
                    .filter((name) => name && !names.includes(name))
                    .join(' ');
            },
        };
        append(...children) {
            this.children.push(...children);
        }
        replaceChildren(...children) {
            this.children = children;
        }
        replaceWith() { }
        getContext() {
            return {};
        }
        toDataURL() {
            return `data:image/png;base64,${this.width}x${this.height}`;
        }
    }
    class FakeTextLayerBuilder {
        div = new FakeElement();
        textDivs = [];
        textContentItemsStr = [];
        setTextContentSource(textContent) {
            this.cancel();
            this.textContentItemsStr = textContent.items.map((item) => item.str);
        }
        async render() {
            textLayerRenderCalls += 1;
            if (holdNextTextLayer) {
                await new Promise((resolve, reject) => {
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
    const pages = sizes.map(([width, height], pageIndex) => ({
        getViewport({ scale }) {
            return { width: width * scale, height: height * scale, scale };
        },
        render({ viewport }) {
            renderCalls += 1;
            lastRenderedWidth = viewport.width;
            renderStartWidths.push(viewport.width);
            let rejectRender = () => { };
            const promise = holdNextRender
                ? new Promise((resolve, reject) => {
                    activeRenderCalls += 1;
                    maxActiveRenderCalls = Math.max(maxActiveRenderCalls, activeRenderCalls);
                    let settled = false;
                    const finish = (complete) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        activeRenderCalls -= 1;
                        pendingRenders = pendingRenders.filter((pending) => pending.resolve !== resolveRender);
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
            return new Promise((resolve) => {
                pendingTextContents.push({
                    resolve: () => resolve(textContent),
                });
            });
        },
        cleanup() {
            cleanupCalls[pageIndex] += 1;
            return true;
        },
    }));
    const pdf = {
        numPages: pages.length,
        async getPage(pageNumber) {
            return pages[pageNumber - 1];
        },
        async getOutline() {
            return [];
        },
        async destroy() { },
    };
    globalThis.document = {
        createDocumentFragment: () => new FakeElement(),
        createElement: () => new FakeElement(),
    };
    globalThis.pdfjsLib = {
        getDocument: () => ({ promise: Promise.resolve(pdf) }),
    };
    globalThis.pdfjsViewer = {
        TextLayerBuilder: FakeTextLayerBuilder,
    };
    try {
        const session = await createPdfRenderSession('QQ==');
        const layout = session.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        strict_1.default.equal(layout.pages.length, 3);
        strict_1.default.equal(layout.fragment.children.length, 3);
        strict_1.default.equal(layout.pages[0].pageShell.style.width, '612px');
        strict_1.default.equal(layout.pages[1].pageShell.style.height, '595px');
        strict_1.default.equal(layout.pages[0].drawingCanvas.width, 1);
        strict_1.default.equal(layout.pages[0].drawingCanvas.style.width, '612px');
        strict_1.default.equal(renderCalls, 0);
        strict_1.default.equal(textLayerRenderCalls, 0);
        strict_1.default.equal(session.resolveScale({ mode: 'actual-size', scale: 4, layout: 'single' }, { width: 300, height: 200 }), layout.resolvedScale);
        const textIndex = await session.prepareTextIndex(layout.pages);
        strict_1.default.equal(renderCalls, 0);
        strict_1.default.equal(textCalls, 3);
        strict_1.default.equal(textLayerRenderCalls, 0);
        strict_1.default.equal(textIndex[0].text, 'page-612');
        strict_1.default.equal(await session.prepareTextIndex(layout.pages), textIndex);
        strict_1.default.equal(textCalls, 3);
        strict_1.default.deepEqual(cleanupCalls, [1, 1, 1]);
        strict_1.default.equal(await session.renderPage(layout.pages[1]), true);
        strict_1.default.equal(renderCalls, 1);
        strict_1.default.equal(layout.pages[1].renderState, 'rendered');
        strict_1.default.deepEqual(layout.pages[1].textContentItemsStr, ['page-842']);
        strict_1.default.equal(textCalls, 3);
        strict_1.default.equal(textLayerRenderCalls, 1);
        strict_1.default.equal(await session.renderPage(layout.pages[1]), true);
        strict_1.default.equal(renderCalls, 1);
        layout.pages[1].drawingCanvas.width = 842;
        layout.pages[1].drawingCanvas.height = 595;
        const formOverlay = new FakeElement();
        const highlightOverlay = new FakeElement();
        layout.pages[1].textLayer.style.pointerEvents = 'auto';
        layout.pages[1].textLayer.style.userSelect = 'text';
        layout.pages[1].formLayer.append(formOverlay);
        layout.pages[1].highlightLayer.append(highlightOverlay);
        const releasedTextLayer = layout.pages[1].textLayer;
        const cleanupCallsBeforeRelease = cleanupCalls[1];
        session.releasePagesExcept([1]);
        strict_1.default.equal(layout.pages[1].pdfCanvas.width, 1);
        strict_1.default.equal(layout.pages[1].drawingCanvas.width, 1);
        strict_1.default.equal(layout.pages[1].renderState, 'idle');
        strict_1.default.equal(layout.pages[1].textReady, false);
        strict_1.default.notEqual(layout.pages[1].textLayer, releasedTextLayer);
        strict_1.default.equal(layout.pages[1].textLayer.style.pointerEvents, 'auto');
        strict_1.default.equal(layout.pages[1].textLayer.style.userSelect, 'text');
        strict_1.default.deepEqual(layout.pages[1].formLayer.children, [formOverlay]);
        strict_1.default.deepEqual(layout.pages[1].highlightLayer.children, [
            highlightOverlay,
        ]);
        strict_1.default.equal(cleanupCalls[1], cleanupCallsBeforeRelease + 1);
        strict_1.default.equal(await session.renderPage(layout.pages[1]), true);
        strict_1.default.equal(renderCalls, 2);
        strict_1.default.deepEqual(layout.pages[1].textContentItemsStr, ['page-842']);
        strict_1.default.equal(textCalls, 3);
        holdNextRender = true;
        const obsoleteRender = session.renderPage(layout.pages[0]);
        session.cancelRendering();
        strict_1.default.equal(await obsoleteRender, false);
        strict_1.default.equal(cancelCalls, 1);
        strict_1.default.equal(layout.pages[0].renderState, 'idle');
        const nextLayout = session.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        maxActiveRenderCalls = 0;
        const renders = nextLayout.pages.map((pageEntry) => session.renderPage(pageEntry));
        await Promise.resolve();
        strict_1.default.equal(activeRenderCalls, 2);
        strict_1.default.equal(maxActiveRenderCalls, 2);
        pendingRenders.slice().forEach((pending) => pending.resolve());
        await new Promise((resolve) => setImmediate(resolve));
        strict_1.default.equal(activeRenderCalls, 1);
        pendingRenders.slice().forEach((pending) => pending.resolve());
        strict_1.default.deepEqual(await Promise.all(renders), [true, true, true]);
        strict_1.default.equal(maxActiveRenderCalls, 2);
        const priorityLayout = session.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        renderStartWidths.length = 0;
        const firstTwo = priorityLayout.pages
            .slice(0, 2)
            .map((pageEntry) => session.renderPage(pageEntry));
        await Promise.resolve();
        const pendingThumbnail = session.renderThumbnail(1, 92);
        const pendingForeground = session.renderPage(priorityLayout.pages[2]);
        pendingRenders[0].resolve();
        await new Promise((resolve) => setImmediate(resolve));
        strict_1.default.equal(renderStartWidths.at(-1), 400);
        pendingRenders.slice().forEach((pending) => pending.resolve());
        await new Promise((resolve) => setImmediate(resolve));
        pendingRenders.slice().forEach((pending) => pending.resolve());
        await Promise.all([...firstTwo, pendingForeground, pendingThumbnail]);
        const supersededLayout = session.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        const oldRequest = session.prioritizePages([1, 2, 3]);
        const oldRenders = supersededLayout.pages.map((pageEntry) => session.renderPage(pageEntry, undefined, oldRequest));
        await Promise.resolve();
        const currentRequest = session.prioritizePages([3]);
        session.releasePagesExcept([3]);
        const currentRender = session.renderPage(supersededLayout.pages[2], undefined, currentRequest);
        await new Promise((resolve) => setImmediate(resolve));
        strict_1.default.equal(activeRenderCalls, 1);
        pendingRenders[0].resolve();
        strict_1.default.deepEqual(await Promise.all(oldRenders), [false, false, true]);
        strict_1.default.equal(await currentRender, true);
        strict_1.default.equal(supersededLayout.pages[0].pdfCanvas.width, 1);
        strict_1.default.equal(supersededLayout.pages[1].pdfCanvas.width, 1);
        holdNextRender = false;
        const renderCallsBeforeThumbnail = renderCalls;
        const thumbnail = await session.renderThumbnail(2, 92);
        strict_1.default.match(thumbnail, /^data:image\/png;base64,/);
        strict_1.default.equal(lastRenderedWidth, 92);
        strict_1.default.equal(renderCalls, renderCallsBeforeThumbnail + 1);
        strict_1.default.equal(await session.renderThumbnail(2, 92), thumbnail);
        strict_1.default.equal(renderCalls, renderCallsBeforeThumbnail + 1);
        const thumbnailLayout = session.createLayout({ mode: 'custom', scale: 2, layout: 'single' }, { width: 900, height: 700 });
        strict_1.default.equal(thumbnailLayout.pages[1].thumbnailDataUrl, thumbnail);
        const staleSession = await createPdfRenderSession('QQ==');
        const rawTextLayout = staleSession.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        holdNextTextContent = true;
        const rawTextRequest = staleSession.prioritizePages([1]);
        const staleRawTextRender = staleSession.renderPage(rawTextLayout.pages[0], undefined, rawTextRequest);
        await new Promise((resolve) => setImmediate(resolve));
        strict_1.default.equal(pendingTextContents.length, 1);
        holdNextTextContent = false;
        const nextRawTextRequest = staleSession.prioritizePages([2]);
        const currentRawTextRender = staleSession.renderPage(rawTextLayout.pages[1], undefined, nextRawTextRequest);
        pendingTextContents.shift()?.resolve();
        strict_1.default.equal(await staleRawTextRender, false);
        strict_1.default.equal(await currentRawTextRender, true);
        strict_1.default.equal(rawTextLayout.pages[0].renderState, 'idle');
        const staleTextLayerLayout = staleSession.createLayout({ mode: 'actual-size', scale: 1, layout: 'single' }, { width: 900, height: 700 });
        holdNextTextLayer = true;
        const textLayerRequest = staleSession.prioritizePages([1]);
        const staleTextLayerRender = staleSession.renderPage(staleTextLayerLayout.pages[0], undefined, textLayerRequest);
        await new Promise((resolve) => setImmediate(resolve));
        strict_1.default.ok(activeTextLayerRender);
        holdNextTextLayer = false;
        const nextTextLayerRequest = staleSession.prioritizePages([3]);
        const currentTextLayerRender = staleSession.renderPage(staleTextLayerLayout.pages[2], undefined, nextTextLayerRequest);
        strict_1.default.equal(await staleTextLayerRender, false);
        strict_1.default.equal(await currentTextLayerRender, true);
        strict_1.default.equal(staleTextLayerLayout.pages[0].renderState, 'idle');
        await staleSession.destroy();
        await session.destroy();
    }
    finally {
        globalThis.document = originalDocument;
        globalThis.pdfjsLib = originalPdfjs;
        globalThis.pdfjsViewer = originalPdfjsViewer;
    }
});
(0, node_test_1.default)('drawing layer expands a lazy canvas before pointer coordinates are used', async () => {
    const { createDrawingLayer } = await importMedia('drawingLayer.js');
    const context = { clearRect() { } };
    const drawingCanvas = {
        width: 1,
        height: 1,
        addEventListener() { },
        getContext: () => context,
    };
    const pageEntry = {
        pageNumber: 1,
        width: 612,
        height: 792,
        drawingCanvas,
        pageShell: { addEventListener() { } },
    };
    const layer = createDrawingLayer([pageEntry], {
        getHighlights: () => [],
    });
    layer.ensurePageCanvas(pageEntry);
    strict_1.default.equal(drawingCanvas.width, 612);
    strict_1.default.equal(drawingCanvas.height, 792);
});
//# sourceMappingURL=pdfTextIndex.test.js.map