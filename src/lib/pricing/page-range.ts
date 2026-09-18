export interface ParsedPageRange {
  pages: number[];
  count: number;
  normalizedString: string;
}

export class InvalidPageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPageRangeError';
  }
}

/**
 * Parses and validates a page range string (e.g., "1-5, 8, 10-12") against total document pages.
 * Handles whitespace, comma-separated tokens, hyphenated ranges, out-of-bounds pages, reversed ranges, etc.
 * Normalizes duplicate page selections by deduplicating and sorting in ascending order.
 */
export function parsePageRange(
  input: string | null | undefined,
  totalDocumentPages: number
): ParsedPageRange {
  if (totalDocumentPages <= 0 || !Number.isInteger(totalDocumentPages)) {
    throw new InvalidPageRangeError('Document must have at least 1 valid page.');
  }

  // If empty, null, or "all", select all pages in the document
  if (!input || input.trim().toLowerCase() === 'all') {
    const allPages = Array.from({ length: totalDocumentPages }, (_, i) => i + 1);
    return {
      pages: allPages,
      count: totalDocumentPages,
      normalizedString: totalDocumentPages === 1 ? '1' : `1-${totalDocumentPages}`,
    };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    throw new InvalidPageRangeError('Page selection cannot be empty.');
  }

  const parts = trimmed.split(',').map((p) => p.trim());
  const selectedPagesSet = new Set<number>();

  for (const part of parts) {
    if (!part) {
      throw new InvalidPageRangeError(`Malformed page selection: empty token encountered.`);
    }

    if (part.includes('-')) {
      const rangeParts = part.split('-').map((s) => s.trim());
      if (rangeParts.length !== 2 || !rangeParts[0] || !rangeParts[1]) {
        throw new InvalidPageRangeError(`Malformed page range: "${part}". Format should be "start-end".`);
      }

      const start = Number(rangeParts[0]);
      const end = Number(rangeParts[1]);

      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new InvalidPageRangeError(`Non-numeric page numbers in range: "${part}".`);
      }

      if (start <= 0 || end <= 0) {
        throw new InvalidPageRangeError(`Page numbers must be greater than 0: "${part}".`);
      }

      if (start > end) {
        throw new InvalidPageRangeError(
          `Reversed page range: "${part}". Starting page (${start}) cannot be greater than ending page (${end}).`
        );
      }

      if (end > totalDocumentPages) {
        throw new InvalidPageRangeError(
          `Page ${end} exceeds total document pages (${totalDocumentPages}).`
        );
      }

      for (let p = start; p <= end; p++) {
        selectedPagesSet.add(p);
      }
    } else {
      const page = Number(part);
      if (!Number.isInteger(page)) {
        throw new InvalidPageRangeError(`Non-numeric page number: "${part}".`);
      }

      if (page <= 0) {
        throw new InvalidPageRangeError(`Page numbers must be greater than 0, received ${page}.`);
      }

      if (page > totalDocumentPages) {
        throw new InvalidPageRangeError(
          `Page ${page} exceeds total document pages (${totalDocumentPages}).`
        );
      }

      selectedPagesSet.add(page);
    }
  }

  if (selectedPagesSet.size === 0) {
    throw new InvalidPageRangeError('No valid pages were selected.');
  }

  const sortedPages = Array.from(selectedPagesSet).sort((a, b) => a - b);

  // Generate normalized string representation (e.g., "1-3, 5, 8-10")
  const ranges: string[] = [];
  let rangeStart = sortedPages[0];
  let prev = sortedPages[0];

  for (let i = 1; i <= sortedPages.length; i++) {
    const current = sortedPages[i];
    if (current === prev + 1) {
      prev = current;
    } else {
      if (rangeStart === prev) {
        ranges.push(`${rangeStart}`);
      } else if (prev === rangeStart + 1) {
        ranges.push(`${rangeStart}, ${prev}`);
      } else {
        ranges.push(`${rangeStart}-${prev}`);
      }
      rangeStart = current;
      prev = current;
    }
  }

  return {
    pages: sortedPages,
    count: sortedPages.length,
    normalizedString: ranges.join(', '),
  };
}
