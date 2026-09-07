# Viewport Rendering Group 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse each PDF once, create lightweight shells for every page, and render only the current page and its immediate neighbors.

**Architecture:** Replace the stateless full-document renderer with a document-scoped render session that owns the parsed PDF, page metadata, and active PDF.js render tasks. The webview keeps all page shells for navigation, while an `IntersectionObserver` requests PDF canvases and text layers for the visible page window. Existing annotation, form, selection, search, and navigation controllers continue to consume `state.pageEntries`.

**Tech Stack:** JavaScript ES modules in a VS Code Webview, PDF.js 3.11, Node.js built-in test runner, TypeScript test harness

**Spec:** `openspec/changes/improve-render-performance/design.md` and `openspec/changes/improve-render-performance/specs/viewport-page-rendering/spec.md`

## Global Constraints

- Do not add dependencies or upgrade PDF.js.
- Do not change the PDF save format or stored annotation schema.
- Keep the existing `pageEntry` fields used by search, drawing, forms, comments, selection, sidebar, and viewport controllers.
- Treat PDF.js rendering cancellation as expected control flow; propagate other failures.
- Do not require performance measurements for completion.

---

### Task 1: Buffered page selection

**Files:**

- Modify: `media/pdfRenderer.js`
- Modify: `tests/pdfTextIndex.test.ts`

**Interfaces:**

- Produces: `getBufferedPageNumbers(visiblePageNumbers, pageCount, bufferPages = 1): number[]`

- [x] **Step 1: Write the failing test**

Add assertions that empty input returns an empty list, page 1 expands to pages 1 and 2, the last page does not exceed `pageCount`, and multiple visible pages produce a sorted list without duplicates.

- [x] **Step 2: Run the focused test and verify failure**

Run: `npm test -- --test-name-pattern="buffered page"`

Expected: FAIL because `getBufferedPageNumbers` is not exported.

- [x] **Step 3: Implement the page selection helper**

Use a `Set`, clamp every candidate to `1..pageCount`, and return the values in ascending order. Do not add a scheduler abstraction.

- [x] **Step 4: Run the focused test**

Run: `npm test -- --test-name-pattern="buffered page"`

Expected: PASS.

### Task 2: Document-scoped render session

**Files:**

- Modify: `media/pdfRenderer.js`
- Modify: `media/main.js`

**Interfaces:**

- Produces: `createPdfRenderSession(base64, outlineBase64, metrics)`
- Session methods: `createLayout(zoomConfig, workspaceSize)`, `renderPage(pageEntry, metrics)`, `ensureTextLayers(pageEntries, metrics)`, `cancelRendering()`, `destroy()`
- `createLayout` returns the existing `pages`, `outline`, `resolvedScale`, and `fragment` fields.

- [ ] **Step 1: Move PDF loading and page metadata into a session**

Decode and call `getDocument` only in `createPdfRenderSession`. Cache the document proxy, optional outline document proxy, outline, page proxies, and scale-1 dimensions.

- [ ] **Step 2: Split layout creation from page rendering**

`createLayout` creates every page shell and overlay layer with correct dimensions but leaves the PDF canvas empty. Preserve every `pageEntry` field used by existing controllers.

- [ ] **Step 3: Render one page on demand**

`renderPage` sizes and draws the PDF canvas, then obtains and renders the text layer. Store the PDF.js render task on the page entry and make repeated calls share the same promise.

- [ ] **Step 4: Add cancellation and disposal**

`cancelRendering` cancels active page tasks and invalidates their generation. `destroy` cancels work and destroys both parsed document proxies without destroying the same proxy twice.

- [ ] **Step 5: Replace repeated PDF loading in main**

Create the session on the `init` message, reuse it in every `rerenderPages` call, and destroy a previous session before loading a replacement document.

### Task 3: Visible-page rendering

**Files:**

- Modify: `media/main.js`
- Modify: `media/styles.css`

**Interfaces:**

- Consumes: `getBufferedPageNumbers`, session `renderPage`, and session `cancelRendering`
- Produces: one `IntersectionObserver` owned by the current layout

- [ ] **Step 1: Observe page shells**

After replacing the page DOM and attaching existing controllers, observe every shell with `workspaceEl` as the root. Request intersecting pages and their one-page buffer.

- [ ] **Step 2: Prioritize the current page on each layout**

Before returning from `rerenderPages`, await the current page and its neighbors. The initial layout therefore paints page 1 without waiting for every page.

- [ ] **Step 3: Cancel the prior layout**

Disconnect the old observer and call `cancelRendering` as soon as zoom, responsive resize, layout, or a replacement document requests another layout.

- [ ] **Step 4: Keep empty shells visually stable**

Use the page shell background while its PDF canvas is empty, and mark a shell rendered only after the current generation completes.

### Task 4: Existing feature compatibility

**Files:**

- Modify: `media/main.js`
- Modify: `media/pdfRenderer.js`
- Modify: `media/search.js` only if the existing synchronous entry point cannot safely wait for text layers
- Modify: `media/drawingLayer.js` only if a page needs an explicit redraw after lazy initialization

**Interfaces:**

- Consumes: session `ensureTextLayers`
- Produces: a main-level asynchronous search refresh that ignores stale queries

- [ ] **Step 1: Reapply page overlays after layout creation**

Keep drawing, highlights, comments, forms, sidebar, current-page state, interaction mode, and zoom anchor restoration in their existing order after the page shells enter the DOM.

- [ ] **Step 2: Preserve search across unrendered pages**

When a non-empty search is requested, await text-layer preparation for all pages without blocking initial display. Ignore a completed preparation if the query or layout generation changed, then call the existing search result calculation.

- [ ] **Step 3: Render navigation targets**

Page number, outline, and search navigation continue to use page shells. Their intersection with the viewport triggers the target page render without requiring special navigation state.

- [ ] **Step 4: Keep input behavior on lazily rendered pages**

Verify that drawing handlers are registered once per current shell and that highlight, comment, and form overlays use the shell dimensions even before the PDF canvas completes.

### Task 5: Verification and OpenSpec progress

**Files:**

- Modify: `openspec/changes/improve-render-performance/tasks.md`

- [ ] **Step 1: Run all automated checks**

Run: `npm test`

Expected: all tests pass.

Run: `npm run lint`

Expected: no lint errors.

Run: `npm run compile`

Expected: TypeScript compilation succeeds.

- [ ] **Step 2: Inspect the structural invariants**

Confirm by source search that `getDocument` is called only during session creation, no loop renders every page during initial layout, and every active PDF.js render task has a cancellation path.

- [ ] **Step 3: Update task status**

Mark OpenSpec tasks 1.1 through 1.5 complete when their implementation and automated checks pass. Mark 1.6 complete only if the VS Code Webview smoke check was actually run.
