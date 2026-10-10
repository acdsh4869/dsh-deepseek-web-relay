# v1.6.0 气泡触发逻辑改动说明（面向使用者）

## 一句话

气泡从「划词就弹」改成「**明确手势才弹**」，并且在输入框、搜索框、代码块、菜单、
侧栏、表格、筛选标签等区域**任何情况下都不弹**。

---

## 一、你截图里的问题，根因是什么

不是气泡定位不准，而是**三条漏斗全都绕过了区域判断**。这三条必须一起堵，
只改其中一处，问题会换个姿势回来。

### 漏斗 1：排除清单只有三类元素

原 `readSelection` 只排除了 `textarea / input / [contenteditable="true"]`。
插件市场的**搜索框**恰好是 `<input>`，能被拦住；但**过滤标签（chip/tag）、
表格单元格、插件卡片描述、设置页 tab** 都不在这三类里 → 全部放行。

### 漏斗 2：选区缓存完全不判区域

`cacheSelection`（拖选过程中被高频调用）**没有任何区域判断**。
在插件市场里划词时，缓存照样被填上；随后 mouseup 走「缓存兜底」分支就把气泡弹了出来。
**只改 mouseup 是不够的。**

### 漏斗 3：缓存跨区域泄漏 —— 这就是你截图里现象的直接成因

```
① 在对话正文划词 → 缓存记下这段文字（当时合规）
② 走到插件市场，在搜索框里划词 → readSelection 被区域闸门拒绝
③ 但 4 秒内的缓存还热着 → 兜底分支把它掏出来冒泡，而且冒在搜索框旁边
```

### 附带缺陷：漏了滚动收起

`client.js` 里**没有** scroll 监听（网页端 `page-script.js` 有，客户端漏了）。
气泡是 `position: fixed`，页面一滚它就停在原地不动，变成一块悬在半空的药丸 ——
原来贴着选区，滚完之后正好压在输入框或中间某个控件上。
这是「气泡挡住界面」的**另一半**成因，光加区域闸门解决不了。

---

## 二、改了什么

### 1. 语义区域闸门：按「这是什么控件」判断，不按「它在第几层页面」判断

这是本次最关键的设计决定。DSH 是 React 应用，class 名是构建期生成的
（v1.2.0 已经踩过这个坑），所以**绝不引用 DSH 自己的 class 名**——
那样做现在能跑，DSH 一升版就失效。

规则表全部使用语义稳定的标签名与 role：

| 类别 | 拦截内容 |
|---|---|
| 表单 | `input` `textarea` `select` `[contenteditable]` `[role=textbox]` `[role=searchbox]` |
| 代码 | `code` `pre` `kbd` `[class*=monaco-editor]` `[class*=code-block]` |
| 控件 | `button` `a[href]` `[role=button]` `[role=tab]` `[role=menuitem]` `label` |
| 浮层 | `[role=menu]` `[role=dialog]` `[role=tooltip]` |
| 地标 | `nav` `aside` `header` `footer` `[role=navigation]` `[role=banner]` |
| 侧栏 | `[class*=sidebar]` `[class*=sidenav]` `[class*=nav-list]` |
| 表格 | `table` `tr` `td` `[role=grid]` `[role=cell]` `dl/dt/dd` |
| 筛选标签 | `[class*=chip]` `[class*=badge]` `[class*=tag-list]` `[class*=filter-bar]` |
| 媒体 | `svg` `canvas` `img` `video` |

判定分三档 `chat` / `neutral` / `unknown`，其中 **`unknown` 也按 neutral 处理**
（fail-closed）：宁可少弹一次、让用户手动按快捷键，也不要在界面上乱糊气泡。

三条漏斗的封堵方式：
- 漏斗 1 → `readSelection` 用新闸门
- 漏斗 2 → `cacheSelection` 用**同一套**闸门
- 漏斗 3 → 新增 `selectionZoneAllowed()`，专门守缓存兜底那条路

### 2. 触发方式改为 `modifier`（新默认）

```
bubbleTrigger: 'modifier'（原 'select'）
```

普通划词**一律不弹泡**。两条入口互为冗余：

- **入口①** 按住 `Alt` 划词 → 松手即弹
- **入口②** 先正常划词，再补按一下 `Alt` → 4 秒内弹出

为什么要两条：Windows 上 `Alt` 可能被 DSH 壳层或系统菜单栏吃掉，
只留入口①会时灵时不灵。两条任意一条可用就够了 —— 交互的可靠性比姿势优雅重要。

另外，**右键选区在 `modifier` 模式下同样可用**（右键本身就是「我要对这个选区
做点什么」的明确信号，不需要额外手势）。

### 3. 不遮挡关键 UI

- 补上 `scroll` / `resize` / `blur` 收起（原先完全缺失），滚动时一并作废待命窗口
- 新增 `bubbleAutoHideMs`（默认 6 秒）自动消失：即便某条异常路径让气泡残留，
  它也一定自己走，不给界面留被糊住的机会

### 4. 快捷键不再走缓存兜底

`Ctrl+Shift+S` 是显式意图动作，现在只认真实选区 ——
避免用户早就划好的词被一个误按的组合键发出去。

---

## 三、一个诚实的已知限制

**插件卡片的「描述文字」拦不住。**

它是裸 `<div><p>`，没有任何语义标记能把它和对话正文区分开。
任何纯选择器方案都做不到（除非去匹配 DSH 构建期 class 名，那会随版本失效）。

这类场景由**触发方式的改变**兜住：用户必须主动按住 `Alt` 才可能冒泡，
普通划词（你截图里的场景）压根不会弹。

如果你连这一类也想拦掉，把配置设成严格档：

```yaml
config:
  bubbleScope: conversation
```

代价是它依赖 class 名，DSH 升版可能对不上（届时气泡会变得很安静，
改回 `input-excluded` 即可）。

---

## 四、怎么用（推荐配置）

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-deepseek-chat
      name: dsh-deepseek-chat
      config:
        bubbleTrigger: modifier   # 默认值，可省略
        bubbleModifier: alt       # 想换成 Ctrl/Shift 也行
        hotkeySend: ctrl+shift+s  # 划完词直接发，最省心
```

**日常最推荐的用法：划完词按 `Ctrl+Shift+S`。**
完全不经过气泡的指针链路，也就不存在气泡遮挡界面的问题。

需要气泡按钮时：`Alt` + 划词，或划完词补按 `Alt`，或直接右键选区。

---

## 五、怎么验证改对了

重启 DSH 后，在 `%TEMP%\dsh-deepseek-chat-status.json` 里看 `overlay-rendered`，
它现在会带上实际生效的配置：

```json
{
  "phase": "overlay-rendered",
  "trigger": "modifier",
  "modifier": "alt",
  "scope": "input-excluded"
}
```

逐项自查：

| 操作 | 期望 |
|---|---|
| 插件市场搜索框里划词 | 不弹 |
| 过滤标签（chip）上划词 | 不弹 |
| 设置页 tab / 表格里划词 | 不弹 |
| 代码块里划词 | 不弹 |
| DSH 输入框里划词 | 不弹 |
| 正文普通划词（不按 Alt） | **不弹**（这是本次的核心改动） |
| 正文 `Alt` + 划词 | 弹 |
| 正文划完词补按 `Alt` | 弹 |
| 正文划词后右键 | 弹 |
| 气泡弹出后不做任何操作 | 6 秒后自动消失 |
| 气泡弹出后滚动页面 | 立即消失 |

若某个区域该拦没拦，诊断里 `bubble-none` 的 `why` 会写明是哪一类规则拦的
（`zone:form-control` / `zone:filter-chip` / `zone:table` …），照着它调规则表即可。

---

## 六、自测脚本

新增两个**不需要启动 DSH**、直接用 Node 就能跑的用例：

```bash
node tools/test-bubble-zone.cjs      # 区域判定：17 例 + 严格档 4 例
node tools/test-bubble-trigger.cjs   # 触发流程：26 例
```

（需要 `linkedom`：`npm i linkedom`）

> 值得一提：集成测试在开发过程中**实测抓到两个真 bug**，都已修 ——
> 一是 `onArmKey` 用 `key.length > 1` 判断「是不是主键」，
> 把 `'Alt'`（长度 3）自己给滤掉了，导致入口② 永远不会触发；
> 二是上面第三节说的缓存跨区域泄漏。
> 这类逻辑光靠肉眼看代码是看不出来的。
