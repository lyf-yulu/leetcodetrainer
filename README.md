# LeetCode Trainer

带 AI 教练的本地刷题器。判题之后不是冷冰冰的 Accepted / Wrong Answer，而是告诉你**为什么**。

- **答对但不够好** → 分析你的实际复杂度，对比最优解，指出「从你的思路跳到最优解」缺的那一步
- **答错但思路对** → 先判断思路是否本质正确；是则定位 bug 行；否则给渐进提示（提示 1/2/3），不直接甩答案
- **错题本** → 每次失败自动归类错误类型，生成可复习的笔记
- **掌握度追踪** → 未做 / 尝试过 / 未通过 / 勉强过 / 已通过 / 已掌握 + 复习队列

## 快速开始

```bash
node server.mjs          # 无需 npm install，零依赖
# 打开 http://127.0.0.1:8080
```

顶栏「题库」打开题目列表（题号 + 题名 + 难度，4028 题本地缓存），
按题号或题名搜索，点一行即加载。也可以直接输入题目 slug（LeetCode 网址里的
那段，如 `two-sum`）回车加载；粘 LeetCode 完整网址同样可以，程序会自己提取 slug。

**中文题面**：题面默认显示中文 —— 优先取 leetcode.cn 官方翻译（免费、原生质量），
不可达时用 AI 兜底翻译；每题的翻译缓存在后端，只花一次。题面右上角
「EN / 中文」按钮随时切换，题面里的相对图片链接自动改写。

**调试输入框**：编辑栏下方可粘贴任意 JSON 输入直接运行看输出（含 print 日志与
异常 traceback），不判对错、不记进度、按题自动记忆 —— 刷题时随手试输入的
主力工具。格式：`[参数1, 参数2, …]`，多条输入用 `[[…],[…]]`，回车或点「调试」。

## 接 AI

复制 `config.example.json` 为 `config.json` 并填入你的 key：

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-..."
}
```

任何 OpenAI 兼容服务都行（DeepSeek、阿里百炼、OpenRouter、本地 vLLM…）。
`baseUrl` 填到 `/v1` 为止。改完重启服务。

**key 只留在后端**，不进浏览器、不写日志。`config.json` 已在 `.gitignore` 里。

没配 AI 也能用：判题、进度追踪照常，只是没有教练点评。

## 语言支持

| 语言 | 执行方式 | 状态 |
|---|---|---|
| Python3 | Pyodide（浏览器内 WASM） | 已验证 |
| C++ | 后端调本机 `c++`，C++17 | 已验证（Apple clang 21） |
| Java | 后端调本机 `javac`/`java` | 已验证（OpenJDK 26，brew 安装自动探测） |

顶栏徽章显示实时探测结果，未安装的语言在下拉框里自动置灰。
装 Java：`brew install openjdk`，然后重启服务。后端按 `$JAVA_HOME` →
`brew --prefix openjdk` → 系统注册的 JDK 顺序自动探测，brew 装的
**无需** sudo 符号链接那一步。

## 测试用例从哪来

LeetCode 的 GraphQL 给出示例**输入**，但不给期望输出。所以：

1. 加载题目时先解析出示例输入，此时用例状态是「未判定」——能跑、能看输出，但不声称对错
2. 点「补全用例」，AI 从题面里抽取每个示例的期望输出，再补边界用例（空输入、约束边界、重复值、负数…）
3. 结果缓存在 localStorage，同一题只花一次 AI 调用

判题比对做了归一化：浮点容差 1e-5、数组顺序不敏感、void 操作槽位跳过。
机械判不准的（多解题型）交给 AI 判定，而不是直接判错。

## 判题原理

LeetCode 题型是「实现 Solution 类的某个方法」，判题驱动由题目的 `metaData` 自动生成——
不需要为每道题手写 driver。三种题型形状都支持：

- 普通函数：`{name, params, return}`
- 系统设计类：`{classname, constructor, methods, systemdesign: true}`（如 LRU Cache）
- 结构类型：`ListNode` / `TreeNode` 参数与返回值，自动在扁平数组与对象之间转换

用户代码里的 `print()` / `cout` 输出被单独捕获到 `log` 字段，不会污染判题结果流。

## 快捷键

- `Cmd/Ctrl + Enter` — 提交
- `Esc` — 关闭弹层

## 测试

`tests/harness.test.mjs` 对三套 harness 走完整链路验证，零依赖、无需启动服务：

```bash
node tests/harness.test.mjs
```

覆盖：metaData → 驱动生成 → 编译 → 运行 → 哨兵解析 → 判题，题型含普通函数、
系统设计（LRU Cache）、ListNode 进出、void 原地修改，外加日志捕获、运行时异常、
编译错误、错误答案判定、浮点容差、行号重映射等行为。Python 直接跑系统
`python3`（生成出的驱动只用标准库，与 Pyodide 行为一致）；本机缺某语言的
工具链时，对应用例跳过而非失败。

浏览器端到端测试（需服务运行中，用本机 Chrome headless，可选依赖
playwright-core，仓库本身保持零依赖）：

```bash
mkdir -p /tmp/lct-e2e && cd /tmp/lct-e2e && npm init -y && npm i playwright-core
ln -s /tmp/lct-e2e/node_modules tests/node_modules   # 已被 gitignore
node tests/e2e-browser.mjs    # 完整用户流程：加载/运行/调试/提交/进度/降级
node tests/e2e-ai.mjs         # AI 教练全链路：补全用例/诊断/错题本/点评/追问
```

## 安全须知

`/api/run` 会在你本机**无沙箱**执行代码。服务只监听 `127.0.0.1`，**不要暴露到公网**。
这是本地自用工具的取舍：换来的是启动快、支持语言多、不用装 Docker。

抓 LeetCode 仅个人学习用途：带磁盘缓存、单题串行请求、不做批量爬取。

## 文件结构

```
server.mjs              零依赖后端：静态服务 + 6 个 API（含题库列表、中文翻译）
tests/
  harness.test.mjs      三语言 harness 验证（node tests/harness.test.mjs）
  e2e-browser.mjs       真实浏览器全流程验证（可选依赖 playwright-core）
  e2e-ai.mjs            AI 教练全链路验证（需 config.json）
public/
  index.html            三栏布局
  app.js                UI 状态机、判题流程、进度/错题本
  harness.mjs           metaData → Python 驱动；用例解析；输出解析
  harness-cpp.mjs       metaData → C++ 驱动（含精简 JSON 解析器）
  harness-java.mjs      metaData → Java 驱动（反射式序列化，绕开泛型擦除）
  judge.mjs             结果归一化比对
  runner-py.js          Pyodide Web Worker 封装（超时可强杀）
  ai.js                 三条教练路径的提示词
data/                   运行期生成（已 gitignore）
  problems/<slug>.json  题面缓存
  progress.json         刷题进度
  notes.json            错题本
```
