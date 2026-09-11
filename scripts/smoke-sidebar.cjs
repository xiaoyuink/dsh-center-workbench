/**
 * Regression smoke test: the client half registers the four official right-Sidebar tabs.
 *
 * Run: node scripts/smoke-sidebar.cjs   (needs jsdom; set JSDOM_PATH if it lives elsewhere)
 *
 * Simulates the new-DSH client environment (sidebarRightTabs + sidebarRight +
 * slots), loads the bundle, runs apply(), then mounts every registered tab body
 * with react-dom/server to prove each one renders without throwing.
 */
const path = require('path');
const PLUGIN = path.resolve(__dirname, '..'); // 测试始终针对本仓库里的 lib/client.js
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');

const html = '<!doctype html><html><body>' +
  '<div data-pane="sidebar"><div class="logoRow"><button class="newSessionBtn">新建会话</button></div><nav></nav></div>' +
  '<div data-dsh-center-col></div></body></html>';
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3280/' });
const w = dom.window;
global.window = w; global.document = w.document; global.navigator = w.navigator;
global.localStorage = w.localStorage; global.MutationObserver = w.MutationObserver;
global.HTMLElement = w.HTMLElement; global.Element = w.Element; global.Node = w.Node;
global.Event = w.Event; global.MouseEvent = w.MouseEvent;
global.getComputedStyle = w.getComputedStyle.bind(w);
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
w.requestAnimationFrame = global.requestAnimationFrame;
global.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
w.ResizeObserver = global.ResizeObserver;

const fetchCalls = [];
global.fetch = (url, init) => {
  fetchCalls.push(String(url));
  const u = String(url);
  if (u.includes('/tree')) {
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, entries: [
      { name: 'src', isDir: true, size: 0 },
      { name: 'README.md', isDir: false, size: 1200 },
    ] }) });
  }
  if (u.includes('/drives')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, drives: [] }) });
  if (u.includes('/api/dsh-workbench/file?')) {
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, text: '# 工作台 README\n\n内容示例。' }) });
  }
  if (u.includes('/env')) return Promise.resolve({ json: () => Promise.resolve({ ok: true, home: '/home/sya', platform: 'linux', sep: '/' }) });
  return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
};
w.fetch = global.fetch;

const errors = [];
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };

let factory;
w.__ModuleLoader__ = { load: (o) => { factory = o.factory; } };
require(path.join(PLUGIN, 'lib/client.js'));
const mod = factory((id) => {
  if (id === 'react') return require(path.join(PLUGIN, 'node_modules/react'));
  if (id === 'react-dom/client') return require(path.join(PLUGIN, 'node_modules/react-dom/client'));
  if (id === '@deepseek-ai/dsh-client-ui-primitives') { const e = new Error('not available'); e.code = 'MODULE_NOT_FOUND'; throw e; }
  throw new Error('unexpected require: ' + id);
});
const React = require(path.join(PLUGIN, 'node_modules/react'));
const { createRoot } = require(path.join(PLUGIN, 'node_modules/react-dom/client'));
const { act } = require(path.join(PLUGIN, 'node_modules/react-dom/test-utils'));

// React 18 requires this flag for act() in a non-test framework environment.
global.IS_REACT_ACT_ENVIRONMENT = true;

/** Mount one component under act() and return its rendered text. */
async function mountAndRead(type, props) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(React.createElement(type, props)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const text = host.textContent || '';
  await act(async () => { root.unmount(); });
  host.remove();
  return text;
}

const flush = (ms) => new Promise((r) => setTimeout(r, ms || 30));

// ---- fake client ctx: sessions + slots + sidebarRight(Tabs) -----------------
const listeners = new Set();
let snapshot = {
  byId: { root: { id: 'root', displayTitle: '主会话', origin: 'user', running: true, cwd: '/home/sya/project/workbench插件' } },
  current: 'root', jobsBySession: {}, subagentsByParent: {},
};
const sessions = {
  list: { subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }, getSnapshot() { return snapshot; } },
  setSubagentCatalogOpen() {}, refreshSubagents() {}, openSubagent() {},
  subagentAddress() { return undefined; }, open() {},
};

const registeredTabs = [];
const registeredSlots = [];
const disposers = [];
function fakeSlots() {
  return {
    inject(name, cb) { disposers.push(() => {}); return cb(); },
    register(opts, Comp) { registeredSlots.push({ opts, Comp }); return () => {}; },
  };
}
function fakeTabs() {
  return {
    register(def) { registeredTabs.push(def); return () => {}; },
  };
}
const sidebarRightCalls = [];
const openResourceCalls = [];
const sidebarRight = {
  openTab(kind, options) { sidebarRightCalls.push({ kind, options }); },
  openResource(address, options) { openResourceCalls.push({ address, options }); }, close() {}, active() { return undefined; }, isExpanded() { return false; },
  toggleExpanded() {}, focus() {}, split() { return undefined; }, float() {}, dock() {},
};
const ctx = {
  get(n) {
    if (n === 'sessions') return sessions;
    if (n === 'sidebarRightTabs') return tabs;
    if (n === 'sidebarRight') return sidebarRight;
    return undefined;
  },
  effect(fn) { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {}; },
  on() { return () => {}; },
  slots: fakeSlots(),
};
const tabs = fakeTabs();

function assert(cond, msg) {
  if (cond) { console.log('  ✓ ' + msg); } else { console.log('  ✗ ' + msg); process.exitCode = 1; }
}

(async () => {
  console.log('== sidebar mode: apply() ==');
  mod.apply(ctx);
  await flush();

  const kinds = registeredTabs.map((d) => d.kind);
  assert(registeredTabs.length === 5, 'registered 5 tab types (got ' + registeredTabs.length + ': ' + kinds.join(', ') + ')');
  assert(JSON.stringify(kinds) === JSON.stringify([
    'dsh-workbench-explorer', 'dsh-workbench-browser', 'dsh-workbench-terminal', 'dsh-workbench-tasks', 'dsh-workbench-preview',
  ]), 'kinds are the four workbench tabs plus the file-preview tab');
  const previewType = registeredTabs.find((d) => d.kind === 'dsh-workbench-preview');
  assert(!!previewType && (previewType.patterns || []).indexOf('dsh-resource://workbench-preview/**') >= 0,
    'the preview type claims dsh-resource://workbench-preview/**');
  assert(previewType.title('dsh-resource://workbench-preview/' + encodeURIComponent('/a/b/README.md')) === 'README.md',
    'a preview tab is titled after the file name');
  assert(!previewType.guide, 'the preview type stays off the guide page');
  assert(registeredTabs.every((d) => d.priority === 'extension'), 'all register in the extension band');
  assert(registeredTabs.every((d) => d.id.startsWith('dsh-workbench/')), 'ids are namespaced under the package');
  const guides = registeredTabs.filter((d) => d.guide).map((d) => (d.guide || [])[0]);
  assert(guides.length === 4 && guides.every((g) => g && typeof g.title === 'function' && typeof g.icon === 'function'),
    'each page type contributes one guide entry with an icon (got ' + guides.length + ')');
  assert(guides[0].title() === '资源管理器', 'explorer guide title (got ' + guides[0].title() + ')');
  assert(guides.map((g) => g.order).join(',') === '30,31,32,33', 'guide orders are 30..33');
  assert(document.documentElement.hasAttribute('data-dsh-cw-sidebar'), 'html[data-dsh-cw-sidebar] set (hides the old middle-column switch)');

  const bodies = registeredSlots.filter((s) => s.opts.name === 'sidebar.right.pane.tab');
  assert(bodies.length === 5, 'registered 5 tab bodies (got ' + bodies.length + ')');
  assert(bodies.every((b) => b.opts.key.startsWith('dsh-workbench/')), 'body keys match the type ids');
  assert(registeredSlots.some((s) => s.opts.id === 'dsh-workbench-tab-action'), 'header action button registered');

  console.log('== mount each tab body ==');
  for (const b of bodies) {
    const key = b.opts.key;
    try {
      const props = Object.assign({}, b.opts.inject ? b.opts.inject() : {});
      const text = await mountAndRead(b.Comp, props);
      if (key.endsWith('/terminal')) {
        // xterm renders into a canvas/DOM tree with no text; presence is the signal.
        assert(true, key + ' mounts (terminal host renders, no text expected)');
      } else {
        assert(text.length > 0, key + ' mounts (' + text.length + ' chars: ' + JSON.stringify(text.slice(0, 60)) + ')');
      }
    } catch (e) {
      assert(false, key + ' threw: ' + (e && e.message));
    }
  }

  console.log('== header button element ==');
  const header = registeredSlots.find((s) => s.opts.id === 'dsh-workbench-tab-action');
  try {
    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    await act(async () => { root2.render(React.createElement(header.Comp, {})); });
    const button = host2.querySelector('[data-dsh-cw-header-action]');
    assert(button !== null, 'header button carries data-dsh-cw-header-action');
    await act(async () => { button.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
    assert(sidebarRightCalls.length === 1 && sidebarRightCalls[0].kind === 'dsh-workbench-explorer',
      'clicking opens/focuses the explorer tab (got ' + JSON.stringify(sidebarRightCalls) + ')');
    await act(async () => { root2.unmount(); });
    host2.remove();
  } catch (e) {
    assert(false, 'header action threw: ' + (e && e.message));
  }


  console.log('== explorer: open a file into the editor pane ==');
  try {
    const explorer = bodies.find((b) => b.opts.key.endsWith('/explorer'));
    const host3 = document.createElement('div');
    document.body.appendChild(host3);
    const root3 = createRoot(host3);
    await act(async () => { root3.render(React.createElement(explorer.Comp, explorer.opts.inject())); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    const rows = host3.querySelectorAll('.dsh-cs-row');
    assert(rows.length >= 2, 'tree rows rendered (' + rows.length + ')');
    const fileRow = [...rows].find((r) => (r.textContent || '').includes('README.md'));
    assert(!!fileRow, 'README.md row present');
    if (fileRow) {
      const before = openResourceCalls.length;
      await act(async () => {
        fileRow.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
      });
      await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
      assert(openResourceCalls.length === before + 1, 'double-click asks the sidebar to open a resource tab');
      const call = openResourceCalls[openResourceCalls.length - 1];
      assert(call.address === 'dsh-resource://workbench-preview/' + encodeURIComponent('/home/sya/project/workbench插件/README.md'),
        'address is the workbench preview address for that file (got ' + call.address + ')');
      assert(call.options && call.options.kind === 'dsh-workbench-preview', 'the call names our preview kind');
      assert(call.options && call.options.params && call.options.params.path === '/home/sya/project/workbench插件/README.md',
        'the file path rides along as a navigation param');
      assert(host3.querySelector('.dsh-cs-editor') === null, 'no preview pane is drawn inside the explorer tab (no bottom split)');
    }
    await act(async () => { root3.unmount(); });
    host3.remove();
  } catch (e) {
    assert(false, 'explorer interaction threw: ' + (e && e.message));
  }



  console.log('== file-preview tab body reads tabInfo (direct prop) ==');
  try {
    const previewBody = registeredSlots.find((s) => s.opts.key === 'dsh-workbench/preview');
    assert(!!previewBody, 'preview body is registered');
    const address = 'dsh-resource://workbench-preview/' + encodeURIComponent('/home/sya/project/workbench插件/README.md');
    const closed = [];
    const useTabInfo = () => ({
      sidebar: { expanded: true, fullscreen: false },
      panel: { id: 'pane-1' },
      tab: {
        id: 'tab-1', kind: 'dsh-workbench-preview',
        navigation: { address: address, params: { path: '/home/sya/project/workbench插件/README.md' }, revision: 1 },
        visible: true,
        actions: { close: () => closed.push('close'), openResource() {}, openTab() {} },
      },
    });
    const host4 = document.createElement('div');
    document.body.appendChild(host4);
    const root4 = createRoot(host4);
    await act(async () => {
      root4.render(React.createElement(previewBody.Comp, Object.assign({ useTabInfo }, previewBody.opts.inject())));
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    const text = host4.textContent || '';
    assert(text.indexOf('没有可预览的文件') < 0, 'does not fall back to the empty notice when tabInfo exists');
    const textarea = host4.querySelector('.dsh-cs-editor-textarea');
    assert(!!textarea && textarea.value.indexOf('(加载中…)') < 0 && textarea.value.length > 0,
      'renders the file content in an editable body');
    const note = host4.querySelector('.dsh-cs-editor-note');
    assert(!!note && note.textContent.indexOf('README.md') >= 0, 'header shows the absolute path');
    await act(async () => { root4.unmount(); });
    host4.remove();
  } catch (e) {
    assert(false, 'preview body threw: ' + (e && e.message));
  }


  console.log('== preview content is cached across tab remounts ==');
  try {
    const previewBody = registeredSlots.find((s) => s.opts.key === 'dsh-workbench/preview');
    const CACHE_PATH = '/home/sya/project/workbench插件/scripts/缓存用例.md';
    const address = 'dsh-resource://workbench-preview/' + encodeURIComponent(CACHE_PATH);
    const mk = (id) => {
      const useTabInfo = () => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' },
        tab: { id, kind: 'dsh-workbench-preview',
          navigation: { address, params: { path: CACHE_PATH }, revision: 1 },
          visible: true, actions: { close() {}, openResource() {}, openTab() {} } },
      });
      return useTabInfo;
    };
    const fileCalls = () => fetchCalls.filter((u) => u.indexOf('/api/dsh-workbench/file?') === 0).length;
    const mediaBefore = fetchCalls.filter((u) => u.indexOf('/media?') >= 0).length;

    const before = fileCalls();
    const h1 = document.createElement('div'); document.body.appendChild(h1);
    const r1 = createRoot(h1);
    await act(async () => { r1.render(React.createElement(previewBody.Comp, Object.assign({ useTabInfo: mk('tab-a') }, previewBody.opts.inject()))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    const firstReads = fileCalls() - before;
    assert(firstReads === 1, 'first open reads the file once (got ' + firstReads + ')');
    await act(async () => { r1.unmount(); });           // 切走：正文被卸载
    h1.remove();

    const h2 = document.createElement('div'); document.body.appendChild(h2);
    const r2 = createRoot(h2);
    await act(async () => { r2.render(React.createElement(previewBody.Comp, Object.assign({ useTabInfo: mk('tab-a') }, previewBody.opts.inject()))); });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
    const afterSwitch = fileCalls() - before;
    assert(afterSwitch === 1, 'switching back does NOT read the file again (still ' + afterSwitch + ' read)');
    const ta = h2.querySelector('.dsh-cs-editor-textarea');
    assert(!!ta && ta.value.indexOf('工作台 README') >= 0, 'content comes straight from the cache');
    await act(async () => { r2.unmount(); });
    h2.remove();
    assert(fetchCalls.filter((u) => u.indexOf('/media?') >= 0).length === mediaBefore, 'no media request for a text preview');
  } catch (e) {
    assert(false, 'preview cache test threw: ' + (e && e.message));
  }


  console.log('== preview tab keeps its rendered tree across tab switches ==');
  try {
    const previewBody = registeredSlots.find((s) => s.opts.key === 'dsh-workbench/preview');
    const P1 = '/home/sya/project/workbench插件/src/一.md';
    const P2 = '/home/sya/project/workbench插件/src/二.md';
    const infos = {};
    const tabInfoFor = (tabId, filePath) => {
      infos[tabId] = infos[tabId] || (() => ({
        sidebar: { expanded: true, fullscreen: false }, panel: { id: 'pane-1' },
        tab: { id: tabId, kind: 'dsh-workbench-preview',
          navigation: { address: 'dsh-resource://workbench-preview/' + encodeURIComponent(filePath), params: { path: filePath }, revision: 1 },
          visible: true, actions: { close() {}, openResource() {}, openTab() {} } },
      }));
      return infos[tabId];
    };

    // 外壳（标签正文）在 React 里重新渲染时，返回的必须还是同一个元素对象——
    // React 据此复用已有的组件实例（不重新挂载、不重新解码）。
    const memoRefs = [];
    const Probe = () => {
      const el = previewBody.Comp(Object.assign({ useTabInfo: tabInfoFor('tab-x', P1) }, previewBody.opts.inject()));
      memoRefs.push(el); // 这里是外壳刚返回的元素（React 还没渲染它）
      return el;
    };
    const hostP = document.createElement('div'); document.body.appendChild(hostP);
    const rootP = createRoot(hostP);
    let forceProbe = () => {};
    const Rerenderable = () => {
      const [, force] = React.useState(0);
      forceProbe = () => force((n) => n + 1);
      return React.createElement(Probe, {});
    };
    await act(async () => { rootP.render(React.createElement(Rerenderable, {})); });
    await act(async () => { forceProbe(); });
    assert(memoRefs.length >= 2 && memoRefs[0] === memoRefs[memoRefs.length - 1],
      'the shell hands React the same element object on every render (renders=' + memoRefs.length + ')');
    await act(async () => { rootP.unmount(); });
    hostP.remove();

    // 不同标签各有各的缓存元素
    const memoY = [];
    const memoX = [];
    const Probe2 = () => {
      memoY.push(previewBody.Comp(Object.assign({ useTabInfo: tabInfoFor('tab-y', P2) }, previewBody.opts.inject())));
      memoX.push(previewBody.Comp(Object.assign({ useTabInfo: tabInfoFor('tab-x', P1) }, previewBody.opts.inject())));
      return React.createElement(React.Fragment, null, memoX[memoX.length - 1], memoY[memoY.length - 1]);
    };
    const hostQ = document.createElement('div'); document.body.appendChild(hostQ);
    const rootQ = createRoot(hostQ);
    await act(async () => { rootQ.render(React.createElement(Probe2, {})); });
    assert(memoX[0] !== memoY[0], 'a different tab gets its own cached element');
    await act(async () => { rootQ.unmount(); });
    hostQ.remove();
  } catch (e) {
    assert(false, 'element-cache test threw: ' + (e && e.message));
  }

  console.log('== sidebar services arrive late (probe retry, no fallback) ==');
  try {
    const lateSlots = [];
    const lateTabs = { register(def) { lateSlots.push(def); return () => {}; } };
    const lateRight = { openTab() {}, active() { return undefined; }, isExpanded() { return false; } };
    let ready = false;
    const lateCtx = {
      get(n) {
        if (!ready) return undefined;
        if (n === 'sessions') return sessions;
        if (n === 'sidebarRightTabs') return lateTabs;
        if (n === 'sidebarRight') return lateRight;
        return undefined;
      },
      effect(fn) { const d = fn(); return () => {}; },
      on() { return () => {}; },
      slots: fakeSlots(),
    };
    mod.apply(lateCtx);
    await flush(120);
    assert(lateSlots.length === 0, 'nothing registered while the services are absent');
    ready = true; // 服务此刻才提供，落在探测窗口内
    await flush(400);
    assert(lateSlots.length === 5, 'tabs registered after the services appear (got ' + lateSlots.length + ')');
    assert(document.querySelector('[data-dsh-cs-host-root]') === null, 'no middle column mounted on the late-service path');
  } catch (e) {
    assert(false, 'late-service path threw: ' + (e && e.message));
  }

  console.log('== legacy mode (no sidebar services) ==');
  const legacyErrors = [];
  const legacyCtx = {
    get() { return undefined; },
    effect(fn) { const d = fn(); return () => {}; },
    on() { return () => {}; },
    slots: fakeSlots(),
  };
  try {
    mod.apply(legacyCtx);
    await flush(3600); // 服务探测窗口（20 × 150ms）结束后才回退中部栏
    assert(document.querySelector('[data-dsh-workbench-entry]') !== null, 'legacy middle-column switch mounted');
    assert(document.querySelector('[data-dsh-cs-host-root]') !== null, 'legacy middle-column panel host mounted');
  } catch (e) {
    assert(false, 'legacy apply threw: ' + (e && e.message));
  }

  await flush(50);
  const realErrors = errors.filter((e) => !/Warning:/.test(e) && !/unique "key"/.test(e));
  assert(realErrors.length === 0, 'no real console.error (' + (realErrors.length ? realErrors.join(' | ') : 'clean; ' + errors.length + ' React warnings ignored') + ')');
  console.log('\ndone.');
})();
