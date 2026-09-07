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

export async function renderPdf(
  base64,
  container,
  zoomConfig,
  workspaceSize,
  outlineBase64 = base64,
  metrics = startRenderRequest()
) {
  const pdfjsLib = globalThis.pdfjsLib;
  const TextLayerBuilder = globalThis.pdfjsViewer?.TextLayerBuilder;
  if (!pdfjsLib?.getDocument || !TextLayerBuilder) {
    throw new Error('pdf.js viewer failed to load in the webview.');
  }

  const pdfData = metrics.measure('decode', () =>
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  );
  const loadingTask = pdfjsLib.getDocument({
    data: pdfData,
    disableWorker: true,
  });
  const pdf = await metrics.measure('getDocument', () => loadingTask.promise);
  let outlinePdf = pdf;
  if (outlineBase64 && outlineBase64 !== base64) {
    const outlinePdfData = Uint8Array.from(atob(outlineBase64), (char) =>
      char.charCodeAt(0)
    );
    const outlineLoadingTask = pdfjsLib.getDocument({
      data: outlinePdfData,
      disableWorker: true,
    });
    outlinePdf = await metrics.measure(
      'getDocument.outline',
      () => outlineLoadingTask.promise
    );
  }
  const firstPage = await pdf.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: 1 });
  const outline = await metrics.measure('buildOutline', () =>
    buildOutline(outlinePdf)
  );
  const resolvedScale = resolveScale(zoomConfig, workspaceSize, {
    width: baseViewport.width,
    height: baseViewport.height,
  });
  const renderOutputScale = resolveRenderOutputScale({
    pageCount: pdf.numPages,
    pageWidth: baseViewport.width,
    pageHeight: baseViewport.height,
    zoomScale: resolvedScale,
    devicePixelRatio: globalThis.devicePixelRatio || 1,
  });
  const thumbnailWidth = pdf.numPages > 80 ? 64 : pdf.numPages > 40 ? 76 : 92;
  const pages = [];
  const fragment = document.createDocumentFragment();

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: resolvedScale });
    const unscaledViewport = page.getViewport({ scale: 1 });
    const outputScale = renderOutputScale;
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

    pdfCanvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    pdfCanvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    drawingCanvas.width = viewport.width;
    drawingCanvas.height = viewport.height;
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

    const pdfContext = pdfCanvas.getContext('2d');
    await metrics.measure(
      'page.render',
      () =>
        page.render({
          canvasContext: pdfContext,
          viewport,
          transform:
            outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
        }).promise,
      pageNumber
    );

    const thumbnailCanvas = document.createElement('canvas');
    const thumbnailScale = thumbnailWidth / Math.max(viewport.width, 1);
    thumbnailCanvas.width = Math.max(
      1,
      Math.round(viewport.width * thumbnailScale)
    );
    thumbnailCanvas.height = Math.max(
      1,
      Math.round(viewport.height * thumbnailScale)
    );
    metrics.measure(
      'page.thumbnail',
      () =>
        thumbnailCanvas
          .getContext('2d')
          .drawImage(
            pdfCanvas,
            0,
            0,
            thumbnailCanvas.width,
            thumbnailCanvas.height
          ),
      pageNumber
    );

    const textContentSource = await metrics.measure(
      'page.text',
      () => page.getTextContent(),
      pageNumber
    );
    textLayerBuilder.setTextContentSource(textContentSource);
    await metrics.measure(
      'page.text',
      () => textLayerBuilder.render(viewport),
      pageNumber
    );

    const thumbnailDataUrl = metrics.measure(
      'page.thumbnail',
      () => thumbnailCanvas.toDataURL('image/png'),
      pageNumber
    );

    pages.push({
      pageNumber,
      pageShell,
      pdfCanvas,
      highlightLayer,
      searchLayer,
      formLayer,
      commentLayer,
      textLayer,
      textDivs: textLayerBuilder.textDivs,
      textContentItemsStr: textLayerBuilder.textContentItemsStr,
      drawingCanvas,
      thumbnailDataUrl,
      width: viewport.width,
      height: viewport.height,
      pdfWidth: unscaledViewport.width,
      pdfHeight: unscaledViewport.height,
    });
  }

  return {
    pages,
    outline,
    resolvedScale,
    fragment,
    metrics,
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
