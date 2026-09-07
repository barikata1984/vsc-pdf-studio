function pointInsideRect(point, rect, scaleX, scaleY) {
  const left = rect.x * scaleX;
  const top = rect.y * scaleY;
  const right = left + rect.width * scaleX;
  const bottom = top + rect.height * scaleY;
  return (
    point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
  );
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) /
        (dx * dx + dy * dy)
    )
  );
  const projectionX = start.x + t * dx;
  const projectionY = start.y + t * dy;
  return Math.hypot(point.x - projectionX, point.y - projectionY);
}

function drawStroke(context, canvas, stroke) {
  if (!stroke.points.length) {
    return;
  }

  context.strokeStyle = stroke.color;
  const scaleX =
    canvas.width / Math.max(stroke.viewportWidth || canvas.width, 1);
  const scaleY =
    canvas.height / Math.max(stroke.viewportHeight || canvas.height, 1);
  context.lineWidth = stroke.width * ((scaleX + scaleY) / 2);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.beginPath();
  context.moveTo(stroke.points[0].x * scaleX, stroke.points[0].y * scaleY);

  for (const point of stroke.points.slice(1)) {
    context.lineTo(point.x * scaleX, point.y * scaleY);
  }

  context.stroke();
}

function isStylusEraseEvent(event) {
  if (event.pointerType !== 'pen') {
    return false;
  }

  return (
    event.button === 5 ||
    (event.buttons & 32) === 32 ||
    event.button === 2 ||
    (event.buttons & 2) === 2
  );
}

function isTouchInputAllowed(event, options) {
  return (
    event.pointerType !== 'touch' || options.getAllowFingerDrawing?.() === true
  );
}

export function createDrawingLayer(pageEntries, options) {
  const state = {
    strokes: [],
    currentStroke: null,
    activePointerId: null,
    touchPan: null,
  };

  function redrawPage(pageEntry) {
    const context = pageEntry.drawingCanvas.getContext('2d');
    context.clearRect(
      0,
      0,
      pageEntry.drawingCanvas.width,
      pageEntry.drawingCanvas.height
    );

    for (const stroke of state.strokes) {
      if (stroke.page === pageEntry.pageNumber) {
        drawStroke(context, pageEntry.drawingCanvas, stroke);
      }
    }

    if (state.currentStroke?.page === pageEntry.pageNumber) {
      drawStroke(context, pageEntry.drawingCanvas, state.currentStroke);
    }
  }

  function redrawAll() {
    for (const pageEntry of pageEntries) {
      redrawPage(pageEntry);
    }
  }

  function ensurePageCanvas(pageEntry) {
    const width = Math.max(1, Math.floor(pageEntry.width));
    const height = Math.max(1, Math.floor(pageEntry.height));
    if (
      pageEntry.drawingCanvas.width === width &&
      pageEntry.drawingCanvas.height === height
    ) {
      return;
    }
    pageEntry.drawingCanvas.width = width;
    pageEntry.drawingCanvas.height = height;
    redrawPage(pageEntry);
  }

  function toPoint(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function finalizeStroke(event) {
    if (
      event &&
      state.activePointerId !== null &&
      event.pointerId !== state.activePointerId
    ) {
      return;
    }

    if (!state.currentStroke) {
      state.activePointerId = null;
      return;
    }

    if (state.currentStroke.points.length > 1) {
      state.strokes.push(state.currentStroke);
      options.onChange(
        structuredClone(state.strokes),
        structuredClone(state.currentStroke)
      );
    }

    state.currentStroke = null;
    state.activePointerId = null;
    redrawAll();
  }

  function eraseAtPoint(pageEntry, point) {
    const targetStroke = findStrokeNearPoint(pageEntry.pageNumber, point);
    if (targetStroke) {
      state.strokes = state.strokes.filter(
        (stroke) => stroke.id !== targetStroke.id
      );
      options.onErase?.(
        structuredClone(targetStroke),
        structuredClone(state.strokes)
      );
      redrawAll();
      return true;
    }

    const targetHighlight = findHighlightAtPoint(pageEntry.pageNumber, point);
    if (targetHighlight) {
      const remainingHighlights = (options.getHighlights?.() ?? []).filter(
        (highlight) => highlight.id !== targetHighlight.id
      );
      options.onEraseHighlight?.(
        structuredClone(targetHighlight),
        structuredClone(remainingHighlights)
      );
      return true;
    }

    return false;
  }

  function findStrokeNearPoint(pageNumber, point) {
    let bestStroke = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const stroke of state.strokes) {
      if (stroke.page !== pageNumber) {
        continue;
      }

      const scaleX =
        point.viewportWidth /
        Math.max(stroke.viewportWidth || point.viewportWidth, 1);
      const scaleY =
        point.viewportHeight /
        Math.max(stroke.viewportHeight || point.viewportHeight, 1);
      const threshold = Math.max(
        stroke.width * ((scaleX + scaleY) / 2) * 1.5,
        14
      );

      for (let index = 0; index < stroke.points.length; index += 1) {
        const candidate = stroke.points[index];
        const currentPoint = {
          x: candidate.x * scaleX,
          y: candidate.y * scaleY,
        };
        const previous = stroke.points[index - 1];
        const distance = previous
          ? distanceToSegment(
              point,
              {
                x: previous.x * scaleX,
                y: previous.y * scaleY,
              },
              currentPoint
            )
          : Math.hypot(currentPoint.x - point.x, currentPoint.y - point.y);

        if (distance <= threshold && distance < bestDistance) {
          bestStroke = stroke;
          bestDistance = distance;
        }
      }
    }

    return bestStroke;
  }

  function findHighlightAtPoint(pageNumber, point) {
    for (const highlight of options.getHighlights?.() ?? []) {
      if (highlight.page !== pageNumber) {
        continue;
      }

      const scaleX =
        point.viewportWidth /
        Math.max(highlight.viewportWidth || point.viewportWidth, 1);
      const scaleY =
        point.viewportHeight /
        Math.max(highlight.viewportHeight || point.viewportHeight, 1);

      for (const rect of highlight.rects) {
        if (pointInsideRect(point, rect, scaleX, scaleY)) {
          return highlight;
        }
      }
    }

    return null;
  }

  for (const pageEntry of pageEntries) {
    const canvas = pageEntry.drawingCanvas;

    pageEntry.pageShell.addEventListener(
      'pointerdown',
      (event) => {
        if (!isStylusEraseEvent(event)) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        ensurePageCanvas(pageEntry);
        const point = {
          ...toPoint(canvas, event),
          viewportWidth: canvas.width,
          viewportHeight: canvas.height,
        };
        eraseAtPoint(pageEntry, point);
      },
      true
    );

    canvas.addEventListener('pointerdown', (event) => {
      const mode = isStylusEraseEvent(event) ? 'erase' : options.getMode();
      if (mode === 'select') {
        return;
      }

      ensurePageCanvas(pageEntry);
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      if (!isTouchInputAllowed(event, options)) {
        state.touchPan = {
          pointerId: event.pointerId,
          clientX: event.clientX,
          clientY: event.clientY,
        };
        return;
      }

      if (mode === 'erase') {
        const point = {
          ...toPoint(canvas, event),
          viewportWidth: canvas.width,
          viewportHeight: canvas.height,
        };
        eraseAtPoint(pageEntry, point);
        return;
      }

      state.currentStroke = {
        id: crypto.randomUUID(),
        page: pageEntry.pageNumber,
        color: options.getColor(),
        width: options.getWidth(),
        viewportWidth: canvas.width,
        viewportHeight: canvas.height,
        points: [toPoint(canvas, event)],
      };
      state.activePointerId = event.pointerId;
      redrawPage(pageEntry);
    });

    canvas.addEventListener('pointermove', (event) => {
      if (state.touchPan?.pointerId === event.pointerId) {
        event.preventDefault();
        const scrollContainer = options.getScrollContainer?.();
        if (scrollContainer) {
          scrollContainer.scrollLeft -= event.clientX - state.touchPan.clientX;
          scrollContainer.scrollTop -= event.clientY - state.touchPan.clientY;
        }
        state.touchPan.clientX = event.clientX;
        state.touchPan.clientY = event.clientY;
        return;
      }

      if (
        !state.currentStroke ||
        event.pointerId !== state.activePointerId ||
        state.currentStroke.page !== pageEntry.pageNumber ||
        options.getMode() !== 'annotate'
      ) {
        return;
      }

      state.currentStroke.points.push(toPoint(canvas, event));
      redrawPage(pageEntry);
    });

    function finishPointer(event) {
      if (state.touchPan?.pointerId === event.pointerId) {
        state.touchPan = null;
        return;
      }
      finalizeStroke(event);
    }

    canvas.addEventListener('pointerup', finishPointer);
    canvas.addEventListener('pointercancel', finishPointer);
  }

  return {
    ensurePageCanvas,
    redrawPage,
    load(strokes) {
      state.strokes = structuredClone(strokes);
      state.currentStroke = null;
      state.activePointerId = null;
      state.touchPan = null;
      redrawAll();
    },
    removeStroke(strokeId) {
      state.strokes = state.strokes.filter((stroke) => stroke.id !== strokeId);
      redrawAll();
    },
    undoLastStroke() {
      const lastStroke = state.strokes.at(-1);
      if (!lastStroke) {
        return null;
      }

      state.strokes = state.strokes.slice(0, -1);
      redrawAll();
      return structuredClone(lastStroke);
    },
  };
}
