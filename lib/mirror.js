// One-way mirror of Firefox bookmarks into the browser's native bookmarks.
//
// Root mapping (chosen so a later two-way sync can map 1:1):
//   Firefox "Bookmarks Toolbar"  → browser bookmarks/favorites bar   (shared root)
//   Firefox "Other Bookmarks"    → browser "Other bookmarks/favorites" (shared root)
//   Firefox "Mobile Bookmarks"   → browser "Mobile bookmarks" root if present (shared),
//                                  else a "Mobile Bookmarks" folder in Other
//   Firefox "Bookmarks Menu"     → a "Bookmarks Menu" folder in Other
//
// Only nodes this mirror created are ever touched (tracked in a GUID → node-id
// map). In shared roots, the browser's own bookmarks stay first and untouched;
// mirrored ones follow in Firefox order. Edits made in the browser to mirrored
// bookmarks are overwritten on the next sync (it's a mirror).
const MAP_KEY = "mirror:map";
const ROOT_FOLDERS = { menu: "Bookmarks Menu", mobile: "Mobile Bookmarks" };

/**
 * @param {Object<string, object>} records  Firefox bookmark records by GUID (cache, no tombstones)
 * @param {{uid?: string, api?: object, storage?: object}} opts  api = chrome.bookmarks-compatible
 * @returns {Promise<{created, updated, moved, removed}>}
 */
export async function reconcile(records, { uid, api = chrome.bookmarks, storage = chrome.storage.local } = {}) {
  const stats = { created: 0, updated: 0, moved: 0, removed: 0 };
  const stored = (await storage.get(MAP_KEY))[MAP_KEY];
  let map = stored && stored.uid === uid ? stored.map : {};

  // Index the browser's tree.
  let [root] = await api.getTree();
  const nodes = new Map();
  const walk = (n) => { nodes.set(n.id, n); (n.children || []).forEach(walk); };
  walk(root);
  const tops = root.children || [];
  const bar = tops.find((c) => c.folderType === "bookmarks-bar") || tops[0];
  const other = tops.find((c) => c.folderType === "other") || tops[1];
  const mobileRoot = tops.find((c) => c.folderType === "mobile") || tops[2];

  // Drop mappings whose node the user deleted (it'll be recreated) or whose type changed.
  for (const [g, id] of Object.entries(map)) if (!nodes.has(id)) delete map[g];

  // Live Firefox set, reachable from the four roots.
  const live = new Set();
  const visit = (g) => {
    const r = records[g];
    if (!r || live.has(g)) return;
    live.add(g);
    if (r.type === "folder") (r.children || []).forEach(visit);
  };
  for (const g of ["toolbar", "unfiled", "menu", "mobile"]) visit(g);

  // Remove mirrored nodes that are gone from Firefox (or unsupported now).
  for (const [g, id] of Object.entries(map)) {
    if (g === "menu" || g === "mobile") { if (records[g]) continue; }
    else if (live.has(g) && isSupported(records[g])) continue;
    try { await api.removeTree(id); stats.removed++; } catch { /* parent already removed */ }
    delete map[g];
  }
  if (stats.removed) {
    // Removing a folder also removed anything inside it, including bookmarks
    // Firefox merely moved elsewhere: re-index so those get recreated.
    [root] = await api.getTree();
    nodes.clear();
    walk(root);
    for (const [g, id] of Object.entries(map)) if (!nodes.has(id)) delete map[g];
  }

  const nodeOf = async (id) => nodes.get(id) || (await api.get(id).then((a) => a[0]).catch(() => null));

  // Ensure the managed root folders exist.
  async function managedFolder(g, title, parentId) {
    let n = map[g] && (await nodeOf(map[g]));
    if (!n || n.url) {
      n = await api.create({ parentId, title });
      nodes.set(n.id, n);
      map[g] = n.id;
      stats.created++;
    } else {
      if (n.title !== title) { await api.update(n.id, { title }); stats.updated++; }
      if (n.parentId !== parentId) { await api.move(n.id, { parentId }); stats.moved++; }
    }
    return n.id;
  }

  const targets = [["toolbar", bar.id, true], ["unfiled", other.id, true]];
  if (records.menu) targets.push(["menu", await managedFolder("menu", ROOT_FOLDERS.menu, other.id), false]);
  if (records.mobile) {
    if (mobileRoot) { targets.push(["mobile", mobileRoot.id, true]); if (map.mobile) { try { await api.removeTree(map.mobile); } catch {} delete map.mobile; } }
    else targets.push(["mobile", await managedFolder("mobile", ROOT_FOLDERS.mobile, other.id), false]);
  }

  async function syncFolder(ffGuid, parentId, shared) {
    const ff = records[ffGuid];
    const kids = (ff?.children || []).filter((g) => records[g] && isSupported(records[g]));
    for (const g of kids) {
      const r = records[g];
      const isFolder = r.type === "folder";
      let n = map[g] && (await nodeOf(map[g]));
      if (n && !!n.url === isFolder) { await api.removeTree(n.id).catch(() => {}); stats.removed++; n = null; }
      if (!n) {
        n = await api.create(isFolder ? { parentId, title: r.title || "" } : { parentId, title: r.title || r.bmkUri, url: r.bmkUri });
        nodes.set(n.id, n);
        map[g] = n.id;
        stats.created++;
      } else {
        const changes = {};
        if ((n.title || "") !== (r.title || (isFolder ? "" : r.bmkUri))) changes.title = r.title || (isFolder ? "" : r.bmkUri);
        if (!isFolder && n.url !== r.bmkUri) changes.url = r.bmkUri;
        if (Object.keys(changes).length) { await api.update(n.id, changes); stats.updated++; }
        if (n.parentId !== parentId) { await api.move(n.id, { parentId }); stats.moved++; }
      }
      if (isFolder) await syncFolder(g, n.id, false);
    }
    await order(parentId, kids.map((g) => map[g]), shared);
  }

  // Put mirrored children in Firefox order. Browser-owned children keep their
  // order: first in shared roots, last inside mirrored folders.
  async function order(parentId, wanted, shared) {
    const current = (await api.getChildren(parentId)).map((c) => c.id);
    const mine = new Set(Object.values(map));
    const foreign = current.filter((id) => !mine.has(id));
    const desired = shared ? [...foreign, ...wanted] : [...wanted, ...foreign];
    const cur = current.slice();
    for (let i = 0; i < desired.length; i++) {
      if (cur[i] === desired[i]) continue;
      const from = cur.indexOf(desired[i]);
      if (from < 0) continue;
      await api.move(desired[i], { parentId, index: i });   // always moves *up*: index is exact
      cur.splice(from, 1);
      cur.splice(i, 0, desired[i]);
      stats.moved++;
    }
  }

  try {
    for (const [g, parentId, shared] of targets) await syncFolder(g, parentId, shared);
  } finally {
    await storage.set({ [MAP_KEY]: { uid, map } });
  }
  return stats;
}

/** Remove everything the mirror created (when mirroring is turned off). */
export async function removeAll({ api = chrome.bookmarks, storage = chrome.storage.local } = {}) {
  const stored = (await storage.get(MAP_KEY))[MAP_KEY];
  let removed = 0;
  for (const id of Object.values(stored?.map || {})) {
    try { await api.removeTree(id); removed++; } catch {}
  }
  await storage.remove(MAP_KEY);
  return removed;
}

// Separators/queries/livemarks have no browser equivalent; place: URLs can't be opened.
function isSupported(r) {
  if (!r) return false;
  if (r.type === "folder") return true;
  return r.type === "bookmark" && !!r.bmkUri && !/^place:/i.test(r.bmkUri);
}
