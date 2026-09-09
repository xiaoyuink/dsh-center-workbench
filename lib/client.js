/**
 * dsh-center-workbench Client half —— 独立中栏面板。
 *
 * 这是一个自带中栏文件浏览面板的插件（不依赖 dsh-better-sidebar）：
 *   - 把「中部栏」开关以侧边栏导航项的形式插入侧边栏根，紧跟生图插件按钮下方
 *     （与生图插件同款做法：直接操作 DOM + MutationObserver 自修复）；
 *   - 开关打开时，在窗口正中央渲染一个文件浏览面板（文件树 + 预览），
 *     并把对话栏向右推到面板右边缘；
 *   - 面板可拖动调整宽度、可关闭；开关状态与宽度持久化到 localStorage。
 *
 * 手写 window.__ModuleLoader__.load bundle（持久化插件形态），无 JSX（React.createElement）。
 */
window.__ModuleLoader__.load({
  id: "dsh-center-workbench",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var React = require("react");
    var ReactDOMClient = require("react-dom/client");
    // 可选加载 ui-primitives（Markdown 预览用 MarkdownText）；缺失则 Markdown 回退 <pre>。
    var primitives = null;
    try { primitives = require("@deepseek-ai/dsh-client-ui-primitives"); } catch (e) {}
    var createElement = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useCallback = React.useCallback;
    var useMemo = React.useMemo;
    var useSyncExternalStore = React.useSyncExternalStore;
    var useLayoutEffect = React.useLayoutEffect;

    // 客户端不再使用 slot 注册（中部栏开关/面板均直接操作 DOM），无需注入 slots。
    var inject = [];

    // ===== 面板状态（模块级共享：脚注开关 + 面板组件读写同一份） =====
    var WIDTH_KEY = "dsh-center-workbench:width";
    var TABORDER_KEY = "dsh-center-workbench:tabOrder";
    // 每次重开 DSH 都默认关闭中部栏（不持久化"打开"状态）；宽度仍持久化。
    var state = { open: false, width: readWidth() };
    // 编辑器状态（抬到模块级，供"关闭文件/关闭中部栏"时的未保存判断与保存）。
    var editorState = { path: "", text: "", dirty: false, editable: false };
    // 跨平台默认根目录：apply() 会从宿主 /env 拉取（Windows 为 C:\Users\xxx），
    // 仅当会话 cwd 缺失时作为兜底，不再写死 /home/sya。
    var defaultHome = "/home/sya";
    /** 标签默认顺序。 */
    var DEFAULT_TAB_ORDER = ["explorer", "browser", "terminal", "tasks"];
    /** 从 localStorage 读取上次的标签顺序（校验为合法的全量顺序，否则回退默认）。 */
    function readTabOrder() {
      try {
        var raw = localStorage.getItem(TABORDER_KEY);
        if (raw) {
          var arr = JSON.parse(raw);
          if (Array.isArray(arr) && arr.length === DEFAULT_TAB_ORDER.length
            && new Set(arr).size === DEFAULT_TAB_ORDER.length
            && arr.every(function (t) { return DEFAULT_TAB_ORDER.indexOf(t) >= 0; })) {
            return arr;
          }
        }
      } catch (e) { /* ignore */ }
      return DEFAULT_TAB_ORDER.slice();
    }

    // 「自动弹出后台任务页」偏好（对齐 better-sidebar 的 autoOpenJobs / autoOpenSubagent，
    // 默认开；本地持久化，无设置页时在后台任务页头部一键切换）。
    var AUTOOPEN_KEY = "dsh-center-workbench:autoOpenTasks";
    function readAutoOpenTasks() {
      try { if (localStorage.getItem(AUTOOPEN_KEY) === "0") return false; } catch (e) { /* ignore */ }
      return true;
    }
    function persistAutoOpenTasks(v) {
      try { localStorage.setItem(AUTOOPEN_KEY, v ? "1" : "0"); } catch (e) { /* ignore */ }
    }

    function readWidth() {
      var v = 400;
      try { var raw = localStorage.getItem(WIDTH_KEY); if (raw) v = parseInt(raw, 10) || 400; } catch (e) { /* ignore */ }
      return Math.max(280, Math.min(v, Math.max(280, window.innerWidth - 320)));
    }
    function persistWidth(w) {
      try { localStorage.setItem(WIDTH_KEY, String(w)); } catch (e) { /* ignore */ }
    }

    var subscribers = new Set();
    var isDragging = false;
    function emit() { subscribers.forEach(function (fn) { fn(); }); }
    function subscribe(fn) { subscribers.add(fn); return function () { subscribers.delete(fn); }; }
    function getState() { return state; }
    // —— 自定义对话框（替代浏览器原生 prompt/confirm/alert）——
    var dialogState = null;
    var dialogSubs = new Set();
    function dialogSubscribe(fn) { dialogSubs.add(fn); return function () { dialogSubs.delete(fn); }; }
    function dialogGet() { return dialogState; }
    function showDialog(opts) {
      return new Promise(function (resolve) {
        dialogState = { opts: opts, resolve: resolve };
        dialogSubs.forEach(function (fn) { fn(); });
      });
    }
    function closeDialog(value) {
      var d = dialogState;
      dialogState = null;
      if (d && d.resolve) d.resolve(value);
      dialogSubs.forEach(function (fn) { fn(); });
    }
    var lastMenuPos = null;
    function confirmDlg(message, pos) { return showDialog({ kind: "confirm", message: message, pos: pos || lastMenuPos }); }
    function promptDlg(message, defaultValue, pos) { return showDialog({ kind: "prompt", message: message, defaultValue: defaultValue || "", pos: pos || lastMenuPos }); }
    function alertDlg(message, pos) { return showDialog({ kind: "alert", message: message, pos: pos || lastMenuPos }); }
    // —— 进度条（导入/导出等长任务）——
    var progressState = null;
    var progressSubs = new Set();
    function progressSubscribe(fn) { progressSubs.add(fn); return function () { progressSubs.delete(fn); }; }
    function progressGet() { return progressState; }
    function showProgress(label, total) {
      progressState = { label: label, total: total || 0, done: 0 };
      progressSubs.forEach(function (fn) { fn(); });
    }
    function updateProgress(done, label) {
      if (!progressState) return;
      progressState = { label: label !== undefined ? label : progressState.label, total: progressState.total, done: done };
      progressSubs.forEach(function (fn) { fn(); });
    }
    function hideProgress() {
      progressState = null;
      progressSubs.forEach(function (fn) { fn(); });
    }
    function setOpen(open) {
      if (state.open === open) return;
      state = { ...state, open: open };
      if (!open) editorState = { path: "", text: "", dirty: false, editable: false };
      emit();
      applyLayout();
    }
    /** 关闭中部栏：若有未保存的编辑器改动，先确认"是否保存"（是→保存），然后关闭。 */
    function requestPanelClose() {
      if (editorState.dirty && editorState.path) {
        confirmDlg("文件有未保存的改动，是否保存？").then(function (ok) {
          if (ok) {
            const p = editorState.path;
            const t = editorState.text;
            saveFile(p, t).then(function () { setOpen(false); }).catch(function () { setOpen(false); });
            return;
          }
          setOpen(false);
        });
        return;
      }
      setOpen(false);
    }
    function toggleOpen() {
      if (state.open) requestPanelClose();
      else setOpen(true);
    }
    function setWidth(width) {
      var w = clampWidth(width);
      if (state.width === w) return;
      state = { ...state, width: w };
      persistWidth(w);
      emit();
      applyLayout();
    }

    // ===== 对话栏右移：把对话栏内容从「面板右边缘」开始 =====
    // DSH 的对话槽外层 [data-slot="conversation"] 是 slot host，多半是
    // display:contents，直接给它加 padding 无效；真正承载布局的主列是它的
    // 父级（AppFrame 的 centerCol，一个真正的 grid/flex 盒）。所以把右移量
    // 加到父级列上，并给它打上 [data-dsh-center-workbench-conv] 标记便于调试/CSS。
    function convColumn() {
      try {
        var selectors = ['#root [data-slot="conversation"]', '[data-slot="conversation"]'];
        for (var i = 0; i < selectors.length; i++) {
          var conv = document.querySelector(selectors[i]);
          if (conv && conv.parentElement) return conv.parentElement;
        }
        return null;
      } catch (e) { return null; }
    }
    function applyLayout() {
      var col = convColumn();
      if (!state.open || !col) {
        if (col) { col.removeAttribute("data-dsh-center-workbench-conv"); col.style.paddingLeft = ""; }
        document.documentElement.style.setProperty("--dsh-center-pad", "0px");
        document.documentElement.style.setProperty("--dsh-center-workbench-left", "0px");
        return;
      }
      col.setAttribute("data-dsh-center-workbench-conv", "");
      // 主列（AppFrame 的 centerCol）左边缘 = 左侧栏右边缘。面板锚定在那里，
      // 对话栏向右推「面板宽度」，从而形成 [左侧栏 | 中部栏 | 对话栏] 三段式，
      // 面板左边缘与左侧栏对齐，无左侧留白。
      var left = col.getBoundingClientRect().left || 0;
      var width = Math.min(state.width, Math.max(0, window.innerWidth - left));
      document.documentElement.style.setProperty("--dsh-center-workbench-left", left + "px");
      document.documentElement.style.setProperty("--dsh-center-pad", width + "px");
      col.style.paddingLeft = width + "px";
    }
    /** 面板宽度上限：视口宽 - 左侧栏宽 - 对话栏最小宽度(320)。 */
    function clampWidth(width) {
      var left = 0;
      try { var col = convColumn(); left = col ? Math.round(col.getBoundingClientRect().left) : 0; } catch (e) { /* 0 */ }
      var max = Math.max(280, window.innerWidth - left - 320);
      return Math.max(280, Math.min(Math.round(width), max));
    }
    /** 直接落地对话栏右移量（拖拽时绕过 React 状态，保证实时跟手）。 */
    function applyPad(width) {
      var col = convColumn();
      var w = Math.max(0, Math.round(width));
      if (col) col.style.paddingLeft = w + "px";
      document.documentElement.style.setProperty("--dsh-center-pad", w + "px");
    }

    // ===== 全局样式 =====
    var CSS_TEXT = [
      "/* dsh-center-workbench: 独立中栏面板 */",
      ".dsh-cs-host{position:fixed;inset:0;z-index:25;pointer-events:none}",
      "/* 对话栏主列右移量（由 applyLayout 写入 --dsh-center-pad） */",
      "[data-dsh-center-workbench-conv]{padding-left:var(--dsh-center-pad,0px)}",
      ".dsh-cs-panel{position:absolute;top:0;bottom:0;left:var(--dsh-center-workbench-left,0px);transform:none;",
      "  pointer-events:auto;display:flex;flex-direction:column;overflow:hidden;",
      "  background:var(--dsw-alias-bg-layer-1);",
      "  border-left:1px solid var(--dsw-alias-border-l2);border-right:1px solid var(--dsw-alias-border-l2);",
      "  transition:transform var(--ds-transition-duration-slow) var(--ds-ease-in-out),width var(--ds-transition-duration-slow) var(--ds-ease-in-out);}",
      ".dsh-cs-panel.dsh-cs-hidden{transform:translateY(-110%);pointer-events:none;visibility:hidden}",
      ".dsh-cs-header{flex:none;height:36px;display:flex;align-items:center;gap:8px;padding:0 10px;",
      "  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}",
      ".dsh-cs-title{flex:1;min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);",
      "  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-cs-close{width:28px;height:28px;border:none;border-radius:50%;background:transparent;",
      "  color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none}",
      ".dsh-cs-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-resize{position:absolute;right:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:2;touch-action:none}",
      ".dsh-cs-resize:hover,.dsh-cs-resize[data-dragging]{background:var(--dsw-alias-interactive-bg-hover-accent)}",
      "/* 资源管理器横向双栏：左=文件夹导航，右=文件编辑 */",
      ".dsh-cs-content{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dsh-cs-explorer{flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden}",
      ".dsh-cs-browser{flex:1 1 50%;min-width:0;display:flex;flex-direction:column;overflow:hidden}",
      ".dsh-cs-browser-bar{flex:none;display:flex;align-items:center;gap:4px;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-cs-browser-up{flex:none;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;",
      "  background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      ".dsh-cs-browser-up:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-browser-path{flex:1;min-width:0;white-space:normal;overflow-wrap:break-word;",
      "  font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;flex-wrap:wrap;gap:2px}",
      ".dsh-cs-crumb{flex:none;max-width:220px;height:22px;padding:2px 5px;border:none;border-radius:6px;background:transparent;",
      "  color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-browser-body{flex:1;min-height:0;overflow:auto;padding:4px 8px}",
      ".dsh-cs-browser-drive{flex:none;height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;",
      "  background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}",
      "/* 左右分栏分隔条 */",
      ".dsh-cs-divider{flex:none;width:8px;cursor:col-resize;touch-action:none;position:relative;z-index:3;",
      "  background:var(--dsw-alias-bg-layer-1)}",
      ".dsh-cs-divider::after{content:'';position:absolute;top:0;bottom:0;left:50%;width:1px;cursor:col-resize;",
      "  transform:translateX(-50%);background:var(--dsw-alias-border-l1)}",
      ".dsh-cs-divider:hover::after,.dsh-cs-divider[data-dragging]::after{background:var(--dsw-alias-interactive-bg-hover-accent)}",
      ".dsh-cs-row{display:flex;align-items:center;gap:6px;box-sizing:border-box;width:100%;height:30px;",
      "  padding:0 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);",
      "  font:var(--dsw-font-xs-13);cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}",
      ".dsh-cs-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-row.dsh-cs-selected{outline:1px solid var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-1px}",
      ".dsh-cs-row-icon{flex:none;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-row-caret{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary);user-select:none}",
      ".dsh-cs-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-cs-row-size{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-empty{padding:16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center}",
      "/* 标签栏 */",
      ".dsh-cs-tabs{flex:none;display:flex;align-items:center;gap:2px;height:34px;padding:0 6px;",
      "  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}",
      ".dsh-cs-tab{flex:none;height:28px;padding:0 10px;border:none;border-radius:8px;background:transparent;",
      "  color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;",
      "  display:inline-flex;align-items:center;gap:4px}",
      ".dsh-cs-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-tab-badge{flex:none;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font:var(--dsw-font-xxs-strong-11);display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}",
      ".dsh-cs-tab[data-active]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-tab[draggable]{cursor:grab}",
      "/* 右键菜单 */",
      ".dsh-cs-menu-backdrop{position:fixed;inset:0;z-index:60;background:transparent}",
      ".dsh-cs-menu{position:fixed;z-index:61;min-width:140px;padding:4px;border:1px solid var(--dsw-alias-border-inverted);",
      "  border-radius:10px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv3);",
      "  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
      ".dsh-cs-menu-item{display:block;width:100%;box-sizing:border-box;padding:6px 12px;border:none;border-radius:7px;text-align:left;",
      "  background:transparent;color:inherit;font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap}",
      ".dsh-cs-menu-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-menu-item:disabled{opacity:.4;cursor:default}",
      ".dsh-cs-menu-item-danger{color:var(--dsw-alias-state-error-primary)}",
      ".dsh-cs-menu-sep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l1)}",
      "/* 自定义对话框 */",
      ".dsh-cs-modal{position:fixed;inset:0;z-index:200;pointer-events:auto}",
      ".dsh-cs-modal-backdrop{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1)}",
      ".dsh-cs-dialog{position:absolute;z-index:201;pointer-events:auto;min-width:300px;max-width:420px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);",
      "  border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-dialog-center{left:50%;top:50%;transform:translate(-50%,-50%)}",
      ".dsh-cs-dialog-title{font:var(--dsw-font-s-strong-14);margin-bottom:10px}",
      ".dsh-cs-dialog-body{font:var(--dsw-font-xs-13)}",
      ".dsh-cs-dialog-message{white-space:pre-wrap;word-break:break-word}",
      ".dsh-cs-dialog-input{box-sizing:border-box;width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;",
      "  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13)}",
      ".dsh-cs-dialog-input:focus{outline:none;border-color:var(--dsw-alias-border-l3)}",
      ".dsh-cs-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}",
      ".dsh-cs-dialog-btn{height:30px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;",
      "  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer}",
      ".dsh-cs-dialog-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-dialog-primary{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary)}",
      "/* 进度指示 */",
      ".dsh-cs-progress{position:fixed;inset:0;z-index:180;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}",
      ".dsh-cs-progress-box{width:360px;max-width:88vw;box-sizing:border-box;padding:16px 18px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-progress-title{font:var(--dsw-font-s-strong-14);margin-bottom:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-progress-track{position:relative;height:6px;border-radius:3px;background:var(--dsw-alias-border-l2);overflow:hidden}",
      ".dsh-cs-progress-fill{position:absolute;left:0;top:0;height:100%;background:var(--dsw-alias-interactive-bg-hover-accent);transition:width .12s ease}",
      ".dsh-cs-progress-fill.indeterminate{width:30%;animation:dsh-cs-progress-slide 1.1s ease-in-out infinite}",
      "@keyframes dsh-cs-progress-slide{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}",
      ".dsh-cs-progress-num{margin-top:8px;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);text-align:right}",
      "/* 编辑器 */",
      ".dsh-cs-editor{flex:1 1 50%;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-cs-editor-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-cs-editor-edit,.dsh-cs-editor-save,.dsh-cs-editor-close{flex:none;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;",
      "  background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer;white-space:nowrap}",
      ".dsh-cs-editor-edit:hover,.dsh-cs-editor-save:hover,.dsh-cs-editor-close:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-editor-edit-active{border-color:var(--dsw-alias-interactive-bg-hover-accent);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-editor-save[data-dirty]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}",
      ".dsh-cs-editor-close{margin-left:auto}",
      ".dsh-cs-editor-note{flex:1;min-width:0;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-cs-editor-textarea[readonly]{color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-editor-textarea{flex:1;min-height:0;border:none;outline:none;resize:none;padding:10px 14px;",
      "  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);",
      "  font:var(--dsw-font-xs-13);font-family:var(--ds-font-family-code);white-space:pre-wrap;overflow-wrap:anywhere;",
      "  word-break:break-word;overflow-y:auto;overflow-x:hidden;tab-size:2}",
      "/* 编辑器文件预览 */",
      ".dsh-cs-viewer{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;padding:10px}",
      ".dsh-cs-viewer-img{max-width:100%;max-height:100%;object-fit:contain}",
      ".dsh-cs-viewer-frame{flex:1;min-height:0;width:100%;border:none;background:var(--dsw-alias-bg-base)}",
      "/* PDF 预览：撑满容器，避免 iframe 默认矮高 */",
      ".dsh-cs-viewer-pdf{position:relative;flex:1;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}",
      ".dsh-cs-viewer-pdf .dsh-cs-viewer-frame{display:block;width:100%;height:100%;flex:none}",
      ".dsh-cs-viewer-pdf .dsh-cs-viewer-frame[style]{width:100%;height:100%}",
      "/* Office 预览（Word/Excel/CSV/PPT） */",
      ".dsh-cs-viewer-msg{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-viewer-pane{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}",
      ".dsh-cs-viewer-toolbar{flex:none;display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-cs-viewer-toolbar-label{font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary);margin-right:4px;white-space:nowrap}",
      ".dsh-cs-viewer-tool-btn{height:24px;min-width:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer}",
      ".dsh-cs-viewer-tool-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-viewer-tool-btn[data-on]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}",
      ".dsh-cs-viewer-tool-btn:disabled{opacity:.4;cursor:default}",
      ".dsh-cs-viewer-tool-spacer{flex:1}",
      ".dsh-cs-viewer-zoom-num{min-width:44px;text-align:center;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-viewer-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}",
      ".dsh-cs-viewer-text{font:var(--dsw-font-xs-13);font-family:var(--ds-font-family-code);white-space:pre-wrap;word-break:break-all;color:var(--dsw-alias-label-primary);margin:0}",
      ".dsh-cs-docx-mount{max-width:860px;margin:0 auto}",
      ".dsh-cs-docx-mount .docx-wrapper{background:transparent;box-shadow:none;padding:0}",
      ".dsh-cs-docx-mount .docx{box-shadow:var(--dsw-shadow-lv2)!important;margin-bottom:12px}",
      ".dsh-cs-ppt-mount{margin:0 auto;width:max-content}",
      "/* pptx-preview 列表模式：解除容器固定高（默认 540px 内滚），让多页平铺由外层滚动 */",
      ".dsh-cs-ppt-list .pptx-preview-wrapper{height:auto!important;overflow:visible!important}",
      ".dsh-cs-viewer-table{width:max-content;min-width:100%;border-collapse:collapse;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-viewer-table-fit{width:100%;min-width:0}",
      ".dsh-cs-viewer-table th,.dsh-cs-viewer-table td{border:1px solid var(--dsw-alias-border-l1);padding:4px 8px;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      "/* 表头吸顶：背景必须不透明（--dsw-alias-interactive-bg-hover 是半透明 token，",
      "   否则滚动内容会从表头底下透视出来，看起来像表头跟着内容移动） */",
      ".dsh-cs-viewer-table th{background:var(--dsw-alias-bg-layer-1);font-weight:600;position:sticky;top:0;box-shadow:inset 0 -1px 0 var(--dsw-alias-border-l2)}",
      ".dsh-cs-viewer-table td{background:var(--dsw-alias-bg-layer-1)}",
      ".dsh-cs-viewer-sheet{margin-bottom:14px}",
      ".dsh-cs-viewer-sheet-title{font:var(--dsw-font-s-strong-14);margin:0 0 6px;color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-viewer-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);text-align:center;padding:8px}",
      ".dsh-cs-md{flex:1;min-height:0;overflow:auto;padding:12px 16px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-unsupported{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}",
      ".dsh-cs-unsupported-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-unsupported-sub{max-width:80%;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-cs-md-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code)}",
      "/* 浏览器标签 */",
      ".dsh-cs-web{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}",
      ".dsh-cs-web-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      "/* SSH(ssh-ops) 嵌入：面板由 JS 内联钉位（含 transform 祖先坐标换算）；钉住前先隐藏防闪 */",
      ".dsh-cs-ssh-host{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;overflow:hidden}",
      ".dsh-cs-ssh-hint{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);text-align:center}",
      "html[data-dsh-cw-ssh-active] [data-dsh-ssh-ops-panel]{visibility:hidden}",
      "html[data-dsh-cw-ssh-active][data-dsh-ssh-ops-panel-open] [class*=\"centerCol\"]{margin-right:0!important}",
      ".dsh-cs-web-url{flex:1;min-width:0;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;",
      "  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}",
      ".dsh-cs-web-url:focus{outline:none;border-color:var(--dsw-alias-border-l2)}",
      ".dsh-cs-web-go{flex:none;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;",
      "  color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer}",
      ".dsh-cs-web-go:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-web-frame{flex:1;min-height:0;width:100%;border:none;background:var(--dsw-alias-bg-base)}",
      ".dsh-cs-note{padding:16px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center}",
      "/* 终端 */",
      ".dsh-cs-terminal{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);padding:2px 6px 6px}",
      ".dsh-cs-terminal.dsh-cs-terminal-hidden{display:none}",
      ".dsh-cs-terminal-mount{flex:1;min-height:0;position:relative;overflow:hidden}",
      ".dsh-cs-terminal-mount .xterm{height:100%}",
      ".dsh-cs-terminal-mount .xterm-viewport{background-color:transparent!important}",
      "/* 侧边栏导航入口「中部栏」（对齐生图插件按钮样式，插入侧边栏根） */",
      ".dsh-cs-sidebar-entry{box-sizing:border-box;width:100%;height:32px;border:none;border-radius:8px;background:transparent;",
      "  color:var(--dsw-alias-label-secondary);font-size:13px;display:flex;align-items:center;gap:8px;",
      "  padding:0 12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-align:left}",
      ".dsh-cs-sidebar-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-sidebar-entry[data-dsh-open=\"1\"]{background:var(--dsw-specific-sidebar-nav-item-active,var(--dsw-alias-interactive-bg-active));color:var(--dsw-alias-label-primary);font-weight:600}",
      ".dsh-cs-sidebar-entry-icon{flex:none;display:inline-flex;align-items:center;justify-content:center}",
      ".dsh-cs-sidebar-entry-label{flex:none;overflow:hidden;text-overflow:ellipsis}",
      "[data-dsh-frame][data-sidebar-collapsed] .dsh-cs-sidebar-entry{justify-content:center;width:100%;padding:0}",
      "[data-dsh-frame][data-sidebar-collapsed] .dsh-cs-sidebar-entry-label{display:none}",
      "/* 后台任务页：子代理拓扑 + 后台任务 */",
      ".dsh-cs-tasks{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:10px 12px}",
      ".dsh-cs-tasks-header{flex:none;display:flex;align-items:center;gap:8px;padding:2px 4px 8px}",
      ".dsh-cs-tasks-title{flex:none;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-tasks-count{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-tasks-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:4px}",
      ".dsh-cs-tasks-empty{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center;padding:18px 8px}",
      ".dsh-cs-tasks-tree{display:flex;flex-direction:column}",
      ".dsh-cs-task-node{display:flex;flex-direction:column}",
      ".dsh-cs-task-row{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:4px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;text-align:left;white-space:nowrap;overflow:hidden}",
      ".dsh-cs-task-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-task-row.dsh-cs-task-root{font-weight:600}",
      ".dsh-cs-task-row.dsh-cs-task-row-active{background:var(--dsw-alias-interactive-bg-active);box-shadow:inset 2px 0 0 var(--dsw-alias-interactive-bg-hover-accent)}",
      ".dsh-cs-task-row.dsh-cs-task-row-disabled{opacity:.6;cursor:default}",
      ".dsh-cs-task-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-dot-running{background:var(--dsw-alias-state-success-primary)}",
      ".dsh-cs-task-dot-done{background:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-dot-warn{background:var(--dsw-alias-state-warn-primary)}",
      ".dsh-cs-task-dot-error{background:var(--dsw-alias-state-error-primary)}",
      ".dsh-cs-task-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-task-secondary{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-children{margin-left:8px;border-left:1px solid var(--dsw-alias-border-l1);padding-left:6px}",
      ".dsh-cs-task-loading{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);padding:2px 8px}",
      ".dsh-cs-task-error{display:flex;align-items:center;gap:8px;padding:2px 8px;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxs-12)}",
      ".dsh-cs-task-error-retry{height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer}",
      ".dsh-cs-task-error-retry:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-task-live{display:flex;flex-direction:column;gap:2px;padding:2px 8px 4px 22px;margin-left:8px;border-left:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-live-tool{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-task-live-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      "/* 后台任务列表 */",
      ".dsh-cs-task-jobs{display:flex;flex-direction:column;gap:6px;margin-top:10px}",
      ".dsh-cs-task-jobs-header{display:flex;align-items:center;gap:8px;padding:0 4px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}",
      ".dsh-cs-task-jobs-title{flex:none;font:var(--dsw-font-xxs-strong-12);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-task-jobs-count{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-jobs-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}",
      ".dsh-cs-task-jobs-row{display:flex;align-items:center;gap:4px;border-radius:8px}",
      ".dsh-cs-task-jobs-row.dsh-cs-task-jobs-selected{background:var(--dsw-alias-interactive-bg-active)}",
      ".dsh-cs-task-jobs-row-main{box-sizing:border-box;display:flex;align-items:center;gap:6px;flex:1;min-width:0;padding:5px 8px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);cursor:pointer;text-align:left}",
      ".dsh-cs-task-jobs-row-main:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-task-job-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-jobs-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}",
      ".dsh-cs-task-jobs-line{display:flex;align-items:center;gap:6px;min-width:0}",
      ".dsh-cs-task-jobs-kind{flex:none;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;font:var(--dsw-font-xxxs-strong-11);line-height:14px;color:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-jobs-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--ds-font-family-code);font-size:var(--dsw-font-xxxs-11-font-size);line-height:var(--dsw-font-xxxs-11-line-height);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-task-jobs-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-jobs-kill{flex:none;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;margin-right:4px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dsh-cs-task-jobs-kill:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}",
      ".dsh-cs-task-jobs-kill-armed,.dsh-cs-task-jobs-kill-armed:hover{width:auto;height:20px;padding:0 8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxxs-strong-11);white-space:nowrap}",
      ".dsh-cs-task-jobs-kill:disabled{opacity:.5;cursor:default}",
      ".dsh-cs-task-jobs-pane{position:sticky;bottom:0;z-index:1;margin-top:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);box-shadow:0 -6px 12px -8px rgba(0,0,0,.35);overflow:hidden}",
      ".dsh-cs-task-jobs-pane-header{display:flex;align-items:center;gap:6px;height:28px;padding:0 4px 0 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".dsh-cs-task-jobs-dot{flex:none;width:8px;height:8px;border-radius:50%}",
      ".dsh-cs-task-jobs-settled{opacity:.8}",
      ".dsh-cs-task-jobs-kill-error{flex:none;margin-right:4px;color:var(--dsw-alias-state-error-primary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-refresh{flex:none;margin-left:auto;height:24px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-strong-12);cursor:pointer}",
      ".dsh-cs-task-refresh:hover{background:var(--dsw-alias-interactive-bg-hover)}",
      ".dsh-cs-task-refresh:disabled{opacity:.4;cursor:default}",
      ".dsh-cs-task-row-loading{opacity:.55;cursor:default}",
      ".dsh-cs-tasks-empty{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);text-align:center;padding:18px 8px}",
      ".dsh-cs-tasks-empty-hint{font:var(--dsw-font-xxxs-11);margin-top:6px}",
      ".dsh-cs-task-row:focus-visible,.dsh-cs-task-jobs-row-main:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-hover-accent);outline-offset:-2px}",
      ".dsh-cs-task-jobs-pane-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font:var(--dsw-font-xxs-strong-12)}",
      ".dsh-cs-task-jobs-pane-status{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-jobs-pane-close{flex:none;width:20px;height:20px;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}",
      ".dsh-cs-task-jobs-pane-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-task-jobs-pane pre.dsh-cs-task-jobs-pre{margin:0;max-height:220px;overflow:auto;padding:8px 10px;font:var(--dsw-font-mono-12);white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-task-jobs-hint{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12);padding:8px 10px}",
      ".dsh-cs-task-jobs-error{color:var(--dsw-alias-state-error-primary)}",
    ].join("\n");
    var CSS_TAG = "dsh-center-workbench/layout.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-center-workbench";
      tag.dataset.pluginCss = CSS_TAG;
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
    }

    // ===== 文件浏览器 =====
    // 图标风格：描边式轮廓（参考 VS Code 默认文件图标 / GitHub 网页文件浏览器的
    // 观感），并**按文件类型着色**（文件夹琥珀色，编程语言沿用 GitHub Linguist
    // 配色，图片/PDF/压缩包/表格/数据库等各有专属形状）。
    var DIR_ICON = "M1.8 3.1h4.2l1 1.4h7.2v8.4H1.8z";
    var FILE_ICON = "M3.7 2.7h5.6L12 5.6v7.7H3.7zM9.3 2.7v2.9H12";
    var ICON_CODE = "M5.8 4.7 3.3 8l2.5 3.3M10.2 4.7 12.7 8l-2.5 3.3";
    var ICON_IMAGE = "M2.5 3.5h11v9H2.5zM4 10.8l3.2-3.2 2.2 2.2 1.5-1.5L13 10.8M11.45 5.8a.95.95 0 1 1-1.9 0 .95.95 0 0 1 1.9 0z";
    var ICON_DOC = "M3.6 2.8h5.6l2.6 2.6v7.8H3.6zM9.2 2.8v2.6h2.6M5.6 8h4.8M5.6 10.3h4.8";
    var ICON_WORD = "M3.7 2.7h5.6L12 5.6v7.7H3.7zM9.3 2.7v2.9H12M5.6 7.2l1.1 3.4 1.1-2.9 1.1 2.9 1.1-3.4";
    var ICON_EXCEL = "M3.7 2.7h5.6L12 5.6v7.7H3.7zM9.3 2.7v2.9H12M6.4 6.9l3.2 3.8M9.6 6.9l-3.2 3.8";
    var ICON_PPT = "M3.7 2.7h5.6L12 5.6v7.7H3.7zM9.3 2.7v2.9H12M6.4 6.6v4.1M6.4 6.6h1.7a1.65 1.65 0 0 1 0 3.3H6.4";
    var ICON_RIB = "M5.2 2.7h5.6v10.6l-2.8-1.8-2.8 1.8z";
    var ICON_TERM = "M2.6 3.6h10.8v8.8H2.6zM4.7 6.1l1.9 1.9-1.9 1.9M9 10h3";
    var ICON_TABLE = "M2.7 3.3h10.6v9.4H2.7zM2.7 6.2h10.6M2.7 9h10.6M7.2 3.3v9.4";
    var ICON_DB = "M8 3c2.9 0 5.2.9 5.2 2s-2.3 2-5.2 2-5.2-.9-5.2-2S5.1 3 8 3zM2.8 5v6c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V5";
    var ICON_BOX = "M3 5.4h10a.4.4 0 0 1 .4.4v5.1a.4.4 0 0 1-.4.4H3a.4.4 0 0 1-.4-.4V5.8a.4.4 0 0 1 .4-.4zM5.4 2.9h5.2L13 5.4H3L5.4 2.9zM8 6.6v3.1";
    function iconSet(d, c, exts) {
      var o = {};
      for (var i = 0; i < exts.length; i++) o[exts[i]] = { d: d, c: c };
      return o;
    }
    var FILE_ICON_MAP = Object.assign({},
      iconSet(ICON_IMAGE, "#A074C4", ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "jfif", "pjpeg", "heic", "heif", "tif", "tiff", "psd", "psb", "svg"]),
      iconSet(ICON_RIB, "#E2574C", ["pdf"]),
      iconSet(ICON_DOC, "#519ABA", ["md", "markdown", "mdx", "rst"]),
      iconSet(ICON_CODE, "#E34C26", ["html", "htm", "xhtml"]),
      iconSet(ICON_CODE, "#663399", ["css", "scss", "less", "sass", "styl"]),
      iconSet(ICON_CODE, "#4C9E9E", ["json", "jsonc", "yml", "yaml", "toml", "xml", "plist"]),
      iconSet(ICON_CODE, "#F1E05A", ["js", "jsx", "mjs", "cjs"]),
      iconSet(ICON_CODE, "#3178C6", ["ts", "tsx", "mts", "cts"]),
      iconSet(ICON_CODE, "#4B8BBE", ["py", "pyw", "ipynb"]),
      iconSet(ICON_CODE, "#E76F00", ["java"]),
      iconSet(ICON_CODE, "#00ADD8", ["go"]),
      iconSet(ICON_CODE, "#CC342D", ["rb", "ruby"]),
      iconSet(ICON_CODE, "#DEA584", ["rs"]),
      iconSet(ICON_CODE, "#777BB4", ["php"]),
      iconSet(ICON_CODE, "#F34B7D", ["cpp", "cc", "cxx"]),
      iconSet(ICON_CODE, "#8B949E", ["c", "h", "hpp"]),
      iconSet(ICON_CODE, "#8A5CF6", ["swift", "kt", "kts", "dart"]),
      iconSet(ICON_TERM, "#89E051", ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "psm1"]),
      iconSet(ICON_DB, "#E38C00", ["sql", "db", "sqlite", "duckdb"]),
      iconSet(ICON_TABLE, "#7BB169", ["csv", "tsv", "dat"]),
      iconSet(ICON_BOX, "#C19A55", ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"]),
      iconSet(ICON_WORD, "#2B579A", ["doc", "docx", "docm", "dotx"]),
      iconSet(ICON_EXCEL, "#217346", ["xls", "xlsx", "xlsm", "xlsb", "xltx"]),
      iconSet(ICON_PPT, "#D24726", ["ppt", "pptx", "pptm", "potx"]),
      iconSet(ICON_DOC, "#3B7BBF", ["odt", "ods", "odp", "wps", "et", "dps"]),
      iconSet(ICON_DOC, "#9AA0A6", ["txt", "text", "log", "lock", "env", "cfg", "ini", "conf", "properties", "editorconfig", "gitignore", "gitattributes", "gitmodules", "npmrc", "license", "readme", "makefile", "mk"]),
      iconSet(ICON_CODE, "#2496ED", ["dockerfile"]),
    );
    /** 依据名称/目录判定图标形状与颜色。 */
    function fileIconOf(name, isDir) {
      if (isDir) return { d: DIR_ICON, c: "#E6B450" };
      var lower = String(name || "").toLowerCase();
      var ext = lower.indexOf(".") >= 0 ? lower.split(".").pop() : lower;
      var hit = FILE_ICON_MAP[ext];
      return hit || { d: FILE_ICON, c: "#9AA0A6" };
    }
    function Icon(d, color) {
      return createElement("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none", style: color ? { color: color } : undefined },
        createElement("path", { d: d, stroke: "currentColor", strokeWidth: 1.35, strokeLinecap: "round", strokeLinejoin: "round" }));
    }
    function fmtSize(n) {
      if (n < 1024) return n + "B";
      if (n < 1048576) return (n / 1024).toFixed(1) + "KB";
      return (n / 1048576).toFixed(1) + "MB";
    }
    // 路径统一归一化为正斜杠，兼容 Windows 反斜杠路径（C:\Users\x -> C:/Users/x）。
    function normPath(p) {
      return String(p || "").replace(/\\/g, "/");
    }
    function joinPath(dir, name) {
      var d = normPath(dir).replace(/[\\/]+$/, "");
      if (d === "" || d === "/") return "/" + name;
      return d + "/" + name;
    }
    function parentOf(p) {
      var t = normPath(p).replace(/\/+$/, "");
      if (t === "" || t === "/") return "/";
      // Windows 盘符根：C: 或 C:/ 之上没有父目录，返回自身（带斜杠便于读取）。
      if (/^[A-Za-z]:$/.test(t)) return t + "/";
      var idx = t.lastIndexOf("/");
      if (idx <= 0) return "/";
      var parent = t.slice(0, idx);
      if (/^[A-Za-z]:$/.test(parent)) return parent + "/"; // C:/Users -> C:/
      return parent.replace(/\/+$/, "") === "" ? "/" : parent;
    }
    function baseName(p) {
      var t = normPath(p).replace(/\/+$/, "");
      if (t === "" || t === "/") return "";
      if (/^[A-Za-z]:$/.test(t)) return ""; // Windows 盘符根，无文件名
      var idx = t.lastIndexOf("/");
      return idx < 0 ? t : t.slice(idx + 1);
    }
    /** 取 Windows 盘符（如 C:）或 null（非盘符路径）。 */
    function driveOf(p) {
      var m = /^([A-Za-z]:)(\/|$)/.exec(normPath(p));
      return m ? m[1] : null;
    }
    function fileOp(op, src, dst) {
      return fetch("/api/dsh-center-workbench/file/op", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: op, src: src, dst: dst }),
      }).then(function (r) { return r.json(); });
    }
    /** 递归收集 FileSystemDirectoryHandle 下的所有文件（相对路径），用于「导入文件夹」。 */
    function collectDirFiles(rootHandle, prefix) {
      var out = [];
      function walk(dirHandle, rel) {
        var it = dirHandle && typeof dirHandle.entries === "function" ? dirHandle.entries() : null;
        if (!it) return Promise.resolve();
        function loop() {
          return it.next().then(function (r) {
            if (r.done) return undefined;
            var h = r.value[1];
            var childRel = rel ? rel + "/" + r.value[0] : r.value[0];
            if (h && h.kind === "file") {
              return h.getFile().then(function (file) { out.push({ rel: childRel, file: file }); }).then(loop);
            } else if (h && h.kind === "directory") {
              return walk(h, childRel).then(loop);
            }
            return loop();
          });
        }
        return loop();
      }
      return walk(rootHandle, String(prefix || "")).then(function () { return out; });
    }
    function delFile(path) {
      return fetch("/api/dsh-center-workbench/file/del", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path }),
      }).then(function (r) { return r.json(); });
    }
    function createPath(kind, path) {
      return fetch("/api/dsh-center-workbench/file/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: kind, path: path }),
      }).then(function (r) { return r.json(); });
    }
    function fetchTree(path) {
      return fetch("/api/dsh-center-workbench/tree?path=" + encodeURIComponent(path)).then(function (r) { return r.json(); });
    }
    function fetchFile(path) {
      return fetch("/api/dsh-center-workbench/file?path=" + encodeURIComponent(path)).then(function (r) { return r.json(); });
    }
    function saveFile(path, text) {
      return fetch("/api/dsh-center-workbench/file/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: path, text: text }),
      }).then(function (r) { return r.json(); });
    }
    function mediaUrl(path) {
      return "/api/dsh-center-workbench/media?path=" + encodeURIComponent(path);
    }
    /** 递归列出目录（相对路径）。 */
    function fetchTreeRecursive(path) {
      return fetch("/api/dsh-center-workbench/tree/recursive?path=" + encodeURIComponent(path)).then(function (r) { return r.json(); });
    }
    /** 把相对路径拼到绝对目录下，避免重复斜杠；base 归一化为正斜杠（兼容 Windows）。 */
    function joinRel(base, rel) {
      var b = normPath(base).replace(/[\\/]+$/, "");
      var r = String(rel || "").replace(/^[\\/]+/, "");
      return b + "/" + r;
    }
    /** 上传一个外部文件（原始二进制）到目标目录；rel 为相对路径（可含子目录，host 会建父目录）。 */
    function uploadFile(dir, relpath, blob) {
      return fetch("/api/dsh-center-workbench/file/upload?dir=" + encodeURIComponent(dir) + "&rel=" + encodeURIComponent(relpath), {
        method: "POST",
        body: blob,
      }).then(function (r) { return r.json(); });
    }
    /** 依据扩展名判断文件预览类型：image/html/pdf/markdown/code。 */
    function previewKindOf(path) {
      var parts = (path || "").split(".");
      var ext = (parts.length > 1 ? parts.pop() : "").toLowerCase();
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "jfif", "pjpeg"].indexOf(ext) >= 0) return "image";
      // 需解码的图片格式（浏览器无法直接 <img> 渲染，走扩展预览器）。
      if (["tif", "tiff"].indexOf(ext) >= 0) return "tiff";
      if (["heic", "heif"].indexOf(ext) >= 0) return "heic";
      if (["psd", "psb"].indexOf(ext) >= 0) return "psd";
      if (["html", "htm"].indexOf(ext) >= 0) return "html";
      if (ext === "pdf") return "pdf";
      if (["md", "markdown"].indexOf(ext) >= 0) return "markdown";
      // Office 类（只读预览，不走文本编辑器）。
      if (["doc", "docx", "docm"].indexOf(ext) >= 0) return "word";
      if (["xls", "xlsx", "xlsm", "xlsb"].indexOf(ext) >= 0) return "excel";
      if (["csv", "tsv"].indexOf(ext) >= 0) return "csv";
      if (["ppt", "pptx", "pptm"].indexOf(ext) >= 0) return "powerpoint";
      // 文本/代码类：可编辑。
      var code = ["py", "js", "mjs", "ts", "jsx", "tsx", "json", "txt", "css", "scss", "less", "sh", "bash", "zsh", "yml", "yaml", "toml", "xml", "c", "cpp", "h", "hpp", "java", "go", "rs", "rb", "php", "sql", "conf", "ini", "log", "env", "cfg", "properties", "vue", "svelte", "r", "ipynb", "m", "makefile", "dockerfile", "editorconfig", "gitignore", "npmrc"];
      if (code.indexOf(ext) >= 0) return "code";
      return "unsupported";
    }

    // ===== 后台任务页（子代理拓扑 + 后台任务）纯函数 =====
    var SIDE_LABEL_PREFIX = "Side: ";
    var EMPTY_SESSION_LIST = { byId: {}, jobsBySession: undefined, current: "" };
    function isSideThreadSummary(s) {
      return !!s && s.origin === "subagent" && (s.displayTitle || "").indexOf(SIDE_LABEL_PREFIX) === 0;
    }
    /** 主会话：沿子→父持久链向上到第一个非子代理会话。 */
    function rootAncestor(byId, sessionId) {
      if (!sessionId) return undefined;
      var start = byId[sessionId];
      if (!start) return sessionId;
      var seen = new Set();
      var cur = start;
      var last;
      while (cur && cur.origin === "subagent" && cur.parentId !== undefined && !seen.has(cur.id)) {
        seen.add(cur.id);
        last = cur;
        cur = byId[cur.parentId];
      }
      if (last === undefined) return start.id;
      return (byId[last.parentId] && byId[last.parentId].id) || sessionId;
    }
    function isJobLive(job) { return !!job && (job.status === "running" || job.status === "stopping"); }
    /** 某个父会话的直接子代理（不含 Side Chat 线程）。 */
    function directChildren(byId, parentId) {
      var out = [];
      Object.keys(byId).forEach(function (k) {
        var s = byId[k];
        if (s && s.origin === "subagent" && s.parentId === parentId && !isSideThreadSummary(s)) out.push(s);
      });
      return out;
    }
    /** 整棵拓扑树（根 + 所有经子代理链能到达的会话）的会话 id 集合。 */
    function treeSessionIds(byId, rootId) {
      var ids = new Set();
      if (!rootId || !byId[rootId]) return ids;
      Object.keys(byId).forEach(function (k) {
        var s = byId[k];
        if (s.id === rootId) { ids.add(s.id); return; }
        var seen = new Set();
        var cur = s;
        var reached = false;
        while (cur && cur.origin === "subagent" && cur.parentId !== undefined && !seen.has(cur.id)) {
          seen.add(cur.id);
          if (cur.parentId === rootId) { reached = true; break; }
          cur = byId[cur.parentId];
        }
        if (reached) ids.add(s.id);
      });
      return ids;
    }
    /** 收集整棵树的背景任务（含拥主会话 + 标题）。 */
    function collectTreeJobs(byId, jobsBySession, rootId) {
      var rows = [];
      if (!jobsBySession) return rows;
      treeSessionIds(byId, rootId).forEach(function (sid) {
        var jobs = jobsBySession[sid];
        if (!jobs || jobs.length === 0) return;
        var ownerTitle = (byId[sid] && byId[sid].displayTitle) || sid;
        for (var i = 0; i < jobs.length; i++) rows.push({ ownerSessionId: sid, ownerTitle: ownerTitle, job: jobs[i] });
      });
      return rows;
    }
    function orderJobs(rows) {
      return rows.slice().sort(function (a, b) {
        var al = isJobLive(a.job), bl = isJobLive(b.job);
        if (al !== bl) return al ? -1 : 1;
        if (al) return a.job.startedAt - b.job.startedAt;
        var fa = a.job.finishedAt || a.job.startedAt, fb = b.job.finishedAt || b.job.startedAt;
        return (fb - fa) || (a.job.startedAt - b.job.startedAt);
      });
    }
    function jobStatusLabel(status) {
      switch (status) {
        case "running": return "运行中";
        case "stopping": return "终止中";
        case "completed": return "已完成";
        case "killed": return "已终止";
        case "failed": return "失败";
        default: return status;
      }
    }
    /** 状态点 CSS 类：运行中 / 失败 / 停止中·已终止 / 已结束。 */
    function jobDotClass(status) {
      if (status === "running") return "dsh-cs-task-dot-running";
      if (status === "failed") return "dsh-cs-task-dot-error";
      if (status === "stopping" || status === "killed") return "dsh-cs-task-dot-warn";
      return "dsh-cs-task-dot-done";
    }
    function formatJobDuration(ms) {
      var total = Math.max(0, Math.floor(ms / 1000));
      var s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
      if (h > 0) return h + "小时" + m + "分";
      if (m > 0) return m + "分" + s + "秒";
      return s + "秒";
    }
    /** 某个会话的直系子代理数量（持久 origin 行；Side Chat 线程不算）。 */
    function directSubagentCount(byId, sessionId) {
      var n = 0;
      Object.keys(byId || {}).forEach(function (k) {
        var s = byId[k];
        if (s && s.origin === "subagent" && s.parentId === sessionId && !isSideThreadSummary(s)) n += 1;
      });
      return n;
    }
    /**
     * 两次列表快照之间该会话是否「新出现直系子代理」（0 → N）。切到已有子代理的
     * 会话不触发（基线从当前数量开始），因此不会打断用户已有的布局。
     */
    function detectNewDirectSubagent(prev, next, sessionId) {
      if (!sessionId) return false;
      return directSubagentCount(prev && prev.byId, sessionId) === 0
        && directSubagentCount(next && next.byId, sessionId) > 0;
    }
    /**
     * 两次列表快照之间该会话是否出现「新任务 id」。与子代理触发（仅 0 → N）不同，
     * 任意新增任务都触发：一个会话里代理可能先后启动多个后台任务，每个都该被看到。
     */
    function detectNewJob(prev, next, sessionId) {
      if (!sessionId) return false;
      var prevIds = {};
      (((prev && prev.jobsBySession) || {})[sessionId] || []).forEach(function (j) { prevIds[j.id] = true; });
      return (((next && next.jobsBySession) || {})[sessionId] || []).some(function (j) { return !prevIds[j.id]; });
    }
    /** 子代理自动激活去抖（ms）：Side Chat 线程的 origin 与其「Side: 」标题分两帧到达，
    *  立即判定会把线程首帧误认为新子代理；延迟后用实时快照按原基线重评估。 */
    var AUTO_OPEN_DEBOUNCE_MS = 500;
    /** 窄视口阈值（与 better-sidebar 一致）：窄屏不强制展开中部栏，只准备标签页。 */
    var NARROW_MAX_WIDTH = 768;

    // ===== 资源管理器：VS Code 风格目录树（文件夹逐级展开/收起，缩进 + ▸/▾） =====
    function Browser(props) {
      var ctx = props.ctx;
      var onOpenFile = props.onOpenFile || function () {};
      // 响应式读取当前会话的工作区 cwd（随会话切换/出现而更新），作为初始根目录。
      var rootCwd = useSyncExternalStore(
        useCallback(function (cb) {
          try { var s = ctx.get("sessions"); return s && s.list ? s.list.subscribe(cb) : function () {}; } catch (e) { return function () {}; }
        }, [ctx]),
        useCallback(function () {
          try {
            var s = ctx.get("sessions");
            if (!s || !s.list) return "";
            var l = s.list.getSnapshot();
            var cur = l && l.current;
            return (cur && l.byId && l.byId[cur] && l.byId[cur].cwd) || "";
          } catch (e) { return ""; }
        }, [ctx]),
      );
      var root = normPath(rootCwd || defaultHome);
      var curPath = props.curPath || "";
      var onNavigate = props.onNavigate || function () {};
      var current = curPath || root;
      // —— 树形状态：dirs 缓存每个目录条目 {path: {list, loaded, sig, error}}；expanded 记录展开目录 ——
      var [dirs, setDirs] = useState(null);
      var [expanded, setExpanded] = useState(null);
      var [menu, setMenu] = useState(null);
      var [selected, setSelected] = useState([]);
      var [anchor, setAnchor] = useState(null);
      var [selDir, setSelDir] = useState(current); // 活动目录：粘贴/新建/导入目标（点击目录即目录本身，点文件即其父级）
      var [drives, setDrives] = useState([]); // Windows 盘符列表，非 Windows 为空
      var onCopy = props.onCopy || function () {};
      var onCut = props.onCut || function () {};
      var onPaste = props.onPaste || function () {};
      var onCopyPath = props.onCopyPath || function () {};
      var onCreateDir = props.onCreateDir || function () {};
      var onCreateFile = props.onCreateFile || function () {};
      var onRename = props.onRename || function () {};
      var onDelete = props.onDelete || function () {};
      var onUploadExternal = props.onUploadExternal || function () {};
      var onExport = props.onExport || function () {};
      var onImportFolder = props.onImportFolder || function () {};
      var onImportFiles = props.onImportFiles || function () {};
      var hasClipboard = !!props.clipboard;
      var refreshToken = props.refreshToken || 0;
      var dirsRef = useRef(null);
      dirsRef.current = dirs;

      /** 加载并缓存一个目录的条目。 */
      function loadDir(path) {
        return fetchTree(path).then(function (json) {
          var list = (json && json.entries) || [];
          var sig = JSON.stringify(list.map(function (e) { return e.name + "|" + e.isDir + "|" + e.size; }));
          setDirs(function (prev) {
            var next = Object.assign({}, prev || {});
            next[path] = json && json.ok
              ? { list: list, loaded: true, sig: sig, error: null }
              : { list: [], loaded: true, sig: "", error: (json && json.error) || "无法读取目录" };
            return next;
          });
        }).catch(function (e) {
          setDirs(function (prev) {
            var next = Object.assign({}, prev || {});
            next[path] = { list: [], loaded: true, sig: "", error: String((e && e.message) || e) };
            return next;
          });
        });
      }
      /** 展开/收起目录（懒加载）。 */
      function toggleExpand(path) {
        if (expanded && expanded[path]) {
          setExpanded(function (prev) { var n = Object.assign({}, prev); delete n[path]; return n; });
          return;
        }
        var d = dirs && dirs[path];
        if (!d || !d.loaded) loadDir(path);
        setExpanded(function (prev) { var n = Object.assign({}, prev || {}); n[path] = true; return n; });
      }
      /** 深度优先收集可见行（根目录为 depth 0，展开的目录逐级下钻）。 */
      function collectRows() {
        var out = [];
        function walk(path, depth) {
          var d = dirs && dirs[path];
          if (!d || !d.loaded || !d.list) return;
          for (var j = 0; j < d.list.length; j++) {
            var ent = d.list[j];
            var full = joinPath(path, ent.name);
            out.push({ ent: ent, full: full, depth: depth, ic: fileIconOf(ent.name, ent.isDir) });
            if (ent.isDir && expanded && expanded[full]) walk(full, depth + 1);
          }
        }
        walk(current, 0);
        return out;
      }

      // 键盘：Ctrl/Cmd+C（复制选中）、Ctrl/Cmd+X（剪切）、Ctrl/Cmd+V（粘贴到活动目录）、Delete（删除选中）。输入框/文本域内不拦截。
      useEffect(function () {
        function onKey(e) {
          var t = e.target;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
          // 只在本插件资源管理器内部响应，避免拦截到 DSH 对话栏的 Ctrl+C/Ctrl+V 等。
          var rootEl = props.rootRef && props.rootRef.current;
          if (rootEl && (!t || !rootEl.contains(t))) return;
          if (e.key === "Delete") { if (selected.length > 0) { e.preventDefault(); onDelete(selected); } return; }
          if (!(e.ctrlKey || e.metaKey)) return;
          var k = String(e.key || "").toLowerCase();
          if (k === "c") { if (selected.length > 0) { e.preventDefault(); onCopy(selected); } }
          else if (k === "x") { if (selected.length > 0) { e.preventDefault(); onCut(selected); } }
          else if (k === "v") { if (hasClipboard) { e.preventDefault(); onPaste(selDir); } }
        }
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [selected, selDir, hasClipboard, onCopy, onCut, onPaste, onDelete]);

      // 粘贴外部文件：从 Windows 资源管理器 Ctrl+C 复制的文件，页面 Ctrl+V 时
      // paste 事件的 clipboardData.files 会带出它们（OS 剪贴板，非内部剪贴板）。
      // 注意：该方式跨浏览器不可靠（Chrome/FF 行为不同），拖放才是标准可靠路径。
      // 仅在内部剪贴板为空时处理，避免与内部复制/粘贴冲突。监听 window 以尽可能捕捉。
      useEffect(function () {
        function onPaste(e) {
          if (hasClipboard) return;
          var t = e.target;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
          // 只在本插件资源管理器内部响应外部文件粘贴，避免拦截对话栏的文本粘贴。
          var rootEl = props.rootRef && props.rootRef.current;
          if (rootEl && (!t || !rootEl.contains(t))) return;
          var files = e.clipboardData && e.clipboardData.files;
          if (files && files.length) {
            e.preventDefault();
            onUploadExternal(Array.prototype.slice.call(files), selDir);
          }
        }
        window.addEventListener("paste", onPaste);
        return function () { window.removeEventListener("paste", onPaste); };
      }, [hasClipboard, selDir, onUploadExternal]);

      // 拉取 Windows 盘符（非 Windows 返回空），供盘符下拉切换。
      useEffect(function () {
        var alive = true;
        fetch("/api/dsh-center-workbench/drives").then(function (r) { return r.json(); })
          .then(function (j) { if (alive && j && j.ok) setDrives(j.drives || []); })
          .catch(function () { /* 非 Windows 或接口异常，保持空 */ });
        return function () { alive = false; };
      }, []);

      // 根目录变更 / 刷新令牌变化：重置树并加载根。
      useEffect(function () {
        setDirs(null);
        setExpanded(null);
        setSelected([]);
        setAnchor(null);
        setSelDir(current);
        loadDir(current);
      }, [current, refreshToken]);

      // 轮询已加载的目录，自动发现外部新增/删除（内容未变则不重渲染，避免闪烁）。
      useEffect(function () {
        var alive = true;
        var timer = window.setInterval(function () {
          var d = dirsRef.current;
          if (!d) return;
          Object.keys(d).forEach(function (p) {
            if (!alive) return;
            var node = d[p];
            if (!node || !node.loaded) return;
            fetchTree(p).then(function (json) {
              if (!alive || !json || !json.ok) return;
              var list = json.entries || [];
              var sig = JSON.stringify(list.map(function (e) { return e.name + "|" + e.isDir + "|" + e.size; }));
              if (sig === node.sig) return;
              setDirs(function (prev) {
                var n = Object.assign({}, prev || {});
                n[p] = { list: list, loaded: true, sig: sig, error: null };
                return n;
              });
            }).catch(function () { /* 忽略瞬时失败 */ });
          });
        }, 2500);
        return function () { alive = false; window.clearInterval(timer); };
      }, []);

      function openMenu(e, path, isDir, paths) {
        e.preventDefault();
        e.stopPropagation();
        lastMenuPos = { x: e.clientX, y: e.clientY };
        // 保留多选：右键点在已被选中的项上 → 维持整个选区；否则选中该项。paths 显式传入时以其为准。
        var sel = paths === undefined ? (selected.indexOf(path) >= 0 ? selected.slice() : [path]) : (paths || []);
        setSelected(sel);
        setAnchor(sel.length ? sel[sel.length - 1] : null);
        if (sel.length && isDir) setSelDir(path);
        setMenu({ x: e.clientX, y: e.clientY, path: path, paths: sel, isDir: !!isDir });
      }

      var parts = current.split(/[\\/]+/).filter(Boolean);
      var acc = "";
      var crumbs = [];
      for (var i = 0; i < parts.length; i++) {
        // Windows 盘符：面包屑首段作为盘根（C: -> C:/），避免拼成错误的 /C:。
        if (i === 0 && /^[A-Za-z]:$/.test(parts[i])) acc = parts[i] + "/";
        else acc = acc.replace(/\/+$/, "") + "/" + parts[i];
        crumbs.push({ label: parts[i], path: acc });
      }
      var curDrive = drives.length > 0 ? driveOf(current) : null;
      var flatRows = collectRows(); // 可见行（DFS 扁平顺序），Shift 区间选择基于它
      var rowEls = flatRows.map(function (row) {
        var full = row.full;
        var isDir = row.ent.isDir;
        var isOpen = !!(expanded && expanded[full]);
        return createElement("button", {
          key: full,
          type: "button",
          className: "dsh-cs-row" + (selected.indexOf(full) >= 0 ? " dsh-cs-selected" : ""),
          style: { paddingLeft: (7 + row.depth * 14) + "px" },
          onClick: function (e) {
            // Shift + 单击：在锚点与点击项之间按可见顺序连续选择（锚点保持不变）。
            if (e.shiftKey && anchor) {
              var aI = -1, bI = -1;
              for (var m = 0; m < flatRows.length; m++) {
                if (flatRows[m].full === anchor) aI = m;
                if (flatRows[m].full === full) bI = m;
              }
              if (aI >= 0 && bI >= 0) {
                var lo = Math.min(aI, bI), hi = Math.max(aI, bI);
                var range = [];
                for (var m2 = lo; m2 <= hi; m2++) range.push(flatRows[m2].full);
                setSelected(range);
                return;
              }
            }
            if (e.ctrlKey || e.metaKey) {
              if (selected.indexOf(full) >= 0) setSelected(selected.filter(function (x) { return x !== full; }));
              else setSelected(selected.concat(full));
              setAnchor(full);
              return;
            }
            setSelected([full]);
            setAnchor(full);
            setSelDir(isDir ? full : parentOf(full));
            // 单击文件夹 = 打开/进入该文件夹（面包屑/树根随之切换）；展开走箭头。
            if (isDir) onNavigate(full);
          },
          onDoubleClick: function () { if (!isDir) onOpenFile(full); },
          onContextMenu: function (e) { openMenu(e, full, isDir); },
        }, [
          createElement("span", {
            className: "dsh-cs-row-caret",
            title: isDir ? (isOpen ? "收起" : "展开") : undefined,
            onClick: isDir ? function (e) { e.stopPropagation(); toggleExpand(full); } : undefined,
          }, isDir ? (isOpen ? "▾" : "▸") : ""),
          createElement("span", { className: "dsh-cs-row-icon" }, Icon(row.ic.d, row.ic.c)),
          createElement("span", { className: "dsh-cs-row-name" }, row.ent.name),
          !isDir ? createElement("span", { className: "dsh-cs-row-size" }, fmtSize(row.ent.size)) : null,
        ]);
      });
      var rootDir = dirs && dirs[current];
      var bodyContent;
      if (!rootDir || !rootDir.loaded) bodyContent = createElement("div", { className: "dsh-cs-empty" }, "加载中…");
      else if (rootDir.error) bodyContent = createElement("div", { className: "dsh-cs-empty" }, "加载失败：" + rootDir.error);
      else bodyContent = rowEls.length ? rowEls : createElement("div", { className: "dsh-cs-empty" }, "空目录");

      return createElement("div", { ref: props.rootRef, className: "dsh-cs-browser", style: props.style }, [
        createElement("div", { className: "dsh-cs-browser-bar" }, [
          createElement("button", {
            type: "button", className: "dsh-cs-browser-up", title: "上一级（根目录上移）",
            disabled: parentOf(current) === current, onClick: function () { onNavigate(parentOf(current)); },
          }, "↑"),
          drives.length > 0 ? createElement("select", {
            className: "dsh-cs-browser-drive", title: "切换盘符",
            value: curDrive || "", onChange: function (e) { var v = e.target.value; if (v) onNavigate(v + "/"); },
          }, [
            createElement("option", { value: "" }, "盘符"),
          ].concat(drives.map(function (d) { return createElement("option", { value: d }, d); }))) : null,
          createElement("div", { className: "dsh-cs-browser-path" }, [
            // Windows 下根不是 /，隐藏进不去的 "/" 面包屑；盘符已作为首段面包屑。
            curDrive ? null : createElement("button", { key: "/", type: "button", className: "dsh-cs-crumb", onClick: function () { onNavigate("/"); } }, "/"),
          ].concat(crumbs.map(function (seg) {
            return createElement("button", { key: seg.path, type: "button", className: "dsh-cs-crumb", onClick: function () { onNavigate(seg.path); } }, seg.label);
          }))),
        ]),
        createElement("div", {
          className: "dsh-cs-browser-body",
          onContextMenu: function (e) { openMenu(e, current, true, []); },
          onDragOver: function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "copy"; } catch (err) {} },
          onDrop: function (e) {
            e.preventDefault();
            var files = e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) onUploadExternal(Array.prototype.slice.call(files), selDir);
          },
        }, [bodyContent]),
        menu ? [
          createElement("div", { className: "dsh-cs-menu-backdrop", key: "bd", onMouseDown: function () { setMenu(null); }, onContextMenu: function (e) { e.preventDefault(); setMenu(null); } }),
          createElement("div", { className: "dsh-cs-menu", key: "m", style: { left: menu.x, top: menu.y }, onContextMenu: function (e) { e.preventDefault(); } }, [
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: menu.paths.length ? "" : "未选中任何项", disabled: !menu.paths.length, onClick: function () { onCopy(menu.paths); setMenu(null); } }, "复制"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: menu.paths.length ? "" : "未选中任何项", disabled: !menu.paths.length, onClick: function () { onCut(menu.paths); setMenu(null); } }, "剪切"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: hasClipboard ? "" : "剪贴板为空", disabled: !hasClipboard, onClick: function () { onPaste(menu.isDir ? menu.path : parentOf(menu.path)); setMenu(null); } }, "粘贴"),
            createElement("div", { className: "dsh-cs-menu-sep" }),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCopyPath(menu.path); setMenu(null); } }, "复制路径"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "选一个 Windows 文件夹，把该项（含子目录）写入其中", onClick: function () { onExport(menu.path, menu.isDir); setMenu(null); } }, "导出到 Windows 文件夹…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "弹出系统文件夹选择器，把所选文件夹导入目标目录（保留子目录结构）", onClick: function () { onImportFolder(menu.isDir ? menu.path : parentOf(menu.path)); setMenu(null); } }, "导入文件夹…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "弹出系统文件选择器，把所选一个或多个文件导入目标目录", onClick: function () { onImportFiles(menu.isDir ? menu.path : parentOf(menu.path)); setMenu(null); } }, "导入文件…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCreateDir(menu.isDir ? menu.path : parentOf(menu.path)); setMenu(null); } }, "新建目录"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCreateFile(menu.isDir ? menu.path : parentOf(menu.path)); setMenu(null); } }, "新建文件"),
            createElement("div", { className: "dsh-cs-menu-sep" }),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onRename(menu.path); setMenu(null); } }, "重命名"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item dsh-cs-menu-item-danger", title: menu.paths.length ? "" : "未选中任何项", disabled: !menu.paths.length, onClick: function () { onDelete(menu.paths); setMenu(null); } }, "删除"),
          ]),
        ] : null,
      ]);
    }

    // ===== 图片预览（滚轮缩放，可滚动） =====
    function ImageViewer(props) {
      var path = props.path;
      var imgRef = useRef(null);
      var [zoom, setZoom] = useState(1);
      var [fit, setFit] = useState(null);
      function onLoad() {
        var img = imgRef.current;
        if (!img || !img.naturalWidth) return;
        var c = img.parentElement;
        if (!c) return;
        var cw = Math.max(1, c.clientWidth);
        var ch = Math.max(1, c.clientHeight);
        var s = Math.min(cw / img.naturalWidth, ch / img.naturalHeight, 1);
        setFit({ w: Math.round(img.naturalWidth * s), h: Math.round(img.naturalHeight * s) });
      }
      useEffect(function () {
        var el = imgRef.current;
        if (!el) return;
        var onWheel = function (e) { e.preventDefault(); setZoom(function (z) { return Math.min(10, Math.max(0.2, z + (e.deltaY < 0 ? 0.15 : -0.15))); }); };
        var onDbl = function () { setZoom(1); };
        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("dblclick", onDbl);
        return function () { el.removeEventListener("wheel", onWheel); el.removeEventListener("dblclick", onDbl); };
      }, []);
      var style = fit
        ? { width: Math.round(fit.w * zoom) + "px", height: Math.round(fit.h * zoom) + "px" }
        : { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" };
      return createElement("div", { className: "dsh-cs-viewer" }, [
        createElement("img", { ref: imgRef, src: props.src || mediaUrl(props.path), alt: path, onLoad: onLoad, style: style }),
      ]);
    }

    // ===== 图片扩展预览：TIFF（UTIF.js） / HEIC（heic2any） / PSD（ag-psd）→ 解码后复用 ImageViewer =====
    function rgbaToCanvasUrl(rgba, w, h) {
      var canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext("2d");
      var imgData = ctx.createImageData(w, h);
      imgData.data.set(rgba);
      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL("image/png");
    }
    function DecodedImage(props) {
      var path = props.path || "";
      var kind = props.kind || "tiff"; // tiff | heic | psd
      var [status, setStatus] = useState("loading");
      var [errMsg, setErrMsg] = useState("");
      var [src, setSrc] = useState(null);
      useEffect(function () {
        var alive = true;
        setStatus("loading");
        setSrc(null);
        fetch(mediaUrl(path)).then(function (r) {
          if (!r.ok) throw new Error("无法读取文件");
          return r.arrayBuffer();
        }).then(function (buf) {
          if (kind === "tiff") return decodeTiff(buf);
          if (kind === "heic") return decodeHeic(buf);
          return decodePsd(buf);
        }).then(function (url) {
          if (alive) { setSrc(url); setStatus("ready"); }
        }).catch(function (e) {
          if (alive) { setErrMsg(String((e && e.message) || e)); setStatus("error"); }
        });
        return function () { alive = false; };
      }, [path, kind]);
      if (status === "loading") return viewerMsg("图片解码中…");
      if (status === "error") return viewerMsg("图片预览失败：" + errMsg);
      return createElement(ImageViewer, { path: path, src: src });
      function decodeTiff(buf) {
        var ab = buf instanceof ArrayBuffer ? buf : buf.buffer;
        return ensureVendor("pako", "/api/dsh-center-workbench/vendor/pako.js").then(function () {
          return ensureVendor("UTIF", "/api/dsh-center-workbench/vendor/utif.js");
        }).then(function (UTIF) {
          var ifds = UTIF.decode(ab);
          if (!ifds || !ifds.length) throw new Error("TIFF 解析失败");
          UTIF.decodeImage(ab, ifds[0], ifds);
          var rgba = UTIF.toRGBA8(ifds[0]);
          var w = ifds[0].width || 0, h = ifds[0].height || 0;
          if (!rgba || !rgba.length || !w || !h) throw new Error("TIFF 图像解码失败");
          return rgbaToCanvasUrl(rgba, w, h);
        });
      }
      function decodeHeic(buf) {
        return ensureVendor("heic2any", "/api/dsh-center-workbench/vendor/heic2any.js").then(function (lib) {
          return lib({ blob: new Blob([buf], { type: "image/heic" }) });
        }).then(function (out) {
          var b = Array.isArray(out) ? out[0] : out;
          if (!b) throw new Error("HEIC 转换失败");
          var fr = new FileReader();
          return new Promise(function (resolve, reject) {
            fr.onload = function () { resolve(String(fr.result)); };
            fr.onerror = function () { reject(new Error("HEIC 读取结果失败")); };
            fr.readAsDataURL(b);
          });
        });
      }
      function decodePsd(buf) {
        return ensureVendor("agPsd", "/api/dsh-center-workbench/vendor/ag-psd.js").then(function (lib) {
          var psd = lib.readPsd(buf, { skipLayerImageData: true, skipThumbnail: true, skipCompositeImageData: false });
          var canvas = (psd && psd.canvas) || (typeof lib.getCompositeCanvas === "function" ? lib.getCompositeCanvas(psd) : null);
          if (!canvas) throw new Error("未获取到 PSD 合成图像");
          return canvas.toDataURL("image/png");
        });
      }
    }

    // ===== PDF 预览（滚轮缩放整个 PDF iframe） =====
    function PdfViewer(props) {
      var path = props.path;
      var iframeRef = useRef(null);
      var [zoom, setZoom] = useState(1);
      useEffect(function () {
        var el = iframeRef.current;
        if (!el) return;
        var onWheel = function (e) { e.preventDefault(); setZoom(function (z) { return Math.min(8, Math.max(0.2, z + (e.deltaY < 0 ? 0.15 : -0.15))); }); };
        var onDbl = function () { setZoom(1); };
        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("dblclick", onDbl);
        return function () { el.removeEventListener("wheel", onWheel); el.removeEventListener("dblclick", onDbl); };
      }, []);
      return createElement("div", { className: "dsh-cs-viewer-pdf" }, [
        createElement("iframe", { ref: iframeRef, className: "dsh-cs-viewer-frame", src: mediaUrl(path), style: { width: "100%", height: "100%", transform: "scale(" + zoom + ")", transformOrigin: "top left" } }),
      ]);
    }

    // ===== 就地编辑器（编辑/保存/关闭，默认只读，点「编辑」才可改） =====
    function Editor(props) {
      var path = props.path || "";
      var text = props.text || "";
      var dirty = props.dirty;
      var editable = props.editable;
      var previewKind = props.previewKind || "code";
      var onEditToggle = props.onEditToggle || function () {};
      var onChange = props.onChange || function () {};
      var onSave = props.onSave || function () {};
      var onClose = props.onClose || function () {};
      // 可编辑类型：代码(code)与 Markdown(markdown)——可切换预览/编辑。
      var isEditable = previewKind === "code" || previewKind === "markdown";
      var isUnsupported = previewKind === "unsupported";
      // 纯预览类（图片/HTML/PDF/不支持）：只读，只留「关闭」。
      var previewLabel = previewKind === "image" ? "图片预览" : previewKind === "tiff" ? "TIFF 预览" : previewKind === "heic" ? "HEIC 预览" : previewKind === "psd" ? "PSD 预览" : previewKind === "html" ? "HTML 预览" : previewKind === "pdf" ? "PDF 预览" : previewKind === "word" ? "Word 预览" : previewKind === "excel" ? "Excel 预览" : previewKind === "csv" ? "CSV 预览" : previewKind === "powerpoint" ? "PPT 预览" : "不支持预览";
      var bar = isEditable
        ? createElement("div", { className: "dsh-cs-editor-bar" }, [
            createElement("button", { type: "button", className: "dsh-cs-editor-edit" + (editable ? " dsh-cs-editor-edit-active" : ""), "data-active": editable ? "1" : undefined, title: editable ? "退出编辑" : "激活编辑", onClick: function () { onEditToggle(); } }, "编辑"),
            createElement("button", { type: "button", className: "dsh-cs-editor-save", "data-dirty": dirty ? "1" : undefined, title: "保存到磁盘", disabled: !path || !editable, onClick: function () { onSave(); } }, "保存"),
            createElement("button", { type: "button", className: "dsh-cs-editor-close", title: "关闭该文件", onClick: function () { onClose(); } }, "关闭"),
          ])
        : createElement("div", { className: "dsh-cs-editor-bar" }, [
            createElement("span", { className: "dsh-cs-editor-note" }, previewLabel),
            createElement("button", { type: "button", className: "dsh-cs-editor-close", title: "关闭该文件", onClick: function () { onClose(); } }, "关闭"),
          ]);
      var textareaBody = createElement("textarea", {
        className: "dsh-cs-editor-textarea",
        value: text,
        readOnly: !editable,
        spellCheck: false,
        onInput: function (e) { if (editable) onChange(e.currentTarget.value); },
        onKeyDown: function (e) { if (editable && (e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); onSave(); } },
      });
      var body;
      if (!path) {
        body = createElement("div", { className: "dsh-cs-note" }, "在「资源管理器」双击一个文件即可预览；默认只读，点「编辑」后即可修改并「保存」。");
      } else if (previewKind === "image") {
        body = createElement(ImageViewer, { path: path });
      } else if (previewKind === "tiff") {
        body = createElement(DecodedImage, { path: path, kind: "tiff" });
      } else if (previewKind === "heic") {
        body = createElement(DecodedImage, { path: path, kind: "heic" });
      } else if (previewKind === "psd") {
        body = createElement(DecodedImage, { path: path, kind: "psd" });
      } else if (previewKind === "html") {
        body = createElement("iframe", { className: "dsh-cs-viewer-frame", src: mediaUrl(path), sandbox: "allow-scripts allow-forms allow-popups allow-same-origin" });
      } else if (previewKind === "pdf") {
        body = createElement(PdfViewer, { path: path });
      } else if (previewKind === "markdown") {
        // 编辑中 → 可编辑文本域；否则 → Markdown 渲染预览。
        if (editable) {
          body = textareaBody;
        } else {
          var MarkdownText = primitives && primitives.MarkdownText;
          body = createElement("div", { className: "dsh-cs-md" },
            MarkdownText ? createElement(MarkdownText, { text: text, labels: { code: { copyLabel: "复制", copiedLabel: "已复制" }, footnotes: "" } }) : createElement("pre", { className: "dsh-cs-md-pre" }, text));
        }
      } else if (previewKind === "word") {
        body = createElement(WordPreview, { path: path });
      } else if (previewKind === "excel") {
        body = createElement(ExcelPreview, { path: path });
      } else if (previewKind === "csv") {
        body = createElement(CsvPreview, { path: path });
      } else if (previewKind === "powerpoint") {
        body = createElement(PptxPreview, { path: path });
      } else if (previewKind === "unsupported") {
        body = createElement("div", { className: "dsh-cs-unsupported" }, [
          createElement("div", { className: "dsh-cs-unsupported-title" }, "该文件类型不支持预览"),
          createElement("div", { className: "dsh-cs-unsupported-sub" }, baseName(path)),
        ]);
      } else {
        body = textareaBody;
      }
      return createElement("div", { className: "dsh-cs-editor" }, [bar, body]);
    }

    // ===== 终端（WebSocket 连接宿主 node-pty） =====
    // —— 主题/配色：随 DSH 方案（浅/深）动态取 token 与 ANSI 调色板 ——
    function isDarkScheme() {
      if (typeof document === "undefined") return true;
      var decided = document.documentElement.style.colorScheme !== "";
      if (decided) return document.body.hasAttribute("data-ds-dark-theme");
      return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
    }
    function tokenValue(name) {
      if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "";
      return getComputedStyle(document.body).getPropertyValue(name).trim();
    }
    function effectiveTokenValue(name) {
      var v = tokenValue(name);
      return (v === "" || v === "transparent" || v === "unset") ? "" : v;
    }
    // one-dark / one-light 语法色（与 better-sidebar 同源），浅色下字体清晰。
    var ONE_DARK = { black:"#282c34", gray:"#abb2bf", faintGray:"#5c6370", white:"#ffffff", red:"#e06c75", green:"#98c379", yellow:"#e5c07b", blue:"#61afef", magenta:"#c678dd", cyan:"#56b6c2", orange:"#d19a66" };
    var ONE_LIGHT = { black:"#383a42", gray:"#a0a1a7", faintGray:"#4f525e", white:"#ffffff", offWhite:"#fafafa", red:"#e45649", green:"#50a14f", yellow:"#c18401", blue:"#0184bc", magenta:"#a626a4", cyan:"#0997b3", orange:"#986801", link:"#4078f2" };
    function ansiPalette(dark) {
      var p = dark ? ONE_DARK : ONE_LIGHT;
      return {
        black: p.black, red: p.red, green: p.green, yellow: p.yellow, blue: p.blue, magenta: p.magenta, cyan: p.cyan, white: p.gray,
        brightBlack: dark ? p.faintGray : p.faintGray, brightRed: p.red, brightGreen: p.green, brightYellow: p.yellow,
        brightBlue: p.blue, brightMagenta: p.magenta, brightCyan: p.cyan, brightWhite: dark ? p.white : p.offWhite,
      };
    }
    function buildTerminalTheme() {
      var dark = isDarkScheme();
      var background = effectiveTokenValue("--dsw-alias-bg-base") || (dark ? "#1a1a24" : "#ffffff");
      var foreground = effectiveTokenValue("--dsw-alias-label-primary") || (dark ? "#e6e6ee" : "#1f1f28");
      return Object.assign({ background: background, foreground: foreground, cursor: foreground, cursorAccent: background, selectionBackground: dark ? "#33334a" : "#cfe0ff" }, ansiPalette(dark));
    }
    function subscribeTheme(cb) {
      var mo = new MutationObserver(function () { cb(); });
      try { mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] }); } catch (e) {}
      try { mo.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] }); } catch (e) {}
      var mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
      if (mq && mq.addEventListener) mq.addEventListener("change", cb);
      return function () { try { mo.disconnect(); } catch (e) {} if (mq && mq.removeEventListener) mq.removeEventListener("change", cb); };
    }

    // 加载 xterm 的 UMD/CSS（宿主已提供静态路由），只加载一次。
    var _xtermReady = null;
    function ensureXterm() {
      if (_xtermReady) return _xtermReady;
      _xtermReady = new Promise(function (resolve) {
        if (window.Terminal) { resolve(); return; }
        var base = "/api/dsh-center-workbench";
        var css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = base + "/xterm.css";
        css.setAttribute("data-dsh-cs-xterm-css", "");
        document.head.appendChild(css);
        var pending = 2;
        var done = function () { pending -= 1; if (pending <= 0) resolve(); };
        var s1 = document.createElement("script");
        s1.src = base + "/xterm.js";
        s1.onload = done; s1.onerror = done;
        document.head.appendChild(s1);
        var s2 = document.createElement("script");
        s2.src = base + "/addon-fit.js";
        s2.onload = done; s2.onerror = done;
        document.head.appendChild(s2);
      });
      return _xtermReady;
    }

    // —— Office 预览库懒加载（宿主静态路由提供 UMD/IIFE，按需加载一次）——
    // docx-preview 的 UMD 依赖全局 JSZip（须先加载）；xlsx 为 SheetJS UMD；
    // pptx-preview 为宿主预打包的 IIFE（全局 pptxPreview，含 echarts 等依赖）。
    var _vendorLoads = {};
    function ensureVendor(globalName, url) {
      var g = typeof window === "undefined" ? undefined : window[globalName];
      if (g) return Promise.resolve(g);
      if (!_vendorLoads[globalName]) {
        _vendorLoads[globalName] = new Promise(function (resolve, reject) {
          var s = document.createElement("script");
          s.src = url;
          s.onload = function () { resolve(window[globalName]); };
          s.onerror = function () { reject(new Error("无法加载预览组件 " + url)); };
          document.head.appendChild(s);
        });
      }
      return _vendorLoads[globalName];
    }
    function ensureDocxLib() {
      var base = "/api/dsh-center-workbench";
      return ensureVendor("JSZip", base + "/vendor/jszip.js").then(function () {
        return ensureVendor("docx", base + "/vendor/docx-preview.js");
      });
    }
    function ensureXlsxLib() { return ensureVendor("XLSX", "/api/dsh-center-workbench/vendor/xlsx.js"); }
    function ensurePptxLib() { return ensureVendor("pptxPreview", "/api/dsh-center-workbench/vendor/pptx-preview.js"); }

    // ===== Office 预览：Word(docx) / Excel(xlsx) / CSV / PPT(pptx) =====
    // 共性：顶部工具栏（缩小/放大/适应宽度/显示方式切换）+ 内容缩放（Chromium zoom）。
    function ViewToolbar(props) {
      var modes = props.modes || [];
      var zoom = props.zoom || 1;
      var fit = !!props.fit;
      return createElement("div", { className: "dsh-cs-viewer-toolbar" }, [
        createElement("span", { className: "dsh-cs-viewer-toolbar-label" }, props.label || ""),
        createElement("button", { type: "button", className: "dsh-cs-viewer-tool-btn", title: "缩小", disabled: zoom <= 0.4, onClick: props.onZoomOut }, "−"),
        createElement("span", { className: "dsh-cs-viewer-zoom-num" }, Math.round(zoom * 100) + "%"),
        createElement("button", { type: "button", className: "dsh-cs-viewer-tool-btn", title: "放大", disabled: zoom >= 2.5, onClick: props.onZoomIn }, "+"),
        createElement("button", { type: "button", className: "dsh-cs-viewer-tool-btn", title: "缩放至适合宽度", "data-on": fit ? "" : undefined, onClick: props.onFit }, "适应宽度"),
        createElement("span", { className: "dsh-cs-viewer-tool-spacer" }),
      ].concat(modes.map(function (m) {
        return createElement("button", { key: m.key, type: "button", className: "dsh-cs-viewer-tool-btn", "data-on": props.mode === m.key ? "" : undefined, title: "显示方式：" + m.label, onClick: function () { props.onMode(m.key); } }, m.label);
      })));
    }
    function viewerMsg(text) {
      return createElement("div", { className: "dsh-cs-viewer-msg" }, text);
    }
    /** 缩放值取整（0.4–2.5）。 */
    function clampZoom(z) { return Math.max(0.4, Math.min(2.5, z)); }
    /** 行数组 → 表格（首行作表头；fit 时表格宽度 100% 适应容器；最多 200 行）。 */
    function officeTable(rows, note, fit) {
      var maxRows = 200;
      var shown = rows.slice(0, maxRows);
      var parts = [];
      if (shown.length > 0) {
        parts.push(createElement("thead", null, [createElement("tr", null, (shown[0] || []).map(function (c, i) {
          return createElement("th", { key: i }, c == null ? "" : String(c));
        }))]));
        parts.push(createElement("tbody", null, shown.slice(1).map(function (row, ri) {
          return createElement("tr", { key: ri }, (row || []).map(function (c, ci) {
            return createElement("td", { key: ci }, c == null ? "" : String(c));
          }));
        })));
      } else {
        parts.push(createElement("div", { className: "dsh-cs-viewer-note" }, "（空表）"));
      }
      return [
        createElement("table", { className: "dsh-cs-viewer-table" + (fit ? " dsh-cs-viewer-table-fit" : "") }, parts),
        note ? createElement("div", { className: "dsh-cs-viewer-note" }, note) : null,
      ];
    }
    /** CSV 文本解码：优先 UTF-8，出现替换符且浏览器支持时回退 GBK（国内常见编码）。 */
    function decodeCsvText(buf) {
      var txt = new TextDecoder("utf-8").decode(buf);
      if (txt.indexOf("\uFFFD") >= 0) {
        try { return new TextDecoder("gbk").decode(buf); } catch (e) { /* 不支持则保持 UTF-8 */ }
      }
      return txt;
    }
    /** 极简 CSV 解析：支持引号包裹、转义引号 ""、跨行字段。 */
    function parseCsv(text) {
      var rows = [], row = [], field = "", inQ = false, i = 0, n = String(text || "").length;
      while (i < n) {
        var ch = text[i];
        if (inQ) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
            inQ = false; i += 1; continue;
          }
          field += ch; i += 1; continue;
        }
        if (ch === '"') { inQ = true; i += 1; continue; }
        if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
        if (ch === "\n" || ch === "\r") {
          if (ch === "\r" && text[i + 1] === "\n") i += 1;
          row.push(field); field = ""; rows.push(row); row = []; i += 1; continue;
        }
        field += ch; i += 1;
      }
      if (field !== "" || row.length) { row.push(field); rows.push(row); }
      return rows;
    }
    function WordPreview(props) {
      var path = props.path || "";
      var mountRef = useRef(null);
      var paneRef = useRef(null);
      var [status, setStatus] = useState("loading");
      var [errMsg, setErrMsg] = useState("");
      var [zoom, setZoom] = useState(1);
      var [fit, setFit] = useState(true);
      var [mode, setMode] = useState("page"); // page | text
      var [text, setText] = useState("");
      var naturalRef = useRef(819);
      var fitRef = useRef(true);
      fitRef.current = fit;
      function fitToPane() {
        var pane = paneRef.current;
        if (!pane || naturalRef.current <= 0) return;
        setZoom(clampZoom(pane.clientWidth / naturalRef.current));
      }
      // 适应宽度模式下，面板尺寸变化时重新计算缩放。
      useEffect(function () {
        var pane = paneRef.current;
        if (!pane || typeof ResizeObserver === "undefined") return;
        var ro = new ResizeObserver(function () { if (fitRef.current) fitToPane(); });
        ro.observe(pane);
        return function () { ro.disconnect(); };
      }, []);
      useEffect(function () {
        var alive = true;
        setStatus("loading");
        fetch(mediaUrl(path)).then(function (r) {
          if (!r.ok) throw new Error("无法读取文件");
          return r.arrayBuffer();
        }).then(function (buf) {
          if (!alive) return;
          if (mode === "text") return renderText(buf);
          return renderPages(buf);
        }).catch(function (e) {
          if (alive) { setErrMsg(String((e && e.message) || e)); setStatus("error"); }
        });
        function renderPages(buf) {
          return ensureDocxLib().then(function (docxLib) {
            var el = mountRef.current;
            if (!el) return;
            el.innerHTML = "";
            return docxLib.renderAsync(buf, el, null, { inWrapper: true }).then(function () {
              if (!alive) return;
              var w = el.querySelector(".docx-wrapper > .docx") || el.firstChild;
              if (w && w.offsetWidth) naturalRef.current = w.offsetWidth;
              setStatus("ready");
              if (fit) fitToPane();
            });
          });
        }
        function renderText(buf) {
          return ensureVendor("JSZip", "/api/dsh-center-workbench/vendor/jszip.js").then(function (JSZip) {
            return JSZip.loadAsync(buf).then(function (zip) { return zip.file("word/document.xml").async("string"); });
          }).then(function (xml) {
            if (!alive) return;
            var doc = new DOMParser().parseFromString(xml, "application/xml");
            var paras = doc.getElementsByTagName("w:p");
            var out = [];
            for (var i = 0; i < paras.length; i++) {
              var ts = paras[i].getElementsByTagName("w:t");
              var line = "";
              for (var j = 0; j < ts.length; j++) line += ts[j].textContent;
              out.push(line);
            }
            setText(out.join("\n"));
            setStatus("ready");
          });
        }
        return function () { alive = false; };
      }, [path, mode]);
      if (status === "error") return viewerMsg("Word 预览失败：" + errMsg);
      return createElement("div", { className: "dsh-cs-viewer-pane" }, [
        createElement(ViewToolbar, {
          label: "Word", zoom: zoom, fit: fit, mode: mode,
          modes: [{ key: "page", label: "分页" }, { key: "text", label: "文本" }],
          onZoomIn: function () { setFit(false); setZoom(clampZoom(zoom + 0.1)); },
          onZoomOut: function () { setFit(false); setZoom(clampZoom(zoom - 0.1)); },
          onFit: function () { setFit(true); fitToPane(); },
          onMode: setMode,
        }),
        createElement("div", { ref: paneRef, className: "dsh-cs-viewer-body" }, [
          status === "loading" ? viewerMsg("Word 预览加载中…") : null,
          mode === "page"
            ? createElement("div", { ref: mountRef, className: "dsh-cs-docx-mount", style: { zoom: zoom } })
            : createElement("pre", { className: "dsh-cs-viewer-text", style: { zoom: zoom } }, text),
        ]),
      ]);
    }
    function ExcelPreview(props) {
      var path = props.path || "";
      var [status, setStatus] = useState("loading");
      var [errMsg, setErrMsg] = useState("");
      var [sheets, setSheets] = useState(null); // [{name, rows, csv}]
      var [zoom, setZoom] = useState(1);
      var [fit, setFit] = useState(true);
      var [mode, setMode] = useState("grid"); // grid | raw
      useEffect(function () {
        var alive = true;
        setStatus("loading");
        ensureXlsxLib().then(function (XLSX) {
          return fetch(mediaUrl(path)).then(function (r) {
            if (!r.ok) throw new Error("无法读取文件");
            return r.arrayBuffer();
          }).then(function (buf) {
            if (!alive) return;
            var wb = XLSX.read(buf, { type: "array", cellDates: true });
            var out = [];
            (wb.SheetNames || []).forEach(function (name) {
              var ws = wb.Sheets && wb.Sheets[name];
              out.push({
                name: name,
                rows: ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) : [],
                csv: ws ? XLSX.utils.sheet_to_csv(ws) : "",
              });
            });
            setSheets(out);
            setStatus("ready");
          });
        }).catch(function (e) {
          if (alive) { setErrMsg(String((e && e.message) || e)); setStatus("error"); }
        });
        return function () { alive = false; };
      }, [path]);
      if (status === "loading") return viewerMsg("Excel 预览加载中…");
      if (status === "error") return viewerMsg("Excel 预览失败：" + errMsg);
      var body;
      if (mode === "raw") {
        body = (sheets || []).map(function (s) {
          return createElement("div", { key: s.name, className: "dsh-cs-viewer-sheet" }, [
            createElement("div", { className: "dsh-cs-viewer-sheet-title" }, "Sheet：" + s.name),
            createElement("pre", { className: "dsh-cs-viewer-text", style: { zoom: zoom } }, s.csv || "（空）"),
          ]);
        });
      } else {
        body = (sheets || []).map(function (s) {
          return createElement("div", { key: s.name, className: "dsh-cs-viewer-sheet" }, [
            createElement("div", { className: "dsh-cs-viewer-sheet-title" }, "Sheet：" + s.name),
            officeTable(s.rows, s.rows.length > 200 ? "共 " + s.rows.length + " 行，仅显示前 200 行" : null, fit),
          ]);
        });
      }
      return createElement("div", { className: "dsh-cs-viewer-pane" }, [
        createElement(ViewToolbar, {
          label: "Excel", zoom: zoom, fit: fit, mode: mode,
          modes: [{ key: "grid", label: "表格" }, { key: "raw", label: "原始" }],
          onZoomIn: function () { setZoom(clampZoom(zoom + 0.1)); },
          onZoomOut: function () { setZoom(clampZoom(zoom - 0.1)); },
          onFit: function () { setFit(!fit); },
          onMode: setMode,
        }),
        createElement("div", { className: "dsh-cs-viewer-body" }, [
          createElement("div", { style: { zoom: zoom } }, body),
        ]),
      ]);
    }
    function CsvPreview(props) {
      var path = props.path || "";
      var [status, setStatus] = useState("loading");
      var [errMsg, setErrMsg] = useState("");
      var [rows, setRows] = useState(null);
      var [raw, setRaw] = useState("");
      var [zoom, setZoom] = useState(1);
      var [fit, setFit] = useState(true);
      var [mode, setMode] = useState("grid"); // grid | raw
      useEffect(function () {
        var alive = true;
        setStatus("loading");
        fetch(mediaUrl(path)).then(function (r) {
          if (!r.ok) throw new Error("无法读取文件");
          return r.arrayBuffer();
        }).then(function (buf) {
          if (!alive) return;
          var txt = decodeCsvText(buf);
          setRaw(txt);
          setRows(parseCsv(txt));
          setStatus("ready");
        }).catch(function (e) {
          if (alive) { setErrMsg(String((e && e.message) || e)); setStatus("error"); }
        });
        return function () { alive = false; };
      }, [path]);
      if (status === "loading") return viewerMsg("CSV 预览加载中…");
      if (status === "error") return viewerMsg("CSV 预览失败：" + errMsg);
      var body = mode === "raw"
        ? createElement("pre", { className: "dsh-cs-viewer-text", style: { zoom: zoom } }, raw)
        : officeTable(rows || [], (rows || []).length > 200 ? "共 " + rows.length + " 行，仅显示前 200 行" : null, fit);
      return createElement("div", { className: "dsh-cs-viewer-pane" }, [
        createElement(ViewToolbar, {
          label: "CSV", zoom: zoom, fit: fit, mode: mode,
          modes: [{ key: "grid", label: "表格" }, { key: "raw", label: "原始" }],
          onZoomIn: function () { setZoom(clampZoom(zoom + 0.1)); },
          onZoomOut: function () { setZoom(clampZoom(zoom - 0.1)); },
          onFit: function () { setFit(!fit); },
          onMode: setMode,
        }),
        createElement("div", { className: "dsh-cs-viewer-body" }, [
          createElement("div", { style: { zoom: zoom } }, body),
        ]),
      ]);
    }
    function PptxPreview(props) {
      var path = props.path || "";
      var mountRef = useRef(null);
      var paneRef = useRef(null);
      var viewerRef = useRef(null);
      var bufRef = useRef(null);
      var [status, setStatus] = useState("loading");
      var [errMsg, setErrMsg] = useState("");
      var [zoom, setZoom] = useState(1);
      var [fit, setFit] = useState(true);
      var [mode, setMode] = useState("list"); // list(默认，多页平铺) | slide
      var fitRef = useRef(true);
      var modeRef = useRef("slide");
      fitRef.current = fit;
      modeRef.current = mode;
      function fitToPane() {
        var pane = paneRef.current;
        if (!pane) return;
        // 幻灯模式：适应宽度；列表模式：再多取一个「约两页」高度上限，缩小后一屏可见多页。
        var byW = pane.clientWidth / 960;
        var byH = pane.clientHeight / 1100;
        setZoom(clampZoom(modeRef.current === "list" ? Math.min(byW, byH) : byW));
      }
      // 适应宽度模式下，面板尺寸变化时重新计算缩放。
      useEffect(function () {
        var pane = paneRef.current;
        if (!pane || typeof ResizeObserver === "undefined") return;
        var ro = new ResizeObserver(function () { if (fitRef.current) fitToPane(); });
        ro.observe(pane);
        return function () { ro.disconnect(); };
      }, []);
      useEffect(function () {
        var alive = true;
        var modeArg = mode;
        setStatus("loading");
        ensurePptxLib().then(function (lib) {
          var load = bufRef.current
            ? Promise.resolve(bufRef.current)
            : fetch(mediaUrl(path)).then(function (r) { if (!r.ok) throw new Error("无法读取文件"); return r.arrayBuffer(); });
          return load.then(function (buf) {
            if (!alive) return;
            bufRef.current = buf;
            var el = mountRef.current;
            if (!el) return;
            if (viewerRef.current && typeof viewerRef.current.destroy === "function") {
              try { viewerRef.current.destroy(); } catch (e) { /* ignore */ }
            }
            el.innerHTML = "";
            viewerRef.current = lib.init(el, { width: 960, height: 540, mode: modeArg });
            return Promise.resolve(viewerRef.current.preview(buf)).then(function () {
              if (!alive) return;
              setStatus("ready");
              if (fit) fitToPane();
            });
          });
        }).catch(function (e) {
          if (alive) { setErrMsg(String((e && e.message) || e)); setStatus("error"); }
        });
        return function () {
          alive = false;
          var v = viewerRef.current;
          viewerRef.current = null;
          if (v && typeof v.destroy === "function") { try { v.destroy(); } catch (e) { /* ignore */ } }
        };
      }, [path, mode]);
      if (status === "error") return viewerMsg("PPT 预览失败：" + errMsg);
      return createElement("div", { className: "dsh-cs-viewer-pane" }, [
        createElement(ViewToolbar, {
          label: "PPT", zoom: zoom, fit: fit, mode: mode,
          modes: [{ key: "slide", label: "幻灯" }, { key: "list", label: "列表" }],
          onZoomIn: function () { setFit(false); setZoom(clampZoom(zoom + 0.1)); },
          onZoomOut: function () { setFit(false); setZoom(clampZoom(zoom - 0.1)); },
          onFit: function () { setFit(true); fitToPane(); },
          onMode: setMode,
        }),
        createElement("div", { ref: paneRef, className: "dsh-cs-viewer-body" }, [
          status === "loading" ? viewerMsg("PPT 预览加载中…") : null,
          createElement("div", { ref: mountRef, className: "dsh-cs-ppt-mount" + (mode === "list" ? " dsh-cs-ppt-list" : ""), style: { zoom: zoom } }),
        ]),
      ]);
    }

    function Terminal(props) {
      var ctx = props.ctx;
      var mountRef = useRef(null);
      var wsRef = useRef(null);
      var sessCwd = useSyncExternalStore(
        useCallback(function (cb) {
          try { var s = ctx.get("sessions"); return s && s.list ? s.list.subscribe(cb) : function () {}; } catch (e) { return function () {}; }
        }, [ctx]),
        useCallback(function () {
          try {
            var s = ctx.get("sessions");
            if (!s || !s.list) return "";
            var l = s.list.getSnapshot();
            var cur = l && l.current;
            return (cur && l.byId && l.byId[cur] && l.byId[cur].cwd) || "";
          } catch (e) { return ""; }
        }, [ctx]),
      );

      useEffect(function () {
        var disposed = false;
        var cwd = sessCwd || "";
        var scheme = window.location.protocol === "https:" ? "wss" : "ws";
        var url = scheme + "://" + window.location.host + "/api/dsh-center-workbench/terminal?cwd=" + encodeURIComponent(cwd);
        var term, fit, ro, ws, unsubTheme;
        ensureXterm().then(function () {
          if (disposed) return;
          var el = mountRef.current;
          if (!el) return;
          var T = window.Terminal;
          var Fit = window.FitAddon && window.FitAddon.FitAddon;
          if (!T) { return; }
          term = new T({
            cursorBlink: true,
            fontFamily: "var(--ds-font-family-code), monospace",
            fontSize: 13,
            convertEol: true,
            theme: buildTerminalTheme(),
          });
          if (Fit) { fit = new Fit(); term.loadAddon(fit); }
          term.open(el);
          var lastScheme = isDarkScheme();
          unsubTheme = subscribeTheme(function () {
            var cur = isDarkScheme();
            if (cur !== lastScheme) { lastScheme = cur; try { term.options.theme = buildTerminalTheme(); } catch (e) {} }
          });
          var fitTerm = function () { if (fit && !disposed) { try { fit.fit(); } catch (e) {} } };
          if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(fitTerm); ro.observe(el); }
          ws = new WebSocket(url);
          wsRef.current = ws;
          ws.onopen = function () { fitTerm(); try { term.focus(); } catch (e) {} };
          ws.onmessage = function (e) { if (typeof e.data === "string") term.write(e.data); };
          ws.onclose = function () { try { term.write("\r\n[连接已断开]\r\n"); } catch (e) {} };
          ws.onerror = function () {};
          term.onData(function (data) { if (ws.readyState === 1) ws.send(data); });
          term.onResize(function (dim) { if (ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols: dim.cols, rows: dim.rows })); });
          setTimeout(fitTerm, 50);
        });
        return function () {
          disposed = true;
          if (unsubTheme) unsubTheme();
          try { if (ws) ws.close(); } catch (e) {}
          if (ro) ro.disconnect();
          try { if (term) term.dispose(); } catch (e) {}
        };
      }, [ctx, sessCwd]);

      var visible = props.visible !== false;
      return createElement("div", { className: "dsh-cs-terminal" + (visible ? "" : " dsh-cs-terminal-hidden") }, [
        createElement("div", { ref: mountRef, className: "dsh-cs-terminal-mount" }),
      ]);
    }

    // ===== 浏览器标签（内嵌 iframe + 地址栏） =====
    function WebBrowser() {
      var [url, setUrl] = useState("");
      var [src, setSrc] = useState("about:blank");
      function go() {
        var u = String(url || "").trim();
        if (!u) return;
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
        setSrc(u);
      }
      return createElement("div", { className: "dsh-cs-web" }, [
        createElement("div", { className: "dsh-cs-web-bar" }, [
          createElement("input", {
            className: "dsh-cs-web-url",
            value: url,
            spellCheck: false,
            placeholder: "输入网址后回车，如 https://github.com",
            onInput: function (e) { setUrl(e.currentTarget.value); },
            onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); go(); } },
          }),
          createElement("button", { type: "button", className: "dsh-cs-web-go", title: "打开网址", onClick: go }, "打开"),
        ]),
        createElement("iframe", { className: "dsh-cs-web-frame", src: src, sandbox: "allow-scripts allow-forms allow-popups allow-same-origin allow-modals allow-downloads" }),
      ]);
    }

    // ===== 自定义对话框（替代原生 prompt/confirm/alert） =====
    function Dialog() {
      var inputRef = useRef(null);
      var d = useSyncExternalStore(dialogSubscribe, dialogGet);
      if (!d) return null;
      var opts = d.opts;
      var kind = opts.kind;
      var style = { minWidth: "300px", maxWidth: "420px" };
      if (opts.pos && typeof opts.pos.x === "number") {
        style.left = Math.max(8, Math.min(opts.pos.x, window.innerWidth - 320)) + "px";
        style.top = Math.max(8, Math.min(opts.pos.y, window.innerHeight - 170)) + "px";
      }
      return createElement("div", { className: "dsh-cs-modal" }, [
        createElement("div", { className: "dsh-cs-modal-backdrop", onMouseDown: function () { closeDialog(kind === "prompt" ? null : false); } }),
        createElement("div", { className: "dsh-cs-dialog" + (opts.pos && typeof opts.pos.x === "number" ? "" : " dsh-cs-dialog-center"), style: style, onMouseDown: function (e) { e.stopPropagation(); } }, [
          createElement("div", { className: "dsh-cs-dialog-title" }, kind === "confirm" ? "确认" : kind === "prompt" ? "输入" : "提示"),
          createElement("div", { className: "dsh-cs-dialog-body" },
            kind === "prompt"
              ? createElement("input", { ref: inputRef, className: "dsh-cs-dialog-input", defaultValue: opts.defaultValue, autoFocus: true, spellCheck: false,
                  onKeyDown: function (e) { if (e.key === "Enter") { e.preventDefault(); closeDialog(inputRef.current ? inputRef.current.value : null); } else if (e.key === "Escape") { e.preventDefault(); closeDialog(null); } } })
              : createElement("div", { className: "dsh-cs-dialog-message" }, opts.message)),
          createElement("div", { className: "dsh-cs-dialog-actions" }, kind === "alert"
            ? createElement("button", { type: "button", className: "dsh-cs-dialog-btn dsh-cs-dialog-primary", onClick: function () { closeDialog(true); } }, "确定")
            : [
                createElement("button", { type: "button", className: "dsh-cs-dialog-btn", onClick: function () { closeDialog(kind === "prompt" ? null : false); } }, "取消"),
                createElement("button", { type: "button", className: "dsh-cs-dialog-btn dsh-cs-dialog-primary", onClick: function () { closeDialog(kind === "prompt" ? (inputRef.current ? inputRef.current.value : null) : true); } }, "确定"),
              ]),
        ]),
      ]);
    }

    // ===== 进度指示（导入/导出/删除等长任务） =====
    function Progress() {
      var p = useSyncExternalStore(progressSubscribe, progressGet);
      if (!p) return null;
      var total = p.total || 0;
      var done = p.done || 0;
      var ind = total <= 0;
      var pct = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
      return createElement("div", { className: "dsh-cs-progress" }, [
        createElement("div", { className: "dsh-cs-progress-box" }, [
          createElement("div", { className: "dsh-cs-progress-title" }, p.label || "处理中…"),
          createElement("div", { className: "dsh-cs-progress-track" }, [
            createElement("div", { className: "dsh-cs-progress-fill" + (ind ? " indeterminate" : ""), style: ind ? undefined : { width: pct + "%" } }),
          ]),
          createElement("div", { className: "dsh-cs-progress-num" }, ind ? "" : (done + " / " + total)),
        ]),
      ]);
    }

    // ===== 后台任务页（子代理拓扑 + 后台任务列表/输出/强杀） =====
    function TaskOutputDock(props) {
      var ownerSessionId = props.ownerSessionId;
      var job = props.job;
      var active = props.active;
      var onClose = props.onClose || function () {};
      var [state, setState] = useState("loading");
      useEffect(function () {
        var alive = true;
        var timer = null;
        function load() {
          if (!alive) return;
          fetch("/api/dsh-center-workbench/tasks/output", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: ownerSessionId, id: job.id }),
          }).then(function (r) { return r.json(); })
            .then(function (json) {
              if (!alive) return;
              if (json && json.ok) setState({ text: json.text || "", truncated: !!json.truncated, read: !!json.read });
              else setState(function (c) { return c === "loading" ? "error" : c; });
            })
            .catch(function () { if (alive) setState(function (c) { return c === "loading" ? "error" : c; }); });
        }
        load();
        if (active && isJobLive(job)) timer = window.setInterval(load, 2000);
        return function () { alive = false; if (timer) window.clearInterval(timer); };
      }, [ownerSessionId, job.id, active, job.status]);
      var preRef = useRef(null);
      useEffect(function () {
        if (isJobLive(job) && state && typeof state === "object" && state.text && preRef.current) {
          preRef.current.scrollTop = preRef.current.scrollHeight;
        }
      }, [state, job.status]);
      return createElement("div", { className: "dsh-cs-task-jobs-pane", role: "region", "aria-label": job.label + " 后台任务输出" }, [
        createElement("div", { className: "dsh-cs-task-jobs-pane-header" }, [
          createElement("span", { className: "dsh-cs-task-jobs-dot " + jobDotClass(job.status) }),
          createElement("span", { className: "dsh-cs-task-jobs-pane-label", title: job.label }, job.label),
          createElement("span", { className: "dsh-cs-task-jobs-pane-status" }, jobStatusLabel(job.status) + (job.detail && job.detail !== "" ? " · " + job.detail : "")),
          createElement("button", { type: "button", className: "dsh-cs-task-jobs-pane-close", title: "关闭", onClick: onClose }, "×"),
        ]),
        state === "loading" ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "加载中…") : null,
        state === "error" ? createElement("div", { className: "dsh-cs-task-jobs-hint dsh-cs-task-jobs-error" }, "输出读取失败") : null,
        typeof state === "object"
          ? (state.text.length > 0
            ? createElement("pre", { ref: preRef, className: "dsh-cs-task-jobs-pre" }, state.text)
            : (state.read ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "暂无输出")
              : createElement("div", { className: "dsh-cs-task-jobs-hint" }, "等待模型读取该任务的输出（模型执行 job_output 后，输出会显示在这里）")))
          : null,
        typeof state === "object" && state.truncated ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "输出过长，已截断显示") : null,
      ]);
    }

    function JobsSection(props) {
      var byId = props.byId;
      var jobsBySession = props.jobsBySession;
      var rootId = props.rootId;
      var active = props.active;
      var rows = useMemo(function () { return orderJobs(collectTreeJobs(byId, jobsBySession, rootId)); }, [byId, jobsBySession, rootId]);
      var [selectedId, setSelectedId] = useState(undefined);
      var [armedId, setArmedId] = useState(undefined);
      var [killingId, setKillingId] = useState(undefined);
      var [killErrorId, setKillErrorId] = useState(undefined);
      var [now, setNow] = useState(function () { return Date.now(); });
      var selectedRow;
      rows.forEach(function (r) { if (r.job.id === selectedId) selectedRow = r; });
      var liveCount = 0;
      rows.forEach(function (r) { if (isJobLive(r.job)) liveCount += 1; });
      var ownerSet = new Set();
      rows.forEach(function (r) { ownerSet.add(r.ownerSessionId); });
      var multiOwner = ownerSet.size > 1;
      useEffect(function () {
        if (armedId === undefined) return;
        var t = window.setTimeout(function () { setArmedId(undefined); }, 3000);
        return function () { window.clearTimeout(t); };
      }, [armedId]);
      useEffect(function () {
        if (liveCount === 0) return;
        setNow(Date.now());
        var t = window.setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { window.clearInterval(t); };
      }, [liveCount]);
      useEffect(function () {
        if (selectedId !== undefined && selectedRow === undefined) setSelectedId(undefined);
      }, [selectedId, selectedRow]);
      function kill(row) {
        setKillingId(row.job.id);
        fetch("/api/dsh-center-workbench/tasks/kill", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: row.ownerSessionId, id: row.job.id }),
        }).then(function (r) { return r.json(); })
          .then(function (json) {
            if (!(json && json.ok)) setKillErrorId(row.job.id);
            else setKillErrorId(undefined);
            setKillingId(undefined); setArmedId(undefined);
          })
          .catch(function () { setKillErrorId(row.job.id); setKillingId(undefined); setArmedId(undefined); });
      }
      if (rows.length === 0) return null;
      var countLabel = liveCount > 0
        ? (rows.length + " 个后台任务 · " + liveCount + " 运行中")
        : (rows.length + " 个后台任务");
      var section = createElement("div", { key: "jobs", className: "dsh-cs-task-jobs" }, [
        createElement("div", { className: "dsh-cs-task-jobs-header" }, [
          createElement("span", { className: "dsh-cs-task-jobs-title" }, "后台任务"),
          createElement("span", { className: "dsh-cs-task-jobs-count" }, countLabel),
        ]),
        createElement("ul", { className: "dsh-cs-task-jobs-list", "aria-label": "后台任务" }, rows.map(function (row) {
          var job = row.job;
          var live = isJobLive(job);
          var selected = selectedId === job.id;
          var armed = armedId === job.id;
          var killing = killingId === job.id;
          var elapsed = live ? (now - job.startedAt) : ((job.finishedAt || job.startedAt) - job.startedAt);
          var secondary = [
            (multiOwner ? row.ownerTitle : null),
            jobStatusLabel(job.status),
            (job.detail && job.detail !== "" ? job.detail : null),
            formatJobDuration(elapsed),
          ].filter(Boolean).join(" · ");
          return createElement("li", { key: job.id, className: "dsh-cs-task-jobs-row" + (!live ? " dsh-cs-task-jobs-settled" : "") + (selected ? " dsh-cs-task-jobs-selected" : "") }, [
            createElement("button", {
              type: "button",
              className: "dsh-cs-task-jobs-row-main",
              "aria-pressed": selected ? "true" : "false",
              "aria-label": job.label + " " + secondary,
              onClick: function () { setSelectedId(selected ? undefined : job.id); },
            }, [
              createElement("span", { className: "dsh-cs-task-job-dot " + jobDotClass(job.status) }),
              createElement("span", { className: "dsh-cs-task-jobs-content" }, [
                createElement("span", { className: "dsh-cs-task-jobs-line" }, [
                  createElement("span", { className: "dsh-cs-task-jobs-kind", title: job.kind }, job.kind),
                  createElement("span", { className: "dsh-cs-task-jobs-label", title: job.label }, job.label),
                ]),
                createElement("span", { className: "dsh-cs-task-jobs-secondary" }, secondary),
              ]),
            ]),
            job.status === "running" ? createElement("button", {
              type: "button",
              className: "dsh-cs-task-jobs-kill" + (armed ? " dsh-cs-task-jobs-kill-armed" : ""),
              "aria-label": armed ? "再次点击确认终止" : "终止",
              title: armed ? "再次点击确认终止" : "终止",
              disabled: killing,
              onClick: function (e) { e.stopPropagation(); if (armed) kill(row); else setArmedId(job.id); },
            }, armed ? "确认终止" : createElement("svg", {
              width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg",
            }, createElement("rect", { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: "currentColor", stroke: "none" }))) : null,
            killErrorId === job.id ? createElement("span", { className: "dsh-cs-task-jobs-kill-error" }, "终止失败") : null,
          ]);
        })),
      ]);
      // 输出面板作为滚动容器的直接子元素（sticky bottom 停靠，对齐 better-sidebar：
      // 列表在上方滚动时面板常驻底部，像终端一样不随内容滚走）。
      var dock = selectedRow !== undefined
        ? createElement(TaskOutputDock, {
          key: "dock",
          ownerSessionId: selectedRow.ownerSessionId,
          job: selectedRow.job,
          active: active,
          onClose: function () { setSelectedId(undefined); },
        })
        : null;
      return createElement(React.Fragment, null, section, dock);
    }

    function TasksView(props) {
      var ctx = props.ctx;
      var active = !!props.active;
      var sessions = ctx.get("sessions");
      var list = useSyncExternalStore(
        useCallback(function (cb) {
          try { return sessions && sessions.list ? sessions.list.subscribe(cb) : function () {}; } catch (e) { return function () {}; }
        }, [sessions]),
        useCallback(function () {
          try {
            if (!sessions || !sessions.list) return EMPTY_SESSION_LIST;
            var l = sessions.list.getSnapshot();
            return l || EMPTY_SESSION_LIST; // 返回 harness 缓存的稳定快照引用，避免无限重渲染
          } catch (e) { return EMPTY_SESSION_LIST; }
        }, [sessions]),
      );
      var byId = list.byId || {};
      var current = list.current || "";
      var rootId = useMemo(function () { return rootAncestor(byId, current); }, [byId, current]);
      // —— 目录化拓扑（better-sidebar 同款 seam）：subagentsByParent 惰性 catalog + setSubagentCatalogOpen 观察 ——
      var catalogs = list.subagentsByParent || {};
      var hasCatalogs = useMemo(function () { return Object.keys(catalogs).length > 0; }, [catalogs]);
      var observedRef = useRef(new Set());
      /** 观察一个父目录的 catalog（宿主开始为其刷新；重复调用幂等）。 */
      function observe(parentId) {
        if (observedRef.current.has(parentId)) return;
        observedRef.current.add(parentId);
        try { if (sessions && typeof sessions.setSubagentCatalogOpen === "function") sessions.setSubagentCatalogOpen(parentId, true); } catch (e) { /* ignore */ }
      }
      /** 关闭全部观察（根切换/卸载/页面隐藏时调用）。 */
      function unobserveAll() {
        var s = observedRef.current;
        try {
          if (sessions && typeof sessions.setSubagentCatalogOpen === "function") {
            s.forEach(function (id) { sessions.setSubagentCatalogOpen(id, false); });
          }
        } catch (e) { /* ignore */ }
        s.clear();
      }
      /** 手动刷新一个父目录的 catalog（错误重试 / 顶部刷新）。 */
      function refreshCatalog(parentId) {
        try {
          if (sessions && typeof sessions.refreshSubagents === "function") sessions.refreshSubagents(parentId);
          else observe(parentId);
        } catch (e) { /* ignore */ }
      }
      /** 遍历有子目录的节点（collectBranchIds 等价实现）。 */
      function collectBranchIdsFrom(c) {
        var out = [], seen = new Set();
        function visit(parentId) {
          if (seen.has(parentId)) return;
          seen.add(parentId);
          var cat = c[parentId];
          (cat && cat.entries || []).forEach(function (entry) {
            if (entry.kind === "child" && entry.hasChildren) { out.push(entry.id); visit(entry.id); }
          });
        }
        if (rootId !== undefined) visit(rootId);
        return out;
      }
      var branches = useMemo(function () { return hasCatalogs ? collectBranchIdsFrom(catalogs) : []; }, [catalogs, rootId, hasCatalogs]);
      // 根观察：**不能**依赖 catalog 是否已存在——第一个 catalog 正是由这里请求的，
      // 用 hasCatalogs 做门会造成死锁（没人请求 → subagentsByParent 永远为空 →
      // 门永远关着，页面一直「加载中…」）。依赖只留根/可见性，catalog 快照每次
      // 重建（宿主 getListSnapshot 每次 Object.fromEntries）都不会打断观察。
      useEffect(function () {
        if (!active || rootId === undefined) return;
        observe(rootId);
        return function () { unobserveAll(); };
      }, [rootId, active]);
      // 分支观察：只增不减。branches 的身份随每次会话列表快照变化，effect 会频繁
      // 重跑；若像以前那样在 cleanup 里 unobserveAll，就会「释放→重开」抖振，
      // 把宿主 catalog 反复重置为 loading（且每次刷新都 notify → 再次重跑 → 死循环）。
      useEffect(function () {
        if (!active) return;
        branches.forEach(observe);
      }, [branches, active]);
      // 卸载时释放全部观察（宿主停止刷新不再使用的 catalog）。
      useEffect(function () {
        return function () { unobserveAll(); };
      }, []);

      var [live, setLive] = useState({});
      var liveAbortRef = useRef(null);
      useEffect(function () { setLive({}); }, [rootId]);
      useEffect(function () {
        if (!active || rootId === undefined) return;
        var alive = true;
        var timer = null;
        function tick() {
          if (!alive) return;
          if (liveAbortRef.current) try { liveAbortRef.current.abort(); } catch (e) {}
          var ac = new AbortController();
          liveAbortRef.current = ac;
          fetch("/api/dsh-center-workbench/tasks/live?root=" + encodeURIComponent(rootId), { signal: ac.signal })
            .then(function (r) { return r.json(); })
            .then(function (json) { if (alive && json && json.ok) setLive(json.live || {}); })
            .catch(function () { /* 保留上次 live 映射，下一轮重试 */ })
            .then(function () { if (alive) timer = setTimeout(tick, 3000); });
        }
        tick();
        return function () { alive = false; if (timer) clearTimeout(timer); if (liveAbortRef.current) { try { liveAbortRef.current.abort(); } catch (e) {} } };
      }, [rootId, active]);

      /**
       * 跳进子代理会话。地址必须带 catalog 的 mode（one-shot / continuable）：
       * 会话控制器的 selectSubagent 会用 `entry.mode !== address.mode` 校验，
       * 缺 mode 会直接抛错（点击卡片无反应）。catalog 行自带 mode；无 catalog 的
       * 旧宿主回退到会话控制器已保留的地址解析。
       */
      function openChild(childId, parentId, mode) {
        try {
          if (!sessions || !sessions.openSubagent) return;
          var addr = { parentSessionId: parentId, childSessionId: childId };
          var m = (mode === "one-shot" || mode === "continuable") ? mode : undefined;
          if (m === undefined && typeof sessions.subagentAddress === "function") {
            var retained = sessions.subagentAddress(childId);
            if (retained && (retained.mode === "one-shot" || retained.mode === "continuable")) m = retained.mode;
          }
          if (m !== undefined) addr.mode = m;
          sessions.openSubagent(addr);
        } catch (e) { console.error('[dsh-center-workbench] openSubagent failed:', e); }
      }
      function openMain() {
        try { if (rootId !== undefined && sessions && sessions.open) sessions.open(rootId); } catch (e) { /* ignore */ }
      }
      /** 目录未就绪的加载占位行（byId 有直系子代理则逐条占位，否则"加载中…"）。 */
      function loadingRows(parentId, level) {
        var children = directChildren(byId, parentId);
        if (children.length === 0) {
          return createElement("div", { key: "l0", className: "dsh-cs-task-empty dsh-cs-task-loading", style: { paddingLeft: (level * 14) + "px" } }, "加载中…");
        }
        return children.map(function (s) {
          return createElement("div", {
            key: s.id,
            role: "treeitem",
            "aria-disabled": "true",
            "aria-level": level,
            "aria-label": "加载中…",
            className: "dsh-cs-task-row dsh-cs-task-row-disabled dsh-cs-task-row-loading",
            style: { paddingLeft: (7 + level * 14) + "px" },
          }, [
            createElement("span", { className: "dsh-cs-task-dot " + (s.running === true ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
            createElement("span", { className: "dsh-cs-task-label" }, "加载中…"),
          ]);
        });
      }
      /** 运行中卡片的活动行：工具调用 + 最后文本；都没有则"思考中…"。 */
      function liveLines(entryId) {
        var lv = live[entryId];
        if (lv === undefined || (lv.text === undefined && lv.tool === undefined)) {
          return createElement("div", { className: "dsh-cs-task-live" }, "思考中…");
        }
        return createElement("div", { className: "dsh-cs-task-live" }, [
          lv.tool ? createElement("span", { className: "dsh-cs-task-live-tool" }, lv.tool.name + (lv.tool.args ? " " + String(lv.tool.args).slice(0, 60) : "")) : null,
          lv.text ? createElement("span", { className: "dsh-cs-task-live-text" }, String(lv.text).replace(/\s+/g, " ").trim()) : null,
        ]);
      }
      /** 目录化行渲染（better-sidebar CatalogRows 等价）：加载占位/错误重试/诊断/子目录递归。 */
      function renderCatalog(parentId, level) {
        var cat = catalogs[parentId];
        var emptyLoading = cat && cat.state === "loading" && (!cat.entries || cat.entries.length === 0);
        if (!cat || emptyLoading) return loadingRows(parentId, level);
        if (cat.state === "error") {
          return [createElement("div", { key: "err", className: "dsh-cs-task-error", style: { paddingLeft: (level * 14) + "px" } }, [
            createElement("span", { className: "dsh-cs-task-error-text" }, (cat.error && cat.error.message) || "目录加载失败"),
            createElement("button", { type: "button", className: "dsh-cs-task-error-retry", onClick: function () { refreshCatalog(parentId); } }, "重试"),
          ])];
        }
        var entries = (cat.entries || []).filter(function (entry) {
          if (entry.kind === "child") return !((entry.label || "").indexOf(SIDE_LABEL_PREFIX) === 0);
          var s = byId[entry.id];
          return !(s && (s.displayTitle || "").indexOf(SIDE_LABEL_PREFIX) === 0);
        });
        return entries.map(function (entry) {
          if (entry.kind === "diagnostic") {
            return createElement("div", { key: entry.id, role: "treeitem", "aria-disabled": "true", "aria-level": level, title: diagnosticReasonOf(entry.reason), className: "dsh-cs-task-row dsh-cs-task-row-disabled", style: { paddingLeft: (7 + level * 14) + "px" } }, [
              createElement("span", { className: "dsh-cs-task-dot dsh-cs-task-dot-error" }),
              createElement("span", { className: "dsh-cs-task-label" }, entry.id),
              createElement("span", { className: "dsh-cs-task-secondary" }, diagnosticReasonOf(entry.reason)),
            ]);
          }
          var s = byId[entry.id];
          var label = entry.label || (s && s.displayTitle) || entry.id;
          var running = entry.activity === "running";
          var secondary = [s && s.displayTitle, modeLabelOf(entry.mode), running ? "运行中" : "未运行"].filter(Boolean).join(" · ");
          var isCurrent = entry.id === current;
          return createElement("div", { key: entry.id, className: "dsh-cs-task-node", style: { paddingLeft: (level * 14) + "px" } }, [
            createElement("button", { type: "button", role: "treeitem", tabIndex: 0, "aria-level": level, "aria-expanded": entry.hasChildren ? "true" : undefined, "aria-current": isCurrent ? "true" : undefined, "aria-label": label + " " + secondary, className: "dsh-cs-task-row" + (isCurrent ? " dsh-cs-task-row-active" : ""), onClick: function () { openChild(entry.id, parentId, entry.mode); } }, [
              createElement("span", { className: "dsh-cs-task-dot " + (running ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
              createElement("span", { className: "dsh-cs-task-label" }, label),
              createElement("span", { className: "dsh-cs-task-secondary" }, secondary),
            ]),
            running ? liveLines(entry.id) : null,
            entry.hasChildren
              ? createElement("div", { className: "dsh-cs-task-children", role: "group" }, renderCatalog(entry.id, level))
              : null,
          ]);
        });
      }
      /** 旧版兜底：无 subagent seam（subagentsByParent 为空）时按 byId 镜像渲染拓扑。 */
      function renderLevel(pid, depth) {
        return directChildren(byId, pid).map(function (s) {
          var running = s.running === true;
          return createElement("div", { key: s.id, className: "dsh-cs-task-node", style: { paddingLeft: (depth * 14) + "px" } }, [
            createElement("button", { type: "button", role: "treeitem", tabIndex: 0, "aria-level": depth, "aria-current": s.id === current ? "true" : undefined, className: "dsh-cs-task-row" + (s.id === current ? " dsh-cs-task-row-active" : ""), onClick: function () { openChild(s.id, pid); } }, [
              createElement("span", { className: "dsh-cs-task-dot " + (running ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
              createElement("span", { className: "dsh-cs-task-label" }, s.displayTitle || s.id),
              createElement("span", { className: "dsh-cs-task-secondary" }, running ? "运行中" : "空闲"),
            ]),
            running ? liveLines(s.id) : null,
          ].concat(renderLevel(s.id, depth + 1)));
        });
      }
      var rootSummary = rootId !== undefined ? byId[rootId] : undefined;
      var rootCatalog = rootId !== undefined ? catalogs[rootId] : undefined;
      // 摘要已宣告成员、但描述符目录还没跟上（或刚 ready 仍为空）→ 加载占位，避免闪空。
      var summaryBackedLoading = hasCatalogs && rootId !== undefined
        && (rootCatalog === undefined || (rootCatalog.state === "ready" && rootCatalog.entries.length === 0))
        && directChildren(byId, rootId).length > 0;
      var readyEmpty = hasCatalogs && rootCatalog && rootCatalog.state === "ready"
        && rootCatalog.entries.length === 0
        && directChildren(byId, rootId || "").length === 0;
      var totals = useMemo(function () {
        var n = 0, r = 0;
        Object.keys(byId).forEach(function (k) {
          var s = byId[k];
          if (!s || s.origin !== "subagent" || isSideThreadSummary(s)) return;
          var seen = new Set();
          var cur = s;
          var under = false;
          while (cur && cur.origin === "subagent" && cur.parentId !== undefined && !seen.has(cur.id)) {
            seen.add(cur.id);
            if (cur.parentId === rootId) { under = true; break; }
            cur = byId[cur.parentId];
          }
          if (under) { n += 1; if (s.running === true) r += 1; }
        });
        return { count: n, running: r };
      }, [byId, rootId]);
      var bodyRef = useRef(null);
      /** 树内方向键导航（ArrowUp/Down/Home/End），跳跃禁用行。 */
      function onTreeKeyDown(e) {
        var el = bodyRef.current;
        if (!el) return;
        var items = el.querySelectorAll('[role="treeitem"]:not([aria-disabled="true"])');
        if (items.length === 0) return;
        var idx = Array.prototype.indexOf.call(items, document.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); focusAt(items, idx + 1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); focusAt(items, idx < 0 ? items.length - 1 : idx - 1); }
        else if (e.key === "Home") { e.preventDefault(); focusAt(items, 0); }
        else if (e.key === "End") { e.preventDefault(); focusAt(items, items.length - 1); }
      }
      function focusAt(items, index) {
        var n = items.length;
        if (n === 0) return;
        var item = items[((index % n) + n) % n];
        if (item && item.focus) item.focus();
      }
      var topologyBody;
      if (rootId === undefined) {
        topologyBody = createElement("div", { className: "dsh-cs-tasks-empty" }, "无法解析当前会话的主代理（无子代理数据或宿主未挂载子代理服务）。");
      } else {
        var rootTitle = (rootSummary && rootSummary.displayTitle) || "主代理";
        topologyBody = createElement("div", { className: "dsh-cs-tasks-tree", role: "tree", "aria-label": "子代理拓扑" }, [
          createElement("div", { role: "treeitem", tabIndex: 0, "aria-level": 0, "aria-current": rootId === current ? "true" : undefined, "aria-label": rootTitle + " 主代理" }, [
            createElement("button", { type: "button", className: "dsh-cs-task-row dsh-cs-task-root" + (rootId === current ? " dsh-cs-task-row-active" : ""), onClick: openMain }, [
              createElement("span", { className: "dsh-cs-task-dot " + (rootSummary && rootSummary.running === true ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
              createElement("span", { className: "dsh-cs-task-label" }, rootTitle),
              createElement("span", { className: "dsh-cs-task-secondary" }, "主代理 · " + (rootSummary && rootSummary.running === true ? "运行中" : "空闲")),
            ]),
          ]),
          createElement("div", { className: "dsh-cs-task-children", role: "group" }, summaryBackedLoading
            ? loadingRows(rootId, 1)
            : (hasCatalogs ? renderCatalog(rootId, 1) : renderLevel(rootId, 1))),
          readyEmpty ? createElement("div", { className: "dsh-cs-tasks-empty" }, [
            createElement("div", null, "暂无子代理"),
            createElement("div", { className: "dsh-cs-tasks-empty-hint" }, "当前主代理派生的子代理将显示在这里"),
          ]) : null,
        ]);
      }

      return createElement("div", { className: "dsh-cs-tasks" }, [
        createElement("div", { className: "dsh-cs-tasks-header" }, [
          createElement("span", { className: "dsh-cs-tasks-title" }, "后台任务" + (rootSummary && rootSummary.displayTitle ? " · " + rootSummary.displayTitle : "")),
          totals.count > 0 ? createElement("span", { className: "dsh-cs-tasks-count" },
            totals.running > 0 ? (totals.count + " 个子代理 · " + totals.running + " 运行中") : (totals.count + " 个子代理")) : null,
          createElement("button", {
            type: "button",
            className: "dsh-cs-task-refresh",
            title: props.autoOpen ? "新子代理 / 新任务出现时自动切到本页（点击关闭）" : "自动切页已关闭（点击开启）",
            onClick: props.onToggleAutoOpen || function () {},
          }, props.autoOpen ? "自动弹出：开" : "自动弹出：关"),
          createElement("button", { type: "button", className: "dsh-cs-task-refresh", title: "刷新拓扑", disabled: rootId === undefined, onClick: function () { if (rootId !== undefined) refreshCatalog(rootId); } }, "刷新"),
        ]),
        createElement("div", { ref: bodyRef, className: "dsh-cs-tasks-body", onKeyDown: onTreeKeyDown }, [
          topologyBody,
          createElement(JobsSection, { byId: byId, jobsBySession: list.jobsBySession, rootId: rootId, active: active }),
        ]),
      ]);
      /** 子代理模式的中文标签。 */
      function modeLabelOf(mode) { return mode === "one-shot" ? "一次性" : "可续接"; }
      /** 目录诊断原因的中文标签。 */
      function diagnosticReasonOf(reason) {
        if (reason === "corrupt") return "目录损坏";
        if (reason === "unsupported") return "不支持的条目";
        return "不可用";
      }
    }

    // ===== SSH(ssh-ops) 嵌入：把 dsh-ssh-ops 的悬浮面板“显示”进本标签页 =====
    // 面板留在 ssh-ops 自己的 overlay 层：进入标签时给 <html> 打上
    // data-dsh-cw-ssh-active + 本容器矩形（CSS 变量 + 面板内联样式双保险）把
    // position:fixed 面板钉到本区域；离开时移除并还原。会话标签栏内的权威
    // 按钮（[role="tablist"] 内）是唯一可点击的开/关通道；本组件可能因布局
    // 变化被 React 重挂载，用模块级计数保证「打开/关闭」只由首个挂载执行。
    var cwSshHostCount = 0;
    function sshOpsButton() {
      var list = document.querySelectorAll('[data-dsh-ssh-ops-tab="true"]');
      for (var i = 0; i < list.length; i++) {
        if (list[i].closest && list[i].closest('[role="tablist"]')) return list[i];
      }
      return list.length ? list[0] : null;
    }
    function SshOpsHost(props) {
      var hostRef = useRef(null);
      var [phantom, setPhantom] = useState(true); // 面板尚未出现（诊断提示用）
      useLayoutEffect(function () {
        var hostEl = hostRef.current;
        if (!hostEl) return;
        var PANEL = '[data-dsh-ssh-ops-panel="true"]';
        var ACTIVE = "data-dsh-cw-ssh-active";
        var html = document.documentElement;
        var origInline = null; // 面板被 pin 之前的内联样式快照 {panel, saved}
        var overlayEl = null; // shell.overlay 层级容器（其 z=20 会封住面板的 z=900）
        var savedOverlayZ = undefined;
        var clickedOpen = false;
        var retryTimer = null;
        var diagDone = false;
        var lastClickAt = 0;
        cwSshHostCount += 1;
        var firstHost = cwSshHostCount === 1;
        var diag = function (msg) { try { console.log("[dsh-center-workbench:ssh]", msg); } catch (e) {} };
        diag("挂载 host（first=" + firstHost + "）btn=" + (sshOpsButton() ? "有" : "无") + " panel=" + (!!document.querySelector(PANEL)));
        function applyRect() {
          var r;
          try { r = hostEl.getBoundingClientRect(); } catch (e) { return; }
          if (!r || !r.width || !r.height) return;
          var panel = document.querySelector(PANEL);
          if (!panel) { try { setPhantom(true); } catch (e) { /* ignore */ } return; }
          try { setPhantom(false); } catch (e) { /* ignore */ }
          if (!origInline) {
            origInline = { panel: panel, saved: {} };
            ["left", "top", "right", "bottom", "width", "height", "maxWidth", "visibility"].forEach(function (k) {
              origInline.saved[k] = panel.style[k];
            });
          }
          // 根因：DSH 的 shell.overlay 层（overlayLayer，z=20）低于本插件工作台根
          //（.dsh-cs-host，z=25），面板 z=900 也被封在 20 的层叠上下文里，永远画在工作台下面。
          // 钉住期间把该层抬到 26（略高于工作台），卸载时还原。
          if (!overlayEl) {
            var ov = panel.closest('[data-shell-overlay="true"]') || null;
            if (ov) {
              overlayEl = ov;
              savedOverlayZ = ov.style.zIndex || "";
              ov.style.zIndex = "26";
              diag("抬高层级容器 overlayLayer 至 z=" + getComputedStyle(ov).zIndex);
            } else {
              diag("未找到 shell.overlay 层级容器（data-shell-overlay）");
            }
          }
          // 面板在 shell.overlay 内，其 fixed 定位可能相对某个 transform 祖先
          //（offsetParent 即该包含块；null=视口）。按包含块原点换算坐标，
          // 否则面板会被钉到视口坐标的“错误位置”（看不见）。
          var cb = panel.offsetParent;
          var blockLeft = 0, blockTop = 0;
          if (cb && cb !== document.body && cb !== document.documentElement) {
            var cr;
            try { cr = cb.getBoundingClientRect(); } catch (e) { cr = null; }
            if (cr) { blockLeft = cr.left; blockTop = cr.top; }
          }
          panel.style.left = (r.left - blockLeft) + "px";
          panel.style.top = (r.top - blockTop) + "px";
          panel.style.right = "auto";
          panel.style.bottom = "auto";
          panel.style.width = r.width + "px";
          panel.style.height = r.height + "px";
          panel.style.maxWidth = "none";
          panel.style.position = "fixed";
          // 必须带 important：覆盖本插件“钉住前隐藏”的 CSS 规则，防止面板永久隐藏。
          panel.style.setProperty("visibility", "visible", "important");
          // 诊断：钉住之后检查真实最终状态（此前在钉住前检查，报的是旧状态）。
          if (!diagDone) {
            diagDone = true;
            diag("已钉住 host=" + [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(",") + " cb=" + (cb ? (cb.tagName + " block=" + Math.round(blockLeft) + "," + Math.round(blockTop)) : "viewport") + " panel=" + [Math.round(panel.getBoundingClientRect().left), Math.round(panel.getBoundingClientRect().top), Math.round(panel.getBoundingClientRect().width), Math.round(panel.getBoundingClientRect().height)].join(","));
            try {
              var cs = getComputedStyle(panel);
              var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
              var topEl = document.elementFromPoint(cx, cy);
              diag("覆盖检查：panel visibility=" + cs.visibility + " display=" + cs.display + " z=" + cs.zIndex + " opacity=" + cs.opacity + " layer=" + (overlayEl ? getComputedStyle(overlayEl).zIndex : "miss") + " | host中心(" + cx + "," + cy + ")最上层=" + (topEl ? (topEl.tagName + "." + String(topEl.className || "").slice(0, 48) + (topEl.getAttribute && topEl.getAttribute("data-dsh-ssh-ops-panel") ? " [SSH-PANEL]" : "") + ((panel.contains(topEl) || topEl === panel) ? " [INSIDE-SSH-PANEL]" : "")) : "null"));
              // 400ms 后再查一次：若 ssh-ops 重渲染重置了内联样式，这里会暴露“再次被隐藏”。
              window.setTimeout(function () {
                try {
                  var cs2 = getComputedStyle(panel);
                  var topEl2 = document.elementFromPoint(cx, cy);
                  diag("400ms后复查：panel visibility=" + cs2.visibility + " 最上层=" + (topEl2 ? (topEl2.tagName + "." + String(topEl2.className || "").slice(0, 48) + (topEl2.getAttribute && topEl2.getAttribute("data-dsh-ssh-ops-panel") ? " [SSH-PANEL]" : "") + ((panel.contains(topEl2) || topEl2 === panel) ? " [INSIDE-SSH-PANEL]" : "")) : "null"));
                } catch (e2) { /* ignore */ }
              }, 400);
            } catch (e) { /* ignore */ }
          }
        }
        applyRect();
        html.setAttribute(ACTIVE, "");
        if (firstHost) {
          var wasOpen = html.hasAttribute("data-dsh-ssh-ops-panel-open");
          if (!document.querySelector(PANEL) && !wasOpen) {
            var btn = sshOpsButton();
            diag("点击 ssh-ops 头部按钮打开面板… open=" + !!btn);
            if (btn) {
              try { btn.click(); clickedOpen = true; lastClickAt = Date.now(); } catch (e) { /* ignore */ }
              retryTimer = window.setTimeout(function () {
                if (!document.querySelector(PANEL) && !html.hasAttribute("data-dsh-ssh-ops-panel-open")) {
                  diag("600ms 后仍未出现面板，重试点击…");
                  var btn2 = sshOpsButton();
                  if (btn2) { try { btn2.click(); lastClickAt = Date.now(); } catch (e) { /* ignore */ } }
                }
              }, 600);
            }
          }
        }
        var ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applyRect) : null;
        if (ro) ro.observe(hostEl);
        window.addEventListener("resize", applyRect);
        var timer = window.setInterval(function () {
          applyRect();
          // 面板不在且确定未开启（html 无 open 标记）时才点击重开；
          // 盲点击会命中 toggle 语义，把已开启的面板误关闭。
          var now = Date.now();
          if (!document.querySelector(PANEL) && !html.hasAttribute("data-dsh-ssh-ops-panel-open")) {
            if (now - lastClickAt > 800 && sshOpsButton()) {
              lastClickAt = now;
              diag("面板不在且未开启：重点击打开…");
              try { sshOpsButton().click(); } catch (e) { /* ignore */ }
            }
          }
        }, 120);
        return function () {
          window.clearInterval(timer);
          if (retryTimer) window.clearTimeout(retryTimer);
          if (ro) ro.disconnect();
          window.removeEventListener("resize", applyRect);
          cwSshHostCount -= 1;
          if (cwSshHostCount > 0) return; // 仍有其它实例挂载：只释放本实例
          if (origInline) {
            var saved = origInline.saved;
            Object.keys(saved).forEach(function (k) {
              if (saved[k] === "") origInline.panel.style.removeProperty(k);
              else origInline.panel.style[k] = saved[k];
            });
          }
          html.removeAttribute(ACTIVE);
          if (overlayEl && savedOverlayZ !== undefined) {
            if (savedOverlayZ === "") overlayEl.style.removeProperty("z-index");
            else overlayEl.style.zIndex = savedOverlayZ;
            overlayEl = null;
            savedOverlayZ = undefined;
          }
          if (clickedOpen && document.querySelector(PANEL)) {
            var closeBtn = sshOpsButton();
            if (closeBtn) { try { closeBtn.click(); } catch (e) { /* ignore */ } }
          }
        };
      }, []);
      return createElement("div", { ref: hostRef, className: "dsh-cs-ssh-host" }, [
        phantom ? createElement("div", { className: "dsh-cs-ssh-hint" }, "正在等待 SSH 面板加载…（若长时间未出现，请查看控制台 [dsh-center-workbench:ssh] 日志）") : null,
      ]);
    }

    // ===== 面板外壳（居中 + 标题栏 + 标签页 + 宽度拖拽） =====
    function Panel(props) {
      var ctx = props.ctx;
      var snapshot = useSyncExternalStore(subscribe, getState);
      var dragRef = useRef(null);
      var panelRef = useRef(null);
      var splitDragRef = useRef(null);
      var browserRef = useRef(null);
      var splitRef = useRef(null);
      var [activeTab, setActiveTab] = useState("");
      var [editorPath, setEditorPath] = useState("");
      var [editorText, setEditorText] = useState("");
      var [dirty, setDirty] = useState(false);
      var [editing, setEditing] = useState(false);
      var [splitPx, setSplitPx] = useState(0);
      // 资源管理器的导航位置（抬升到 Panel，切标签不卸载，保证记住上次浏览目录）。
      var [browserPath, setBrowserPath] = useState("");
      // 终端是否已打开过：打开后保持挂载（切标签只隐藏不重启），关闭中部栏才重置。
      var [terminalOpened, setTerminalOpened] = useState(false);
      var [previewKind, setPreviewKind] = useState("code");
      var [tabOrder, setTabOrder] = useState(readTabOrder);
      var [browserCollapsed, setBrowserCollapsed] = useState(false);
      var [clipboard, setClipboard] = useState(null); // { path, cut } 或 null
      var [refreshToken, setRefreshToken] = useState(0);
      var [autoOpenTasks, setAutoOpenTasks] = useState(readAutoOpenTasks);
      var dragTabRef = useRef(null);
      // —— SSH(ssh-ops) 检测：宿主安装并挂载 dsh-ssh-ops 时追加「SSH」标签页 ——
      var [sshOps, setSshOps] = useState(false);
      useEffect(function () {
        var alive = true;
        function probe() {
          return !!(document.querySelector('[data-dsh-ssh-ops-tab="true"]') || document.querySelector('[data-dsh-ssh-ops-panel="true"]'));
        }
        function check() { if (alive) setSshOps(probe()); }
        check();
        // ssh-ops 客户端可能晚于本面板挂载：面板打开期间轮询片刻。
        var timer = window.setInterval(function () { if (probe()) { check(); window.clearInterval(timer); } }, 500);
        window.setTimeout(function () { window.clearInterval(timer); }, 10000);
        return function () { alive = false; window.clearInterval(timer); };
      }, [snapshot.open]);
      // 可用性变化时同步标签顺序（可用追加到末尾，不可用剔除）。
      useEffect(function () {
        if (sshOps) {
          if (tabOrder.indexOf("ssh") < 0) setTabOrder(tabOrder.concat("ssh"));
        } else if (tabOrder.indexOf("ssh") >= 0) {
          var rest = tabOrder.filter(function (k) { return k !== "ssh"; });
          setTabOrder(rest);
          if (activeTab === "ssh") setActiveTab(rest.length ? rest[rest.length - 1] : "");
        }
      }, [sshOps]);
      // 后台任务角标：当前树中「运行中」任务数（订阅会话列表，供标签页显示）。
      var tasksList = useSyncExternalStore(
        useCallback(function (cb) {
          try { var s = ctx.get("sessions"); return s && s.list ? s.list.subscribe(cb) : function () {}; } catch (e) { return function () {}; }
        }, [ctx]),
        useCallback(function () {
          try { var s = ctx.get("sessions"); var l = s && s.list ? s.list.getSnapshot() : null; return l || EMPTY_SESSION_LIST; } catch (e) { return EMPTY_SESSION_LIST; }
        }, [ctx]),
      );
      var tasksBadge = useMemo(function () {
        var byId = tasksList.byId || {};
        var rootId = rootAncestor(byId, tasksList.current || "");
        if (!rootId || !byId[rootId]) return 0;
        var n = 0;
        treeSessionIds(byId, rootId).forEach(function (sid) {
          var jobs = (tasksList.jobsBySession || {})[sid] || [];
          for (var i = 0; i < jobs.length; i++) { if (isJobLive(jobs[i])) n += 1; }
        });
        return n;
      }, [tasksList]);
      // —— 自动激活「后台任务」页（移植 better-sidebar 的 use-host-feeds 触发器）——
      // 基线从「当前快照」开始：刚打开页面/切到已有子代理的会话都不触发，用户
      // 刻意摆好的布局不会被抢。偏好关闭时只更新基线，不做任何切换。
      var autoOpenRef = useRef(autoOpenTasks);
      autoOpenRef.current = autoOpenTasks;
      var autoBaselineRef = useRef(undefined);
      var autoPendingRef = useRef(null);
      var jobBaselineRef = useRef(undefined);
      /** 切到「后台任务」页；中部栏已关闭时宽屏才自动展开（窄屏只准备标签页，
      *  不让后台活动强行盖住对话区——与 better-sidebar 的窄屏策略一致）。 */
      function activateTasks() {
        if (!autoOpenRef.current) return;
        var narrow = typeof window !== "undefined" && window.innerWidth < NARROW_MAX_WIDTH;
        if (!getState().open && !narrow) setOpen(true);
        setActiveTab("tasks");
      }
      // 新子代理：0 → N（去抖后按原基线对实时快照重评估，避免 Side Chat 线程首帧误判）。
      useEffect(function () {
        var prev = autoBaselineRef.current;
        autoBaselineRef.current = tasksList;
        var sessionId = tasksList.current || "";
        if (!sessionId || prev === undefined) return;
        if (autoPendingRef.current !== null) return;
        if (!detectNewDirectSubagent(prev, tasksList, sessionId)) return;
        var baseline = prev;
        var timer = window.setTimeout(function () {
          autoPendingRef.current = null;
          var live = null;
          try { var s = ctx.get("sessions"); live = s && s.list ? s.list.getSnapshot() : null; } catch (e) { /* ignore */ }
          if (!live || !detectNewDirectSubagent(baseline, live, sessionId)) return;
          activateTasks();
        }, AUTO_OPEN_DEBOUNCE_MS);
        autoPendingRef.current = { baseline: baseline, timer: timer };
      }, [tasksList]);
      // 新任务：任意新任务 id 立即触发（一个会话里可能先后启动多个后台任务）。
      useEffect(function () {
        var prev = jobBaselineRef.current;
        jobBaselineRef.current = tasksList;
        var sessionId = tasksList.current || "";
        if (!sessionId || prev === undefined) return;
        if (!detectNewJob(prev, tasksList, sessionId)) return;
        activateTasks();
      }, [tasksList]);
      // 会话切换 / 卸载：撤销已武装的去抖重评估。
      useEffect(function () {
        return function () {
          var pending = autoPendingRef.current;
          if (pending !== null) window.clearTimeout(pending.timer);
          autoPendingRef.current = null;
        };
      }, [tasksList.current]);

      function doCopy(paths) { setClipboard({ paths: (Array.isArray(paths) ? paths : [paths]).slice(), cut: false }); }
      function doCut(paths) { setClipboard({ paths: (Array.isArray(paths) ? paths : [paths]).slice(), cut: true }); }
      function doCopyPath(path) { try { navigator.clipboard.writeText(path); } catch (e) {} }
      function doFileOp(op, src, dst) {
        return fileOp(op, src, dst).then(function (json) {
          if (json && json.ok) { setRefreshToken(function (n) { return n + 1; }); return true; }
          alertDlg("操作失败：" + ((json && json.error) || "未知错误"));
          return false;
        }).catch(function (e) { alertDlg("操作失败：" + String(e && e.message || e)); return false; });
      }
      function doPaste(targetDir) {
        if (!clipboard || !clipboard.paths || clipboard.paths.length === 0) return;
        var list = clipboard.paths.slice();
        var cut = clipboard.cut;
        (function next(i) {
          if (i >= list.length) { if (cut) setClipboard(null); return; }
          var src = list[i];
          var dst = joinPath(targetDir, baseName(src));
          fileOp(cut ? "move" : "copy", src, dst).then(function (json) {
            if (json && json.ok) { setRefreshToken(function (n) { return n + 1; }); }
            else { alertDlg("操作失败：" + ((json && json.error) || "未知错误")); }
            next(i + 1);
          });
        })(0);
      }
      // 上传来自 Windows 资源管理器（拖入/粘贴）的外部文件到目标目录。
      // 拖入文件夹时，浏览器给每个文件带 webkitRelativePath（如 myfolder/sub/a.txt），
      // 用它作为相对路径重建子目录结构；粘贴/普通文件则退回文件名。
      function doUploadExternal(fileList, targetDir) {
        var files = fileList || [];
        var dir = String(targetDir || browserPath || "").trim();
        if (files.length === 0 || !dir) return;
        (function next(i) {
          if (i >= files.length) { return; }
          var f = files[i];
          var name = f && f.name;
          if (!name) { next(i + 1); return; }
          var rel = (f.webkitRelativePath && String(f.webkitRelativePath).trim()) || name;
          var read = typeof f.arrayBuffer === "function"
            ? f.arrayBuffer()
            : Promise.resolve(f);
          read.then(function (buf) {
            return uploadFile(dir, rel, buf);
          }).then(function (json) {
            if (json && json.ok) { setRefreshToken(function (n) { return n + 1; }); }
            else { alertDlg("上传失败：" + ((json && json.error) || "未知错误")); }
            next(i + 1);
          }).catch(function (e) {
            alertDlg("上传失败：" + String((e && e.message) || e));
            next(i + 1);
          });
        })(0);
      }
      // 导出到 Windows 外部目录：用系统文件夹选择器选目标目录，再重建目录树写进去。
      // File System Access API（仅 Chromium/安全上下文）。必须由用户手势触发。
      function doExportWindows(path, isDir) {
        var target = String(path || "").trim();
        if (!target) return;
        if (!window.showDirectoryPicker) {
          alertDlg("当前浏览器不支持「导出到 Windows 文件夹」\n请使用 Chrome / Microsoft Edge。");
          return;
        }
        window.showDirectoryPicker({ mode: "readwrite" }).then(function (root) {
          var isDirFlag = !!isDir;
          var op = isDirFlag
            ? (function () {
                return fetchTreeRecursive(target).then(function (json) {
                  if (!json || !json.ok) throw new Error((json && json.error) || "读取目录失败");
                  var entries = json.entries || [];
                  var fileEntries = [];
                  for (var fi = 0; fi < entries.length; fi++) { if (!entries[fi].isDir) fileEntries.push(entries[fi]); }
                  showProgress("正在导出…", fileEntries.length);
                  var doneFiles = 0;
                  // 在所选文件夹里新建一个与该目录同名的子文件夹，再把内容放进去
                  // （与导入方向“拖入 myfolder 会生成 myfolder/...”保持一致）。
                  var prefix = baseName(target) || "exported";
                  function destRel(rel) { return prefix + "/" + rel; }
                  var seq = Promise.resolve();
                  // 先建所有子目录（含嵌套）
                  entries.forEach(function (e) {
                    if (!e.isDir) return;
                    seq = seq.then(function () {
                      var cur = root;
                      var segs = destRel(e.rel).split("/");
                      return segs.reduce(function (p, seg) {
                        return p.then(function (h) { return h.getDirectoryHandle(seg, { create: true }); });
                      }, Promise.resolve(cur));
                    });
                  });
                  // 再依次写入所有文件
                  entries.forEach(function (e) {
                    if (e.isDir) return;
                    seq = seq.then(function () {
                      var abs = joinRel(target, e.rel);
                      return fetch(mediaUrl(abs)).then(function (r) {
                        if (!r.ok) throw new Error("无法读取 " + e.rel);
                        return r.arrayBuffer();
                      }).then(function (buf) {
                        var segs = destRel(e.rel).split("/");
                        var name = segs[segs.length - 1];
                        var dirSegs = segs.slice(0, -1);
                        var cur = root;
                        var chain = Promise.resolve(cur);
                        dirSegs.forEach(function (seg) {
                          chain = chain.then(function (h) { return h.getDirectoryHandle(seg, { create: true }); });
                        });
                        return chain.then(function (h) { return h.getFileHandle(name, { create: true }); })
                          .then(function (fh) { return fh.createWritable(); })
                          .then(function (w) { return w.write(buf).then(function () { return w.close(); }); })
                          .then(function () { doneFiles += 1; updateProgress(doneFiles, e.rel); });
                      });
                    });
                  });
                  return seq;
                });
              })()
            : (function () {
                showProgress("正在导出…", 1);
                return fetch(mediaUrl(target)).then(function (r) {
                  if (!r.ok) throw new Error("无法读取文件");
                  return r.arrayBuffer();
                }).then(function (buf) {
                  return root.getFileHandle(baseName(target), { create: true }).then(function (fh) {
                    return fh.createWritable();
                  }).then(function (w) {
                    return w.write(buf).then(function () { return w.close(); });
                  });
                }).then(function () { updateProgress(1, baseName(target)); });
              })();
          op.then(function () {
            hideProgress();
            alertDlg("导出完成，已写入所选文件夹。");
          }).catch(function (e) {
            hideProgress();
            if (e && e.name === "AbortError") return;
            alertDlg("导出失败：" + String((e && e.message) || e));
          });
        }).catch(function (e) {
          hideProgress();
          if (e && e.name === "AbortError") return; // 用户取消选择
          alertDlg("选择文件夹失败：" + String((e && e.message) || e));
        });
      }
      // 从外部导入：点菜单 → 弹出系统文件/文件夹选择器（File System Access API）选好即导入。
      // 走浏览器端内容流式上传（与拖放同路径）：文件直传，文件夹递归枚举后按相对路径重建。
      // 仅支持 Chrome / Edge（需安全上下文，本机 127.0.0.1/localhost 可用）。
      function doImportFiles(targetDir) {
        var dir = String(targetDir || browserPath || "").trim();
        if (!dir) return;
        if (!window.showOpenFilePicker) { alertDlg("当前浏览器不支持「导入文件」\n请使用 Chrome / Microsoft Edge。"); return; }
        window.showOpenFilePicker({ multiple: true }).then(function (handles) {
          if (!handles || !handles.length) return;
          showProgress("正在导入…", handles.length);
          return handles.reduce(function (chain, h) {
            return chain.then(function (acc) {
              return h.getFile().then(function (file) {
                return uploadFile(dir, file.name, file).then(function (json) {
                  if (json && json.ok) { acc.push(true); }
                  else { alertDlg("导入失败：" + ((json && json.error) || "未知错误")); acc.push(false); }
                  updateProgress(acc.length, "正在导入 " + file.name);
                  return acc;
                });
              }).catch(function (e) { alertDlg("导入失败：" + String((e && e.message) || e)); acc.push(false); updateProgress(acc.length); return acc; });
            });
          }, Promise.resolve([])).then(function (results) {
            hideProgress();
            setRefreshToken(function (n) { return n + 1; });
            alertDlg("导入完成，共 " + results.filter(Boolean).length + " 个文件。");
          });
        }).catch(function (e) {
          hideProgress();
          if (e && e.name === "AbortError") return;
          alertDlg("选择文件失败：" + String((e && e.message) || e));
        });
      }
      function doImportFolder(targetDir) {
        var dir = String(targetDir || browserPath || "").trim();
        if (!dir) return;
        if (!window.showDirectoryPicker) { alertDlg("当前浏览器不支持「导入文件夹」\n请使用 Chrome / Microsoft Edge。"); return; }
        window.showDirectoryPicker({ mode: "read" }).then(function (root) {
          var prefix = (root && root.name) ? root.name : "imported";
          return collectDirFiles(root, prefix).then(function (list) {
            if (!list.length) { alertDlg("所选文件夹为空。"); return; }
            showProgress("正在导入…", list.length);
            return list.reduce(function (chain, it) {
              return chain.then(function (acc) {
                return uploadFile(dir, it.rel, it.file).then(function (json) {
                  if (json && json.ok) { acc.push(true); }
                  else { alertDlg("导入失败：" + ((json && json.error) || "未知错误")); acc.push(false); }
                  updateProgress(acc.length, "正在导入 " + it.rel);
                  return acc;
                });
              }).catch(function (e) { alertDlg("导入失败：" + String((e && e.message) || e)); acc.push(false); updateProgress(acc.length); return acc; });
            }, Promise.resolve([])).then(function (results) {
              hideProgress();
              setRefreshToken(function (n) { return n + 1; });
              alertDlg("导入完成，共 " + results.filter(Boolean).length + " 个文件。");
            });
          });
        }).catch(function (e) {
          hideProgress();
          if (e && e.name === "AbortError") return;
          alertDlg("选择文件夹失败：" + String((e && e.message) || e));
        });
      }
      function doDelete(paths) {
        var list = (Array.isArray(paths) ? paths : [paths]);
        if (list.length === 0) return;
        var msg = list.length === 1 ? "确定删除 \"" + baseName(list[0]) + "\" 吗？该操作不可撤销。" : "确定删除选中的 " + list.length + " 项吗？该操作不可撤销。";
        confirmDlg(msg).then(function (ok) {
          if (!ok) return;
          // 单项（可能是含众多文件的大文件夹）用不定长动画进度；多项按项计数。
          if (list.length === 1) showProgress("正在删除 " + baseName(list[0]) + "…");
          else showProgress("正在删除…", list.length);
          (function next(i) {
            if (i >= list.length) {
              hideProgress();
              setRefreshToken(function (x) { return x + 1; });
              return;
            }
            delFile(list[i]).then(function (json) {
              if (!json || !json.ok) { alertDlg("删除失败：" + ((json && json.error) || "未知错误")); }
              if (list.length > 1) updateProgress(i + 1, "正在删除 " + baseName(list[i]));
              next(i + 1);
            }).catch(function (e) {
              alertDlg("删除失败：" + String((e && e.message) || e));
              if (list.length > 1) updateProgress(i + 1, "正在删除 " + baseName(list[i]));
              next(i + 1);
            });
          })(0);
        });
      }
      function doCreate(kind, targetDir) {
        promptDlg(kind === "dir" ? "新建目录名称：" : "新建文件名称：", "").then(function (name) {
          var n = String(name || "").trim();
          if (!n) return;
          createPath(kind, joinPath(targetDir, n)).then(function (json) {
            if (json && json.ok) { setRefreshToken(function (x) { return x + 1; }); }
            else { alertDlg("创建失败：" + ((json && json.error) || "未知错误")); }
          });
        });
      }
      function doRename(path) {
        var oldName = baseName(path);
        promptDlg("重命名为：", oldName).then(function (newName) {
          var n = String(newName || "").trim();
          if (!n || n === oldName) return;
          var dst = joinPath(parentOf(path), n);
          fileOp("move", path, dst).then(function (json) {
            if (json && json.ok) { setRefreshToken(function (x) { return x + 1; }); }
            else { alertDlg("重命名失败：" + ((json && json.error) || "未知错误")); }
          });
        });
      }
      function reorderTabs(from, to) {
        if (from === null || to === null || from === to) return;
        setTabOrder(function (prev) {
          var next = prev.slice();
          var item = next.splice(from, 1)[0];
          next.splice(to, 0, item);
          // 记住拖动后的标签顺序，下次打开/刷新仍是这个位置。
          try { localStorage.setItem(TABORDER_KEY, JSON.stringify(next)); } catch (e) { /* ignore */ }
          return next;
        });
      }

      // 把编辑器状态同步到模块级，供"关闭中部栏"（脚注开关）判断是否需要保存。
      useEffect(function () {
        editorState = { path: editorPath, text: editorText, dirty: dirty, editable: editing };
      }, [editorPath, editorText, dirty, editing]);

      // 关闭中部栏时重置到"最初"：标签清空、资源管理器导航位置清空（回到工作区根目录）、
      // 关闭已打开的文件、卸载终端（下次打开才重启）。只要面板保持打开，这些状态都记住。
      useEffect(function () {
        if (!snapshot.open) {
          setActiveTab("");
          setBrowserPath("");
          setEditorPath("");
          setEditorText("");
          setDirty(false);
          setEditing(false);
          setTerminalOpened(false);
          setPreviewKind("code");
          setBrowserCollapsed(false);
          setClipboard(null);
        }
      }, [snapshot.open]);

      function openInEditor(path) {
        var p = String(path || "").trim();
        if (!p) return;
        var target = p;
        var kind = previewKindOf(target);
        // 首次打开文件时把左栏设为面板一半（否则保持用户上次拖的分割比例）。
        if (splitPx <= 0) setSplitPx(Math.max(240, Math.round((snapshot.width - 6) / 2)));
        setEditorPath(target);
        setPreviewKind(kind);
        setDirty(false);
        setEditing(false); // 新打开的文件默认只读，需点「编辑」才能改。
        if (kind === "image" || kind === "tiff" || kind === "heic" || kind === "psd" || kind === "html" || kind === "pdf" || kind === "word" || kind === "excel" || kind === "csv" || kind === "powerpoint" || kind === "unsupported") {
          // 原生预览（用 /media 直接显示）或不支持预览类型：无需拉文本。图片/PDF 不可编辑。
          setEditorText("");
          return;
        }
        setEditorText("(加载中…)");
        fetchFile(p).then(function (json) {
          if (json && json.ok) {
            setEditorPath(target);
            setEditorText(json.text);
          } else {
            setEditorText("无法打开：" + ((json && json.error) || "未知错误"));
          }
        });
      }
      function saveEditor() {
        if (!editorPath) return;
        saveFile(editorPath, editorText).then(function (json) {
          if (json && json.ok) { setDirty(false); }
          else {
            setEditorText("保存失败：" + ((json && json.error) || "未知错误") + "\n\n" + editorText);
          }
        });
      }
      function closeFile() {
        setEditorPath("");
        setEditorText("");
        setDirty(false);
        setEditing(false);
      }
      // 关闭文件：若有未保存的改动（dirty），先确认"是否保存"（是→保存）。
      function requestCloseFile() {
        if (dirty && editorPath) {
          confirmDlg("文件有未保存的改动，是否保存？").then(function (ok) {
            if (ok) { saveFile(editorPath, editorText).then(function () { closeFile(); }).catch(function () { closeFile(); }); return; }
            closeFile();
          });
          return;
        }
        closeFile();
      }

      function startDrag(e) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startWidth: snapshot.width, width: snapshot.width };
        isDragging = true;
        // 拖拽期间把全局鼠标固定为竖向 resize，避免指针扫过其他元素变"小手"。
        document.body.style.cursor = "col-resize";
        // 关掉 .dsh-cs-panel 的 width 慢速过渡，让面板边缘跟手；否则每次 move 写 width
        // 都会被 CSS transition 拉慢，导致不跟手。
        if (panelRef.current) panelRef.current.style.transition = "none";
        e.currentTarget.setAttribute("data-dragging", "");
      }
      function moveDrag(e) {
        if (!dragRef.current || !panelRef.current) return;
        var w = clampWidth(dragRef.current.startWidth + (e.clientX - dragRef.current.startX));
        dragRef.current.width = w;
        // 直接写 DOM（面板宽度 + 对话栏右移），避免每次 move 触发 React 重渲染导致不跟手。
        panelRef.current.style.width = w + "px";
        applyPad(w);
      }
      function endDrag(e) {
        if (!dragRef.current) return;
        // 松开时以最后一次真实宽度提交流程（优先 up 坐标；fast flick 用 move 最后值）。
        var w = e && typeof e.clientX === "number"
          ? clampWidth(dragRef.current.startWidth + (e.clientX - dragRef.current.startX))
          : dragRef.current.width;
        dragRef.current = null;
        isDragging = false;
        document.body.style.cursor = "";
        var t = e && e.currentTarget;
        if (t && t.removeAttribute) t.removeAttribute("data-dragging");
        // 恢复面板的 CSS 过渡（供正常开/关动画使用）。
        if (panelRef.current) panelRef.current.style.transition = "";
        setWidth(w);
      }

      // 左右分栏分隔条拖拽（浏览器宽度 = splitPx，编辑器占余下）。
      function startSplit(e) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        splitDragRef.current = { startX: e.clientX, startW: splitPx > 0 ? splitPx : Math.round((snapshot.width - 6) / 2), w: splitPx > 0 ? splitPx : Math.round((snapshot.width - 6) / 2) };
        isDragging = true;
        document.body.style.cursor = "col-resize";
        e.currentTarget.setAttribute("data-dragging", "");
      }
      function moveSplit(e) {
        if (!splitDragRef.current || !browserRef.current) return;
        var maxW = Math.max(200, snapshot.width - 320);
        var w = Math.max(200, Math.min(Math.round(splitDragRef.current.startW + (e.clientX - splitDragRef.current.startX)), maxW));
        splitDragRef.current.w = w;
        // 直接写 DOM 让分割实时跟手，不触发 React 重渲染。
        browserRef.current.style.width = w + "px";
        browserRef.current.style.flex = "none";
      }
      function endSplit(e) {
        if (!splitDragRef.current) return;
        var w = e && typeof e.clientX === "number"
          ? Math.max(200, Math.min(Math.round(splitDragRef.current.startW + (e.clientX - splitDragRef.current.startX)), snapshot.width - 320))
          : splitDragRef.current.w;
        splitDragRef.current = null;
        isDragging = false;
        document.body.style.cursor = "";
        var t = e && e.currentTarget;
        if (t && t.removeAttribute) t.removeAttribute("data-dragging");
        setSplitPx(w);
      }

      var TAB_ICONS = {
        explorer: DIR_ICON,
        browser: "M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM2 8h12M8 2v12M4.2 3.9a7.9 7.9 0 0 0 0 8.2M11.8 3.9a7.9 7.9 0 0 1 0 8.2",
        terminal: "M2 4h12v8H2zM4.5 6.5h3v3h-3z",
        tasks: "M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm2 4h4M6 8h4M6 10h2",
        ssh: "M3 3.5h10v4H3zM3 8.5h10v4H3zM5 5.5h1M5 10.5h1",
      };

      // 资源管理器（左右双栏，宽度可拖；browserCollapsed 时收起左栏只留预览）。
      var hasEditor = !!editorPath;
      var bw = splitPx > 0 ? splitPx : Math.round((snapshot.width - 6) / 2);
      var explorerDiv = createElement("div", { className: "dsh-cs-explorer" }, [
        browserCollapsed ? null : createElement(Browser, {
          ctx: ctx,
          onOpenFile: openInEditor,
          curPath: browserPath,
          onNavigate: setBrowserPath,
          rootRef: browserRef,
          clipboard: clipboard,
          refreshToken: refreshToken,
          onCopy: doCopy,
          onCut: doCut,
          onPaste: doPaste,
          onCopyPath: doCopyPath,
          onDelete: doDelete,
          onUploadExternal: doUploadExternal,
          onExport: doExportWindows,
          onImportFolder: doImportFolder,
          onImportFiles: doImportFiles,
          onCreateDir: function (dir) { doCreate("dir", dir); },
          onCreateFile: function (dir) { doCreate("file", dir); },
          onRename: doRename,
          style: hasEditor ? { flex: "none", width: bw + "px" } : { flex: 1 },
        }),
        browserCollapsed ? null : (hasEditor ? createElement("div", {
          ref: splitRef,
          className: "dsh-cs-divider",
          onPointerDown: startSplit,
          onPointerMove: moveSplit,
          onPointerUp: endSplit,
          onPointerCancel: endSplit,
          onLostPointerCapture: endSplit,
        }) : null),
        hasEditor ? createElement(Editor, {
          path: editorPath,
          text: editorText,
          dirty: dirty,
          editable: editing,
          previewKind: previewKind,
          onEditToggle: function () { setEditing(!editing); },
          onChange: function (v) { setEditorText(v); setDirty(true); },
          onSave: saveEditor,
          onClose: requestCloseFile,
        }) : (browserCollapsed ? createElement("div", { className: "dsh-cs-note" }, "资源管理器已收起，点顶部「资源管理器」展开。") : null),
      ]);
      // 内容区：资源管理器 / 浏览器 / 终端 / 后台任务。
      var content = createElement("div", { className: "dsh-cs-content" }, [
        activeTab === "explorer" ? explorerDiv : null,
        activeTab === "browser" ? createElement(WebBrowser, { key: "dsh-cs-browser" }) : null,
        terminalOpened ? createElement(Terminal, { key: "dsh-cs-terminal", ctx: ctx, visible: activeTab === "terminal" }) : null,
        activeTab === "tasks" ? createElement(TasksView, {
          key: "dsh-cs-tasks",
          ctx: ctx,
          active: activeTab === "tasks",
          autoOpen: autoOpenTasks,
          onToggleAutoOpen: function () { setAutoOpenTasks(function (v) { persistAutoOpenTasks(!v); return !v; }); },
        }) : null,
        activeTab === "ssh" ? createElement(SshOpsHost, { key: "dsh-cs-ssh" }) : null,
        activeTab === "" ? createElement("div", { className: "dsh-cs-note" }, "请在顶部选择「资源管理器」「浏览器」「终端」或「后台任务」。") : null,
      ]);

      return createElement("div", { className: "dsh-cs-host", "data-dsh-cs-host": "" }, [
        createElement("div", {
          ref: panelRef,
          className: "dsh-cs-panel" + (snapshot.open ? "" : " dsh-cs-hidden"),
          style: { width: snapshot.width + "px" },
        }, [
          createElement("div", { className: "dsh-cs-resize", onPointerDown: startDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag }),
          createElement("div", { className: "dsh-cs-header" }, [
            createElement("span", { className: "dsh-cs-title" }),
            createElement("button", { type: "button", className: "dsh-cs-close", title: "关闭中部栏", onClick: requestPanelClose }, [
              createElement("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "none" },
                createElement("path", { d: "M4.5 4.5l7 7m0-7l-7 7", stroke: "currentColor", strokeWidth: "1.5" })),
            ]),
          ]),
          createElement("div", { className: "dsh-cs-tabs" }, (function () {
            var names = { explorer: "资源管理器", browser: "浏览器", terminal: "终端", tasks: "后台任务", ssh: "SSH" };
            return tabOrder.map(function (key) {
              return createElement("button", {
                key: key,
                type: "button",
                draggable: true,
                className: "dsh-cs-tab",
                "data-active": activeTab === key ? "" : undefined,
                onDragStart: function (e) { dragTabRef.current = key; try { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", key); } catch (err) {} },
                onDragOver: function (e) { e.preventDefault(); try { e.dataTransfer.dropEffect = "move"; } catch (err) {} },
                onDrop: function (e) { e.preventDefault(); var from = dragTabRef.current; dragTabRef.current = null; if (from) reorderTabs(tabOrder.indexOf(from), tabOrder.indexOf(key)); },
                onDragEnd: function () { dragTabRef.current = null; },
                onClick: function () {
                  // 预览文件时，再次点击「资源管理器」→ 收起/展开左侧资源管理器栏。
                  if (key === "explorer" && activeTab === "explorer" && editorPath) { setBrowserCollapsed(!browserCollapsed); return; }
                  setActiveTab(key);
                  if (key === "terminal") setTerminalOpened(true);
                },
              }, [
                createElement("span", { className: "dsh-cs-tab-icon" }, Icon(TAB_ICONS[key])),
                createElement("span", null, names[key] || key),
                key === "tasks" && tasksBadge > 0 ? createElement("span", { className: "dsh-cs-tab-badge" }, tasksBadge) : null,
              ]);
            });
          })()),
          content,
        ]),
        createElement(Dialog, {}),
        createElement(Progress, {}),
      ]);
    }

    // ===== 脚注开关按钮 =====
    // 把「中部栏」开关直接插入侧边栏导航，紧跟生图插件按钮下方（与生图插件同款做法：
    // 直接操作 DOM + MutationObserver 自修复，避免 React 重渲染时被挤走）。
    function mountSidebarEntry() {
      var entry = document.createElement("button");
      entry.type = "button";
      entry.setAttribute("data-dsh-center-workbench-entry", "");
      entry.className = "dsh-cs-sidebar-entry";
      entry.innerHTML = '<span class="dsh-cs-sidebar-entry-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"><path d="' + DIR_ICON + '"/></svg></span><span class="dsh-cs-sidebar-entry-label"></span>';

      function sync() {
        var s = getState();
        entry.setAttribute("data-dsh-open", s.open ? "1" : "0");
        entry.setAttribute("aria-pressed", s.open ? "true" : "false");
        entry.title = s.open ? "关闭中部栏" : "打开中部栏（文件浏览面板）";
        var label = entry.querySelector(".dsh-cs-sidebar-entry-label");
        if (label) label.textContent = s.open ? "关闭中部栏" : "中部栏";
      }
      var unsub = subscribe(sync);
      sync();
      entry.addEventListener("click", toggleOpen);

      function sidebarRoot() {
        var column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]');
        if (!column) return undefined;
        var logo = column.querySelector('[class*="logoRow"]');
        return (logo && logo.parentElement) || column.firstElementChild;
      }
      function newSessionButton(root) {
        var nested = root.querySelector('button[class*="newSession"]');
        if (nested) return nested;
        for (var i = 0; i < root.children.length; i++) {
          var c = root.children[i];
          if (c.tagName === "BUTTON") return c;
        }
        return undefined;
      }
      function place(root) {
        // 优先紧跟生图插件按钮下方；无则插到「新会话/logo 行」之后（导航顶端）。
        var img = root.querySelector('[data-dsh-image-create-entry]');
        if (img) {
          if (entry.parentElement !== root) root.insertBefore(entry, img.nextElementSibling);
          return true;
        }
        var button = newSessionButton(root);
        if (!button) return false;
        if (entry.parentElement !== root) {
          var row = button.closest('[class*="logoRow"]');
          var base = row && row.parentElement === root ? row : button;
          root.insertBefore(entry, base.nextElementSibling);
        }
        return true;
      }

      var root;
      var placed = false;
      var rootObserver = null;
      function tryPlace() {
        if (root !== undefined && !root.isConnected) { root = undefined; placed = false; }
        if (placed && document.body.contains(entry)) return;
        if (!root) root = sidebarRoot();
        if (!root) return;
        placed = place(root);
        if (placed && rootObserver) rootObserver.observe(root, { childList: true, subtree: true });
      }
      rootObserver = new MutationObserver(function () {
        if (root === undefined || !root.isConnected) { root = undefined; placed = false; }
        if (!root || !root.contains(entry)) { placed = false; tryPlace(); return; }
      });
      var waitObserver = new MutationObserver(function () { tryPlace(); });
      waitObserver.observe(document.body, { childList: true, subtree: true });
      tryPlace();

      return function () {
        waitObserver.disconnect();
        rootObserver.disconnect();
        unsub();
        entry.remove();
      };
    }

    // ===== 客户端插件入口 =====
    function apply(ctx) {
      applyLayout();

      // 拉取宿主环境信息（用户主目录/平台），用于跨平台默认根目录。
      try {
        fetch("/api/dsh-center-workbench/env").then(function (r) { return r.json(); })
          .then(function (j) { if (j && j.ok && j.home) defaultHome = j.home; })
          .catch(function () { /* 用回模块级默认值 */ });
      } catch (e) { /* ignore */ }

      // 「中部栏」开关：放到侧边栏导航，紧挨生图插件按钮下方（不再放设置旁边的脚注）。
      var entryDisposer = mountSidebarEntry();

      // 挂载居中面板 root。
      var host = document.createElement("div");
      host.setAttribute("data-dsh-cs-host-root", "");
      document.body.appendChild(host);
      var root = ReactDOMClient.createRoot(host);
      root.render(createElement(Panel, { ctx: ctx }));

      // 窗口尺寸变化时重算对话栏右移 + 面板锚定位置。
      window.addEventListener("resize", applyLayout);

      // 面板锚定在主列（左侧栏）边缘，需要随左侧栏展开/收起、主列重建实时对齐：
      // ResizeObserver 监听主列尺寸变化；MutationObserver 捕获主列节点重建/出现，
      // 重新绑定并重组（rAF 节流，避免聊天流式渲染时高频触发）。
      var resizeObs = null;
      function ensureObs() {
        var col = convColumn();
        if (!col) return;
        if (resizeObs && resizeObs._t === col) return;
        if (resizeObs) resizeObs.disconnect();
        resizeObs = new ResizeObserver(function () { if (!isDragging) applyLayout(); });
        resizeObs.observe(col);
        resizeObs._t = col;
      }
      var pending = false;
      var bodyObs = new MutationObserver(function () {
        if (pending) return;
        pending = true;
        requestAnimationFrame(function () {
          pending = false;
          ensureObs();
          // 拖拽中布局由 moveDrag 直接写 DOM，这里若重跑 applyLayout 会用旧状态
          // 覆盖右移量，导致不跟手；拖拽时跳过。
          if (!isDragging) applyLayout();
        });
      });
      bodyObs.observe(document.body, { childList: true, subtree: true });
      ensureObs();

      ctx.effect(function () {
        return function () {
          window.removeEventListener("resize", applyLayout);
          if (entryDisposer) entryDisposer();
          if (bodyObs) bodyObs.disconnect();
          if (resizeObs) resizeObs.disconnect();
          root.unmount();
          host.remove();
        };
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
