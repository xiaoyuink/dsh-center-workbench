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
      ".dsh-cs-md{flex:1;min-height:0;overflow:auto;padding:12px 16px;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}",
      ".dsh-cs-unsupported{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center}",
      ".dsh-cs-unsupported-title{font:var(--dsw-font-s-strong-14);color:var(--dsw-alias-label-secondary)}",
      ".dsh-cs-unsupported-sub{max-width:80%;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dsh-cs-md-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--ds-font-family-code)}",
      "/* 浏览器标签 */",
      ".dsh-cs-web{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}",
      ".dsh-cs-web-bar{flex:none;display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
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
      ".dsh-cs-task-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-dot-running{background:var(--dsw-alias-state-success-primary)}",
      ".dsh-cs-task-dot-done{background:var(--dsw-alias-label-tertiary)}",
      ".dsh-cs-task-dot-warn{background:var(--dsw-alias-state-warn-primary)}",
      ".dsh-cs-task-dot-error{background:var(--dsw-alias-state-error-primary)}",
      ".dsh-cs-task-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-task-secondary{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
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
      ".dsh-cs-task-jobs-kind{flex:none;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-jobs-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}",
      ".dsh-cs-task-jobs-secondary{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxxs-11)}",
      ".dsh-cs-task-jobs-kill{flex:none;font:var(--dsw-font-xxxs-11);color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);border-radius:999px;background:transparent;cursor:pointer;padding:2px 8px}",
      ".dsh-cs-task-jobs-kill-armed{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}",
      ".dsh-cs-task-jobs-pane{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;margin-top:6px}",
      ".dsh-cs-task-jobs-pane-header{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
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
    var DIR_ICON = "M1.5 3h4l1 1.5h8a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z";
    var FILE_ICON = "M4 2.5h5.5L12 5v8.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z";
    function Icon(d) {
      return createElement("svg", { viewBox: "0 0 16 16", width: "14", height: "14", fill: "currentColor" },
        createElement("path", { d: d }));
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
      if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].indexOf(ext) >= 0) return "image";
      if (["html", "htm"].indexOf(ext) >= 0) return "html";
      if (ext === "pdf") return "pdf";
      if (["md", "markdown"].indexOf(ext) >= 0) return "markdown";
      // 文本/代码类：可编辑。
      var code = ["py", "js", "mjs", "ts", "jsx", "tsx", "json", "txt", "css", "scss", "less", "sh", "bash", "zsh", "yml", "yaml", "toml", "xml", "c", "cpp", "h", "hpp", "java", "go", "rs", "rb", "php", "sql", "conf", "ini", "log", "csv", "env", "cfg", "properties", "vue", "svelte", "r", "ipynb", "m", "makefile", "dockerfile", "editorconfig", "gitignore", "npmrc"];
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
        case "stopping": return "停止中";
        case "completed": return "已完成";
        case "killed": return "已终止";
        case "failed": return "失败";
        default: return status;
      }
    }
    function formatJobDuration(ms) {
      var total = Math.max(0, Math.floor(ms / 1000));
      var s = total % 60, m = Math.floor(total / 60) % 60, h = Math.floor(total / 3600);
      if (h > 0) return h + "小时" + m + "分";
      if (m > 0) return m + "分" + s + "秒";
      return s + "秒";
    }

    // 左侧文件夹导航：点击文件夹进入（当前栏），点击文件回调交给面板打开。
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
      var [entries, setEntries] = useState(null);
      var [error, setError] = useState(null);
      var [loading, setLoading] = useState(false);
      var [menu, setMenu] = useState(null);
      var [selected, setSelected] = useState([]);
      var [anchor, setAnchor] = useState(null);
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

      // 键盘：Ctrl/Cmd+C（复制选中）、Ctrl/Cmd+X（剪切）、Ctrl/Cmd+V（粘贴当前目录）、Delete（删除选中）。输入框/文本域内不拦截。
      useEffect(function () {
        function onKey(e) {
          var t = e.target;
          if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
          // 只在本插件资源管理器内部响应，避免拦截到 DSH 对话栏的 Ctrl+C/Ctrl+V 等。
          var root = props.rootRef && props.rootRef.current;
          if (root && (!t || !root.contains(t))) return;
          if (e.key === "Delete") { if (selected.length > 0) { e.preventDefault(); onDelete(selected); } return; }
          if (!(e.ctrlKey || e.metaKey)) return;
          var k = String(e.key || "").toLowerCase();
          if (k === "c") { if (selected.length > 0) { e.preventDefault(); onCopy(selected); } }
          else if (k === "x") { if (selected.length > 0) { e.preventDefault(); onCut(selected); } }
          else if (k === "v") { if (hasClipboard) { e.preventDefault(); onPaste(current); } }
        }
        document.addEventListener("keydown", onKey);
        return function () { document.removeEventListener("keydown", onKey); };
      }, [selected, current, hasClipboard, onCopy, onCut, onPaste, onDelete]);

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
          var root = props.rootRef && props.rootRef.current;
          if (root && (!t || !root.contains(t))) return;
          var files = e.clipboardData && e.clipboardData.files;
          if (files && files.length) {
            e.preventDefault();
            onUploadExternal(Array.prototype.slice.call(files), current);
          }
        }
        window.addEventListener("paste", onPaste);
        return function () { window.removeEventListener("paste", onPaste); };
      }, [hasClipboard, current, onUploadExternal]);

      // 拉取 Windows 盘符（非 Windows 返回空），供盘符下拉切换。
      useEffect(function () {
        var alive = true;
        fetch("/api/dsh-center-workbench/drives").then(function (r) { return r.json(); })
          .then(function (j) { if (alive && j && j.ok) setDrives(j.drives || []); })
          .catch(function () { /* 非 Windows 或接口异常，保持空 */ });
        return function () { alive = false; };
      }, []);

      // 切换目录（导航）时清空选中项，避免灰色残留。
      useEffect(function () { setSelected([]); setAnchor(null); }, [current]);

      useEffect(function () {
        var alive = true;
        setLoading(true);
        fetchTree(current).then(function (json) {
          if (!alive) return;
          if (json && json.ok) { setEntries(json.entries); setError(null); }
          else { setEntries(null); setError((json && json.error) || "无法读取目录"); }
        }).finally(function () { if (alive) setLoading(false); });
        return function () { alive = false; };
      }, [current, refreshToken]);

      // 轮询当前目录，自动发现外部新增/删除的文件（内容未变则不重渲染，避免闪烁）。
      useEffect(function () {
        var alive = true;
        var sig = function (list) { return JSON.stringify((list || []).map(function (e) { return e.name + "|" + e.isDir + "|" + e.size; })); };
        var timer = window.setInterval(function () {
          fetchTree(current).then(function (json) {
            if (!alive || !json || !json.ok) return;
            setEntries(function (prev) { return sig(prev) === sig(json.entries) ? prev : json.entries; });
            setError(null);
          });
        }, 2500);
        return function () { alive = false; window.clearInterval(timer); };
      }, [current, refreshToken]);

      function openMenu(e, path, isDir, paths) {
        e.preventDefault();
        e.stopPropagation();
        lastMenuPos = { x: e.clientX, y: e.clientY };
        // 保留多选：右键点在已被选中的项上 → 维持整个选区；否则选中该项。paths 显式传入时以其为准。
        var sel = paths === undefined ? (selected.indexOf(path) >= 0 ? selected.slice() : [path]) : (paths || []);
        setSelected(sel);
        setAnchor(sel.length ? sel[sel.length - 1] : null);
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
      var rows = [];
      if (entries) {
        for (var j = 0; j < entries.length; j++) {
          const ent = entries[j];
          const full = joinPath(current, ent.name);
          const isDir = ent.isDir;
          const label = ent.name;
          const size = ent.size;
          const index = j;
          rows.push(createElement("button", {
            key: full,
            type: "button",
            className: "dsh-cs-row" + (selected.indexOf(full) >= 0 ? " dsh-cs-selected" : ""),
            onClick: function (e) {
              if (e.shiftKey && anchor) {
                var a = -1;
                for (var m = 0; m < entries.length; m++) { if (joinPath(current, entries[m].name) === anchor) { a = m; break; } }
                if (a >= 0) {
                  var lo = Math.min(a, index), hi = Math.max(a, index);
                  var range = [];
                  for (var m2 = lo; m2 <= hi; m2++) range.push(joinPath(current, entries[m2].name));
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
            },
            onDoubleClick: function () { isDir ? onNavigate(full) : onOpenFile(full); },
            onContextMenu: function (e) { openMenu(e, full, isDir); },
          }, [
            createElement("span", { className: "dsh-cs-row-icon" }, isDir ? Icon(DIR_ICON) : Icon(FILE_ICON)),
            createElement("span", { className: "dsh-cs-row-name" }, label),
            !isDir ? createElement("span", { className: "dsh-cs-row-size" }, fmtSize(size)) : null,
          ]));
        }
      }

      return createElement("div", { ref: props.rootRef, className: "dsh-cs-browser", style: props.style }, [
        createElement("div", { className: "dsh-cs-browser-bar" }, [
          createElement("button", {
            type: "button", className: "dsh-cs-browser-up", title: "上一级",
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
            if (files && files.length) onUploadExternal(Array.prototype.slice.call(files), current);
          },
        }, [
          error ? createElement("div", { className: "dsh-cs-empty" }, "加载失败：" + error)
            : (!entries ? createElement("div", { className: "dsh-cs-empty" }, loading ? "加载中…" : "空目录") : rows),
        ]),
        menu ? [
          createElement("div", { className: "dsh-cs-menu-backdrop", key: "bd", onMouseDown: function () { setMenu(null); }, onContextMenu: function (e) { e.preventDefault(); setMenu(null); } }),
          createElement("div", { className: "dsh-cs-menu", key: "m", style: { left: menu.x, top: menu.y }, onContextMenu: function (e) { e.preventDefault(); } }, [
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: menu.paths.length ? "" : "未选中任何项", disabled: !menu.paths.length, onClick: function () { onCopy(menu.paths); setMenu(null); } }, "复制"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: menu.paths.length ? "" : "未选中任何项", disabled: !menu.paths.length, onClick: function () { onCut(menu.paths); setMenu(null); } }, "剪切"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: hasClipboard ? "" : "剪贴板为空", disabled: !hasClipboard, onClick: function () { onPaste(menu.isDir ? menu.path : current); setMenu(null); } }, "粘贴"),
            createElement("div", { className: "dsh-cs-menu-sep" }),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCopyPath(menu.path); setMenu(null); } }, "复制路径"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "选一个 Windows 文件夹，把该项（含子目录）写入其中", onClick: function () { onExport(menu.path, menu.isDir); setMenu(null); } }, "导出到 Windows 文件夹…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "弹出系统文件夹选择器，把所选文件夹导入当前目录（保留子目录结构）", onClick: function () { onImportFolder(menu.isDir ? menu.path : current); setMenu(null); } }, "导入文件夹…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", title: "弹出系统文件选择器，把所选一个或多个文件导入当前目录", onClick: function () { onImportFiles(menu.isDir ? menu.path : current); setMenu(null); } }, "导入文件…"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCreateDir(menu.isDir ? menu.path : current); setMenu(null); } }, "新建目录"),
            createElement("button", { type: "button", className: "dsh-cs-menu-item", onClick: function () { onCreateFile(menu.isDir ? menu.path : current); setMenu(null); } }, "新建文件"),
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
        createElement("img", { ref: imgRef, src: mediaUrl(path), alt: path, onLoad: onLoad, style: style }),
      ]);
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
      var previewLabel = previewKind === "image" ? "图片预览" : previewKind === "html" ? "HTML 预览" : previewKind === "pdf" ? "PDF 预览" : "不支持预览";
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
      return createElement("div", { className: "dsh-cs-task-jobs-pane" }, [
        createElement("div", { className: "dsh-cs-task-jobs-pane-header" }, [
          createElement("span", { className: "dsh-cs-task-jobs-pane-label" }, job.label),
          createElement("span", { className: "dsh-cs-task-jobs-pane-status" }, jobStatusLabel(job.status) + (job.detail && job.detail !== "" ? " · " + job.detail : "")),
          createElement("button", { type: "button", className: "dsh-cs-task-jobs-pane-close", title: "关闭", onClick: onClose }, "×"),
        ]),
        state === "loading" ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "加载中…") : null,
        state === "error" ? createElement("div", { className: "dsh-cs-task-jobs-hint dsh-cs-task-jobs-error" }, "读取输出失败") : null,
        typeof state === "object"
          ? (state.text.length > 0
            ? createElement("pre", { ref: preRef, className: "dsh-cs-task-jobs-pre" }, state.text)
            : (state.read ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "无输出")
              : createElement("div", { className: "dsh-cs-task-jobs-hint" }, "模型尚未读取该任务")))
          : null,
        typeof state === "object" && state.truncated ? createElement("div", { className: "dsh-cs-task-jobs-hint" }, "输出过长，已截断") : null,
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
          .then(function () { setKillingId(undefined); setArmedId(undefined); })
          .catch(function () { setKillingId(undefined); setArmedId(undefined); });
      }
      if (rows.length === 0) return null;
      return createElement("div", { className: "dsh-cs-task-jobs" }, [
        createElement("div", { className: "dsh-cs-task-jobs-header" }, [
          createElement("span", { className: "dsh-cs-task-jobs-title" }, "后台任务"),
          createElement("span", { className: "dsh-cs-task-jobs-count" }, liveCount > 0 ? ("共 " + rows.length + " · 运行中 " + liveCount) : ("共 " + rows.length)),
        ]),
        createElement("ul", { className: "dsh-cs-task-jobs-list" }, rows.map(function (row) {
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
          return createElement("li", { key: job.id, className: "dsh-cs-task-jobs-row" + (selected ? " dsh-cs-task-jobs-selected" : "") }, [
            createElement("button", { type: "button", className: "dsh-cs-task-jobs-row-main", onClick: function () { setSelectedId(selected ? undefined : job.id); } }, [
              createElement("span", { className: "dsh-cs-task-job-dot " + (job.status === "running" ? "dsh-cs-task-dot-running" : job.status === "failed" ? "dsh-cs-task-dot-error" : job.status === "stopping" || job.status === "killed" ? "dsh-cs-task-dot-warn" : "dsh-cs-task-dot-done") }),
              createElement("span", { className: "dsh-cs-task-jobs-content" }, [
                createElement("span", { className: "dsh-cs-task-jobs-line" }, [
                  createElement("span", { className: "dsh-cs-task-jobs-kind" }, job.kind),
                  createElement("span", { className: "dsh-cs-task-jobs-label" }, job.label),
                ]),
                createElement("span", { className: "dsh-cs-task-jobs-secondary" }, secondary),
              ]),
            ]),
            live ? createElement("button", { type: "button", className: "dsh-cs-task-jobs-kill" + (armed ? " dsh-cs-task-jobs-kill-armed" : ""), title: armed ? "再点一次确认终止" : "终止任务", disabled: killing, onClick: function (e) { e.stopPropagation(); if (armed) kill(row); else setArmedId(job.id); } }, armed ? "确认终止" : "终止") : null,
          ]);
        })),
        selectedRow !== undefined ? createElement(TaskOutputDock, { ownerSessionId: selectedRow.ownerSessionId, job: selectedRow.job, active: active, onClose: function () { setSelectedId(undefined); } }) : null,
      ]);
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

      var [live, setLive] = useState({});
      useEffect(function () { setLive({}); }, [rootId]);
      useEffect(function () {
        if (!active || rootId === undefined) return;
        var alive = true;
        var timer = null;
        function tick() {
          if (!alive) return;
          fetch("/api/dsh-center-workbench/tasks/live?root=" + encodeURIComponent(rootId))
            .then(function (r) { return r.json(); })
            .then(function (json) {
              if (!alive) return;
              if (json && json.ok) setLive(json.live || {});
            })
            .catch(function () {})
            .then(function () { if (alive) timer = setTimeout(tick, 3000); });
        }
        tick();
        return function () { alive = false; if (timer) clearTimeout(timer); };
      }, [rootId, active]);

      function openChild(childId, parentId) {
        try { if (sessions && sessions.openSubagent) sessions.openSubagent({ parentSessionId: parentId, childSessionId: childId }); } catch (e) { console.error('[dsh-center-workbench] openSubagent failed:', e); }
      }
      function openMain() {
        try { if (rootId !== undefined && sessions && sessions.open) sessions.open(rootId); } catch (e) { /* ignore */ }
      }
      function renderLevel(pid, depth) {
        return directChildren(byId, pid).map(function (s) {
          var running = s.running === true;
          var lv = live[s.id];
          return createElement("div", { key: s.id, className: "dsh-cs-task-node", style: { paddingLeft: (depth * 14) + "px" } }, [
            createElement("button", { type: "button", className: "dsh-cs-task-row", onClick: function () { openChild(s.id, pid); } }, [
              createElement("span", { className: "dsh-cs-task-dot " + (running ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
              createElement("span", { className: "dsh-cs-task-label" }, s.displayTitle || s.id),
              createElement("span", { className: "dsh-cs-task-secondary" }, running ? "运行中" : "空闲"),
            ]),
            running && lv && (lv.text !== undefined || lv.tool !== undefined)
              ? createElement("div", { className: "dsh-cs-task-live" }, [
                  lv.tool ? createElement("span", { className: "dsh-cs-task-live-tool" }, lv.tool.name + " " + String(lv.tool.args || "").slice(0, 60)) : null,
                  lv.text ? createElement("span", { className: "dsh-cs-task-live-text" }, String(lv.text).replace(/\s+/g, " ").trim()) : null,
                ])
              : null,
          ].concat(renderLevel(s.id, depth + 1)));
        });
      }
      var rootSummary = rootId !== undefined ? byId[rootId] : undefined;
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

      return createElement("div", { className: "dsh-cs-tasks" }, [
        createElement("div", { className: "dsh-cs-tasks-header" }, [
          createElement("span", { className: "dsh-cs-tasks-title" }, "后台任务"),
          totals.count > 0 ? createElement("span", { className: "dsh-cs-tasks-count" },
            totals.running > 0 ? (totals.count + " 个 · 运行中 " + totals.running) : (totals.count + " 个")) : null,
        ]),
        createElement("div", { className: "dsh-cs-tasks-body" }, [
          rootId === undefined
            ? createElement("div", { className: "dsh-cs-tasks-empty" }, "无法解析当前会话的主代理（无子代理数据或宿主未挂载子代理服务）。")
            : createElement("div", { className: "dsh-cs-tasks-tree" }, [
                createElement("div", { className: "dsh-cs-task-node" }, [
                  createElement("button", { type: "button", className: "dsh-cs-task-row dsh-cs-task-root", onClick: openMain }, [
                    createElement("span", { className: "dsh-cs-task-dot " + (rootSummary && rootSummary.running === true ? "dsh-cs-task-dot-running" : "dsh-cs-task-dot-done") }),
                    createElement("span", { className: "dsh-cs-task-label" }, (rootSummary && rootSummary.displayTitle) || "主代理"),
                    createElement("span", { className: "dsh-cs-task-secondary" }, "主代理 · " + (rootSummary && rootSummary.running === true ? "运行中" : "空闲")),
                  ]),
                ].concat(renderLevel(rootId, 1))),
              ]),
          createElement(JobsSection, { byId: byId, jobsBySession: list.jobsBySession, rootId: rootId, active: active }),
        ]),
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
      var dragTabRef = useRef(null);

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
        if (kind === "image" || kind === "html" || kind === "pdf" || kind === "unsupported") {
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
        browser: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-1 2v1h2V3a5 5 0 0 1 1.9.5l-1 1.7-1-.2H8v1.4l2 2 1.1-1.1A5 5 0 0 1 13 8a5 5 0 0 1-1 3H5.5l-1.4-1.4 1.1-1.1H7V7H5.7L4 5.3V3.6A5 5 0 0 1 7 3z",
        terminal: "M2 4h12v8H2zM4.5 6.5h3v3h-3z",
        tasks: "M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm2 4h4M6 8h4M6 10h2",
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
        activeTab === "tasks" ? createElement(TasksView, { key: "dsh-cs-tasks", ctx: ctx, active: activeTab === "tasks" }) : null,
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
            var names = { explorer: "资源管理器", browser: "浏览器", terminal: "终端", tasks: "后台任务" };
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
      entry.innerHTML = '<span class="dsh-cs-sidebar-entry-icon"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="' + DIR_ICON + '"/></svg></span><span class="dsh-cs-sidebar-entry-label"></span>';

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
