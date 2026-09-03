export function createInteractionController({
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
  updateSidebarActiveState,
  submitCommentComposer,
  cancelCommentComposer,
  renderComments,
  scheduleZoomRerender,
  createZoomContext,
}) {
  function setColorPopoverOpen(nextOpen) {
    const shouldOpen = Boolean(nextOpen);
    state.colorPopoverOwner = shouldOpen ? 'color' : null;
    colorPopoverEl.hidden = !shouldOpen;
    colorButtonEl.classList.toggle('is-active', shouldOpen);

    if (!shouldOpen) {
      colorPopoverEl.style.removeProperty('--popover-left');
      return;
    }

    const toolbarRect = toolbarEl.getBoundingClientRect();
    const buttonRect = colorButtonEl?.getBoundingClientRect();
    if (!buttonRect) {
      colorPopoverEl.style.setProperty('--popover-left', '0px');
      return;
    }

    const left = buttonRect.left - toolbarRect.left + buttonRect.width / 2;
    colorPopoverEl.style.setProperty('--popover-left', `${left}px`);
  }

  function updateCommentViewsToggleState() {
    commentViewsToggleEl.classList.toggle('is-active', state.showAllComments);
    commentViewsToggleEl.setAttribute(
      'aria-pressed',
      String(state.showAllComments)
    );
    const label = state.showAllComments
      ? 'Collapse all comments'
      : 'Show all comments';
    commentViewsToggleEl.setAttribute('aria-label', label);
    commentViewsToggleEl.setAttribute('title', label);
  }

  function collapseCommentsForModeChange(nextMode) {
    if (nextMode === 'comment') {
      return;
    }

    const hadExpandedComments =
      state.openCommentId !== null ||
      state.openMarkupNoteId !== null ||
      state.showAllComments;
    state.openCommentId = null;
    state.openMarkupNoteId = null;
    state.showAllComments = false;
    updateCommentViewsToggleState();

    if (state.commentComposer) {
      if (state.commentComposer.text.trim()) {
        submitCommentComposer();
      } else {
        cancelCommentComposer();
      }
      return;
    }

    if (hadExpandedComments) {
      renderComments();
    }
  }

  function setMode(mode) {
    collapseCommentsForModeChange(mode);
    state.mode = mode;
    setColorPopoverOpen(false);
    updateInteractionMode();
  }

  function updateInteractionMode() {
    for (const button of modeToggleEl.querySelectorAll('.mode-button')) {
      button.classList.toggle('is-active', button.dataset.mode === state.mode);
    }
    commentButtonEl.classList.toggle('is-active', state.mode === 'comment');

    for (const pageEntry of state.pageEntries) {
      const textInteractionEnabled =
        state.mode === 'select' ||
        state.mode === 'highlight' ||
        state.mode === 'comment';
      const formInteractionEnabled = state.mode === 'select';
      pageEntry.drawingCanvas.style.pointerEvents = textInteractionEnabled
        ? 'none'
        : 'auto';
      pageEntry.drawingCanvas.style.cursor =
        state.mode === 'erase'
          ? 'not-allowed'
          : textInteractionEnabled
            ? 'text'
            : 'crosshair';
      pageEntry.textLayer.style.userSelect = textInteractionEnabled
        ? 'text'
        : 'none';
      pageEntry.textLayer.style.pointerEvents = textInteractionEnabled
        ? 'auto'
        : 'none';
      pageEntry.formLayer.classList.toggle(
        'is-disabled',
        !formInteractionEnabled
      );
      for (const control of pageEntry.formLayer.querySelectorAll(
        '.pdf-form-control'
      )) {
        control.disabled =
          control.dataset.readOnly === 'true' ||
          control.dataset.enabled === 'false' ||
          !formInteractionEnabled;
      }
    }
  }

  function updateHistoryState() {
    const { historyIndex, history } = state;
    document.querySelector('#undo-button').disabled = historyIndex <= 0;
    document.querySelector('#redo-button').disabled =
      historyIndex >= history.length - 1;
  }

  function updateLayoutState() {
    const isDouble = state.pageLayout === 'double';
    pagesEl.classList.toggle('is-double', isDouble);
    layoutToggleEl.classList.toggle('is-active', isDouble);
    layoutToggleEl.setAttribute('aria-pressed', String(isDouble));
    layoutToggleEl.innerHTML = isDouble
      ? icons.layoutSingle
      : icons.layoutDouble;
    const nextLabel = isDouble
      ? 'Switch to single-page view'
      : 'Switch to two-page view';
    layoutToggleEl.setAttribute('aria-label', nextLabel);
    layoutToggleEl.setAttribute('title', nextLabel);
  }

  function setMenuOpen(nextOpen) {
    state.menuOpen = nextOpen;
    menuPanelEl.hidden = !nextOpen;
    menuButtonEl.classList.toggle('is-active', nextOpen);
  }

  function setPageLayout(nextLayout) {
    if (state.pageLayout === nextLayout) {
      return;
    }

    state.pageLayout = nextLayout;
    updateLayoutState();

    if (!state.pdfBase64) {
      return;
    }

    state.zoomContext = createZoomContext();
    scheduleZoomRerender();
  }

  function isTextEditingTarget(target) {
    if (!(target instanceof Element)) {
      return false;
    }

    return Boolean(
      target.closest('input, textarea, select, [contenteditable="true"]')
    );
  }

  return {
    setColorPopoverOpen,
    updateCommentViewsToggleState,
    collapseCommentsForModeChange,
    setMode,
    updateInteractionMode,
    updateHistoryState,
    updateLayoutState,
    setMenuOpen,
    setPageLayout,
    isTextEditingTarget,
  };
}
