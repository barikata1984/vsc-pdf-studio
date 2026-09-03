import { createAutoSaver } from './autosave.js';
import { createBookmarkController } from './bookmarks.js';
import {
  renderCommentLayer,
  renderSelectionActionOverlay,
} from './commentUI.js';
import { createDrawingLayer } from './drawingLayer.js';
import { createFormController } from './forms.js';
import { createInteractionController } from './interaction.js';
import {
  applyTextFieldValidationState,
  createSelectControl,
  getButtonActionState,
  getTextFieldValidationError,
  normalizeDateValueForInput,
  normalizeDateValueForStorage,
} from './formUtils.js';
import {
  cloneAnnotations,
  cloneBookmarks,
  compareBookmarks,
  createHistoryEntry,
  pushHistoryEntry as pushHistoryEntryState,
  syncOutlineState,
} from './historyState.js';
import { icons } from './icons.js';
import { renderPdf } from './pdfRenderer.js';
import { startRenderRequest } from './renderMetrics.js';
import {
  escapeHtml,
  escapeRegExp,
  findTextNode,
  formatCommentDate,
  normalizeSelectedText,
  slugify,
} from './textUtils.js';
import { createSearchController } from './search.js';
import { createSelectionController } from './selection.js';
import { createSidebarController } from './sidebar.js';
import { createViewportController } from './viewport.js';

const vscode = acquireVsCodeApi();
const app = document.querySelector('#app');
const state = {
  fileName: 'PDF',
  commentAuthor: 'PDF Studio',
  allowFingerDrawing: false,
  pdfBase64: '',
  outlinePdfBase64: '',
  pageEntries: [],
  zoomMode: 'automatic',
  zoom: 1.25,
  renderedZoom: 1.25,
  pageLayout: 'single',
  currentPage: 1,
  totalPages: 0,
  color: '#ef4444',
  mode: 'select',
  menuOpen: false,
  pageJumpInProgress: false,
  zoomContext: null,
  gestureZoomBase: null,
  sessionAnnotations: {
    version: 1,
    updatedAt: new Date(0).toISOString(),
    strokes: [],
    highlights: [],
    comments: [],
  },
  formFields: [],
  history: [],
  historyIndex: 0,
  openCommentId: null,
  openMarkupNoteId: null,
  showAllComments: false,
  commentComposer: null,
  selectionSnapshot: null,
  selectionAction: null,
  saveInFlight: false,
  saveQueued: false,
  lastButtonActivation: null,
  sidebarOpen: false,
  sidebarTab: 'outline',
  activeOutlineKey: null,
  collapsedOutline: {},
  bookmarks: [],
  externalOutline: [],
  outline: [],
  searchOpen: false,
  searchQuery: '',
  searchMatches: [],
  activeSearchMatchIndex: -1,
  colorPopoverOwner: null,
};

const MAX_HISTORY_ENTRIES = 30;

app.innerHTML = `
  <div class="toolbar">
    <div class="toolbar-start">
      <button type="button" id="sidebar-toggle" aria-label="Toggle navigation" title="Toggle navigation">${icons.sidebar}</button>
    </div>
    <div class="toolbar-center">
      <div class="toolbar-row toolbar-row-primary">
        <label>
          <input id="page-input" type="number" min="1" value="1" aria-label="Page number" title="Page number" />
          <span class="toolbar-label" id="page-total">/ 1</span>
        </label>
        <div class="zoom-controls">
          <button type="button" id="zoom-out" aria-label="Zoom out">${icons.minus}</button>
          <select id="zoom-preset">
            <option value="automatic">Auto</option>
            <option value="actual-size">Actual Size</option>
            <option value="page-fit">Page Fit</option>
            <option value="page-width">Page Width</option>
            <option value="0.5">50%</option>
            <option value="0.75">75%</option>
            <option value="1">100%</option>
            <option value="1.25">125%</option>
            <option value="1.5">150%</option>
            <option value="2">200%</option>
            <option value="custom">Custom</option>
          </select>
          <button type="button" id="zoom-in" aria-label="Zoom in">${icons.plus}</button>
        </div>
        <button type="button" id="layout-toggle" aria-label="Switch to two-page view" title="Switch to two-page view">${icons.layoutDouble}</button>
      </div>
      <div class="toolbar-row toolbar-row-secondary">
        <div class="mode-wrap">
          <div class="mode-toggle" id="mode-toggle">
            <button type="button" class="mode-button is-active" data-mode="select" aria-label="Select" title="Select">${icons.pointer}</button>
            <button type="button" class="mode-button" data-mode="highlight" aria-label="Highlight" title="Highlight">${icons.highlighter}</button>
            <button type="button" class="mode-button" data-mode="annotate" aria-label="Annotate" title="Annotate">${icons.pen}</button>
            <button type="button" class="mode-button" data-mode="erase" aria-label="Erase" title="Erase">${icons.eraser}</button>
          </div>
        </div>
        <button type="button" id="comment-button" aria-label="Add comment" title="Add comment">${icons.comment}</button>
        <button type="button" id="comment-views-toggle" aria-label="Show all comments" title="Show all comments">${icons.commentsExpanded}</button>
        <button type="button" id="color-button" aria-label="Annotation color" title="Annotation color">
          <span class="toolbar-color-chip" id="color-chip" aria-hidden="true"></span>
        </button>
        <div class="color-popover" id="color-popover" hidden>
          <div class="comment-popover-controls">
            <div class="color-palette" id="color-palette">
              <button type="button" class="color-swatch is-active" data-color="#ef4444" style="--swatch:#ef4444;" aria-label="Red"></button>
              <button type="button" class="color-swatch" data-color="#eab308" style="--swatch:#eab308;" aria-label="Yellow"></button>
              <button type="button" class="color-swatch" data-color="#f97316" style="--swatch:#f97316;" aria-label="Orange"></button>
              <button type="button" class="color-swatch" data-color="#22c55e" style="--swatch:#22c55e;" aria-label="Green"></button>
              <button type="button" class="color-swatch" data-color="#3b82f6" style="--swatch:#3b82f6;" aria-label="Blue"></button>
            </div>
          </div>
        </div>
        <button type="button" id="undo-button" aria-label="Undo" title="Undo">${icons.undo}</button>
        <button type="button" id="redo-button" aria-label="Redo" title="Redo">${icons.redo}</button>
        <div class="search-wrap">
          <button type="button" id="search-button" aria-label="Search document" title="Search document">${icons.search}</button>
          <div class="search-panel" id="search-panel" hidden>
            <input id="search-input" type="search" placeholder="Search" spellcheck="false" />
            <span class="search-count" id="search-count">0 / 0</span>
            <button type="button" id="search-prev" aria-label="Previous result" title="Previous">${icons.chevronLeft}</button>
            <button type="button" id="search-next" aria-label="Next result" title="Next">${icons.chevronRight}</button>
            <button type="button" id="search-close" aria-label="Close search" title="Close">${icons.close}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="toolbar-end">
      <div class="menu-wrap">
        <button type="button" id="menu-button" aria-label="More tools" title="More tools">${icons.menu}</button>
        <div class="menu-panel" id="menu-panel" hidden>
          <label>
            Color
            <input id="stroke-color" type="color" value="#ef4444" />
          </label>
          <label>
            Width
            <select id="stroke-width">
              <option value="1">1 pt</option>
              <option value="2">2 pt</option>
              <option value="3" selected>3 pt</option>
              <option value="4">4 pt</option>
              <option value="6">6 pt</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  </div>
  <div class="content-shell" id="content-shell">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-tabs" id="sidebar-tabs">
        <button type="button" class="sidebar-tab is-active" data-tab="outline" id="outline-tab" hidden>Bookmarks</button>
        <button type="button" class="sidebar-tab" data-tab="pages">Pages</button>
      </div>
      <div class="sidebar-panel" id="outline-panel" hidden>
        <div class="sidebar-list sidebar-outline" id="outline-list"></div>
      </div>
      <div class="sidebar-panel" id="pages-panel">
        <div class="sidebar-list sidebar-pages" id="page-list"></div>
      </div>
    </aside>
    <div class="workspace">
      <div id="pages"></div>
      <div class="empty-state" id="message-box" hidden></div>
    </div>
  </div>
`;

const contentShellEl = document.querySelector('#content-shell');
const toolbarEl = document.querySelector('.toolbar');
const sidebarToggleEl = document.querySelector('#sidebar-toggle');
const sidebarEl = document.querySelector('#sidebar');
const sidebarTabsEl = document.querySelector('#sidebar-tabs');
const outlineTabEl = document.querySelector('#outline-tab');
const pagesPanelEl = document.querySelector('#pages-panel');
const outlinePanelEl = document.querySelector('#outline-panel');
const pageListEl = document.querySelector('#page-list');
const outlineListEl = document.querySelector('#outline-list');
const pageInputEl = document.querySelector('#page-input');
const pageTotalEl = document.querySelector('#page-total');
const zoomInEl = document.querySelector('#zoom-in');
const zoomOutEl = document.querySelector('#zoom-out');
const zoomPresetEl = document.querySelector('#zoom-preset');
const layoutToggleEl = document.querySelector('#layout-toggle');
const modeToggleEl = document.querySelector('#mode-toggle');
const colorPopoverEl = document.querySelector('#color-popover');
const undoButtonEl = document.querySelector('#undo-button');
const redoButtonEl = document.querySelector('#redo-button');
const commentButtonEl = document.querySelector('#comment-button');
const commentViewsToggleEl = document.querySelector('#comment-views-toggle');
const colorButtonEl = document.querySelector('#color-button');
const colorChipEl = document.querySelector('#color-chip');
const searchButtonEl = document.querySelector('#search-button');
const searchPanelEl = document.querySelector('#search-panel');
const searchInputEl = document.querySelector('#search-input');
const searchCountEl = document.querySelector('#search-count');
const searchPrevEl = document.querySelector('#search-prev');
const searchNextEl = document.querySelector('#search-next');
const searchCloseEl = document.querySelector('#search-close');
const menuButtonEl = document.querySelector('#menu-button');
const menuPanelEl = document.querySelector('#menu-panel');
const colorPaletteEl = document.querySelector('#color-palette');
const strokeColorEl = document.querySelector('#stroke-color');
const strokeWidthEl = document.querySelector('#stroke-width');
const workspaceEl = document.querySelector('.workspace');
const pagesEl = document.querySelector('#pages');
const messageBoxEl = document.querySelector('#message-box');

let drawingLayer = null;
let zoomRerenderTimer = null;
let zoomRenderRequestId = 0;
let resizeRerenderTimer = null;

const autoSaver = createAutoSaver(() => {
  requestSave();
});

state.history = [createHistoryEntry(state.sessionAnnotations, [])];

let sidebarController;
let viewportController;
let interactionController;

sidebarController = createSidebarController({
  state,
  contentShellEl,
  sidebarEl,
  sidebarToggleEl,
  sidebarTabsEl,
  outlineTabEl,
  pagesPanelEl,
  outlinePanelEl,
  pageListEl,
  outlineListEl,
  workspaceEl,
  escapeHtml,
  icons,
  jumpToPage: (...args) => viewportController.jumpToPage(...args),
  getPageScrollTop: (...args) => viewportController.getPageScrollTop(...args),
});

const searchController = createSearchController({
  state,
  workspaceEl,
  searchPanelEl,
  searchButtonEl,
  searchInputEl,
  searchCountEl,
  searchPrevEl,
  searchNextEl,
  findTextNode,
  getPageScrollTop: (...args) => viewportController.getPageScrollTop(...args),
  updateCurrentPageFromScroll: (...args) =>
    viewportController.updateCurrentPageFromScroll(...args),
  updatePageIndicator: (...args) =>
    viewportController.updatePageIndicator(...args),
});

const formsController = createFormController({
  state,
  vscode,
  applyTextFieldValidationState,
  createSelectControl,
  getButtonActionState,
  getTextFieldValidationError,
  normalizeDateValueForInput,
  normalizeDateValueForStorage,
  slugify,
  requestSave,
});

const selectionController = createSelectionController({
  state,
  workspaceEl,
  normalizeSelectedText,
  applySessionAnnotations,
  renderSelectionAction,
  renderComments,
});

const bookmarkController = createBookmarkController({
  state,
  cloneBookmarks,
  compareBookmarks,
  createHistoryEntry,
  pushHistoryEntry,
  syncOutlineState,
  renderSidebar: (...args) => sidebarController.renderSidebar(...args),
  updateHistoryState: (...args) =>
    interactionController.updateHistoryState(...args),
  setSidebarTab: (...args) => sidebarController.setSidebarTab(...args),
  setSidebarOpen: (...args) => sidebarController.setSidebarOpen(...args),
  renderSelectionAction,
});

const {
  getOutlineKey,
  expandOutlinePathForPage,
  renderSidebar,
  updateSidebarActiveState,
  setSidebarTab,
  updateSidebarTabUI,
  setSidebarOpen,
} = sidebarController;
const {
  renderSearchHighlights,
  setSearchOpen,
  updateSearchUI,
  updateSearchResults,
  revealSearchMatch,
  moveSearchMatch,
} = searchController;
const {
  renderFormFields,
  updateFormFieldValue,
  queueFormFieldSave,
  activateButtonField,
} = formsController;
const {
  findPageEntryFromNode,
  addHighlightFromSelection,
  snapshotSelection,
  addCommentFromSelection,
} = selectionController;
const { applyBookmarks, addBookmarkFromSelection } = bookmarkController;

viewportController = createViewportController({
  state,
  workspaceEl,
  pageInputEl,
  pageTotalEl,
  zoomPresetEl,
  strokeColorEl,
  colorChipEl,
  colorButtonEl,
  colorPaletteEl,
  outlineListEl,
  renderSidebar: (...args) => sidebarController.renderSidebar(...args),
  updateSidebarActiveState: (...args) =>
    sidebarController.updateSidebarActiveState(...args),
  expandOutlinePathForPage: (...args) =>
    sidebarController.expandOutlinePathForPage(...args),
});

interactionController = createInteractionController({
  state,
  toolbarEl,
  colorPopoverEl,
  colorButtonEl,
  modeToggleEl,
  commentButtonEl,
  commentViewsToggleEl,
  pagesEl,
  layoutToggleEl,
  menuPanelEl,
  menuButtonEl,
  icons,
  updateSidebarActiveState: (...args) =>
    sidebarController.updateSidebarActiveState(...args),
  submitCommentComposer,
  cancelCommentComposer,
  renderComments,
  scheduleZoomRerender,
  createZoomContext,
});

const {
  updatePageIndicator,
  updateZoomPresetIndicator,
  updateCurrentPageFromScroll,
  setActiveColor,
  getCommentOverlayPlacement,
  jumpToPage,
  getPageScrollTop,
} = viewportController;
const {
  setColorPopoverOpen,
  updateCommentViewsToggleState,
  setMode,
  updateInteractionMode,
  updateHistoryState,
  updateLayoutState,
  setMenuOpen,
  setPageLayout,
  isTextEditingTarget,
} = interactionController;

function restoreHistoryEntry(entry) {
  state.bookmarks = cloneBookmarks(entry.bookmarks || []);
  syncOutlineState(state);
  applySessionAnnotations(entry.annotations, {
    skipHistory: true,
  });
  renderSidebar();
}

function pushHistoryEntry(entry) {
  pushHistoryEntryState(state, entry, MAX_HISTORY_ENTRIES);
}

updateCommentViewsToggleState();

function renderHighlights(highlights) {
  for (const pageEntry of state.pageEntries) {
    pageEntry.highlightLayer.replaceChildren();

    for (const highlight of highlights) {
      if (highlight.page !== pageEntry.pageNumber) {
        continue;
      }

      const scaleX =
        pageEntry.width /
        Math.max(highlight.viewportWidth || pageEntry.width, 1);
      const scaleY =
        pageEntry.height /
        Math.max(highlight.viewportHeight || pageEntry.height, 1);

      for (const rect of highlight.rects) {
        const box = document.createElement('div');
        box.className = `highlight-box${highlight.kind === 'underline' ? ' underline-box' : highlight.kind === 'strikeout' ? ' strikeout-box' : ''}`;
        box.style.left = `${rect.x * scaleX}px`;
        box.style.top = `${rect.y * scaleY}px`;
        box.style.width = `${rect.width * scaleX}px`;
        box.style.height = `${rect.height * scaleY}px`;
        box.style.backgroundColor = highlight.color;
        if (highlight.kind === 'underline') {
          box.style.opacity = '1';
          const lineThickness = Math.max(
            2,
            Math.min(rect.height * scaleY * 0.16, 4)
          );
          box.style.height = `${lineThickness}px`;
          box.style.top = `${rect.y * scaleY + rect.height * scaleY - lineThickness}px`;
        } else if (highlight.kind === 'strikeout') {
          box.style.opacity = '1';
          const lineThickness = Math.max(
            2,
            Math.min(rect.height * scaleY * 0.16, 4)
          );
          box.style.height = `${lineThickness}px`;
          box.style.top = `${rect.y * scaleY + rect.height * scaleY * 0.5 - lineThickness * 0.5}px`;
        } else {
          box.style.opacity = '0.28';
        }
        if (highlight.attachedNote?.text) {
          box.style.cursor = 'pointer';
          box.title = 'Open attached note';
          box.addEventListener('click', (event) => {
            event.stopPropagation();
            if (state.commentComposer) {
              submitCommentComposer();
              if (state.commentComposer) {
                cancelCommentComposer();
              }
            }
            state.showAllComments = false;
            state.openCommentId = null;
            state.openMarkupNoteId =
              state.openMarkupNoteId === highlight.id ? null : highlight.id;
            updateCommentViewsToggleState();
            renderComments();
          });
        }
        pageEntry.highlightLayer.append(box);
      }
    }
  }
}

function renderComments() {
  for (const pageEntry of state.pageEntries) {
    renderCommentLayer({
      pageEntry,
      state,
      icons,
      formatCommentDate,
      getCommentOverlayPlacement,
      renderComments,
      applySessionAnnotations,
      updateCommentViewsToggleState,
      submitCommentComposer,
      cancelCommentComposer,
      renderSelectionAction,
    });
  }
}

function renderSelectionAction() {
  renderSelectionActionOverlay({
    state,
    workspaceEl,
    icons,
    addHighlightFromSelection,
    addCommentFromSelection,
    addBookmarkFromSelection,
  });
}

function applySessionAnnotations(annotations, options = {}) {
  const nextAnnotations = cloneAnnotations(annotations);
  state.sessionAnnotations = nextAnnotations;
  drawingLayer?.load(nextAnnotations.strokes);
  renderHighlights(nextAnnotations.highlights);
  renderFormFields();
  renderComments();
  renderSelectionAction();

  if (!options.skipHistory) {
    pushHistoryEntry(createHistoryEntry(nextAnnotations, state.bookmarks));
  }

  updateHistoryState();

  if (!options.skipSave) {
    autoSaver.queue();
  }
}

function requestSave() {
  if (state.saveInFlight) {
    state.saveQueued = true;
    return;
  }

  state.saveInFlight = true;
  state.saveQueued = false;

  vscode.postMessage({
    type: 'documentChanged',
    payload: {
      annotations: {
        version: state.sessionAnnotations.version,
        strokes: state.sessionAnnotations.strokes,
        highlights: state.sessionAnnotations.highlights,
        comments: state.sessionAnnotations.comments,
        updatedAt: new Date().toISOString(),
      },
      formFields: state.formFields,
    },
  });
}

async function rerenderPages() {
  const requestId = ++zoomRenderRequestId;
  const metrics = startRenderRequest();
  const workspaceSize = {
    width: workspaceEl.clientWidth,
    height: workspaceEl.clientHeight,
  };
  const { pages, outline, resolvedScale, fragment } = await renderPdf(
    state.pdfBase64,
    pagesEl,
    getZoomConfig(),
    workspaceSize,
    state.outlinePdfBase64 || state.pdfBase64,
    metrics
  );

  if (requestId !== zoomRenderRequestId) {
    metrics.finish('discarded');
    return;
  }

  metrics.measure('domReplace', () => pagesEl.replaceChildren(fragment));
  state.pageEntries = pages;
  state.externalOutline = outline;
  syncOutlineState(state);
  state.zoom = resolvedScale;
  state.renderedZoom = resolvedScale;
  state.totalPages = state.pageEntries.length;
  state.currentPage = Math.min(state.currentPage, state.totalPages || 1);

  drawingLayer = createDrawingLayer(state.pageEntries, {
    getColor: () => state.color,
    getWidth: () => Number(strokeWidthEl.value),
    getHighlights: () => state.sessionAnnotations.highlights,
    getMode: () => state.mode,
    getAllowFingerDrawing: () => state.allowFingerDrawing,
    getScrollContainer: () => workspaceEl,
    onChange(allStrokes) {
      applySessionAnnotations({
        ...state.sessionAnnotations,
        strokes: allStrokes,
      });
    },
    onErase(_erasedStroke, remainingStrokes) {
      applySessionAnnotations({
        ...state.sessionAnnotations,
        strokes: remainingStrokes,
      });
    },
    onEraseHighlight(_erasedHighlight, remainingHighlights) {
      applySessionAnnotations({
        ...state.sessionAnnotations,
        highlights: remainingHighlights,
      });
    },
  });
  drawingLayer.load(state.sessionAnnotations.strokes);
  renderHighlights(state.sessionAnnotations.highlights);
  renderFormFields();
  renderComments();
  updateSearchResults({ preserveActive: true });
  renderSidebar();
  updatePageIndicator();
  updateZoomPresetIndicator();
  updateLayoutState();
  updateInteractionMode();
  restoreZoomViewport();
  metrics.finish('completed');
}

function cancelCommentComposer() {
  state.commentComposer = null;
  renderComments();
}

function deleteCommentFromComposer() {
  if (state.commentComposer?.sourceHighlightId) {
    const sourceHighlightId = state.commentComposer.sourceHighlightId;
    state.commentComposer = null;
    state.openMarkupNoteId = null;
    applySessionAnnotations({
      ...state.sessionAnnotations,
      highlights: state.sessionAnnotations.highlights.filter(
        (highlight) => highlight.id !== sourceHighlightId
      ),
    });
    return;
  }

  if (!state.commentComposer?.id) {
    cancelCommentComposer();
    return;
  }

  const commentId = state.commentComposer.id;
  state.commentComposer = null;
  state.openCommentId = null;
  applySessionAnnotations({
    ...state.sessionAnnotations,
    comments: state.sessionAnnotations.comments.filter(
      (comment) => comment.id !== commentId
    ),
  });
}

function submitCommentComposer() {
  if (!state.commentComposer || !state.commentComposer.text.trim()) {
    return;
  }

  if (state.commentComposer.sourceHighlightId) {
    const composerState = state.commentComposer;
    const sourceHighlightId = composerState.sourceHighlightId;
    const nextModifiedAt = new Date().toISOString();
    state.openMarkupNoteId = sourceHighlightId;
    state.commentComposer = null;
    applySessionAnnotations({
      ...state.sessionAnnotations,
      highlights: state.sessionAnnotations.highlights.map((highlight) =>
        highlight.id === sourceHighlightId
          ? {
              ...highlight,
              attachedNote: {
                ...(highlight.attachedNote || {}),
                text: composerState.text.trim(),
                author: composerState.author || state.commentAuthor,
                modifiedAt: nextModifiedAt,
                subject: highlight.attachedNote?.subject,
              },
            }
          : highlight
      ),
    });
    window.getSelection()?.removeAllRanges();
    state.selectionSnapshot = null;
    state.selectionAction = null;
    renderSelectionAction();
    return;
  }

  const composerState = state.commentComposer;
  const nextComment = {
    id: composerState.id ?? crypto.randomUUID(),
    author: composerState.author || state.commentAuthor,
    modifiedAt: new Date().toISOString(),
    page: composerState.page,
    viewportWidth: composerState.viewportWidth,
    viewportHeight: composerState.viewportHeight,
    rects: structuredClone(composerState.rects),
    color: composerState.color,
    text: composerState.text.trim(),
  };

  state.openCommentId = nextComment.id;
  state.commentComposer = null;
  applySessionAnnotations({
    ...state.sessionAnnotations,
    comments: state.sessionAnnotations.comments.some(
      (comment) => comment.id === nextComment.id
    )
      ? state.sessionAnnotations.comments.map((comment) =>
          comment.id === nextComment.id ? nextComment : comment
        )
      : state.sessionAnnotations.comments.concat(nextComment),
  });
  window.getSelection()?.removeAllRanges();
  state.selectionSnapshot = null;
  state.selectionAction = null;
  renderSelectionAction();
}

function undo() {
  if (state.historyIndex <= 0) {
    return;
  }

  state.historyIndex -= 1;
  restoreHistoryEntry(state.history[state.historyIndex]);
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) {
    return;
  }

  state.historyIndex += 1;
  restoreHistoryEntry(state.history[state.historyIndex]);
}

async function adjustZoom(delta) {
  const nextZoom = Math.max(
    0.5,
    Math.min(10, Number((state.zoom + delta).toFixed(2)))
  );
  if (nextZoom === state.zoom || !state.pdfBase64) {
    return;
  }

  state.zoomMode = 'custom';
  state.zoomContext = createZoomContext();
  state.zoom = nextZoom;
  scheduleZoomRerender();
}

function scheduleZoomRerender() {
  if (zoomRerenderTimer) {
    window.clearTimeout(zoomRerenderTimer);
  }

  zoomRerenderTimer = window.setTimeout(() => {
    zoomRerenderTimer = null;
    void rerenderPages();
  }, 140);
}

function scheduleResponsiveRerender() {
  if (resizeRerenderTimer) {
    window.clearTimeout(resizeRerenderTimer);
  }

  resizeRerenderTimer = window.setTimeout(() => {
    resizeRerenderTimer = null;

    if (!state.pdfBase64) {
      return;
    }

    if (!['automatic', 'page-fit', 'page-width'].includes(state.zoomMode)) {
      return;
    }

    state.zoomContext = createZoomContext();
    void rerenderPages();
  }, 120);
}

function createZoomContext(anchorClientX, anchorClientY) {
  const workspaceRect = workspaceEl.getBoundingClientRect();
  const clientX = anchorClientX ?? workspaceRect.left + workspaceRect.width / 2;
  const clientY = anchorClientY ?? workspaceRect.top + workspaceRect.height / 2;
  const anchorX = workspaceEl.scrollLeft + (clientX - workspaceRect.left);
  const anchorY = workspaceEl.scrollTop + (clientY - workspaceRect.top);

  return {
    previousZoom: state.renderedZoom,
    anchorX,
    anchorY,
    offsetX: clientX - workspaceRect.left,
    offsetY: clientY - workspaceRect.top,
  };
}

function restoreZoomViewport() {
  const zoomContext = state.zoomContext;
  if (!zoomContext) {
    return;
  }

  const ratio = state.zoom / zoomContext.previousZoom;
  workspaceEl.scrollLeft = zoomContext.anchorX * ratio - zoomContext.offsetX;
  workspaceEl.scrollTop = zoomContext.anchorY * ratio - zoomContext.offsetY;
  state.zoomContext = null;
  clearVisualZoomPreview();
}

function ensureZoomContext(anchorClientX, anchorClientY) {
  if (!state.zoomContext) {
    state.zoomContext = createZoomContext(anchorClientX, anchorClientY);
  }
}

function applyVisualZoomPreview() {
  if (!state.zoomContext) {
    return;
  }

  const ratio = state.zoom / state.zoomContext.previousZoom;
  pagesEl.style.transformOrigin = `${state.zoomContext.anchorX}px ${state.zoomContext.anchorY}px`;
  pagesEl.style.transform = `scale(${ratio})`;
  pagesEl.classList.add('is-zooming');
}

function clearVisualZoomPreview() {
  pagesEl.style.transform = '';
  pagesEl.style.transformOrigin = '';
  pagesEl.classList.remove('is-zooming');
}

function applyWheelZoom(event) {
  if (!state.pdfBase64 || (!event.ctrlKey && !event.metaKey)) {
    return;
  }

  event.preventDefault();

  const zoomFactor = Math.exp(-event.deltaY * 0.0025);
  const nextZoom = Math.max(
    0.5,
    Math.min(10, Number((state.zoom * zoomFactor).toFixed(2)))
  );
  if (nextZoom === state.zoom) {
    return;
  }

  state.zoomMode = 'custom';
  ensureZoomContext(event.clientX, event.clientY);
  state.zoom = nextZoom;
  applyVisualZoomPreview();
  scheduleZoomRerender();
}

function applyGestureZoomStart(event) {
  if (!state.pdfBase64) {
    return;
  }

  event.preventDefault();
  state.gestureZoomBase = state.zoom;
  state.zoomContext = createZoomContext(event.clientX, event.clientY);
  applyVisualZoomPreview();
}

function applyGestureZoomChange(event) {
  if (!state.pdfBase64 || state.gestureZoomBase === null) {
    return;
  }

  event.preventDefault();
  state.zoomMode = 'custom';
  state.zoom = Math.max(
    0.5,
    Math.min(10, Number((state.gestureZoomBase * event.scale).toFixed(2)))
  );
  applyVisualZoomPreview();
  scheduleZoomRerender();
}

function applyGestureZoomEnd() {
  state.gestureZoomBase = null;
}

function applyZoomPreset(value) {
  if (value === 'custom') {
    return;
  }

  if (
    value === 'automatic' ||
    value === 'actual-size' ||
    value === 'page-fit' ||
    value === 'page-width'
  ) {
    state.zoomMode = value;
    state.zoomContext = createZoomContext();
    scheduleZoomRerender();
    return;
  }

  const numericZoom = Number(value);
  if (!Number.isFinite(numericZoom)) {
    return;
  }

  state.zoomMode = 'custom';
  state.zoom = Math.max(0.5, Math.min(10, numericZoom));
  state.zoomContext = createZoomContext();
  applyVisualZoomPreview();
  scheduleZoomRerender();
}

function getZoomConfig() {
  if (state.zoomMode === 'custom') {
    return {
      mode: 'custom',
      scale: state.zoom,
      layout: state.pageLayout,
    };
  }

  return {
    mode: state.zoomMode,
    scale: state.zoom,
    layout: state.pageLayout,
  };
}

zoomInEl.addEventListener('click', () => {
  void adjustZoom(0.25);
});

sidebarToggleEl.addEventListener('click', () => {
  setSidebarOpen(!state.sidebarOpen);
});

searchButtonEl.addEventListener('click', () => {
  setSearchOpen(!state.searchOpen);
});

searchInputEl.addEventListener('input', () => {
  state.searchQuery = searchInputEl.value;
  state.activeSearchMatchIndex = -1;
  updateSearchResults();
});

searchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    moveSearchMatch(event.shiftKey ? -1 : 1);
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    setSearchOpen(false);
  }
});

searchPrevEl.addEventListener('click', () => {
  moveSearchMatch(-1);
});

searchNextEl.addEventListener('click', () => {
  moveSearchMatch(1);
});

searchCloseEl.addEventListener('click', () => {
  setSearchOpen(false);
});

sidebarTabsEl.addEventListener('click', (event) => {
  const tab = event.target.closest('.sidebar-tab');
  if (!tab || tab.hidden) {
    return;
  }

  setSidebarTab(tab.dataset.tab);
});

zoomOutEl.addEventListener('click', () => {
  void adjustZoom(-0.25);
});

zoomPresetEl.addEventListener('change', () => {
  applyZoomPreset(zoomPresetEl.value);
});

layoutToggleEl.addEventListener('click', () => {
  setPageLayout(state.pageLayout === 'double' ? 'single' : 'double');
});

function applyTypedPageJump() {
  const requestedPage = Number(pageInputEl.value);
  if (!Number.isFinite(requestedPage)) {
    updatePageIndicator();
    return;
  }

  const clampedPage = Math.min(
    Math.max(Math.round(requestedPage), 1),
    Math.max(state.totalPages, 1)
  );
  jumpToPage(clampedPage);
}

pageInputEl.addEventListener('change', applyTypedPageJump);
pageInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    applyTypedPageJump();
  }
});

modeToggleEl.addEventListener('click', (event) => {
  const button = event.target.closest('.mode-button');
  if (!button) {
    return;
  }

  setMode(button.dataset.mode);
});

undoButtonEl.addEventListener('click', () => {
  undo();
});

redoButtonEl.addEventListener('click', () => {
  redo();
});

commentButtonEl.addEventListener('mousedown', (event) => {
  event.preventDefault();
});

commentButtonEl.addEventListener('click', () => {
  setMode('comment');
  if (state.selectionSnapshot) {
    addCommentFromSelection();
  }
});

commentViewsToggleEl.addEventListener('click', () => {
  state.showAllComments = !state.showAllComments;
  if (state.showAllComments) {
    state.openCommentId = null;
    state.openMarkupNoteId = null;
  }
  updateCommentViewsToggleState();
  renderComments();
});

colorButtonEl.addEventListener('click', () => {
  setColorPopoverOpen(colorPopoverEl.hidden);
});

menuButtonEl.addEventListener('click', () => {
  setMenuOpen(!state.menuOpen);
});

colorPaletteEl.addEventListener('click', (event) => {
  const swatch = event.target.closest('.color-swatch');
  if (!swatch) {
    return;
  }

  setActiveColor(swatch.dataset.color);
});

strokeColorEl.addEventListener('input', () => {
  setActiveColor(strokeColorEl.value);
});

window.addEventListener('click', (event) => {
  if (!event.target.closest('#color-button, #color-popover')) {
    setColorPopoverOpen(false);
  }

  if (!event.target.closest('.selection-action')) {
    state.selectionAction = null;
    renderSelectionAction();
  }

  if (
    !event.target.closest('.comment-marker, .comment-popup, .comment-composer')
  ) {
    if (!state.showAllComments) {
      state.openCommentId = null;
      state.openMarkupNoteId = null;
      renderComments();
    }
  }

  if (state.searchOpen && !event.target.closest('.search-wrap')) {
    setSearchOpen(false);
  }

  if (menuPanelEl.hidden) {
    return;
  }

  if (
    menuPanelEl.contains(event.target) ||
    menuButtonEl.contains(event.target)
  ) {
    return;
  }

  setMenuOpen(false);
});

window.addEventListener('mouseup', () => {
  window.setTimeout(() => {
    snapshotSelection();
    if (state.mode === 'comment') {
      addCommentFromSelection();
      return;
    }
    addHighlightFromSelection();
  }, 0);
});

document.addEventListener('selectionchange', () => {
  snapshotSelection();
});

window.addEventListener('keydown', (event) => {
  if (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    event.key.toLowerCase() === 'f'
  ) {
    event.preventDefault();
    setSearchOpen(true);
    return;
  }

  if (
    event.key === 'Escape' &&
    state.searchOpen &&
    !isTextEditingTarget(event.target)
  ) {
    setSearchOpen(false);
    return;
  }

  if (
    isTextEditingTarget(event.target) ||
    (!event.ctrlKey && !event.metaKey) ||
    event.altKey
  ) {
    return;
  }

  const key = event.key.toLowerCase();
  if (key === 'z') {
    event.preventDefault();
    if (event.shiftKey) {
      redo();
      return;
    }

    undo();
    return;
  }

  if (key === 'y') {
    event.preventDefault();
    redo();
  }
});

workspaceEl.addEventListener('scroll', updateCurrentPageFromScroll, {
  passive: true,
});
workspaceEl.addEventListener('wheel', applyWheelZoom, { passive: false });
window.addEventListener('resize', scheduleResponsiveRerender, {
  passive: true,
});
window.addEventListener('wheel', applyWheelZoom, {
  passive: false,
  capture: true,
});
window.addEventListener('gesturestart', applyGestureZoomStart, {
  passive: false,
  capture: true,
});
window.addEventListener('gesturechange', applyGestureZoomChange, {
  passive: false,
  capture: true,
});
window.addEventListener('gestureend', applyGestureZoomEnd, {
  passive: true,
  capture: true,
});

window.addEventListener('message', async (event) => {
  const message = event.data;

  if (message.type === 'init') {
    state.fileName = message.payload.fileName;
    state.commentAuthor = message.payload.commentAuthor || 'PDF Studio';
    state.allowFingerDrawing = Boolean(message.payload.allowFingerDrawing);
    state.pdfBase64 = message.payload.pdfBase64;
    state.outlinePdfBase64 =
      message.payload.outlinePdfBase64 || message.payload.pdfBase64;
    state.sessionAnnotations = structuredClone(message.payload.annotations);
    state.formFields = structuredClone(message.payload.formFields);
    state.bookmarks = [];
    state.externalOutline = [];
    syncOutlineState(state);
    state.history = [
      createHistoryEntry(state.sessionAnnotations, state.bookmarks),
    ];
    state.historyIndex = 0;
    state.openCommentId = null;
    state.openMarkupNoteId = null;
    state.commentComposer = null;
    state.selectionSnapshot = null;
    state.selectionAction = null;
    state.searchOpen = false;
    state.searchQuery = '';
    state.searchMatches = [];
    state.activeSearchMatchIndex = -1;
    state.pageLayout = 'single';
    state.mode = 'select';
    state.showAllComments = false;
    state.lastButtonActivation = null;
    setColorPopoverOpen(false);
    searchInputEl.value = '';
    updateSearchUI();
    setSidebarOpen(false);
    setSidebarTab('outline');
    updateLayoutState();
    updateCommentViewsToggleState();

    try {
      await rerenderPages();
      if (state.outline.length) {
        setSidebarOpen(true);
      }
      messageBoxEl.hidden = true;
    } catch (error) {
      messageBoxEl.hidden = false;
      messageBoxEl.textContent =
        error instanceof Error ? error.message : 'Failed to load PDF.';
    }
  }

  if (message.type === 'saved') {
    state.saveInFlight = false;
    if (state.saveQueued) {
      requestSave();
    }
  }

  if (message.type === 'formFieldsReplaced') {
    state.formFields = structuredClone(message.payload.formFields);
    renderFormFields();
    updateInteractionMode();
  }

  if (message.type === 'commentAuthorUpdated') {
    state.commentAuthor = message.payload.commentAuthor || 'PDF Studio';
    if (state.commentComposer && !state.commentComposer.author) {
      renderComments();
    } else if (
      state.openCommentId !== null ||
      state.openMarkupNoteId !== null ||
      state.showAllComments
    ) {
      renderComments();
    }
  }

  if (message.type === 'inputPolicyUpdated') {
    state.allowFingerDrawing = Boolean(message.payload.allowFingerDrawing);
    updateInteractionMode();
  }

  if (message.type === 'error') {
    state.saveInFlight = false;
    state.saveQueued = true;
    messageBoxEl.hidden = false;
    messageBoxEl.textContent = message.payload.message;
  }
});

setActiveColor(state.color);
updateHistoryState();
vscode.postMessage({ type: 'ready' });
