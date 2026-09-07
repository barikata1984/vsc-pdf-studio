# Long-document Scrolling Group 3 Implementation Plan

**Goal:** Bound page memory during long-document scrolling, remove the full-page scan from current-page tracking, and avoid resize renders whose scale is unchanged.

**Architecture:** Keep the existing page-shell `IntersectionObserver` for rendering and add a narrow center-band observer for the current page. The PDF session owns page eviction: pages outside the visible buffer drop their canvas and text-layer contents, call `PDFPageProxy.cleanup()`, and retain document-level text and thumbnail caches. Responsive resize compares the session's resolved scale before cancelling the current layout.

**Constraints:** Do not add dependencies, change saved data, or release fixed-size page shells and document-level caches.

## Task 1: Page eviction and PDF.js cleanup

- [x] Add a failing test for releasing a rendered page and rendering it again.
- [x] Reset PDF and drawing canvases, rebuild the text-layer builder, and call `page.cleanup()` only for pages outside the retained buffer.
- [x] Route every foreground page request through the eviction operation.

## Task 2: Intersection-based current page

- [x] Add a failing structural test that requires an intersection observer and rejects the per-scroll full-page scan.
- [x] Track pages crossing a narrow band at the viewport center and use the lowest page number for a two-page row.
- [x] Remove the obsolete scroll listener and post-jump scan.

## Task 3: Unchanged responsive layout

- [x] Add a failing assertion for resolving the next layout scale without creating a layout.
- [x] On responsive resize, compare the next scale with `renderedZoom` before cancelling or rebuilding the layout.

## Task 4: Verification

- [x] Run focused and complete automated checks.
- [x] Verify `main.pdf` in the Extension Development Host by scrolling to the end and back, resizing without a scale change, searching an offscreen page, and checking annotations and fields.
- [x] Mark OpenSpec tasks 3.1 through 3.5 complete and commit the verified checkpoint.
