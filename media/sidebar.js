export function createSidebarController({
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
  jumpToPage,
  getPageScrollTop,
}) {
  function getOutlineKey(item, path) {
    return `${path.join('.')}:${item.pageNumber ?? ''}:${item.title}`;
  }

  function ensureSidebarItemVisible(container, item) {
    if (!container || !item || container.hidden || sidebarEl.hidden) {
      return;
    }

    const sidebarRect = container.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const padding = 12;

    if (itemRect.top < sidebarRect.top + padding) {
      container.scrollTop -= sidebarRect.top + padding - itemRect.top;
      return;
    }

    if (itemRect.bottom > sidebarRect.bottom - padding) {
      container.scrollTop += itemRect.bottom - (sidebarRect.bottom - padding);
    }
  }

  function expandOutlinePathForPage(items, pageNumber, path = []) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const itemPath = path.concat(index);
      const itemKey = getOutlineKey(item, itemPath);
      if (item.pageNumber === pageNumber) {
        for (
          let ancestorLength = 1;
          ancestorLength < itemPath.length;
          ancestorLength += 1
        ) {
          const ancestorPath = itemPath.slice(0, ancestorLength);
          const ancestor = ancestorPath.reduce(
            (current, pathIndex) => current?.items?.[pathIndex],
            { items }
          );
          if (ancestor) {
            state.collapsedOutline[getOutlineKey(ancestor, ancestorPath)] =
              false;
          }
        }
        return true;
      }

      if (
        item.items?.length &&
        expandOutlinePathForPage(item.items, pageNumber, itemPath)
      ) {
        state.collapsedOutline[itemKey] = false;
        return true;
      }
    }

    return false;
  }

  function countOutlineItems(items) {
    let count = 0;
    for (const item of items) {
      count += 1;
      if (item.items?.length) {
        count += countOutlineItems(item.items);
      }
    }
    return count;
  }

  function updateSidebarTabUI() {
    for (const tab of sidebarTabsEl.querySelectorAll('.sidebar-tab')) {
      tab.classList.toggle('is-active', tab.dataset.tab === state.sidebarTab);
    }

    pagesPanelEl.hidden = state.sidebarTab !== 'pages';
    outlinePanelEl.hidden = state.sidebarTab !== 'outline';
  }

  function updateSidebarActiveState(options = {}) {
    const pageNumber = String(state.currentPage);
    const currentPageEntry = state.pageEntries.find(
      (entry) => entry.pageNumber === state.currentPage
    );
    const currentPageProgress = currentPageEntry
      ? Math.max(
          0,
          Math.min(
            1,
            (workspaceEl.scrollTop - getPageScrollTop(currentPageEntry)) /
              Math.max(currentPageEntry.height, 1)
          )
        )
      : 0;
    let activePageItem = null;
    for (const item of pageListEl.querySelectorAll('.sidebar-item')) {
      const isActive = item.dataset.page === pageNumber;
      item.classList.toggle('is-active', isActive);
      if (isActive) {
        activePageItem = item;
      }
    }

    const preferredOutlineItem =
      state.activeOutlineKey &&
      outlineListEl.querySelector(
        `.sidebar-item[data-outline-key="${CSS.escape(state.activeOutlineKey)}"]`
      );
    let activeOutlineItem = null;
    let bestOutlineDistance = Number.POSITIVE_INFINITY;
    let bestOutlineDepth = -1;

    for (const item of outlineListEl.querySelectorAll('.sidebar-item')) {
      item.classList.remove('is-active');

      if (preferredOutlineItem === item && item.dataset.page === pageNumber) {
        activeOutlineItem = item;
        continue;
      }

      if (!preferredOutlineItem && item.dataset.page === pageNumber) {
        const depth = Number(item.style.getPropertyValue('--depth'));
        const outlineTop = Number(item.dataset.outlineTop ?? '0');
        const distance = Math.abs(outlineTop - currentPageProgress);
        if (
          distance < bestOutlineDistance - 0.0001 ||
          (Math.abs(distance - bestOutlineDistance) <= 0.0001 &&
            depth >= bestOutlineDepth)
        ) {
          bestOutlineDistance = distance;
          bestOutlineDepth = depth;
          activeOutlineItem = item;
        }
      }
    }

    if (activeOutlineItem) {
      activeOutlineItem.classList.add('is-active');
    }

    const activeItem =
      state.sidebarTab === 'outline' ? activeOutlineItem : activePageItem;
    if (options.reveal && activeItem) {
      ensureSidebarItemVisible(
        state.sidebarTab === 'outline' ? outlinePanelEl : pagesPanelEl,
        activeItem
      );
    }
  }

  function renderSidebar(options = {}) {
    pageListEl.replaceChildren();

    for (const pageEntry of state.pageEntries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sidebar-item page-nav-item';
      button.dataset.page = String(pageEntry.pageNumber);
      const thumbnail = pageEntry.thumbnailDataUrl
        ? `<img class="page-nav-thumb" src="${pageEntry.thumbnailDataUrl}" alt="Page ${pageEntry.pageNumber} preview" />`
        : `<span class="page-nav-thumb" style="aspect-ratio:${pageEntry.width}/${pageEntry.height}" aria-hidden="true"></span>`;
      button.innerHTML = `
        ${thumbnail}
        <span class="page-nav-copy">
          <span class="sidebar-item-title">Page ${pageEntry.pageNumber}</span>
        </span>
      `;
      button.addEventListener('click', () => {
        jumpToPage(pageEntry.pageNumber);
      });
      pageListEl.append(button);
    }

    outlineListEl.replaceChildren();
    outlineTabEl.hidden = state.outline.length === 0;
    outlineTabEl.textContent = state.outline.length
      ? `Bookmarks (${countOutlineItems(state.outline)})`
      : 'Bookmarks';
    if (!state.outline.length && state.sidebarTab === 'outline') {
      state.sidebarTab = 'pages';
    } else if (
      state.outline.length &&
      state.sidebarTab !== 'outline' &&
      !state.sidebarOpen
    ) {
      state.sidebarTab = 'outline';
    }

    function appendOutlineItems(items, path = []) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const itemPath = path.concat(index);
        const itemKey = getOutlineKey(item, itemPath);
        const isCollapsed = Boolean(state.collapsedOutline[itemKey]);
        const hasChildren = Boolean(item.items?.length);
        const entry = document.createElement(
          item.pageNumber ? 'button' : 'div'
        );
        entry.className = 'sidebar-item outline-item';
        entry.style.setProperty('--depth', String(item.depth ?? path.length));
        entry.dataset.outlineKey = itemKey;
        if (item.pageNumber) {
          entry.dataset.page = String(item.pageNumber);
          entry.dataset.outlineTop = String(item.topRatio ?? '0');
        }
        entry.innerHTML = `
          <span class="outline-chevron">${hasChildren ? (isCollapsed ? icons.chevronRight : icons.chevronDown) : ''}</span>
          <span class="sidebar-item-title">${escapeHtml(item.title)}</span>
          <span class="sidebar-item-meta">${item.pageNumber ? `p. ${item.pageNumber}` : 'Label only'}</span>
        `;

        if (item.pageNumber) {
          entry.type = 'button';
          entry.addEventListener('click', () => {
            jumpToPage(item.pageNumber, itemKey, item.topRatio ?? null);
          });
        } else {
          entry.classList.add('is-static');
        }

        if (hasChildren) {
          entry.classList.add('has-children');
          const chevron = entry.querySelector('.outline-chevron');
          if (chevron) {
            chevron.addEventListener('click', (event) => {
              event.preventDefault();
              event.stopPropagation();
              state.collapsedOutline[itemKey] = !isCollapsed;
              renderSidebar();
            });
          }
        }

        outlineListEl.append(entry);

        if (hasChildren && !isCollapsed) {
          appendOutlineItems(item.items, itemPath);
        }
      }
    }

    appendOutlineItems(state.outline);
    updateSidebarTabUI();
    updateSidebarActiveState(options);
  }

  function setSidebarTab(nextTab) {
    state.sidebarTab = nextTab;
    updateSidebarTabUI();
    updateSidebarActiveState({ reveal: true });
  }

  function setSidebarOpen(nextOpen) {
    state.sidebarOpen = nextOpen;
    contentShellEl.classList.toggle('is-sidebar-collapsed', !nextOpen);
    sidebarEl.hidden = !nextOpen;
    sidebarToggleEl.classList.toggle('is-active', nextOpen);
    sidebarToggleEl.setAttribute('aria-pressed', String(nextOpen));
    if (nextOpen) {
      updateSidebarTabUI();
      updateSidebarActiveState({ reveal: true });
    }
  }

  return {
    getOutlineKey,
    expandOutlinePathForPage,
    renderSidebar,
    updateSidebarActiveState,
    setSidebarTab,
    updateSidebarTabUI,
    setSidebarOpen,
  };
}
