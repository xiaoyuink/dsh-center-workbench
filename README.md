# dsh-workbench

<p align="center">
  <b>把资源管理器 / 终端 / 浏览器 / 后台任务，装进 DSH 的侧边栏</b><br /><br />
  <code>文件管理</code> <code>预览 / 编辑</code> <code>内嵌浏览器</code> <code>真实终端</code> <code>后台任务</code><br />
  <code>Office 预览</code> <code>TIFF / HEIC / PSD</code> <code>跨平台</code>
</p>

一个 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) Web 插件：把 **资源管理器、内嵌浏览器、真实终端、后台任务** 注册成 **DSH 官方右侧 Sidebar 的标签页**——和官方自带的「工作区文件」、[dsh-ssh-ops](https://github.com/caoyiwei850/dsh-ssh-ops) 的「SSH 终端」并列，各自还带一张 guide 入口卡片（侧边栏「开始」页上的那张卡片）。双击文件会在侧边栏**新开一个文件预览标签**。

宿主没有官方侧边栏服务（旧 DSH）时**自动回退**到自带的「中部栏」三段式面板：窗口正中渲染工作台、把对话栏向右推开。两种形态共用同一套正文组件与宿主路由，功能一致，只是外壳不同。

> **谁适合装**
> 想在 DSH 里边聊边翻代码、改文件、开终端、看子代理与后台任务的人；需要预览 docx / xlsx / pptx / TIFF / HEIC / PSD 这类浏览器默认打不开的文件的人；以及本机 Windows + WSL 双环境来回倒文件的人。

---

## 目录

- [功能](#功能)
- [两种呈现形态](#两种呈现形态)
- [安装](#安装)
- [使用](#使用)
- [侧边栏集成细节](#侧边栏集成细节)
- [平台支持](#平台支持)
- [HTTP 路由](#http-路由)
- [目录结构](#目录结构)
- [开发](#开发)
- [更新记录](#更新记录)
- [License](#license)

---

## 功能

### 资源管理器

- **VS Code 风格目录树**：文件夹带 `▸ / ▾` 箭头——**单击文件夹行 = 进入该文件夹**，**单击 `▸` = 原地展开/收起**（懒加载 + 已加载目录轮询刷新外部变更），层级缩进、面包屑与「上一级」。
- **多选与右键菜单**：Ctrl 点选、Shift 区间选（锚点可反向）；复制 / 剪切 / 粘贴 / 删除 / 重命名 / 新建目录 / 新建文件 / 复制路径 / 在预览中打开 / 用官方预览打开 / 导入 / 导出。
- **键盘快捷键**：`Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Delete`（只在资源管理器内部生效，不抢对话栏的复制粘贴）。
- **文件互通**：从系统资源管理器**拖入**文件或文件夹（保留子目录结构）、`Ctrl+V` 粘贴文件；右键「**导入文件夹… / 导入文件…**」弹系统选择器，选好即导入当前目录；「**导出到文件夹…**」写进系统选择的目录。导入 / 导出 / 删除都有**进度条**。
- **Windows 盘符切换**：工具栏下拉直接选 `C:` / `D:` / …。
- **类型着色图标**：仿 VS Code / GitHub 的描边图标，文件夹琥珀色，编程语言按 Linguist 配色；Word 蓝 W、Excel 绿 X、PPT 橙红 P。

### 预览与编辑

双击文件 = 在侧边栏**新开一个以文件名命名的预览标签**（每个文件一个标签，可同时开着多个；同一个文件重复双击只聚焦）。标签内：

| 类型 | 行为 |
| --- | --- |
| 文本 / 代码 / Markdown | **默认编辑态**，可「预览 ↔ 编辑」、`Ctrl/Cmd+S` 或「保存」写盘，关闭时若有未保存改动会先问一句 |
| 图片（png/jpg/gif/webp/svg/bmp/ico/avif/jfif…） | 只读，滚轮缩放、适应窗口 |
| PDF | 只读，内嵌 iframe，滚轮缩放 |
| HTML | 只读，沙箱 iframe 渲染 |
| **Word**（`.docx`） | [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)，支持「分页 / 文本」两种显示方式 |
| **Excel**（`.xlsx/.xls`） | [SheetJS](https://github.com/SheetJS/sheetjs)，支持「表格 / 原始(TSV)」，表头吸顶 |
| **CSV / TSV** | 内置解析，自动识别 UTF-8 / GBK，支持「表格 / 原始文本」 |
| **PPT**（`.pptx`） | [pptx-preview](https://github.com/501351981/pptx-preview)（已预打包），支持「幻灯 / 列表」 |
| **TIFF** | [UTIF.js](https://github.com/photopea/UTIF.js) 解码预览 |
| **HEIC / HEIF** | [heic2any](https://github.com/alexcorvi/heic2any)，内置 wasm，离线可用 |
| **PSD / PSB** | [ag-psd](https://github.com/Agamnentzar/ag-psd)，预览合并图层 |

Office / PDF / 图片预览统一带**工具栏**：缩小 / 放大（40%–250%）、适应宽度（随面板尺寸实时跟随）。所有解码库都是**按需懒加载**，不拖慢首屏。

**预览内容不重复加载**：切标签回来不发第二次请求——文本与原始字节都按路径缓存在客户端；图片与 PDF 走浏览器原生缓存（宿主 `/media` 带 ETag，未修改时只回一个不带 body 的 304）。

### 内嵌浏览器

沙箱 iframe 网页浏览标签：地址栏、前进 / 后退 / 刷新、多开、可临时解锁限制。

### 真实终端

[xterm.js](https://xtermjs.org/) + `node-pty` + WebSocket 的真实 pty：切标签 / 收起侧边栏不会重启终端，回来看得到完整回滚缓冲。主题跟随 DSH 明暗方案，内置 one-dark / one-light ANSI 调色板。

### 后台任务

- **子代理拓扑树**：消费宿主 `subagentsByParent` seam，目录化懒渲染——子代理展示模式（一次性 / 可续接）、运行状态、目录损坏与不支持的条目诊断、加载占位与错误重试、当前会话高亮、连接线缩进、键盘导航（`↑`/`↓`/`Home`/`End`）与「刷新」。
- **后台任务列表**：仅运行中的任务显示终止按钮（两击确认），已结束行淡化；输出面板**终端式 sticky 底部停靠**，重放**不碰模型的 `job_output` 游标**。
- **自动激活**：「新子代理」或「新任务」出现时自动切到后台任务标签（500ms 去抖），页头可一键关掉；运行中任务数显示为标签角标。
- 点卡片可直接跳进子代理会话（带 `mode`，一次性 / 可续接都正确）。

---

## 两种呈现形态

| 形态 | 触发条件 | 表现 |
| --- | --- | --- |
| **官方侧边栏标签**（推荐） | 宿主提供 `sidebarRightTabs` / `sidebarRight`（DSH ≥ 0.1.5-rc.1） | 四个功能成为官方右侧 Sidebar 的标签页 + guide 入口卡片；宽度、分栏、全屏、折叠全部由官方 Sidebar 掌管。会话头部另有一个「工作台」按钮，一键展开并聚焦资源管理器 |
| **中部栏**（兼容回退） | 宿主没有上述服务（旧 DSH） | 窗口正中渲染面板并把对话栏向右推开；侧边栏导航里的「中部栏」开关控制开合，宽度与标签顺序持久化 |

判定是**窗口重试**式的：拿不到服务就每 150ms 重试，最多 20 次（约 3 秒）——各客户端插件装配有先后，服务可能晚一步才到；整个窗口内都拿不到才回退中部栏，并记录一条 `console.error`，不会留下半截界面。

---

## 安装

### 方式一：一条命令装最新 Release（推荐）

```bash
dsh plugin --profile web add https://github.com/xiaoyuink/dsh-workbench/releases/latest/download/dsh-workbench-latest.tgz
```

上面的 URL 永远指向最新 Release（`/releases/latest/` 会自动重定向），不用改版本号。装指定版本就把 `latest` 换成版本号：

```bash
dsh plugin --profile web add https://github.com/xiaoyuink/dsh-workbench/releases/download/v0.4.5/dsh-workbench-0.4.5.tgz
```

### 方式二：开发模式（`link:`）

```bash
mkdir -p ~/.dsh/plugin && cd ~/.dsh/plugin
git clone https://github.com/xiaoyuink/dsh-workbench.git
cd dsh-workbench
pnpm install                 # node-pty / xterm / ws / Office 预览库
dsh plugin --profile web add "$(pwd)"
```

> **存放位置**：开发模式建议统一放 `~/.dsh/plugin/`；`dsh plugin add` 指向该目录即可，位置任意。

### 装完

1. **重启 `dsh web`**（宿主在启动时加载插件），
2. 浏览器 `Ctrl+Shift+R` 硬刷新（客户端 bundle 会热重载，但硬刷新最省事）。

---

## 使用

1. 点侧边栏「开始」页上的 **资源管理器** 卡片（或会话头部的「工作台」按钮），右侧栏就打开工作台标签。
2. 标签条上的 **+** 可以再开其他工作台标签（浏览器 / 终端 / 后台任务）；标签可拖动排序、可拆分栏、可全屏。
3. 资源管理器里**双击文件** → 新开一个预览标签；双击目录行进入该目录，点 `▸` 原地展开。
4. 拖文件进资源管理器 = 导入；右键「导出到文件夹…」= 导出。

---

## 侧边栏集成细节

- **五个标签类型**（注册 id 都是 `dsh-workbench/<name>`，优先级 `extension`）：

  | kind | 说明 | guide 卡片 |
  | --- | --- | --- |
  | `dsh-workbench-explorer` | 资源管理器（文件树） | ✅ 资源管理器 |
  | `dsh-workbench-browser` | 内嵌浏览器 | ✅ 浏览器 |
  | `dsh-workbench-terminal` | 真实终端 | ✅ 终端 |
  | `dsh-workbench-tasks` | 后台任务 | ✅ 后台任务 |
  | `dsh-workbench-preview` | 文件预览（双击文件时出现，不在 guide 页上） | — |

- **预览标签的资源地址**：`dsh-resource://workbench-preview/<encodeURIComponent(绝对路径)>`，文件路径同时放在导航参数 `params.path` 里；地址即 `contentId`，所以同一个文件重复打开只会聚焦已有标签。用绝对路径，所以工作区之外的文件也能预览。
- **宿主服务依赖**：只用公开的 `ctx.slots` / `ctx.get("sidebarRightTabs")` / `ctx.get("sidebarRight")`；**不依赖、也不修改** `dsh-better-sidebar` 或 `dsh-ssh-ops`。SSH 有自己的标签，互不干扰。
- **会话头部按钮**：注册在 `conversation.session.header.actions`（order 91），点一下 = 展开侧边栏 + 聚焦资源管理器；`sidebarRight.openTab` 本身幂等，不会开出第二个。

---

## 平台支持

针对 **Windows / Linux / macOS** 三平台适配：

- **终端**：Windows 下自动改用 `cmd.exe` / `powershell.exe`（读 `%COMSPEC%`），不依赖 `/bin/bash` 与 `-l`；cwd 缺省回落到用户主目录并做存在性校验。
- **路径**：Windows 盘符路径（`C:\Users\...`）做反斜杠归一化；盘符根可通过工具栏下拉切换。
- **默认目录**：会话 cwd 缺失时回落到宿主用户主目录（由宿主 `/env` 提供），不写死路径。

### Windows 注意事项

- **node-pty 是原生模块**：没有匹配的预编译二进制时会回退 `node-gyp` 编译，需要 Visual Studio Build Tools（含 C++）+ Python。
- **系统选择器**（导入文件夹 / 导入文件 / 导出到文件夹）依赖 File System Access API，**仅 Chrome / Edge**（需安全上下文，本机 `127.0.0.1` 可用），Firefox 不支持；跨浏览器最可靠的导入方式是**拖放**。
- **HEIC 转换**依赖 Web Worker（需安全上下文），首次转换稍慢；超大 TIFF 解码较慢且吃内存。
- **Office 预览**是只读的，不执行宏；docx 渲染效果受宿主字体影响；pptx 里 echarts 类图表支持不完整。

---

## HTTP 路由

宿主半提供的路由（全部挂在 `/api/dsh-workbench/` 下）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/tree` | 列出目录条目 |
| GET | `/file` | 读取文本文件（预览 / 编辑） |
| POST | `/file/save` | 写回文本文件 |
| POST | `/file/upload` | 外部文件导入（拖放 / 粘贴，自动建父目录） |
| POST | `/file/op` | 复制 / 移动（含目录，带自/后代守卫） |
| POST | `/file/del` | 删除文件 / 目录 |
| POST | `/file/create` | 新建目录 / 文件 |
| GET | `/tree/recursive` | 递归列出目录（相对路径，导出用） |
| GET | `/env` | 环境信息（主目录 / 平台 / 分隔符） |
| GET | `/drives` | Windows 盘符列表 |
| GET | `/media` | 原生字节预览（图片 / PDF / HTML 等；带 ETag，未修改回 304） |
| GET | `/tasks/live` | 运行中子代理实时活动 |
| POST | `/tasks/output` | 重放模型已读的任务输出（不碰 `job_output` 游标） |
| POST | `/tasks/kill` | 终止后台任务 |
| GET | `/terminal` | WebSocket 升级 → 真实终端（node-pty） |
| GET | `/xterm.js`、`/addon-fit.js`、`/xterm.css` | xterm 运行时（宿主动态提供） |
| GET | `/vendor/*.js` | 预览解码库 UMD：`jszip` `docx-preview` `xlsx` `pptx-preview` `pako` `utif` `heic2any` `ag-psd` |
| POST | `/diag` | 客户端装配诊断信标（追加写 `~/.dsh/dsh-workbench/diag.jsonl`） |

---

## 目录结构

```
dsh-workbench/
├── package.json          # dsh.bundle.patch + dsh.client + peerDeps
├── cordis.patch.yml      # insert 插件行（挂载 bundle）
├── README.md
├── scripts/
│   └── smoke-sidebar.cjs # jsdom 回归测试（标签注册 / 正文挂载 / 预览缓存 / 回退）
└── lib/
    ├── index.js          # 宿主半：/api/dsh-workbench/* 路由 + 终端(pty) + 后台任务
    └── client.js         # 客户端半：__ModuleLoader__ bundle（侧边栏标签 + 中部栏回退 + 正文组件）
```

---

## 开发

```bash
# 回归测试（需要 jsdom；JSDOM_PATH 指向任意装好 jsdom 的 node_modules）
pnpm add -D jsdom
JSDOM_PATH=./node_modules/jsdom node scripts/smoke-sidebar.cjs
```

`scripts/smoke-sidebar.cjs` 用 jsdom 复刻客户端环境，断言：五个标签类型注册正确（kind / id / 优先级 / guide 卡片 / 预览类型的地址模式与标题）、每个正文都能挂载渲染、会话头部按钮点击会开聚焦、双击文件发出的正是预览资源地址、预览正文能读 `tabInfo` 并渲染内容、**重挂载不重读文件**、宿主没有侧边栏服务时回退中部栏。

改了客户端 `lib/client.js` 后，DSH 的 `client-hmr` 会重载 bundle 并重跑 `apply()`（幂等，不会重复注册）；改了宿主 `lib/index.js` 或新增路由则需要重启 `dsh web`。

发布 Release 时，除 `dsh-workbench-<版本>.tgz` 外请再上传一份固定名资产 **`dsh-workbench-latest.tgz`**（内容相同），这样 README 里「一条命令装最新」的 `releases/latest/download/` 链接永远有效。

---

## 更新记录

### v0.4.x — 融入官方侧边栏

- **v0.4.7**：**会话头部「工作台」按钮改为开关**——此前只有"打开"一个动作；现在一下打开、再一下关闭：关闭态点击 = 展开侧边栏并聚焦资源管理器；工作台开着（侧边栏展开 **且** 活动标签属于本插件任一标签，含文件预览）时点击 = 收起侧边栏。若侧边栏开着但当前是别的标签（比如官方「工作区文件」），点击仍然聚焦回工作台而不是误收起。按钮的 `aria-pressed`、`aria-label` 与 tooltip（打开工作台 / 关闭工作台）随状态同步。

- **v0.4.6**：**预览标签切回来不再重新渲染**——官方 Sidebar 切换标签会卸载再挂载正文，重新挂载会让图片重新解码、Word 重新排版、滚动位置丢失（表现为"又加载了一次"）。现在：①每个预览标签的**正文元素按标签 id 缓存**，切回来时 React 拿到同一个元素对象，原地复用已建好的子树；②解码/解析结果也按路径缓存（TIFF/HEIC/PSD 的 dataURL、Word 的渲染 HTML、Excel 的 sheet 数据、CSV 的解析结果），即使真的重新挂载，**首帧就是成品**；③文件在磁盘上变化时只失效该路径的缓存，关闭标签后自动清理。另：修复回归测试自身——它此前加载的是"已安装插件"目录而不是仓库里的 `lib/client.js`，所以有断言其实没测到目标文件；现已改为按脚本位置定位仓库根。

- **v0.4.5**：`/media` 缓存头收紧为 `max-age=0, must-revalidate`（保留 ETag）——图片 / PDF 每次显示只发一个条件请求，未修改就回 **304（不带 body）**，字节不重传、磁盘不重读，文件改了立刻是新内容，没有陈旧窗口。
- **v0.4.4**：**预览不再每次切换都重新加载**——客户端新增按路径的预览缓存（文本内容 + 原始字节，64 MiB 上限按插入序淘汰），保存 / 复制 / 移动 / 重命名 / 删除会让对应路径失效；宿主 `/media` 补 ETag 与条件请求。
- **v0.4.3**：修复预览标签显示「没有可预览的文件」——官方侧边栏把 tab 信息钩子作为**直接 prop `useTabInfo`** 交给正文（同官方 `FilesBody`），此前误读 `props.hooks.tabInfo` 导致拿不到标签地址。
- **v0.4.2**：**文件预览改成官方侧边栏标签**（每个文件一个，同一个文件重复双击只聚焦）——新增 `dsh-workbench-preview` 类型，地址 `dsh-resource://workbench-preview/…`；删除浮窗实现。
- **v0.4.1**：资源管理器预览改为标签内浮窗（v0.4.2 已被标签方案取代）；guide 卡片名定为「资源管理器」；新增右键「用官方预览打开」；侧边栏服务探测改为窗口重试 + 幂等。
- **v0.4.0**：**融入官方右侧 Sidebar**——检测到 `sidebarRightTabs` / `sidebarRight` 就把四个功能注册成官方标签并各带 guide 卡片，会话头部加「工作台」按钮；宿主没有这些服务时自动回退原中部栏三段式。

### v0.3.x — 中部栏时代

- **v0.3.6**：后台任务页对齐 `dsh-better-sidebar`——自动激活（新子代理 / 新任务）、修复点子代理卡片无反应（缺 `mode`）、输出面板改 sticky 底部停靠、修复「拓扑一直加载中」的死锁与无限刷新循环。
- **v0.3.5**：嵌入 `dsh-ssh-ops` 的 SSH 悬浮面板（该插件自带官方侧边栏标签后已不需要）。
- **v0.3.4**：修复树形资源管理器 Shift 区间多选。
- **v0.3.3**：资源管理器改为 VS Code 风格目录树（`▸/▾`、懒加载、目录缓存轮询刷新）。
- **v0.3.2**：Office 预览（Word / Excel / CSV / PPT）+ 扩展图片预览（TIFF / HEIC / PSD）+ 预览工具栏。
- **v0.3.1**：文件图标按类型着色（仿 VS Code / GitHub）。
- **v0.3.0**：系统选择器导入 / 导出 + 进度条 + 多选与复制修复。
- **v0.2.0**：更名并加入后台任务页、文件互通（拖放 / 粘贴 / 导出）、Windows 适配、标签顺序与宽度持久化。

---

## License

[MIT](./package.json)
