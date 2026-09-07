# Render Pipeline Group 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move PDF.js parsing and rendering to its bundled worker, defer thumbnails and text extraction until requested, and keep visible-page rendering ahead of background work.

**Architecture:** Configure the bundled PDF.js worker in the Webview HTML and remove forced main-thread execution. Extend the document-scoped render session with a two-slot render pool, document-level text-content/index caches, and a document-level thumbnail cache. The viewport orders buffered pages by scroll direction. The sidebar starts a sequential thumbnail producer only while the page list is requested, while search uses the cached DOM-independent index and renders a text layer only for a revealed match.

**Tech Stack:** TypeScript VS Code extension, JavaScript ES modules in a VS Code Webview, bundled PDF.js 3.11 worker, Node.js built-in test runner

**Spec:** `openspec/changes/improve-render-performance/specs/pdf-worker-rendering/spec.md`, `thumbnail-generation/spec.md`, and `viewport-page-rendering/spec.md`

## Global Constraints

- Do not add dependencies or upgrade PDF.js.
- Do not change the PDF or annotation save formats.
- Keep at most two PDF canvas render tasks active in one document session.
- Keep visible-page work ahead of thumbnail work; do not enqueue every thumbnail into the render pool at once.
- Keep thumbnail and text caches independent of zoom layouts and clear them only with the document session.
- Treat PDF.js render cancellation as expected control flow and propagate other failures.

---

### Task 1: Bundled PDF.js worker

**Files:**

- Modify: `src/PdfEditorProvider.ts`
- Modify: `media/pdfRenderer.js`
- Modify: `tests/pdfTextIndex.test.ts`

- [ ] **Step 1: Write the failing worker-option assertion**

Capture the options passed to the fake `getDocument` and assert that `disableWorker` is absent.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm run compile && node out/tests/pdfTextIndex.test.js`

Expected: FAIL because the session currently sends `disableWorker: true`.

- [ ] **Step 3: Configure the bundled worker**

Stop loading `pdf.worker.min.js` as a normal page script. Generate its Webview URI, assign it to `pdfjsLib.GlobalWorkerOptions.workerSrc` after loading `pdf.min.js`, and remove `disableWorker` from `getDocument`.

- [ ] **Step 4: Run the focused test**

Expected: PASS, then confirm the generated HTML still permits the resource and blob worker through CSP.

### Task 2: Bounded and direction-aware page rendering

**Files:**

- Modify: `media/pdfRenderer.js`
- Modify: `media/main.js`
- Modify: `tests/pdfTextIndex.test.ts`

**Interfaces:**

- Produces: `getPrioritizedPageNumbers(visiblePageNumbers, pageCount, direction, bufferPages = 1)`
- Session invariant: no more than two PDF page render tasks run concurrently.

- [ ] **Step 1: Write failing priority and concurrency tests**

Verify that visible pages come first, the page in the scroll direction wins equal-distance ties, and a third render waits while two render promises are unresolved.

- [ ] **Step 2: Implement the session render pool**

Use one small FIFO permit queue owned by the PDF session. Check layout generation after acquiring a permit and before starting PDF.js work.

- [ ] **Step 3: Apply scroll-direction ordering**

Track the last observed scroll position per layout and submit the buffered page numbers in priority order. Keep the existing page-entry render promise sharing and cancellation.

- [ ] **Step 4: Run the focused tests**

Expected: priority order and the two-task ceiling pass, including cancellation of queued obsolete work.

### Task 3: Lazy cached thumbnails

**Files:**

- Modify: `media/pdfRenderer.js`
- Modify: `media/main.js`
- Modify: `media/sidebar.js`
- Modify: `tests/pdfTextIndex.test.ts`

**Interfaces:**

- Session method: `renderThumbnail(pageNumber, width, metrics)`
- Sidebar callback: request thumbnails when the visible tab is `pages`

- [ ] **Step 1: Write the failing thumbnail-cache test**

Verify that no thumbnail is rendered during layout creation, the first request renders at a fixed width, a repeated request reuses its data URL, and a new zoom layout receives the cached URL.

- [ ] **Step 2: Implement document-level thumbnail caching**

Render from the cached page proxy at a fixed 92-pixel width through the session render pool. Keep thumbnail tasks independent of layout generation and cancel them only when destroying the document.

- [ ] **Step 3: Trigger generation from the page list**

When the sidebar is open on `pages`, request thumbnails sequentially and replace each placeholder as it completes. Ignore results from a replaced document, and do not restart cached work after zoom.

- [ ] **Step 4: Run the focused tests**

Expected: the cache and zoom independence assertions pass.

### Task 4: DOM-independent search index

**Files:**

- Modify: `media/pdfRenderer.js`
- Modify: `media/main.js`
- Modify: `media/search.js`
- Modify: `media/textIndex.js` only if match metadata needs extension
- Modify: `tests/pdfTextIndex.test.ts`

**Interfaces:**

- Session method: `prepareTextIndex(pageEntries, metrics)`
- State field: `searchTextIndex`
- Search callback: render a match page before measuring its DOM range

- [ ] **Step 1: Write the failing text-cache test**

Verify that preparing the search index fetches text once per page without rendering a PDF canvas or text layer, and that a later layout reuses the same index.

- [ ] **Step 2: Cache raw text and build the index once**

Use the existing `buildTextIndex` helper. `ensureTextLayer` consumes cached raw text when a visible or revealed page needs selectable DOM text.

- [ ] **Step 3: Search without all text layers**

Build matches from the document index. Store offsets even when a page has no text DOM. When navigation reveals such a match, render its buffered page window, rebuild that match's rectangles, and then scroll to it. Ignore stale queries and layouts.

- [ ] **Step 4: Run focused search tests**

Expected: words on unrendered pages are found, text extraction is cached, and only a revealed page needs a text layer.

### Task 5: Verification and OpenSpec progress

**Files:**

- Modify: `openspec/changes/improve-render-performance/tasks.md`

- [ ] **Step 1: Run all automated checks**

Run: `npm test`

Run: `npm run lint`

Run: `npm run compile`

Run: `npx prettier --check` for changed files.

- [ ] **Step 2: Inspect structural invariants**

Confirm that `disableWorker` is absent, the worker file is not loaded as a page script, thumbnails start only from page-list activation, text-index preparation does not render every text layer, and the render pool ceiling is two.

- [ ] **Step 3: Run the long-document smoke check**

Open `main.pdf` in the Extension Development Host and verify initial display, continuous scrolling, zoom cancellation, page-list thumbnails, an offscreen search match, and existing annotation/form display.

- [ ] **Step 4: Update task status**

Mark OpenSpec tasks 2.1 through 2.5 complete only after the corresponding implementation and verification pass.
