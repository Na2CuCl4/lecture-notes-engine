export interface ReadingPage { path: string; anchors: string[] }
export interface ReadingProgress {
  href: string;
  revision: string;
  timestamp: number;
  scrollY: number;
  anchor?: string;
  offset?: number;
  expanded?: string[];
}

export function readingHref(value: string, origin: string, pages: ReadingPage[]): string | null {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null;
    const page = pages.find(page => page.path === url.pathname);
    if (!page || (url.hash && !page.anchors.includes(decodeURIComponent(url.hash.slice(1))))) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function restoreReadingProgress(value: unknown, origin: string, pages: ReadingPage[], revision: string): ReadingProgress | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<ReadingProgress>;
  if (typeof entry.href !== 'string' || typeof entry.revision !== 'string' || typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) return null;
  const href = readingHref(entry.href, origin, pages);
  if (!href) return null;
  const url = new URL(href, origin);
  const page = pages.find(page => page.path === url.pathname)!;
  // A course update does not invalidate a stable page or anchor. Upgrade a
  // previously current filter link so resuming it does not trigger a false warning.
  if (url.searchParams.get('revision') === entry.revision) url.searchParams.set('revision', revision);
  const anchor = typeof entry.anchor === 'string' && page.anchors.includes(entry.anchor) ? entry.anchor : undefined;
  return {
    href: `${url.pathname}${url.search}${url.hash}`,
    revision,
    timestamp: entry.timestamp,
    scrollY: typeof entry.scrollY === 'number' && Number.isFinite(entry.scrollY) ? Math.max(0, entry.scrollY) : 0,
    ...(anchor ? { anchor, offset: typeof entry.offset === 'number' && Number.isFinite(entry.offset) ? entry.offset : 0 } : {}),
    expanded: Array.isArray(entry.expanded) ? entry.expanded.filter((id): id is string => typeof id === 'string' && page.anchors.includes(id)) : [],
  };
}
