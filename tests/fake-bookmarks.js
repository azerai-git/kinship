// Fake chrome.bookmarks with Chrome's real move semantics (tests only).
export function fakeBookmarks(initial) {
  let next = 100;
  const nodes = new Map();
  const add = (n, parentId) => {
    const node = { id: n.id || String(next++), title: n.title || "", parentId, ...(n.url ? { url: n.url } : { children: [] }), folderType: n.folderType };
    nodes.set(node.id, node);
    if (parentId) nodes.get(parentId).children.push(node.id);
    for (const c of n.children || []) add(c, node.id);
    return node;
  };
  add({ id: "0", children: initial });
  const view = (id) => {
    const n = nodes.get(id);
    const p = n.parentId ? nodes.get(n.parentId) : null;
    const v = { id: n.id, title: n.title, parentId: n.parentId, index: p ? p.children.indexOf(id) : undefined };
    if (n.url) v.url = n.url; else v.children = n.children.map(view);
    if (n.folderType) v.folderType = n.folderType;
    return v;
  };
  const shallow = (id) => { const v = view(id); if (v.children) delete v.children; return v; };
  const need = (id) => { const n = nodes.get(id); if (!n) throw new Error("Can't find bookmark for id."); return n; };
  const api = {
    calls: 0,
    async getTree() { return [view("0")]; },
    async get(id) { return [shallow(need(id).id)]; },
    async getChildren(id) { return need(id).children.map(shallow); },
    async create({ parentId, title, url, index }) {
      api.calls++;
      const p = need(parentId);
      const n = add({ title, url, children: url ? undefined : [] }, null);
      n.parentId = parentId;
      p.children.splice(index ?? p.children.length, 0, n.id);
      return shallow(n.id);
    },
    async update(id, { title, url }) { api.calls++; const n = need(id); if (title !== undefined) n.title = title; if (url !== undefined) n.url = url; return shallow(id); },
    async move(id, { parentId, index }) {
      api.calls++;
      const n = need(id);
      const oldP = nodes.get(n.parentId), oldIdx = oldP.children.indexOf(id);
      const newP = need(parentId ?? n.parentId);
      oldP.children.splice(oldIdx, 1);
      let i = index ?? newP.children.length;
      if (newP === oldP && index !== undefined && index > oldIdx) i--;   // Chrome quirk
      newP.children.splice(i, 0, id);
      n.parentId = newP.id;
      return shallow(id);
    },
    async remove(id) { return api.removeTree(id); },
    async removeTree(id) {
      api.calls++;
      const n = need(id);
      const drop = (x) => { const m = nodes.get(x); (m.children || []).forEach(drop); nodes.delete(x); };
      nodes.get(n.parentId).children.splice(nodes.get(n.parentId).children.indexOf(id), 1);
      drop(id);
    },
    // test helper: titles/urls tree under a node
    dump(id) { const n = nodes.get(id); return n.url ? n.title : { [n.title]: n.children.map((c) => api.dump(c)) }; },
    titles(id) { return nodes.get(id).children.map((c) => nodes.get(c).title); },
    find(title) { return [...nodes.values()].find((n) => n.title === title); },
  };
  return api;
}

