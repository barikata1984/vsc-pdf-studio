import { startRenderRequest } from './renderMetrics.js';
import { buildTextIndex } from './textIndex.js';

export function getBufferedPageNumbers(
  visiblePageNumbers,
  pageCount,
  bufferPages = 1
) {
  const pages = new Set();
  for (const pageNumber of visiblePageNumbers) {
    for (
      let candidate = pageNumber - bufferPages;
      candidate <= pageNumber + bufferPages;
      candidate += 1
    ) {
      if (candidate >= 1 && candidate <= pageCount) {
        pages.add(candidate);
      }
    }
  }
  return [...pages].sort((left, right) => left - right);
}

export function getPrioritizedPageNumbers(
  visiblePageNumbers,
  pageCount,
  direction,
  bufferPages = 1
) {
  const pages = getBufferedPageNumbers(
    visiblePageNumbers,
    pageCount,
    bufferPages
  );
  return pages.sort((left, right) => {
    const leftDistance = Math.min(
      ...visiblePageNumbers.map((pageNumber) => Math.abs(left - pageNumber))
    );
    const rightDistance = Math.min(
      ...visiblePageNumbers.map((pageNumber) => Math.abs(right - pageNumber))
    );
    return (
      leftDistance - rightDistance ||
      (direction < 0 ? left - right : right - left)
    );
  });
}

export async function createPdfRenderSession(
  base64,
  outlineBase64 = base64,
  metrics = startRenderRequest()
) {
  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib?.getDocument) {
    throw new Error('pdf.js failed to load in the webview.');
  }

  const loadDocument = async (source, stage) => {
    const data = metrics.measure(
      stage === 'getDocument' ? 'decode' : 'decode.outline',
      () => Uint8Array.from(atob(source), (char) => char.charCodeAt(0))
    );
    return metrics.measure(
      stage,
      () =>
        pdfjsLib.getDocument({
          data,
        }).promise
    );
  };

  const pdf = await loadDocument(base64, 'getDocument');
  const outlinePdf =
    outlineBase64 && outlineBase64 !== base64
      ? await loadDocument(outlineBase64, 'getDocument.outline')
      : pdf;
  const pages = [];
  const pageSizes = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    pages.push(page);
    pageSizes.push({ width: viewport.width, height: viewport.height });
  }
  const outline = await metrics.measure('buildOutline', () =>
    buildOutline(outlinePdf)
  );
  let generation = 0;
  const activeRenderTasks = new Map();
  const activeTextLayers = new Map();
  const activeThumbnailTasks = new Set();
  const renderingPageEntries = new Set();
  const renderedPageEntries = new Set();
  const thumbnailDataUrls = new Map();
  const thumbnailPromises = new Map();
  const textContents = new Map();
  const textContentPromises = new Map();
  let textIndexPromise = null;
  const foregroundRenderWaiters = [];
  const backgroundRenderWaiters = [];
  let activeRenderCount = 0;
  let renderRequestId = 0;
  let requestedPageNumbers = new Set();
  let destroyed = false;

  async function withRenderSlot(run, background = false) {
    if (activeRenderCount < 2) {
      activeRenderCount += 1;
    } else {
      await new Promise((resolve) =>
        (background ? backgroundRenderWaiters : foregroundRenderWaiters).push(
          resolve
        )
      );
    }
    try {
      return await run();
    } finally {
      const next =
        foregroundRenderWaiters.shift() ?? backgroundRenderWaiters.shift();
      if (next) {
        next();
      } else {
        activeRenderCount -= 1;
      }
    }
  }

  function cancelRendering() {
    generation += 1;
    for (const task of activeRenderTasks.keys()) {
      task.cancel();
    }
    activeRenderTasks.clear();
    for (const textLayerBuilder of activeTextLayers.keys()) {
      textLayerBuilder.cancel();
    }
    activeTextLayers.clear();
  }

  function prioritizePages(pageNumbers) {
    renderRequestId += 1;
    requestedPageNumbers = new Set(pageNumbers);
    for (const [task, pageEntry] of activeRenderTasks) {
      if (!requestedPageNumbers.has(pageEntry.pageNumber)) {
        task.cancel();
      }
    }
    for (const [textLayerBuilder, pageEntry] of activeTextLayers) {
      if (!requestedPageNumbers.has(pageEntry.pageNumber)) {
        textLayerBuilder.cancel();
      }
    }
    return renderRequestId;
  }

  function isPageRenderCurrent(pageEntry, entryGeneration) {
    return (
      !destroyed &&
      entryGeneration === generation &&
      (pageEntry.renderRequestId === null ||
        (pageEntry.renderRequestId === renderRequestId &&
          requestedPageNumbers.has(pageEntry.pageNumber)))
    );
  }

  function createTextLayer(pdfWidth, pdfHeight) {
    const textLayerBuilder = new globalThis.pdfjsViewer.TextLayerBuilder({});
    const textLayer = textLayerBuilder.div;
    textLayer.classList.add('text-layer');
    textLayer.style.width = `${pdfWidth}px`;
    textLayer.style.height = `${pdfHeight}px`;
    return { textLayerBuilder, textLayer };
  }

  function cleanupPageWhenUnused(pageEntry) {
    if (
      requestedPageNumbers.has(pageEntry.pageNumber) ||
      [...renderingPageEntries, ...renderedPageEntries].some(
        (entry) => entry.pageNumber === pageEntry.pageNumber
      )
    ) {
      return;
    }
    pageEntry.page.cleanup();
  }

  function releasePageResources(pageEntry) {
    renderedPageEntries.delete(pageEntry);
    pageEntry.releaseWhenIdle = false;
    pageEntry.renderState = 'idle';
    pageEntry.renderPromise = null;
    pageEntry.renderTask = null;
    pageEntry.pdfCanvas.width = 1;
    pageEntry.pdfCanvas.height = 1;
    pageEntry.drawingCanvas.width = 1;
    pageEntry.drawingCanvas.height = 1;
    pageEntry.pageShell.classList.remove('is-rendered');
    pageEntry.textLayerBuilder.cancel();
    const { pointerEvents, userSelect } = pageEntry.textLayer.style;
    const { textLayerBuilder, textLayer } = createTextLayer(
      pageEntry.pdfWidth,
      pageEntry.pdfHeight
    );
    textLayer.style.pointerEvents = pointerEvents;
    textLayer.style.userSelect = userSelect;
    pageEntry.textLayer.replaceWith(textLayer);
    pageEntry.textLayerBuilder = textLayerBuilder;
    pageEntry.textLayer = textLayer;
    pageEntry.textDivs = [];
    pageEntry.textContentItemsStr = [];
    pageEntry.textReady = false;
    pageEntry.textPromise = null;
    pageEntry.searchLayer.replaceChildren();
    pageEntry.page.cleanup();
  }

  function releasePagesExcept(pageNumbers) {
    const retainedPageNumbers = new Set(pageNumbers);
    for (const pageEntry of renderingPageEntries) {
      if (!retainedPageNumbers.has(pageEntry.pageNumber)) {
        pageEntry.releaseWhenIdle = true;
      }
    }
    for (const pageEntry of [...renderedPageEntries]) {
      if (!retainedPageNumbers.has(pageEntry.pageNumber)) {
        releasePageResources(pageEntry);
      }
    }
  }

  function createLayout(zoomConfig, workspaceSize) {
    if (!globalThis.pdfjsViewer?.TextLayerBuilder) {
      throw new Error('pdf.js viewer failed to load in the webview.');
    }

    cancelRendering();
    releasePagesExcept([]);
    const layoutGeneration = generation;
    const basePageSize = pageSizes[0];
    const resolvedScale = resolveScale(zoomConfig, workspaceSize, basePageSize);
    const outputScale = resolveRenderOutputScale({
      pageCount: pdf.numPages,
      pageWidth: basePageSize.width,
      pageHeight: basePageSize.height,
      zoomScale: resolvedScale,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    });
    const entries = [];
    const fragment = document.createDocumentFragment();

    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      const pageNumber = index + 1;
      const unscaledViewport = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: resolvedScale });
      const pageShell = document.createElement('div');
      const pdfCanvas = document.createElement('canvas');
      const highlightLayer = document.createElement('div');
      const searchLayer = document.createElement('div');
      const formLayer = document.createElement('div');
      const commentLayer = document.createElement('div');
      const { textLayerBuilder, textLayer } = createTextLayer(
        unscaledViewport.width,
        unscaledViewport.height
      );
      const drawingCanvas = document.createElement('canvas');

      pageShell.className = 'page-shell';
      pdfCanvas.className = 'pdf-canvas';
      highlightLayer.className = 'highlight-layer';
      searchLayer.className = 'search-layer';
      formLayer.className = 'form-layer';
      commentLayer.className = 'comment-layer';
      drawingCanvas.className = 'drawing-canvas';

      pageShell.style.setProperty('--scale-factor', String(viewport.scale));
      pageShell.style.width = `${viewport.width}px`;
      pageShell.style.height = `${viewport.height}px`;
      pdfCanvas.width = 1;
      pdfCanvas.height = 1;
      drawingCanvas.width = 1;
      drawingCanvas.height = 1;
      pdfCanvas.style.width = `${viewport.width}px`;
      pdfCanvas.style.height = `${viewport.height}px`;
      drawingCanvas.style.width = `${viewport.width}px`;
      drawingCanvas.style.height = `${viewport.height}px`;

      pageShell.append(
        pdfCanvas,
        highlightLayer,
        searchLayer,
        textLayer,
        formLayer,
        commentLayer,
        drawingCanvas
      );
      fragment.append(pageShell);
      entries.push({
        pageNumber,
        page,
        pageShell,
        pdfCanvas,
        highlightLayer,
        searchLayer,
        formLayer,
        commentLayer,
        textLayer,
        textLayerBuilder,
        textDivs: [],
        textContentItemsStr: [],
        drawingCanvas,
        thumbnailDataUrl: thumbnailDataUrls.get(pageNumber) ?? '',
        width: viewport.width,
        height: viewport.height,
        pdfWidth: unscaledViewport.width,
        pdfHeight: unscaledViewport.height,
        viewport,
        outputScale,
        generation: layoutGeneration,
        renderState: 'idle',
        renderPromise: null,
        renderTask: null,
        renderRequestId: null,
        releaseWhenIdle: false,
      });
    }

    return {
      pages: entries,
      outline,
      resolvedScale,
      fragment,
    };
  }

  async function getTextContent(pageEntry, pageMetrics) {
    const { pageNumber } = pageEntry;
    if (textContents.has(pageNumber)) {
      return textContents.get(pageNumber);
    }
    if (!textContentPromises.has(pageNumber)) {
      textContentPromises.set(
        pageNumber,
        pageMetrics.measure(
          'page.text',
          () => pageEntry.page.getTextContent(),
          pageNumber
        )
      );
    }
    try {
      const textContent = await textContentPromises.get(pageNumber);
      textContents.set(pageNumber, textContent);
      return textContent;
    } finally {
      textContentPromises.delete(pageNumber);
      cleanupPageWhenUnused(pageEntry);
    }
  }

  async function ensureTextLayer(pageEntry, pageMetrics = metrics) {
    const entryGeneration = pageEntry.generation;
    if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
      return false;
    }
    if (pageEntry.textReady) {
      return true;
    }
    if (!pageEntry.textPromise) {
      const textPromise = (async () => {
        const textContentSource = await getTextContent(pageEntry, pageMetrics);
        if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
          return false;
        }
        pageEntry.textLayerBuilder.setTextContentSource(textContentSource);
        activeTextLayers.set(pageEntry.textLayerBuilder, pageEntry);
        try {
          await pageMetrics.measure(
            'page.text',
            () => pageEntry.textLayerBuilder.render(pageEntry.viewport),
            pageEntry.pageNumber
          );
        } catch (error) {
          if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
            return false;
          }
          throw error;
        } finally {
          activeTextLayers.delete(pageEntry.textLayerBuilder);
        }
        if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
          return false;
        }
        pageEntry.textDivs = pageEntry.textLayerBuilder.textDivs;
        pageEntry.textContentItemsStr =
          pageEntry.textLayerBuilder.textContentItemsStr;
        pageEntry.textReady = true;
        return true;
      })();
      pageEntry.textPromise = textPromise;
      try {
        return await textPromise;
      } finally {
        if (pageEntry.textPromise === textPromise && !pageEntry.textReady) {
          pageEntry.textPromise = null;
        }
      }
    }
    return pageEntry.textPromise;
  }

  async function renderPage(
    pageEntry,
    pageMetrics = metrics,
    pageRenderRequestId = null
  ) {
    if (pageEntry.generation !== generation) {
      return false;
    }
    pageEntry.renderRequestId = pageRenderRequestId;
    pageEntry.releaseWhenIdle = false;
    if (pageEntry.renderState === 'rendered') {
      return true;
    }
    if (pageEntry.renderPromise) {
      const pendingRender = pageEntry.renderPromise;
      const completed = await pendingRender;
      if (
        completed ||
        pageEntry.generation !== generation ||
        pageEntry.renderRequestId !== pageRenderRequestId
      ) {
        return completed;
      }
      if (pageEntry.renderPromise === pendingRender) {
        pageEntry.renderPromise = null;
        pageEntry.renderState = 'idle';
      }
      return renderPage(pageEntry, pageMetrics, pageRenderRequestId);
    }

    const entryGeneration = pageEntry.generation;
    pageEntry.renderState = 'rendering';
    renderingPageEntries.add(pageEntry);
    const renderPromise = (async () => {
      const rendered = await withRenderSlot(async () => {
        if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
          return false;
        }
        pageEntry.pdfCanvas.width = Math.max(
          1,
          Math.floor(pageEntry.width * pageEntry.outputScale)
        );
        pageEntry.pdfCanvas.height = Math.max(
          1,
          Math.floor(pageEntry.height * pageEntry.outputScale)
        );
        const renderTask = pageEntry.page.render({
          canvasContext: pageEntry.pdfCanvas.getContext('2d'),
          viewport: pageEntry.viewport,
          transform:
            pageEntry.outputScale === 1
              ? null
              : [pageEntry.outputScale, 0, 0, pageEntry.outputScale, 0, 0],
        });
        pageEntry.renderTask = renderTask;
        activeRenderTasks.set(renderTask, pageEntry);
        try {
          await pageMetrics.measure(
            'page.render',
            () => renderTask.promise,
            pageEntry.pageNumber
          );
        } catch (error) {
          if (
            entryGeneration !== generation ||
            error?.name === 'RenderingCancelledException'
          ) {
            return false;
          }
          throw error;
        } finally {
          activeRenderTasks.delete(renderTask);
          if (pageEntry.renderTask === renderTask) {
            pageEntry.renderTask = null;
          }
        }
        return entryGeneration === generation;
      });

      if (!rendered) {
        return false;
      }

      if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
        return false;
      }
      if (!(await ensureTextLayer(pageEntry, pageMetrics))) {
        return false;
      }
      if (!isPageRenderCurrent(pageEntry, entryGeneration)) {
        return false;
      }
      pageEntry.renderState = 'rendered';
      pageEntry.pageShell.classList.add('is-rendered');
      renderedPageEntries.add(pageEntry);
      return true;
    })();
    pageEntry.renderPromise = renderPromise;
    try {
      return await renderPromise;
    } finally {
      if (
        pageEntry.renderPromise === renderPromise &&
        pageEntry.renderState !== 'rendered'
      ) {
        pageEntry.renderState = 'idle';
        pageEntry.renderPromise = null;
      }
      renderingPageEntries.delete(pageEntry);
      if (pageEntry.releaseWhenIdle) {
        releasePageResources(pageEntry);
      }
    }
  }

  async function prepareTextIndex(pageEntries, pageMetrics = metrics) {
    if (!textIndexPromise) {
      textIndexPromise = (async () => {
        const indexedPages = [];
        for (const pageEntry of pageEntries) {
          indexedPages.push({
            pageNumber: pageEntry.pageNumber,
            textContent: await getTextContent(pageEntry, pageMetrics),
          });
        }
        return buildTextIndex(indexedPages);
      })();
    }

    const index = await textIndexPromise;
    for (const pageEntry of pageEntries) {
      if (pageEntry.generation !== generation) {
        continue;
      }
      pageEntry.textContentItemsStr = (
        textContents.get(pageEntry.pageNumber)?.items ?? []
      ).map((item) => (typeof item?.str === 'string' ? item.str : ''));
    }
    return index;
  }

  async function renderThumbnail(
    pageNumber,
    width = 92,
    pageMetrics = metrics
  ) {
    if (thumbnailDataUrls.has(pageNumber)) {
      return thumbnailDataUrls.get(pageNumber);
    }
    if (thumbnailPromises.has(pageNumber)) {
      return thumbnailPromises.get(pageNumber);
    }

    const page = pages[pageNumber - 1];
    const pageSize = pageSizes[pageNumber - 1];
    if (!page || !pageSize) {
      throw new RangeError(`Unknown PDF page ${pageNumber}.`);
    }

    const promise = withRenderSlot(async () => {
      if (destroyed) {
        return '';
      }
      const viewport = page.getViewport({ scale: width / pageSize.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const renderTask = page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
      });
      activeThumbnailTasks.add(renderTask);
      try {
        await pageMetrics.measure(
          'page.thumbnail',
          () => renderTask.promise,
          pageNumber
        );
      } catch (error) {
        if (error?.name === 'RenderingCancelledException') {
          return '';
        }
        throw error;
      } finally {
        activeThumbnailTasks.delete(renderTask);
        cleanupPageWhenUnused({ pageNumber, page });
      }
      const dataUrl = pageMetrics.measure(
        'page.thumbnail',
        () => canvas.toDataURL('image/png'),
        pageNumber
      );
      thumbnailDataUrls.set(pageNumber, dataUrl);
      return dataUrl;
    }, true);
    thumbnailPromises.set(pageNumber, promise);
    try {
      return await promise;
    } finally {
      thumbnailPromises.delete(pageNumber);
    }
  }

  return {
    pageCount: pdf.numPages,
    pageSizes,
    pages,
    outline,
    createLayout,
    resolveScale: (zoomConfig, workspaceSize) =>
      resolveScale(zoomConfig, workspaceSize, pageSizes[0]),
    renderPage,
    prioritizePages,
    releasePagesExcept,
    renderThumbnail,
    prepareTextIndex,
    cancelRendering,
    async destroy() {
      destroyed = true;
      cancelRendering();
      releasePagesExcept([]);
      for (const task of activeThumbnailTasks) {
        task.cancel();
      }
      activeThumbnailTasks.clear();
      await pdf.destroy();
      if (outlinePdf !== pdf) {
        await outlinePdf.destroy();
      }
    },
  };
}

function resolveRenderOutputScale({
  pageCount,
  pageWidth,
  pageHeight,
  zoomScale,
  devicePixelRatio,
}) {
  const pagePixelArea = Math.max(
    1,
    pageWidth * pageHeight * zoomScale * zoomScale
  );
  const maxTotalPixels = 90_000_000;
  const safeScale = Math.sqrt(
    maxTotalPixels / Math.max(pageCount * pagePixelArea, 1)
  );
  return Math.max(0.6, Math.min(devicePixelRatio, safeScale));
}

async function buildOutline(pdf) {
  const rawOutline = (await pdf.getOutline()) ?? [];
  const pageIndexCache = new Map();
  const destinationCache = new Map();
  const pageViewportCache = new Map();
  let generatedId = 0;

  async function getPageViewport(pageNumber) {
    if (!pageViewportCache.has(pageNumber)) {
      const page = await pdf.getPage(pageNumber);
      pageViewportCache.set(pageNumber, page.getViewport({ scale: 1 }));
    }
    return pageViewportCache.get(pageNumber);
  }

  async function resolveDestination(destination) {
    if (!destination) {
      return null;
    }

    let explicitDestination = destination;
    if (typeof destination === 'string') {
      if (destinationCache.has(destination)) {
        explicitDestination = destinationCache.get(destination);
      } else {
        explicitDestination = await pdf.getDestination(destination);
        destinationCache.set(destination, explicitDestination ?? null);
      }
    }

    if (!Array.isArray(explicitDestination) || !explicitDestination.length) {
      return null;
    }

    const destinationRef = explicitDestination[0];
    if (Number.isInteger(destinationRef) && destinationRef >= 0) {
      return {
        pageNumber: destinationRef + 1,
        explicitDestination,
      };
    }

    if (
      !destinationRef ||
      typeof destinationRef !== 'object' ||
      !('num' in destinationRef) ||
      !('gen' in destinationRef)
    ) {
      return null;
    }

    const cacheKey = `${destinationRef.num}:${destinationRef.gen}`;
    if (pageIndexCache.has(cacheKey)) {
      return {
        pageNumber: pageIndexCache.get(cacheKey),
        explicitDestination,
      };
    }

    try {
      const pageIndex = await pdf.getPageIndex(destinationRef);
      const pageNumber = pageIndex + 1;
      pageIndexCache.set(cacheKey, pageNumber);
      return {
        pageNumber,
        explicitDestination,
      };
    } catch {
      return null;
    }
  }

  async function resolveOutlineTopRatio(destinationInfo) {
    if (!destinationInfo?.explicitDestination || !destinationInfo.pageNumber) {
      return 0;
    }

    const [, destinationType, ...args] = destinationInfo.explicitDestination;
    const viewport = await getPageViewport(destinationInfo.pageNumber);
    const destinationName = destinationType?.name;
    let x = 0;
    let y = viewport.height;

    switch (destinationName) {
      case 'XYZ':
        y = args[1] ?? viewport.height;
        break;
      case 'FitH':
      case 'FitBH':
        y = typeof args[0] === 'number' ? args[0] : viewport.height;
        break;
      case 'FitR':
        y = typeof args[1] === 'number' ? args[1] : viewport.height;
        break;
      case 'Fit':
      case 'FitB':
      default:
        return 0;
    }

    const [, top] = viewport.convertToViewportPoint(x, y);
    return Math.max(0, Math.min(1, top / Math.max(viewport.height, 1)));
  }

  async function mapItems(items, depth = 0) {
    const results = [];

    for (const item of items) {
      const destinationInfo = await resolveDestination(item.dest);
      const ownPageNumber = destinationInfo?.pageNumber ?? null;
      const ownTopRatio = ownPageNumber
        ? await resolveOutlineTopRatio(destinationInfo)
        : 0;
      const children = item.items?.length
        ? await mapItems(item.items, depth + 1)
        : [];
      const fallbackPageNumber =
        children.find((child) => child.pageNumber)?.pageNumber ?? null;
      const fallbackTopRatio =
        children.find((child) => child.pageNumber)?.topRatio ?? 0;
      const pageNumber = ownPageNumber ?? fallbackPageNumber;
      const topRatio = ownPageNumber ? ownTopRatio : fallbackTopRatio;

      const title = item.title?.trim() || `Bookmark ${results.length + 1}`;
      results.push({
        id: `bookmark-${(generatedId += 1)}`,
        title,
        pageNumber,
        topRatio,
        depth,
        isExternal: true,
        actionable: Boolean(pageNumber),
        items: children,
      });
    }

    return results;
  }

  return mapItems(rawOutline);
}

function resolveScale(zoomConfig, workspaceSize, basePageSize) {
  const columnCount = zoomConfig.layout === 'double' ? 2 : 1;
  const interPageGap = columnCount > 1 ? 24 : 0;
  const availableWidth = Math.max(240, workspaceSize.width - 24);
  const columnWidth = Math.max(
    120,
    (availableWidth - interPageGap) / columnCount
  );

  switch (zoomConfig.mode) {
    case 'page-width': {
      return Math.max(0.5, columnWidth / Math.max(basePageSize.width, 1));
    }
    case 'page-fit':
    case 'automatic': {
      const fitWidth = columnWidth / Math.max(basePageSize.width, 1);
      const fitHeight =
        (workspaceSize.height - 24) / Math.max(basePageSize.height, 1);
      return Math.max(0.5, Math.min(fitWidth, fitHeight));
    }
    case 'actual-size': {
      return 1;
    }
    case 'custom':
    default: {
      return zoomConfig.scale;
    }
  }
}
