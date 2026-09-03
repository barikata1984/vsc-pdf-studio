# Changelog

## 0.0.8 (in progress)

- Added timing instrumentation for each load-to-display stage and per-request render start, completion, and cancellation logs
- Moved PDF parsing and rendering off the UI thread into a separate worker
- Separated thumbnail generation from main rendering and generate thumbnails at low resolution when the page list is shown
- Rendered only the visible pages and their neighbors, released off-screen render results, cancelled in-flight renders on zoom or resize, and reused the parsed document instead of reloading it
- Changed the render resolution cap from a whole-document total to a per-page limit and made both the page and drawing canvases follow the display pixel density

## 0.0.7

- Fixed interrupted stylus strokes by separating pen annotation handling from finger scrolling
- Preserved finger annotation when `Allow Finger Drawing` is enabled while keeping touch panning available when it is disabled

## 0.0.6

- Added pen-first touch annotation controls, including an `Allow Finger Drawing` setting and Command Palette toggle
- Fixed stack-overflow failures when reopening PDFs with large annotation histories and added automatic migration to compressed annotation storage
- Expanded comment visibility controls to include supported comments and note-bearing markup imported from other PDF editors
- Improved editor reliability through modularized webview features, stricter payload validation, linting, formatting, and regression tests

## 0.0.5

- Added view, edit, and delete support for note-bearing highlights, underlines, and strikeouts imported from other PDF editors
- Adjusted the shared color button so it matches the sizing and responsive behavior of the other toolbar buttons
- Added a `PDF Studio: Set Comment Author` command for updating the comment author setting from the Command Palette
- Made comment author setting changes update open PDF Studio editors without requiring a reload

## 0.0.4

- Added PDF form filling for existing native fields, including text, checkbox, radio, dropdown, option list, and supported button actions
- Improved cross-editor compatibility for form values, reset behavior, comments, and imported markup from other PDF tools
- Added bookmark support in the navigation sidebar, including external PDF bookmarks and quick bookmark creation from the selection mini toolbar
- Added Underline and Strike Out actions to the selection mini toolbar and imported native Underline/StrikeOut annotations
- Replaced per-feature color access with one shared toolbar color button plus custom color selection from the More menu

## 0.0.3

- Reduced packaged extension size by trimming shipped runtime dependency files without changing functionality
- Collapsed open comment views and cleared empty comment composers when switching to other tools

## 0.0.2

- Improved default PDF text clarity on Retina/high-DPI displays
- Limited undo/redo session history to the 30 most recent states
- Reduced redundant annotation cloning on the save path
- Removed unnecessary local source-path exposure from webview bootstrap markup
- Added a toolbar toggle for single-page and two-page document layouts
- Refined toolbar responsiveness with staged compaction and controlled multi-row wrapping
- Saved comments as native PDF text annotations for compatibility with Adobe and other PDF viewers
- Synced external PDF comment edits back into PDF Studio on reopen
- Moved Studio comment storage to native PDF comments as the primary source of truth
- Added a global show-all-comments toggle and made it contextual to comment mode
- Improved comment popup and composer placement, including two-page layout behavior
- Polished comment action buttons and comment-toolbar ordering

## 0.0.1

- Initial public PDF Studio
- Custom PDF editor for VS Code
- Freehand annotation, highlight, comment, search, and navigation support
- Auto-save back into the source PDF
