import { startRenderRequest } from './renderMetrics.js';

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
          disableWorker: true,
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
  const activeRenderTasks = new Set();

  function cancelRendering() {
    generation += 1;
    for (const task of activeRenderTasks) {
      task.cancel();
    }
    activeRenderTasks.clear();
  }

  function createLayout(zoomConfig, workspaceSize) {
    const TextLayerBuilder = globalThis.pdfjsViewer?.TextLayerBuilder;
    if (!TextLayerBuilder) {
      throw new Error('pdf.js viewer failed to load in the webview.');
    }

    cancelRendering();
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
      const textLayerBuilder = new TextLayerBuilder({});
      const textLayer = textLayerBuilder.div;
      const drawingCanvas = document.createElement('canvas');

      pageShell.className = 'page-shell';
      pdfCanvas.className = 'pdf-canvas';
      highlightLayer.className = 'highlight-layer';
      searchLayer.className = 'search-layer';
      formLayer.className = 'form-layer';
      commentLayer.className = 'comment-layer';
      textLayer.classList.add('text-layer');
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
      textLayer.style.width = `${unscaledViewport.width}px`;
      textLayer.style.height = `${unscaledViewport.height}px`;

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
        thumbnailDataUrl: '',
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
      });
    }

    return {
      pages: entries,
      outline,
      resolvedScale,
      fragment,
    };
  }

  async function ensureTextLayer(pageEntry, pageMetrics = metrics) {
    if (pageEntry.generation !== generation) {
      return false;
    }
    if (pageEntry.textReady) {
      return true;
    }
    if (!pageEntry.textPromise) {
      const entryGeneration = pageEntry.generation;
      pageEntry.textPromise = (async () => {
        const textContentSource = await pageMetrics.measure(
          'page.text',
          () => pageEntry.page.getTextContent(),
          pageEntry.pageNumber
        );
        if (entryGeneration !== generation) {
          return false;
        }
        pageEntry.textLayerBuilder.setTextContentSource(textContentSource);
        await pageMetrics.measure(
          'page.text',
          () => pageEntry.textLayerBuilder.render(pageEntry.viewport),
          pageEntry.pageNumber
        );
        if (entryGeneration !== generation) {
          return false;
        }
        pageEntry.textDivs = pageEntry.textLayerBuilder.textDivs;
        pageEntry.textContentItemsStr =
          pageEntry.textLayerBuilder.textContentItemsStr;
        pageEntry.textReady = true;
        return true;
      })();
    }
    return pageEntry.textPromise;
  }

  async function renderPage(pageEntry, pageMetrics = metrics) {
    if (pageEntry.generation !== generation) {
      return false;
    }
    if (pageEntry.renderState === 'rendered') {
      return true;
    }
    if (pageEntry.renderPromise) {
      return pageEntry.renderPromise;
    }

    const entryGeneration = pageEntry.generation;
    pageEntry.renderState = 'rendering';
    const renderPromise = (async () => {
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
      activeRenderTasks.add(renderTask);
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

      if (
        entryGeneration !== generation ||
        !(await ensureTextLayer(pageEntry, pageMetrics))
      ) {
        return false;
      }
      pageEntry.renderState = 'rendered';
      pageEntry.pageShell.classList.add('is-rendered');
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
    }
  }

  async function ensureTextLayers(pageEntries, pageMetrics = metrics) {
    for (const pageEntry of pageEntries) {
      if (!(await ensureTextLayer(pageEntry, pageMetrics))) {
        return false;
      }
    }
    return true;
  }

  return {
    pageCount: pdf.numPages,
    pageSizes,
    pages,
    outline,
    createLayout,
    renderPage,
    ensureTextLayers,
    cancelRendering,
    async destroy() {
      cancelRendering();
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
