# dsh-center-workbench

<p align="center">
  <b>一个插件，一套中部栏工作台</b><br /><br />
  <code>文件管理</code> <code>预览/编辑</code> <code>内嵌浏览器</code> <code>真实终端</code> <code>后台任务</code><br /><br />
  <b>窗口正中央</b>的文件浏览工作台，把对话栏向右推开，形成 <code>[左侧栏 | 中部栏 | 对话栏]</code> 三段式。
</p>

核心思想：**一个独立的「中部栏」，不依赖、不改动 `dsh-better-sidebar`**。在 DSH 窗口中央渲染一个完整工作台，覆盖文件浏览、预览编辑、浏览器、真实终端与后台任务监控；同时针对 **Windows / Linux / macOS** 三平台做了适配。

> **🧬 谁适合装**
> 想要一个「常驻中央」的文件工作台、又不想被 DSH 自带侧边栏左右布局束缚的用户；以及需要在 DSH 里直接浏览/编辑/预览文件、开终端、看后台任务的研究者与开发者。

## 功能总览

- **资源管理器**：文件树导航、面包屑、多选（Ctrl/Shift）、右键菜单、复制/剪切/粘贴/删除/重命名/新建、目录自动刷新轮询；**Windows 下支持盘符切换**（工具栏下拉选 `C:`/`D:`/… 即可浏览其它盘）。
- **编辑与预览**：图片 / HTML（沙箱 iframe）/ PDF / Markdown（预览↔编辑，Ctrl/Cmd+S 保存）/ 代码高亮编辑；图片/PDF 可滚轮缩放。
- **内嵌浏览器**：沙箱 iframe 网页浏览 tab（多开、后退/前进/刷新、可临时解锁）。
- **真实终端**：xterm.js + node-pty + WebSocket（Windows 自动用 `cmd.exe`/`powershell.exe`；cwd 缺省回落）。
- **后台任务**：子代理拓扑树 + 后台任务列表、输出重放（**不碰模型的 `job_output` 游标**）、两击确认强杀。
- **文件互通**：从 Windows 资源管理器**拖入**文件/文件夹（文件夹保留子目录结构）、`Ctrl+V` 粘贴文件；右键「导出到 Windows 文件夹…」写进系统文件夹选择器选的目录。
- **中部栏开关**：放进侧边栏导航（生图插件按钮下方），宽度与标签顺序持久化。
- **会话隔离**：面板状态随会话/工作区动态锚定，标签宽度与顺序本地持久化。

## 快速上手

### 安装插件

**方式一：一条命令安装最新 Release（推荐，无需源码/依赖，始终最新版）**

```bash
dsh plugin --profile web add https://github.com/xiaoyuink/dsh-center-workbench/releases/latest/download/dsh-center-workbench-latest.tgz
```

> 上面的 URL **永远指向最新版本**（GitHub `/releases/latest/` 自动重定向到最新 Release 的资产），无需改版本号。若想装指定版本，把 `latest` 换成版本号即可：
> `.../releases/download/v0.2.0/dsh-center-workbench-0.2.0.tgz`

**方式二：GitHub 仓库开发模式（`link:`，适合二次开发）**

```bash
# 建议在 ~/.dsh 下新建 plugin 目录，统一存放插件本体
mkdir -p ~/.dsh/plugin
cd ~/.dsh/plugin

git clone https://github.com/xiaoyuink/dsh-center-workbench.git
cd dsh-center-workbench
pnpm install          # 安装插件自身依赖（node-pty / xterm / ws）

# 用 DSH CLI 注册（link: 协议，代码改动重启即生效）
dsh plugin --profile web add "$(pwd)"
```

> **💡 存放位置**：开发模式建议放在 `~/.dsh/plugin/` 统一管理；`dsh plugin add` 指向该目录路径即可，位置任意。

安装后**重启 `dsh web`**（宿主在启动时加载插件），浏览器 `Ctrl+Shift+R` 硬刷新。

### 使用

1. 点击侧边栏导航里的「中部栏」（在生图插件按钮下方）打开中部栏。
2. 顶部标签：**资源管理器 / 浏览器 / 终端 / 后台任务**，可拖动排序（位置记住）。
3. 资源管理器里双击文件即预览/编辑；右键可复制/剪切/粘贴/删除/重命名/新建/导出。
4. 从 Windows 资源管理器把文件/文件夹**拖入**资源管理器列表即导入（文件夹保留结构）；右键 →「导出到 Windows 文件夹…」可把文件/目录写进系统选择的目录。

## 平台支持（Windows / Linux / macOS）

本插件已针对三平台适配：

- **终端**：Windows 下自动改用 `cmd.exe`/`powershell.exe`（读取 `%COMSPEC%`），不再依赖 `/bin/bash` 与 `-l` 参数；cwd 缺省回落到用户主目录（`os.homedir()`），并做存在性校验、多级兜底。
- **路径**：文件浏览器对 Windows 盘符路径（`C:\Users\...`）做反斜杠归一化，向上 / 文件基名 / 新建 / 重命名等操作正常；盘符根（`C:`）可经工具栏下拉切换。
- **默认目录**：会话 cwd 缺失时回落到宿主用户主目录，不再写死 `/home/sya`。

## Windows 注意事项

- **node-pty（原生模块）**：安装时若没有匹配的 Windows 预编译二进制，会回退到 `node-gyp` 编译，需要 **Visual Studio Build Tools（含 C++）+ Python**。若编译失败，安装这两项后重装即可（`pnpm install --force` 或重装依赖）。
- **终端**：Windows 下默认 `cmd.exe`；想用 PowerShell 可在 `lib/index.js` 的终端 route 把默认壳改为 `powershell.exe`。Shell 工具链由 DSH 宿主决定。
- **「导出到 Windows 文件夹…」**：依赖浏览器 File System Access API，仅支持 Chrome / Edge（需安全上下文，本机 `127.0.0.1`/localhost 可用）。不支持 Firefox。
- **粘贴（Ctrl+V）导入文件**：跨浏览器不稳定（`clipboardData.files` 行为各异）；**拖入**是最可靠的导入方式。

## HTTP 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/dsh-center-workbench/tree` | 列出目录条目 |
| GET | `/api/dsh-center-workbench/file` | 读取文本文件（预览/编辑） |
| POST | `/api/dsh-center-workbench/file/save` | 写回文本文件 |
| POST | `/api/dsh-center-workbench/file/upload` | 外部文件导入（拖放/粘贴；自动建父目录） |
| POST | `/api/dsh-center-workbench/file/op` | 复制 / 移动（含目录，含自/后代守卫） |
| POST | `/api/dsh-center-workbench/file/del` | 删除文件/目录 |
| POST | `/api/dsh-center-workbench/file/create` | 新建目录/文件 |
| GET | `/api/dsh-center-workbench/tree/recursive` | 递归列出目录（相对路径，导出用） |
| GET | `/api/dsh-center-workbench/env` | 环境信息（主目录 / 平台 / 分隔符） |
| GET | `/api/dsh-center-workbench/drives` | Windows 盘符列表（盘符切换） |
| GET | `/api/dsh-center-workbench/media` | 原生字节预览（图片 / PDF / HTML 等） |
| GET | `/api/dsh-center-workbench/tasks/live` | 运行中子代理实时活动（后台任务页） |
| POST | `/api/dsh-center-workbench/tasks/output` | 重放模型已读的任务输出（不碰 `job_output` 游标） |
| POST | `/api/dsh-center-workbench/tasks/kill` | 终止后台任务 |
| GET | `/api/dsh-center-workbench/terminal` | WebSocket 升级 → 真实终端（node-pty） |
| GET | `/api/dsh-center-workbench/xterm.js` | xterm UMD（宿主动态提供） |
| GET | `/api/dsh-center-workbench/addon-fit.js` | xterm fit 插件 |

## 安装方式（README 速查）

```bash
# 一条命令装最新（推荐）
dsh plugin --profile web add https://github.com/xiaoyuink/dsh-center-workbench/releases/latest/download/dsh-center-workbench-latest.tgz

# 开发模式（link:）
git clone https://github.com/xiaoyuink/dsh-center-workbench.git && cd dsh-center-workbench && pnpm install
dsh plugin --profile web add "$(pwd)"
```

## 目录结构

```
dsh-center-workbench/
├── package.json          # 声明 dsh.bundle.patch + dsh.client + peerDeps
├── cordis.patch.yml      # insert 插件行（挂载 bundle）
├── README.md
└── lib/
    ├── index.js          # host 半：/api/dsh-center-workbench/* 路由 + 终端(pty) + 后台任务
    └── client.js         # client 半：手写 __ModuleLoader__ bundle（中部栏 + 资源管理器 + 终端 + 后台任务）
```

## 更新记录

> **给维护者**：发布 Release 时，除 `dsh-center-workbench-<版本>.tgz` 外，请再上传一份固定名资产 `dsh-center-workbench-latest.tgz`（内容相同），保证首页「一条命令安装最新 Release」的 `releases/latest/download/` 链接始终指向最新的包。

- **v0.2.0**：更名为 `dsh-center-workbench`；新增**后台任务页**（子代理拓扑 + 后台任务列表 / 输出重放 / 两击强杀，不碰模型 `job_output` 游标）；新增**文件互通**（Windows 拖放/粘贴导入、导出到 Windows 文件夹）；新增**Windows 适配**（终端跨平台壳、盘符切换、路径归一化、默认目录跨平台）；标签顺序与宽度持久化；顶栏去除「中部栏」文字。

## License

[MIT](./package.json)
