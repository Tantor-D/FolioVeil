/** Normal rendered catalog hierarchy. A section row preceding deeper rows is
 * a group; the paginated reader can combine it with its first child. */
export function catalogEntries(document: Document) {
  const entries = [...document.querySelectorAll<HTMLElement>('.readerCatalog_list_item')].map(element => {
    const inner = element.querySelector('[class*="readerCatalog_list_item_level_"]');
    const level = Number(inner?.className.match(/readerCatalog_list_item_level_(\d+)\b/)?.[1]);
    return { element, title: element.querySelector('.readerCatalog_list_item_title_text')?.textContent?.trim() ?? '', level, group: false };
  });
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!, next = entries[index + 1];
    entry.group = Number.isFinite(entry.level) && !!next && Number.isFinite(next.level) && next.level > entry.level;
  }
  return entries;
}

export function catalogChapters(document: Document): HTMLElement[] {
  return catalogEntries(document).filter(entry => !entry.group).map(entry => entry.element);
}

export function selectedChapterTitle(document: Document, includeGroup = false): string | undefined {
  return selectedChapterEntry(document, includeGroup)?.title || undefined;
}

/** Ordinal in the rendered full catalog, including section rows. */
export function selectedChapterIndex(document: Document, includeGroup = false): number | undefined {
  const selected = selectedChapterEntry(document, includeGroup);
  if (selected) return catalogEntries(document).findIndex(entry => entry.element === selected.element);
}

function selectedChapterEntry(document: Document, includeGroup: boolean) {
  const entries = catalogEntries(document);
  const selected = entries.filter(entry => entry.element.classList.contains('readerCatalog_list_item_selected'));
  if (selected.length !== 1) return;
  const current = selected[0]!;
  if (includeGroup || !current.group) return current;
  // The original reader keeps the section row selected on its opening spread.
  // Its first leaf supplies the loaded body; later pre-rendered leaves must not
  // win just because their layout arrived last.
  for (const next of entries.slice(entries.indexOf(current) + 1)) {
    if (!Number.isFinite(next.level) || next.level <= current.level) return;
    if (!next.group) return next;
  }
}

/** Only split a compound heading when all leading headings correspond to an
 * observed catalog ancestor chain ending at a leaf. Number/title pairs without
 * that evidence retain the original combined title. */
export function catalogLeafHeading(document: Document, headings: Element[]): Element | undefined {
  if (headings.length < 2) return;
  const normalize = (value: string) => value.replace(/\s|[\u200b-\u200d\ufeff]/g, '');
  const entries = catalogEntries(document);
  const matches = headings.map(heading => entries.filter(entry => normalize(entry.title) === normalize(heading.textContent ?? '')));
  if (matches.some(items => items.length !== 1)) return;
  const chain = matches.map(items => items[0]!);
  const leaf = chain.at(-1)!;
  if (leaf.group || !Number.isFinite(leaf.level)) return;
  for (let index = 0; index < chain.length - 1; index++) {
    const parent = chain[index]!, child = chain[index + 1]!;
    if (!parent.group || !(parent.level < child.level)) return;
    const between = entries.slice(entries.indexOf(parent) + 1, entries.indexOf(child));
    if (entries.indexOf(parent) >= entries.indexOf(child) || between.some(entry => entry.level <= parent.level)) return;
  }
  return headings.at(-1);
}
