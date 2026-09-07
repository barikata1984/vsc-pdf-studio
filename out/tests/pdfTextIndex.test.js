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
//# sourceMappingURL=pdfTextIndex.test.js.map