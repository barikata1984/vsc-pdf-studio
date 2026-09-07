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
(0, node_test_1.default)('page viewport aspect ratios match the generated page sizes', async () => {
    const { viewportRatios } = await loadPageTextContents(await createSamplePdf());
    viewportRatios.forEach((ratio, pageIndex) => {
        const [width, height] = PAGE_SIZES[pageIndex];
        strict_1.default.ok(Math.abs(ratio - width / height) < 1e-6, `page ${pageIndex + 1} ratio ${ratio} != ${width / height}`);
    });
});
(0, node_test_1.default)('buffered page selection clamps boundaries and removes duplicates', async () => {
    const { getBufferedPageNumbers } = await importMedia('pdfRenderer.js');
    strict_1.default.deepEqual(getBufferedPageNumbers([], 5), []);
    strict_1.default.deepEqual(getBufferedPageNumbers([1], 5), [1, 2]);
    strict_1.default.deepEqual(getBufferedPageNumbers([5], 5), [4, 5]);
    strict_1.default.deepEqual(getBufferedPageNumbers([2, 3], 5), [1, 2, 3, 4]);
});
(0, node_test_1.default)('render session parses one document and caches page dimensions', async () => {
    const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
    const originalPdfjs = globalThis.pdfjsLib;
    let documentLoads = 0;
    let documentDestroys = 0;
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
        getDocument() {
            documentLoads += 1;
            return { promise: Promise.resolve(pdf) };
        },
    };
    try {
        const session = await createPdfRenderSession('QQ==');
        strict_1.default.equal(documentLoads, 1);
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
(0, node_test_1.default)('render session creates page shells and draws only requested pages', async () => {
    const { createPdfRenderSession } = await importMedia('pdfRenderer.js');
    const originalDocument = globalThis.document;
    const originalPdfjs = globalThis.pdfjsLib;
    const originalPdfjsViewer = globalThis.pdfjsViewer;
    let renderCalls = 0;
    let textCalls = 0;
    let cancelCalls = 0;
    let holdNextRender = false;
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
        };
        append(...children) {
            this.children.push(...children);
        }
        getContext() {
            return {};
        }
    }
    class FakeTextLayerBuilder {
        div = new FakeElement();
        textDivs = [];
        textContentItemsStr = [];
        setTextContentSource(textContent) {
            this.textContentItemsStr = textContent.items.map((item) => item.str);
        }
        async render() { }
    }
    const sizes = [
        [612, 792],
        [842, 595],
    ];
    const pages = sizes.map(([width, height]) => ({
        getViewport({ scale }) {
            return { width: width * scale, height: height * scale, scale };
        },
        render() {
            renderCalls += 1;
            let rejectRender = () => { };
            const promise = holdNextRender
                ? new Promise((_resolve, reject) => {
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
        strict_1.default.equal(layout.pages.length, 2);
        strict_1.default.equal(layout.fragment.children.length, 2);
        strict_1.default.equal(layout.pages[0].pageShell.style.width, '612px');
        strict_1.default.equal(layout.pages[1].pageShell.style.height, '595px');
        strict_1.default.equal(layout.pages[0].drawingCanvas.width, 1);
        strict_1.default.equal(layout.pages[0].drawingCanvas.style.width, '612px');
        strict_1.default.equal(renderCalls, 0);
        strict_1.default.equal(await session.renderPage(layout.pages[1]), true);
        strict_1.default.equal(renderCalls, 1);
        strict_1.default.equal(layout.pages[1].renderState, 'rendered');
        strict_1.default.deepEqual(layout.pages[1].textContentItemsStr, ['page-842']);
        strict_1.default.equal(textCalls, 1);
        strict_1.default.equal(await session.renderPage(layout.pages[1]), true);
        strict_1.default.equal(renderCalls, 1);
        strict_1.default.equal(await session.ensureTextLayers(layout.pages), true);
        strict_1.default.equal(renderCalls, 1);
        strict_1.default.equal(textCalls, 2);
        holdNextRender = true;
        const obsoleteRender = session.renderPage(layout.pages[0]);
        session.cancelRendering();
        strict_1.default.equal(await obsoleteRender, false);
        strict_1.default.equal(cancelCalls, 1);
        strict_1.default.equal(layout.pages[0].renderState, 'idle');
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