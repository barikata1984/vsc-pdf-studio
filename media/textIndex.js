// Text index built from pdf.js text content, independent of the DOM so it can
// run both in the webview and under `node --test`.

/**
 * @param {Array<{ pageNumber: number, textContent: { items: Array<{ str?: string, hasEOL?: boolean }> } }>} pages
 * @returns {Array<{ pageNumber: number, text: string, items: Array<{ index: number, start: number, end: number }> }>}
 */
export function buildTextIndex(pages) {
  return pages.map(({ pageNumber, textContent }) => {
    const items = [];
    let text = '';

    (textContent?.items ?? []).forEach((item, index) => {
      const str = typeof item?.str === 'string' ? item.str : '';
      const start = text.length;
      text += str;
      items.push({ index, start, end: text.length });
      if (item?.hasEOL) {
        text += '\n';
      }
    });

    return { pageNumber, text, items };
  });
}

/**
 * Case-insensitive search over the index.
 * @returns {Array<{ pageNumber: number, start: number, end: number, itemIndex: number }>}
 */
export function findInTextIndex(index, query) {
  const needle = String(query ?? '').toLowerCase();
  if (!needle) {
    return [];
  }

  const matches = [];
  for (const page of index) {
    const haystack = page.text.toLowerCase();
    let from = 0;
    for (;;) {
      const start = haystack.indexOf(needle, from);
      if (start === -1) {
        break;
      }
      const end = start + needle.length;
      matches.push({
        pageNumber: page.pageNumber,
        start,
        end,
        itemIndex:
          page.items.find((item) => item.start <= start && start < item.end)
            ?.index ?? -1,
      });
      from = start + 1;
    }
  }
  return matches;
}
