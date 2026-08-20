# LeetCode Trainer — 项目目的

## 一句话目的

一个**本地自用**的 LeetCode 刷题器，把「冷冰冰的 Accepted / Wrong Answer」换成「AI 告诉你**为什么**」——判题只是手段，**教学习者在错处真正学会**才是目的。

## 核心价值

1. **答对但不够好** → 分析实际复杂度，对比最优解，指出「从你的思路跳到最优解」缺的那一步。
2. **答错但思路对** → 先判断思路是否本质正确；是则定位 bug 行，否则给渐进提示（1/2/3），不直接甩答案。
3. **报错随时辅导** → 编译错误、运行时异常、超时，任何一次运行出错 AI 都基于「报错 + 代码 + 题面」讲解，并**先判断思路对不对**：思路对就明确肯定、只指机械性小错；思路错就纠正方向。初学者不用等「能通过」才有 AI 陪练。
4. **错题本** → 每次提交失败自动归类错误类型，生成可复习的笔记。
5. **掌握度追踪** → 未做 / 尝试过 / 未通过 / 勉强过 / 已通过 / 已掌握 + 间隔复习队列。

## 设计取舍（改代码前必须知道）

- **零依赖**：`node server.mjs` 直接跑，无 npm install；Python 用 Pyodide（浏览器 WASM），C++/Java 由后端调本机工具链。
- **判题驱动自动生成**：不手写每题 driver，而是由题目的 `metaData` 自动生成（普通函数 / 系统设计 / ListNode·TreeNode 结构类型三种形状）。
- **AI key 只留后端**：`config.json`（已 gitignore）不进浏览器、不写日志。
- **本地无沙箱执行**：`/api/run` 在本机无沙箱跑代码，服务只监听 `127.0.0.1`，**绝不能暴露公网**。
- **机械判不准的交 AI**：多解题/顺序不敏感题，机械比对返回 `unknown`，由 AI 裁决，而不是直接判错。
- **测试从 LeetCode GraphQL 取示例输入**，但 API 不给期望输出，故「补全用例」由 AI 从题面抽取并补边界。

## 运行与测试

```bash
node server.mjs               # http://127.0.0.1:8080
node tests/harness.test.mjs   # 三语言判题链路（零依赖，无需服务）
# 浏览器 E2E（可选 playwright-core，需服务运行）见 README
```

## 文件结构（关键）

- `server.mjs` — 零依赖后端：静态服务 + 6 个 API（题目、运行、AI、题库、翻译、状态）
- `public/app.js` — UI 状态机、判题流程、进度/错题本、AI 教练渲染
- `public/ai.js` — 三条教练路径的提示词（通过/报错/补全用例 + 追问 + 错题本）
- `public/harness.mjs` / `harness-cpp.mjs` / `harness-java.mjs` — `metaData` → 三语言驱动生成
- `public/judge.mjs` — 结果归一化比对
- `public/runner-py.js` — Pyodide Web Worker 封装（超时可强杀）
- `data/` — 运行期生成（题目缓存、进度、错题本、题库列表），已 gitignore
- `tests/` — `harness.test.mjs`（零依赖）+ `e2e-browser.mjs` + `e2e-ai.mjs`

## 关键约定

- AI 教练所有路径**强制简体中文输出**；JSON key 与代码标识符保持英文。
- 判题结果的 stdout 用 `__LCT__` 哨兵行隔离，用户 `print`/`cout` 进 `log` 字段，不污染判题流。
- 报错/编译错误里的行号要重映射回用户自己的行号（生成文件的行号对用户无意义，还会误导 AI）。
