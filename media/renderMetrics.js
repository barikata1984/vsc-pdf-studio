// Render instrumentation. Must never change behaviour and never throw:
// every entry point degrades to a no-op when `performance` is unavailable.

const NOOP_RECORDER = {
  requestId: 0,
  measure(_name, run) {
    return run();
  },
  finish() {},
};

let nextRequestId = 0;

function getPerformance() {
  const perf = globalThis.performance;
  if (
    !perf ||
    typeof perf.mark !== 'function' ||
    typeof perf.measure !== 'function' ||
    typeof perf.now !== 'function'
  ) {
    return null;
  }
  return perf;
}

/**
 * Begin recording one render request. The returned recorder wraps stages with
 * performance marks/measures and prints a single summary line on finish().
 */
export function startRenderRequest() {
  const perf = getPerformance();
  if (!perf) {
    return NOOP_RECORDER;
  }

  const requestId = (nextRequestId += 1);
  const startedAt = perf.now();
  const stages = new Map();
  const pageStages = new Map();

  function record(name, pageNumber, duration) {
    if (pageNumber === undefined) {
      stages.set(name, (stages.get(name) ?? 0) + duration);
      return;
    }
    let byPage = pageStages.get(name);
    if (!byPage) {
      byPage = new Map();
      pageStages.set(name, byPage);
    }
    byPage.set(pageNumber, (byPage.get(pageNumber) ?? 0) + duration);
  }

  function summarize(name) {
    const byPage = pageStages.get(name);
    if (!byPage || byPage.size === 0) {
      return null;
    }
    const values = [...byPage.values()];
    return {
      sum: round(values.reduce((total, value) => total + value, 0)),
      max: round(Math.max(...values)),
    };
  }

  return {
    requestId,

    /**
     * Run `run` while measuring it. Synchronous callbacks stay synchronous so
     * the existing ordering of awaits and DOM writes is preserved.
     */
    measure(name, run, pageNumber) {
      const label =
        pageNumber === undefined
          ? `pdfStudio:${name}#${requestId}`
          : `pdfStudio:${name}#${requestId}:p${pageNumber}`;
      let startedStage;
      try {
        startedStage = perf.now();
        perf.mark(`${label}:start`);
      } catch {
        return run();
      }

      const done = () => {
        try {
          perf.mark(`${label}:end`);
          perf.measure(label, `${label}:start`, `${label}:end`);
        } catch {
          // ignore: measurement must never break rendering
        }
        record(name, pageNumber, perf.now() - startedStage);
      };

      let result;
      try {
        result = run();
      } catch (error) {
        done();
        throw error;
      }

      if (result && typeof result.then === 'function') {
        return result.then(
          (value) => {
            done();
            return value;
          },
          (error) => {
            done();
            throw error;
          }
        );
      }

      done();
      return result;
    },

    /** @param {'completed' | 'discarded'} result */
    finish(result) {
      try {
        const pageCount = pageStages.get('page.render')?.size ?? 0;
        console.log(
          'pdfStudio:render',
          JSON.stringify({
            requestId,
            result,
            totalMs: round(perf.now() - startedAt),
            pageCount,
            stagesMs: Object.fromEntries(
              [...stages].map(([name, value]) => [name, round(value)])
            ),
            perPageMs: {
              render: summarize('page.render'),
              text: summarize('page.text'),
              thumbnail: summarize('page.thumbnail'),
            },
          })
        );
      } catch {
        // ignore: reporting must never break rendering
      }
    },
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
