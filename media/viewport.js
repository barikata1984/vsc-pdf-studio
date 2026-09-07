export function getCurrentPageRootMargin(viewportHeight) {
  const margin = Math.max(0, Math.floor(viewportHeight * 0.45));
  return `-${margin}px 0px -${margin}px 0px`;
}

export function getCurrentPageNumber(pageNumbers, pageLayout) {
  if (!pageNumbers.length) {
    return null;
  }
  return Math.min(
    ...pageNumbers.map((pageNumber) =>
      pageLayout === 'double' && pageNumber % 2 === 0
        ? pageNumber - 1
        : pageNumber
    )
  );
}

export function createViewportController({
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
  renderSidebar,
  updateSidebarActiveState,
  expandOutlinePathForPage,
}) {
  function updatePageIndicator() {
    pageInputEl.value = String(state.currentPage);
    pageInputEl.max = String(Math.max(state.totalPages, 1));
    pageTotalEl.textContent = `/ ${Math.max(state.totalPages, 1)}`;
  }

  function updateZoomPresetIndicator() {
    if (state.zoomMode !== 'custom') {
      zoomPresetEl.value = state.zoomMode;
      return;
    }

    const matchingOption = Array.from(zoomPresetEl.options).find(
      (option) =>
        !Number.isNaN(Number(option.value)) &&
        Math.abs(Number(option.value) - state.zoom) < 0.01
    );

    zoomPresetEl.value = matchingOption ? matchingOption.value : 'custom';
  }

  function getPageScrollTop(pageEntry) {
    return pageEntry.pageShell.offsetTop;
  }

  function setCurrentPage(pageNumber) {
    if (!Number.isInteger(pageNumber) || pageNumber === state.currentPage) {
      return;
    }

    state.currentPage = pageNumber;
    if (state.activeOutlineKey) {
      const activeOutlineItem = outlineListEl.querySelector(
        `.sidebar-item[data-outline-key="${CSS.escape(state.activeOutlineKey)}"]`
      );
      if (
        !activeOutlineItem ||
        activeOutlineItem.dataset.page !== String(pageNumber)
      ) {
        state.activeOutlineKey = null;
      }
    }
    updatePageIndicator();
    updateSidebarActiveState();
  }

  function setActiveColor(color) {
    state.color = color;
    strokeColorEl.value = color;
    colorChipEl.style.backgroundColor = color;
    colorButtonEl.style.setProperty('--active-color', color);

    for (const swatch of colorPaletteEl.querySelectorAll('.color-swatch')) {
      swatch.classList.toggle('is-active', swatch.dataset.color === color);
    }
  }

  function getCommentOverlayPlacement({
    pageEntry,
    overlayWidth,
    overlayHeight,
    gap,
    anchorRight,
    anchorTop,
    markerAnchorX,
  }) {
    const padding = 8;
    const top = Math.min(
      pageEntry.height - overlayHeight,
      Math.max(2, anchorTop - 2)
    );
    const visibleLeft = workspaceEl.scrollLeft - pageEntry.pageShell.offsetLeft;
    const visibleRight = visibleLeft + workspaceEl.clientWidth;
    const canFitToVisibleRight = (left) =>
      left + overlayWidth + padding <= visibleRight;
    const canFitToVisibleLeft = (left) => left >= visibleLeft + padding;
    const isMostlyRightOfAnchor = (left) =>
      left + overlayWidth * 0.5 >= anchorRight;
    const isMostlyLeftOfAnchor = (left) =>
      left + overlayWidth * 0.5 <= anchorRight;
    const preferredRightLeft = pageEntry.width + gap;
    const shiftedRightLeft = Math.min(
      preferredRightLeft,
      visibleRight - overlayWidth - padding
    );
    const preferredLeftLeft = anchorRight - overlayWidth - gap;
    const shiftedLeftLeft = Math.max(
      padding,
      Math.max(visibleLeft + padding, preferredLeftLeft)
    );
    const preferLeftOutside =
      state.pageLayout === 'double' && pageEntry.pageNumber % 2 === 1;

    let left;
    if (preferLeftOutside) {
      const outsideLeft = -overlayWidth - gap;
      if (canFitToVisibleLeft(outsideLeft)) {
        left = outsideLeft;
      } else if (
        canFitToVisibleLeft(shiftedLeftLeft) &&
        isMostlyLeftOfAnchor(shiftedLeftLeft)
      ) {
        left = shiftedLeftLeft;
      } else if (canFitToVisibleRight(shiftedRightLeft)) {
        left = shiftedRightLeft;
      } else {
        left = Math.max(
          padding,
          Math.min(preferredLeftLeft, pageEntry.width - overlayWidth - padding)
        );
      }
    } else if (canFitToVisibleRight(preferredRightLeft)) {
      left = preferredRightLeft;
    } else if (
      canFitToVisibleRight(shiftedRightLeft) &&
      isMostlyRightOfAnchor(shiftedRightLeft)
    ) {
      left = shiftedRightLeft;
    } else if (canFitToVisibleLeft(shiftedLeftLeft)) {
      left = shiftedLeftLeft;
    } else {
      left = Math.max(
        padding,
        Math.min(preferredLeftLeft, pageEntry.width - overlayWidth - padding)
      );
    }

    const overlayMidX = left + overlayWidth / 2;
    const connectorLeft = Math.min(markerAnchorX, overlayMidX);
    const connectorWidth = Math.max(8, Math.abs(overlayMidX - markerAnchorX));

    return {
      left,
      top,
      connectorLeft,
      connectorWidth,
    };
  }

  function jumpToPage(pageNumber, outlineKey = null, topRatio = null) {
    const targetPage = state.pageEntries.find(
      (entry) => entry.pageNumber === pageNumber
    );
    if (!targetPage) {
      return;
    }

    state.currentPage = pageNumber;
    state.activeOutlineKey = outlineKey;
    const expandedOutline = expandOutlinePathForPage(state.outline, pageNumber);
    updatePageIndicator();
    if (expandedOutline) {
      renderSidebar({ reveal: true });
    } else {
      updateSidebarActiveState({ reveal: true });
    }
    if (typeof topRatio === 'number') {
      workspaceEl.scrollTo({
        top:
          getPageScrollTop(targetPage) +
          Math.max(0, Math.min(1, topRatio)) *
            Math.max(targetPage.height - 48, 0),
        left: workspaceEl.scrollLeft,
        behavior: 'auto',
      });
    } else {
      targetPage.pageShell.scrollIntoView({
        behavior: 'auto',
        block: 'start',
        inline: 'nearest',
      });
    }
  }

  return {
    updatePageIndicator,
    updateZoomPresetIndicator,
    setCurrentPage,
    setActiveColor,
    getCommentOverlayPlacement,
    jumpToPage,
    getPageScrollTop,
  };
}
