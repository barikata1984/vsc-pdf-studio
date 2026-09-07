import { findInTextIndex } from './textIndex.js';

export function createSearchController({
  state,
  workspaceEl,
  searchPanelEl,
  searchButtonEl,
  searchInputEl,
  searchCountEl,
  searchPrevEl,
  searchNextEl,
  findTextNode,
  getPageScrollTop,
  updatePageIndicator,
  ensurePageRendered,
}) {
  function renderSearchHighlights() {
    for (const pageEntry of state.pageEntries) {
      pageEntry.searchLayer.replaceChildren();
    }

    for (let index = 0; index < state.searchMatches.length; index += 1) {
      const match = state.searchMatches[index];
      const pageEntry = state.pageEntries.find(
        (entry) => entry.pageNumber === match.pageNumber
      );
      if (!pageEntry) {
        continue;
      }

      for (const rect of match.rects) {
        const box = document.createElement('div');
        box.className = `search-box${index === state.activeSearchMatchIndex ? ' is-active' : ''}`;
        box.style.left = `${rect.x}px`;
        box.style.top = `${rect.y}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        pageEntry.searchLayer.append(box);
      }
    }
  }

  function setSearchOpen(nextOpen) {
    state.searchOpen = nextOpen;
    searchPanelEl.hidden = !nextOpen;
    searchButtonEl.classList.toggle('is-active', nextOpen);
    if (nextOpen) {
      window.setTimeout(() => {
        searchInputEl.focus();
        searchInputEl.select();
      }, 0);
    }
  }

  function updateSearchUI() {
    const total = state.searchMatches.length;
    const current =
      total && state.activeSearchMatchIndex >= 0
        ? state.activeSearchMatchIndex + 1
        : 0;
    searchCountEl.textContent = `${current} / ${total}`;
    searchPrevEl.disabled = total === 0;
    searchNextEl.disabled = total === 0;
  }

  function computeMatchRects(pageEntry, indexedPage, match) {
    const textDivs = pageEntry.textDivs ?? [];
    if (!indexedPage?.items.length || !textDivs.length) {
      return [];
    }

    const startItem = indexedPage.items.find(
      (item) => item.start <= match.start && match.start < item.end
    );
    const endOffset = Math.max(match.start, match.end - 1);
    const endItem = indexedPage.items.find(
      (item) => item.start <= endOffset && endOffset < item.end
    );
    if (!startItem || !endItem) {
      return [];
    }
    const startNode = findTextNode(textDivs[startItem.index]);
    const endNode = findTextNode(textDivs[endItem.index]);
    if (!startNode || !endNode) {
      return [];
    }

    const range = document.createRange();
    range.setStart(startNode, match.start - startItem.start);
    range.setEnd(endNode, match.end - endItem.start);
    const layerRect = pageEntry.textLayer.getBoundingClientRect();
    const scaleX = pageEntry.width / Math.max(layerRect.width, 1);
    const scaleY = pageEntry.height / Math.max(layerRect.height, 1);
    return Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        x: (rect.left - layerRect.left) * scaleX,
        y: (rect.top - layerRect.top) * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      }));
  }

  function updateSearchResults(options = {}) {
    const query = state.searchQuery.trim();
    if (!query) {
      state.searchMatches = [];
      state.activeSearchMatchIndex = -1;
      renderSearchHighlights();
      updateSearchUI();
      return;
    }

    const previousMatch = options.preserveActive
      ? state.searchMatches[state.activeSearchMatchIndex]
      : null;
    const indexedPages = new Map(
      (state.searchTextIndex ?? []).map((page) => [page.pageNumber, page])
    );
    state.searchMatches = findInTextIndex(
      state.searchTextIndex ?? [],
      query
    ).map((match) => {
      const pageEntry = state.pageEntries.find(
        (entry) => entry.pageNumber === match.pageNumber
      );
      return {
        ...match,
        rects: pageEntry
          ? computeMatchRects(
              pageEntry,
              indexedPages.get(match.pageNumber),
              match
            )
          : [],
      };
    });

    if (!state.searchMatches.length) {
      state.activeSearchMatchIndex = -1;
    } else if (previousMatch) {
      const restoredIndex = state.searchMatches.findIndex(
        (match) =>
          match.pageNumber === previousMatch.pageNumber &&
          match.start === previousMatch.start
      );
      state.activeSearchMatchIndex = restoredIndex >= 0 ? restoredIndex : 0;
    } else if (
      state.activeSearchMatchIndex < 0 ||
      state.activeSearchMatchIndex >= state.searchMatches.length
    ) {
      state.activeSearchMatchIndex = 0;
    }

    renderSearchHighlights();
    updateSearchUI();
  }

  async function revealSearchMatch(index) {
    let match = state.searchMatches[index];
    if (!match) {
      return;
    }

    let pageEntry = state.pageEntries.find(
      (entry) => entry.pageNumber === match.pageNumber
    );
    if (!pageEntry) {
      return;
    }
    if (
      !match.rects.length ||
      pageEntry.renderState !== 'rendered' ||
      !pageEntry.textReady
    ) {
      const requestedMatch = match;
      const rendered = await ensurePageRendered(match.pageNumber);
      match = state.searchMatches[index];
      if (
        !rendered ||
        state.activeSearchMatchIndex !== index ||
        match?.pageNumber !== requestedMatch.pageNumber ||
        match?.start !== requestedMatch.start ||
        match?.end !== requestedMatch.end
      ) {
        return;
      }
      pageEntry = state.pageEntries.find(
        (entry) => entry.pageNumber === match?.pageNumber
      );
      if (!match || !pageEntry) {
        return;
      }
    }

    state.currentPage = match.pageNumber;
    updatePageIndicator();
    const rect = match.rects[0] ?? { x: 0, y: 0 };
    workspaceEl.scrollTo({
      top: getPageScrollTop(pageEntry) + Math.max(0, rect.y - 32),
      left: Math.max(0, rect.x - 24),
      behavior: 'auto',
    });
  }

  function moveSearchMatch(direction) {
    if (!state.searchMatches.length) {
      return;
    }

    const total = state.searchMatches.length;
    const nextIndex =
      state.activeSearchMatchIndex < 0
        ? 0
        : (state.activeSearchMatchIndex + direction + total) % total;
    state.activeSearchMatchIndex = nextIndex;
    renderSearchHighlights();
    updateSearchUI();
    void revealSearchMatch(nextIndex);
  }

  return {
    renderSearchHighlights,
    setSearchOpen,
    updateSearchUI,
    updateSearchResults,
    revealSearchMatch,
    moveSearchMatch,
  };
}
