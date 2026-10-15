/** Temporary, read-only normal-DOM diagnostics. No source text, URLs, identifiers,
 * application state, storage, network requests or canvas pixels are retained.
 * Works as a document_start content script or as a console paste. */
(() => {
  const scope = globalThis;
  scope.__folioVeilDOMProbe?.stop?.();
  const document = scope.document;
  if (!document) return;

  const LIMITS = Object.freeze({ events: 200, earlySamples: 12, roots: 8, nodes: 4000,
    elements: 24, textRanges: 8, rects: 8, attributes: 32, mutationRecords: 100, mutationNodes: 8,
    selectionSamples: 40, selectionRanges: 4, stableNodes: 1200, stableChanges: 12, changedNodes: 120 });
  const ROOT_SELECTOR = '.preRenderContent,.renderTargetContainer';
  const LIVE_SELECTOR = '.readerChapterContent .preRenderContent,.readerChapterContent .renderTargetContainer';
  const TAGS = new Set('div span p h1 h2 h3 h4 h5 h6 img picture canvas svg math table tr td th ul ol li blockquote pre code br section article button a input textarea header footer main'.split(' '));
  const GEOMETRY_ATTRIBUTES = new Set(['data-wr-x', 'data-wr-y', 'data-wr-left', 'data-wr-top',
    'data-wr-right', 'data-wr-bottom', 'data-wr-width', 'data-wr-height', 'data-wr-line-height',
    'data-wr-font-size', 'data-wr-offset-x', 'data-wr-offset-y', 'data-wr-co']);
  const POSITION_ATTRIBUTES = new Set([...GEOMETRY_ATTRIBUTES, 'width', 'height', 'data-wr-offset',
    'data-wr-start', 'data-wr-end', 'data-wr-start-offset', 'data-wr-end-offset',
    'data-wr-page', 'data-wr-page-index', 'data-wr-page-count', 'data-wr-column-index', 'data-wr-column-count']);
  const MARKERS = ['readerChapterContent', 'preRenderContent', 'renderTargetContainer', 'renderTargetPageInfo',
    'renderTargetPageInfo_header_chapterTitle', 'readerFooter', 'wr_selection'];
  const EXCLUDED = 'script,style,template,noscript';
  const events = [], earlySamples = [], selectionSamples = [], stableChanges = [];
  const knownRoots = new WeakSet(), nodeIds = new WeakMap(), selectionIds = new WeakMap(), readerObservers = new Map();
  const earlyRootIds = new Set();
  const counters = { observations: 0, evictedEvents: 0, skippedMutationRecords: 0, skippedMutationNodes: 0,
    unrelatedDiscoveryRecords: 0, delegatedDiscoveryRecords: 0, selectionSamples: 0, evictedSelectionSamples: 0,
    stableSnapshots: 0, evictedStableChanges: 0, truncatedStableChanges: 0, discoveredReaderRoots: 0 };
  const started = scope.performance.now();
  let nextId = 0, stopped = false, frame = 0, latest = [], stableDOM = null, selectionEvent = 0;

  const number = value => Number.isFinite(value) && Math.abs(value) <= 1e8 ? Math.round(value * 100) / 100 : null;
  const id = node => {
    if (!nodeIds.has(node)) nodeIds.set(node, ++nextId);
    return nodeIds.get(node);
  };
  const tag = node => node.nodeType === 3 ? '#text' : TAGS.has(node.localName) ? node.localName : 'other-element';
  const role = root => root.matches('.preRenderContent') ? 'layout' : 'render';
  const environment = () => ({ viewport: { width: number(scope.innerWidth), height: number(scope.innerHeight),
    dpr: number(scope.devicePixelRatio), scrollX: number(scope.scrollX), scrollY: number(scope.scrollY) },
    visibility: ['visible', 'hidden', 'prerender'].includes(document.visibilityState) ? document.visibilityState : 'unknown',
    readyState: document.readyState, focused: document.hasFocus() });
  const rect = value => ({ x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height) });
  const validRect = value => value.x !== null && value.y !== null && value.width > 0 && value.height > 0;
  const invalid = reason => ({ valid: false, reason });

  function layout(node, removed) {
    if (removed || !node.isConnected || node.nodeType !== 1) return null;
    try {
      const style = scope.getComputedStyle(node), result = {};
      const rules = {
        columnWidth: /^(?:auto|\d+(?:\.\d+)?px)$/,
        columnCount: /^(?:auto|\d+)$/,
        columnGap: /^(?:normal|\d+(?:\.\d+)?px)$/,
        writingMode: /^(?:horizontal-tb|vertical-rl|vertical-lr|sideways-rl|sideways-lr)$/,
        direction: /^(?:ltr|rtl)$/,
        transform: /^(?:none|matrix(?:3d)?\([-\d.,eE+ ]+\))$/,
        overflow: /^(?:visible|hidden|clip|scroll|auto)(?: (?:visible|hidden|clip|scroll|auto))?$/,
        overflowX: /^(?:visible|hidden|clip|scroll|auto)$/,
        overflowY: /^(?:visible|hidden|clip|scroll|auto)$/
      };
      for (const [name, rule] of Object.entries(rules)) if (rule.test(style[name])) result[name] = style[name];
      return result;
    } catch { return null; }
  }

  function geometry(node, removed) {
    // A removal record cannot establish geometry at the time of removal, even
    // if the same node has already been reinserted when this callback runs.
    if (removed) return invalid('removal-record-no-live-layout-evidence');
    if (!node.isConnected) return invalid('detached');
    if (node.nodeType !== 1) return invalid('not-an-element');
    try {
      const box = rect(node.getBoundingClientRect());
      return { valid: validRect(box), ...(validRect(box) ? {} : { reason: 'empty-or-invalid-box' }), box };
    } catch { return invalid('measurement-unavailable'); }
  }

  function attributes(node) {
    if (node.nodeType !== 1) return [];
    const result = [];
    for (const attribute of node.attributes) {
      if (!/^data-wr-[a-z][a-z0-9-]{0,39}$/.test(attribute.name)) continue;
      if (result.length >= LIMITS.attributes) break;
      // Identifiers are listed by name only. data-wr-co is a numeric diagnostic
      // candidate; its name/value do not prove character-offset semantics.
      const item = { name: attribute.name };
      if (GEOMETRY_ATTRIBUTES.has(attribute.name) && /^-?\d+(?:\.\d+)?$/.test(attribute.value)) {
        const value = number(Number(attribute.value));
        if (value !== null) item.value = value;
      }
      result.push(item);
    }
    return result;
  }

  function attributeOverview(node) {
    if (node.nodeType !== 1) return { count: 0, truncated: false, values: [] };
    const values = [];
    let count = 0;
    for (const attribute of node.attributes) {
      ++count;
      if (values.length >= LIMITS.attributes || !/^[a-z][a-z0-9:_-]{0,79}$/.test(attribute.name)) continue;
      const item = { name: attribute.name };
      if (POSITION_ATTRIBUTES.has(attribute.name) && /^-?\d+(?:\.\d+)?$/.test(attribute.value)) {
        const value = number(Number(attribute.value));
        if (value !== null) item.value = value;
      }
      values.push(item);
    }
    return { count, truncated: count > values.length, values };
  }

  function inlinePosition(node) {
    if (node.nodeType !== 1 || !node.style) return {};
    const result = {};
    for (const name of ['left', 'top', 'right', 'bottom', 'width', 'height', 'max-width', 'max-height', 'min-width', 'min-height']) {
      const value = node.style.getPropertyValue(name);
      if (/^-?\d+(?:\.\d+)?(?:px|%)?$/.test(value)) result[name] = value;
    }
    const transform = node.style.getPropertyValue('transform');
    if (/^(?:none|matrix(?:3d)?\([-\d.,eE+ ]+\)|translate(?:X|Y|3d)?\([-\d.,%px ]+\))$/.test(transform)) result.transform = transform;
    return result;
  }

  function readerFor(node) {
    return (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.readerChapterContent') ?? null;
  }

  function endpoint(node, offset) {
    if (!node) return null;
    if (!readerFor(node)) return { withinReader: false, connected: node.isConnected };
    const element = node.nodeType === 1 ? node : node.parentElement;
    return { withinReader: true, nodeId: id(node), tag: tag(node), connected: node.isConnected,
      offset: Number.isSafeInteger(offset) && offset >= 0 ? number(offset) : null,
      offsetKind: node.nodeType === 3 ? 'text-utf16' : 'child-index',
      attributeNodeId: element ? id(element) : null, attributes: element ? attributes(element) : [] };
  }

  function rangeRects(range) {
    if (typeof range.getClientRects !== 'function') return invalid('range-api-unavailable');
    const list = range.getClientRects(), rects = [], indexes = new Set();
    for (let index = 0; index < Math.min(list.length, LIMITS.rects / 2); index++) indexes.add(index);
    for (let index = Math.max(0, list.length - LIMITS.rects / 2); index < list.length; index++) indexes.add(index);
    for (const index of indexes) rects.push({ rectIndex: index, ...rect(list[index]) });
    return { valid: rects.some(validRect), rectCount: list.length, rects, truncated: list.length > LIMITS.rects,
      ...(!rects.some(validRect) ? { reason: 'empty-or-invalid-range' } : {}) };
  }

  function selectionMetadata() {
    try {
      const selection = document.getSelection();
      if (!selection) return { available: false };
      const anchor = endpoint(selection.anchorNode, selection.anchorOffset), focus = endpoint(selection.focusNode, selection.focusOffset);
      const withinReader = !!anchor?.withinReader && !!focus?.withinReader;
      const ranges = [];
      if (withinReader) for (let index = 0; index < Math.min(selection.rangeCount, LIMITS.selectionRanges); index++) {
        const range = selection.getRangeAt(index);
        const start = endpoint(range.startContainer, range.startOffset), end = endpoint(range.endContainer, range.endOffset);
        const readable = !!start?.withinReader && !!end?.withinReader;
        ranges.push({ index, start, end, length: readable ? range.toString().length : null,
          geometry: !readable ? invalid('outside-reader') : !range.startContainer.isConnected || !range.endContainer.isConnected
            ? invalid('detached') : rangeRects(range) });
      }
      return { available: true, rangeCount: selection.rangeCount, collapsed: selection.isCollapsed,
        length: withinReader ? selection.toString().length : selection.rangeCount === 0 ? 0 : null,
        anchor, focus, ranges, rangesTruncated: selection.rangeCount > ranges.length,
        scope: withinReader ? 'reader' : selection.rangeCount ? 'outside-reader' : 'none' };
    } catch { return { available: false, reason: 'selection-api-unavailable' }; }
  }

  function stableSnapshot() {
    const nodes = [], roots = document.querySelectorAll('.readerChapterContent');
    let truncated = roots.length > LIMITS.roots, attributesTruncated = false, excludedSubtrees = 0;
    const inspect = node => {
      if (nodes.length === LIMITS.stableNodes) { truncated = true; return false; }
      const overview = attributeOverview(node);
      attributesTruncated ||= overview.truncated;
      nodes.push({ nodeId: id(node), parentNodeId: node.parentNode && readerFor(node.parentNode) ? id(node.parentNode) : null,
        tag: tag(node), connected: node.isConnected, ownTextLength: node.nodeType === 3 ? node.nodeValue?.length ?? 0 : 0,
        markers: node.nodeType === 1 ? MARKERS.filter(marker => node.classList.contains(marker)) : [],
        attributes: overview, positionStyle: inlinePosition(node), geometry: geometry(node, false) });
      return true;
    };
    for (let index = 0; index < Math.min(roots.length, LIMITS.roots); index++) {
      const root = roots[index];
      if (!inspect(root)) break;
      const walker = document.createTreeWalker(root, 5, { acceptNode: node => {
        if (node.nodeType === 1 && (node.namespaceURI === 'http://www.w3.org/2000/svg' || node.matches(EXCLUDED))) {
          ++excludedSubtrees; return 2;
        }
        return 1;
      } });
      let node;
      while ((node = walker.nextNode())) if (!inspect(node)) break;
      if (nodes.length === LIMITS.stableNodes && truncated) break;
    }
    return { sequence: ++counters.stableSnapshots, elapsedMs: number(scope.performance.now() - started),
      rootCount: roots.length, nodeCount: nodes.length, truncated, attributesTruncated, excludedSubtrees, nodes };
  }

  function refreshStable(reason) {
    if (stopped) return;
    const next = stableSnapshot(), before = stableDOM;
    stableDOM = next;
    if (!before) return;
    const old = new Map(before.nodes.map(node => [node.nodeId, node]));
    const added = [], removed = [], changed = [];
    let differenceCount = 0;
    const keep = (list, value) => { if (++differenceCount <= LIMITS.changedNodes) list.push(value); };
    for (const node of next.nodes) {
      const previous = old.get(node.nodeId); old.delete(node.nodeId);
      if (!previous) { keep(added, node); continue; }
      const fields = ['parentNodeId', 'connected', 'ownTextLength', 'markers', 'attributes', 'positionStyle', 'geometry']
        .filter(field => JSON.stringify(previous[field]) !== JSON.stringify(node[field]));
      if (fields.length) keep(changed, { nodeId: node.nodeId, fields, before: previous, after: node });
    }
    for (const node of old.values()) keep(removed, node);
    if (!differenceCount) return;
    if (stableChanges.length === LIMITS.stableChanges) { stableChanges.shift(); ++counters.evictedStableChanges; }
    if (differenceCount > LIMITS.changedNodes) ++counters.truncatedStableChanges;
    stableChanges.push({ from: before.sequence, to: next.sequence, reason, differenceCount,
      truncated: differenceCount > LIMITS.changedNodes,
      exhaustive: differenceCount <= LIMITS.changedNodes && !before.truncated && !next.truncated && !before.attributesTruncated && !next.attributesTruncated,
      removedMeaning: 'absent-from-current-sample; geometry-belongs-to-previous-snapshot', added, removed, changed });
  }

  function textGeometry(node, removed) {
    const sample = { nodeId: id(node), parentNodeId: node.parentNode ? id(node.parentNode) : null,
      length: node.nodeType === 3 ? node.nodeValue?.length ?? 0 : node.textContent?.length ?? 0,
      connected: node.isConnected, ...(node.nodeType === 1 ? { tag: tag(node), attributes: attributes(node) } : {}) };
    if (removed) return { ...sample, geometry: invalid('removal-record-no-live-layout-evidence') };
    if (!node.isConnected) return { ...sample, geometry: invalid('detached') };
    const range = document.createRange();
    try {
      range.selectNodeContents(node);
      return { ...sample, geometry: rangeRects(range) };
    } catch { return { ...sample, geometry: invalid('measurement-unavailable') }; }
    finally { range.detach?.(); }
  }

  function sample(node, root, removed = false) {
    const counts = { elements: 0, textNodes: 0, textLength: 0, images: 0, canvases: 0, nodes: 0, truncated: false };
    const elements = [], textNodes = [], blockNodes = [];
    let blockCount = 0;
    const keepEnds = (values, value) => {
      if (values.length === LIMITS.textRanges) values.splice(LIMITS.textRanges / 2, 1);
      values.push(value);
    };
    const inspect = current => {
      ++counts.nodes;
      if (current.nodeType === 3) {
        ++counts.textNodes;
        counts.textLength += current.nodeValue?.length ?? 0;
        if (current.nodeValue?.length) keepEnds(textNodes, current);
      } else if (current.nodeType === 1) {
        ++counts.elements;
        if (current.localName === 'img') ++counts.images;
        if (current.localName === 'canvas') ++counts.canvases;
        if (elements.length < LIMITS.elements) elements.push({ nodeId: id(current),
          parentNodeId: current === node ? null : id(current.parentNode), tag: tag(current),
          connected: current.isConnected, attributes: attributes(current), geometry: geometry(current, removed), layout: layout(current, removed) });
        if (current.matches('p,h1,h2,h3,h4,h5,h6,blockquote,li,pre,td,th,div[data-wr-co],div[data-wr-id]')) {
          ++blockCount; keepEnds(blockNodes, current);
        }
      }
    };
    inspect(node);
    // TreeWalker avoids creating a retained array of the chapter's DOM/text.
    const walker = document.createTreeWalker(node, 5, {
      acceptNode: candidate => candidate.nodeType === 1 && candidate.matches('script,style,template,noscript') ? 2 : 1
    });
    let child;
    while ((child = walker.nextNode())) {
      if (counts.nodes >= LIMITS.nodes) { counts.truncated = true; break; }
      inspect(child);
    }
    const textRanges = textNodes.map(value => textGeometry(value, removed));
    const blockRanges = blockNodes.map(value => textGeometry(value, removed));
    return { rootId: id(root), role: role(root), nodeId: id(node), tag: tag(node),
      connected: node.isConnected, counts, geometry: geometry(node, removed), layout: layout(node, removed), elements, textRanges, blockRanges,
      samplesTruncated: counts.elements > elements.length || counts.textNodes > textRanges.length || blockCount > blockRanges.length };
  }

  function rememberEarly(value) {
    if (earlySamples.length >= LIMITS.earlySamples || earlyRootIds.has(value.rootId) || !value.connected ||
      value.nodeId !== value.rootId ||
      !(value.counts.textLength || value.counts.images) ||
      !(value.geometry.valid || value.textRanges.some(item => item.geometry.valid))) return;
    earlyRootIds.add(value.rootId);
    earlySamples.push({ elapsedMs: number(scope.performance.now() - started), ...value });
  }

  function emit(kind, value) {
    if (stopped) return;
    ++counters.observations;
    if (events.length === LIMITS.events) { events.shift(); ++counters.evictedEvents; }
    events.push({ sequence: counters.observations, elapsedMs: number(scope.performance.now() - started), kind,
      ...environment(), ...value });
    if (value?.sample && !kind.startsWith('removed')) rememberEarly(value.sample);
  }

  function currentRoots() {
    const values = [];
    for (const root of document.querySelectorAll(LIVE_SELECTOR)) {
      if (values.length === LIMITS.roots) break;
      knownRoots.add(root);
      values.push(sample(root, root));
    }
    return values;
  }

  function checkpoint(kind) {
    if (stopped) return;
    latest = currentRoots();
    for (const value of latest) emit(kind, { sample: value });
    if (!latest.length) emit(kind, { rootCount: 0 });
    refreshStable(kind);
  }

  function rootFor(node) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    const root = element?.closest(ROOT_SELECTOR);
    return root && (knownRoots.has(root) || root.closest('.readerChapterContent')) ? root : null;
  }

  function subtreeRoots(node, inReader) {
    if (node.nodeType !== 1) return [];
    const result = [];
    const add = root => {
      if (result.length < LIMITS.roots && (inReader || knownRoots.has(root) || root.closest('.readerChapterContent'))) {
        knownRoots.add(root); result.push(root);
      }
    };
    if (node.matches(ROOT_SELECTOR)) add(node);
    for (const root of node.querySelectorAll(ROOT_SELECTOR)) add(root);
    return result;
  }

  function containsReader(node) {
    return node.nodeType === 1 && (node.matches('.readerChapterContent') || !!node.querySelector('.readerChapterContent'));
  }

  function relevantRecord(record, discovery) {
    // A dedicated observer proves the record belonged to its reader subtree at
    // mutation time, including targets which are detached by callback time.
    if (!discovery) return true;
    const reader = readerFor(record.target);
    if (reader) return !readerObservers.has(reader);
    for (const nodes of [record.addedNodes, record.removedNodes]) for (const node of nodes) if (containsReader(node)) return true;
    return false;
  }

  function recordPriority(record) {
    if (record.type === 'childList') {
      if (record.target.nodeType === 1 && record.target.matches(ROOT_SELECTOR)) return record.removedNodes.length ? 0 : 1;
      for (const nodes of [record.addedNodes, record.removedNodes]) for (const node of nodes) {
        if (node.nodeType === 1 && (node.matches(ROOT_SELECTOR) || node.querySelector(ROOT_SELECTOR))) return 0;
      }
      return 3;
    }
    return record.type === 'attributes' ? 2 : 4;
  }

  function processRecords(records, discovery = false) {
    if (stopped) return;
    // Filter unrelated document noise BEFORE applying the diagnostic budget.
    // Prefer root lifecycle records, then restore their original batch order.
    const selected = [];
    let relevant = 0;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!relevantRecord(record, discovery)) {
        if (discovery) {
          if (readerObservers.has(readerFor(record.target))) ++counters.delegatedDiscoveryRecords;
          else ++counters.unrelatedDiscoveryRecords;
        }
        continue;
      }
      ++relevant;
      const item = { record, index, priority: recordPriority(record) };
      if (selected.length < LIMITS.mutationRecords) selected.push(item);
      else {
        let worst = 0;
        for (let candidate = 1; candidate < selected.length; candidate++) if (selected[candidate].priority > selected[worst].priority) worst = candidate;
        if (item.priority < selected[worst].priority) selected[worst] = item;
      }
    }
    counters.skippedMutationRecords += relevant - selected.length;
    if (!selected.length) return;
    selected.sort((left, right) => left.index - right.index);
    const changed = new Set();
    for (const { record, index } of selected) {
      const root = rootFor(record.target);
      if (root) changed.add(root);
      const targetElement = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      const inReader = !!targetElement?.closest('.readerChapterContent');
      for (const [kind, nodes] of [['inserted-node', record.addedNodes], ['removed-node', record.removedNodes]]) {
        counters.skippedMutationNodes += Math.max(0, nodes.length - LIMITS.mutationNodes);
        for (let item = 0; item < Math.min(nodes.length, LIMITS.mutationNodes); item++) {
          const node = nodes[item], removed = kind === 'removed-node';
          if (node.nodeType === 1 && node.matches(EXCLUDED)) continue;
          if (root) emit(kind, { mutationIndex: index, sample: sample(node, root, removed) });
          for (const nested of subtreeRoots(node, inReader)) {
            emit(removed ? 'removed-root' : 'inserted-root', { mutationIndex: index, sample: sample(nested, nested, removed) });
            if (!removed) changed.add(nested);
          }
        }
      }
    }
    emit('mutation-batch', { observer: discovery ? 'discovery' : 'reader-subtree', relevantRecords: relevant,
      processedRecords: selected.length, skippedRecords: relevant - selected.length });
    for (const root of changed) emit(root.childNodes.length ? 'root-mutation' : 'root-cleared', { sample: sample(root, root) });
    latest = currentRoots();
    refreshStable('mutation');
    // This samples the next natural frame; it does not postpone mutations or
    // force a source render. Background tabs may never run this callback.
    if (!frame && typeof scope.requestAnimationFrame === 'function') frame = scope.requestAnimationFrame(() => {
      frame = 0; checkpoint('animation-frame');
    });
  }

  function refreshReaders() {
    if (stopped) return;
    const roots = document.querySelectorAll('.readerChapterContent');
    counters.discoveredReaderRoots = roots.length;
    for (const [root, observer] of readerObservers) if (!root.isConnected) { observer.disconnect(); readerObservers.delete(root); }
    for (const root of roots) {
      if (readerObservers.has(root)) continue;
      if (readerObservers.size === LIMITS.roots) break;
      const observer = new scope.MutationObserver(records => processRecords(records));
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      readerObservers.set(root, observer);
    }
  }

  const discoveryObserver = new scope.MutationObserver(records => {
    processRecords(records, true);
    refreshReaders();
  });

  let sourceSelectionContext = false;
  function rememberSelection(trigger, phase, eventId, pointer) {
    if (stopped) return;
    const value = { sequence: ++counters.selectionSamples, eventId, trigger, phase,
      elapsedMs: number(scope.performance.now() - started), ...environment(),
      ...(pointer ? { pointer } : {}), selection: selectionMetadata() };
    if (selectionSamples.length === LIMITS.selectionSamples) { selectionSamples.shift(); ++counters.evictedSelectionSamples; }
    selectionSamples.push(value);
    emit('selection', { selectionSequence: value.sequence, eventId, trigger, phase,
      rangeCount: value.selection.rangeCount ?? null, length: value.selection.length ?? null });
  }
  const pointerDown = event => { sourceSelectionContext = !!readerFor(event.target); };
  const selectionListener = phase => event => {
    if (stopped) return;
    const pointer = event.type === 'pointerup' ? { target: endpoint(event.target, 0),
      x: number(event.clientX), y: number(event.clientY),
      pointerType: ['mouse', 'pen', 'touch'].includes(event.pointerType) ? event.pointerType : 'unknown' } : undefined;
    // A drag can begin in the reader and end over a sibling/overlay. Keep its
    // checkpoint, but endpoint()/selectionMetadata() redact outside nodes.
    if (pointer && !pointer.target?.withinReader && !sourceSelectionContext) return;
    let selection;
    try { selection = document.getSelection(); } catch { /* Selection failure is recorded below for reader pointer events. */ }
    if (!pointer && !sourceSelectionContext && !readerFor(selection?.anchorNode) && !readerFor(selection?.focusNode)) return;
    if (pointer) sourceSelectionContext = true;
    // Capture and bubble are separate samples, since source listeners may clear
    // the Selection during the event. No Event or selected text is retained.
    if (!selectionIds.has(event)) selectionIds.set(event, ++selectionEvent);
    const eventId = selectionIds.get(event), trigger = event.type;
    rememberSelection(trigger, phase, eventId, pointer);
    if (phase === 'capture') scope.queueMicrotask(() => rememberSelection(trigger, 'microtask', eventId, pointer));
  };
  // Window capture precedes document capture even when the site's window
  // listener was registered later. Preserve both checkpoints; neither proves
  // that a Selection did not exist before this listener ran.
  const selectionWindowCapture = selectionListener('window-capture');
  const selectionCapture = selectionListener('capture'), selectionBubble = selectionListener('bubble');

  const visibility = () => checkpoint('visibility');
  const resize = () => checkpoint('resize');
  const scroll = () => { if (!stopped) emit('scroll'); };
  discoveryObserver.observe(document, { subtree: true, childList: true });
  refreshReaders();
  document.addEventListener('visibilitychange', visibility);
  scope.addEventListener('pointerdown', pointerDown, true);
  for (const type of ['pointerup', 'selectionchange']) {
    scope.addEventListener(type, selectionWindowCapture, true);
    document.addEventListener(type, selectionCapture, true);
    document.addEventListener(type, selectionBubble);
  }
  scope.addEventListener('resize', resize);
  document.addEventListener('scroll', scroll, true);
  const api = {
    summary() {
      // Return detached JSON data; callers cannot alter the bounded internal log.
      if (!stopped) { latest = currentRoots(); refreshStable('summary'); }
      return JSON.parse(JSON.stringify({ format: 'folioveil-normal-dom-probe/3', stopped, limits: LIMITS,
        counters, environment: environment(), earlySamples, current: latest, events, selectionSamples, stableDOM, stableChanges,
        limitations: ['sampled-geometry-is-not-page-range-evidence', 'removed-nodes-have-no-removal-time-geometry',
          'attribute-names-do-not-prove-identity-or-offset-semantics', 'counts-and-ranges-may-be-truncated',
          'selection-outside-reader-not-read', 'zero-selection-samples-do-not-exclude-transient-selection',
          'stable-diff-compares-only-exported-metadata'] }));
    },
    stop() {
      if (stopped) return;
      stopped = true; discoveryObserver.disconnect();
      for (const observer of readerObservers.values()) observer.disconnect();
      readerObservers.clear();
      if (frame) scope.cancelAnimationFrame(frame);
      frame = 0;
      document.removeEventListener('visibilitychange', visibility);
      scope.removeEventListener('pointerdown', pointerDown, true);
      for (const type of ['pointerup', 'selectionchange']) {
        scope.removeEventListener(type, selectionWindowCapture, true);
        document.removeEventListener(type, selectionCapture, true);
        document.removeEventListener(type, selectionBubble);
      }
      scope.removeEventListener('resize', resize);
      document.removeEventListener('scroll', scroll, true);
    }
  };
  scope.__folioVeilDOMProbe = api;
  checkpoint('start');
})();
