# 功能插件化与模块化架构调研

调研范围：LLM 请求协议、LLM 渠道及其配置页、预设类型及配置页、语音合成 / OCR / 语言检测渠道及配置页、生词本类型及配置页。
调研基线：工作区 `F:\workspace\labs\langnext`（2026-11-26），NSH 0.6 桌面端，项目处于 Demo 阶段，允许破坏性变更。

## 1. 结论

1. 五条轴里只有 **LLM 协议** 和 **LLM 渠道** 已经是插件式结构：契约 + 注册表 + 宿主页面下放配置 UI（`src/modules/ai/contracts/*`、`runtime/registry.ts`、`ui/registry.ts`、`src/app/ai-setup.ts`）。
2. 其余四条（预设引擎、TTS/OCR/检测渠道、生词本）没有注册表：类型是写死的判别联合，配置页按 `kind` 分支，存储按渠道名分字段，运行时靠 if/else。新增一项要改 6–12 个共享文件。
3. 真正的瓶颈不是缺契约，而是三件公共设施缺位：**统一注册表**、**通用渠道集合存储**、**通用设置页宿主**。这三件在 TTS / OCR / 语言检测里各写了一遍：三个设置页合计 3634 行，三个 store 合计 1896 行，彼此是复制关系。
4. 建议保留 AI 现有契约不动，补一层 `src/framework/contributions`，把其余四条轴迁到同一套「贡献（contribution）」模型；先做编译期内置贡献，不做运行时第三方插件加载。
5. 收益：新增一个 TTS/OCR/检测渠道从「改 9 个文件」降到「1 个实现文件 + 注册一行」；预计可删除 3000 行以上重复代码。代价是一次性迁移，以及设置页与弹窗测试的重写。

## 2. 现状

### 2.1 五条轴的实现矩阵

| 轴 | 契约 | 注册 | 存储 | 配置页 | 运行时分发 | 新增一项的改动面 |
| --- | --- | --- | --- | --- | --- | --- |
| LLM 协议 | `ProtocolDefinition`（`contracts/protocol.ts:97`） | `aiRegistry.registerProtocol` | 无 | 无 | 由 `resolveOperation` 选中 | 1 个实现文件 + `ai-setup.ts` 一行 |
| LLM 渠道 | `ProviderDefinition` + `ProviderPresentation` | `aiRegistry` / `providerSettingsRegistry` | `models.v2.providers` | 宿主 `ChannelEditor` 调 `ProviderSettingsHost` | `resolveOperation` | 2 个文件（definition + presentation）+ 1 行 |
| 预设引擎 | 判别联合 `PresetEngine`（`features/presets/types.ts:32`） | 无 | `presets.v1.items` + 2 组密钥键 | `editor.tsx` 内按 `kind` 的 `<If>` | `translate.ts:283-289` | 12 个共享文件 |
| TTS 渠道 | 字面量联合 `TtsChannelId`（`features/tts/synthesis.ts:4`） | 无 | `settings.tts.v3`，字段名即渠道名 | `tts-section.tsx` 按渠道分支（1202 行） | `channels.ts:49-74` | 约 9 个文件 |
| OCR 渠道 | `OcrServiceBinding` 联合（`features/ocr/settings.ts:43`） | 无 | `settings.ocr.v4` | `ocr-section.tsx`（1167 行） | `recognize.ts:273-291` | 约 5–6 个文件 |
| 语言检测 | `LanguageDetectorBinding` 联合（`settings.ts:23`） | 无 | `settings.languageDetection.v4` | `language-detection-section.tsx`（1265 行） | `detect.ts:325-330` | 约 5–6 个文件 |
| 生词本 | 单一 `WordbookAnkiTarget`（`settings.ts:18`） | 无 | `settings.wordbook.anki.v1` | `wordbook-section.tsx`（347 行，Anki 专用控件） | `session.ts:1336-1393` | 约 8 个生产文件 + 4 个测试文件 |

读数说明：行数取 `src` 下非测试文件；「新增一项的改动面」中 9 / 12 / 8 来自逐文件追踪，5–6 为按同类结构估算。

### 2.2 三个结构性根因

**根因一：渠道身份散落在四个互不相认的层。**
以 TTS 为例，`TtsChannelId` 在 6 个文件里以字符串字面量比较：`synthesis.ts:4`、`settings.ts:22`、`channels.ts:53`、`tts-section.tsx:661`、`quick-speech.ts:45`、`page.tsx:400`。存储记录甚至用渠道名做字段名（`{ googleCloud, azure }`，`settings.ts:284-305`），因此加渠道必须改 record / parse / payload / save 四处。

**根因二：配置页与设置页宿主是手写的三份。**
`ocr-section.tsx`（1167 行）、`tts-section.tsx`（1202 行）、`language-detection-section.tsx`（1265 行）结构逐一对应：渠道头像 → 可拖拽 / 键盘重排的渠道列表 → 添加对话框 → 详情壳（名称、启用开关、保存、删除）→ 凭据可读性检测 effect → 焦点恢复。此外 `page.tsx` 还硬编码了 3 个 `selectedChannel` signal、3 段面包屑、3 个添加按钮（`page.tsx:314-319`、`348-409`、`412-423`、`571-603`）。

**根因三：凭据、失败分类、优先级链各写一遍。**
存储里有 8 组互不相同的凭据键族：`models.v2.credentials.<id>`、`presets.v1.deeplKeys.<ref>`、`presets.v1.googleCloudKeys.<ref>`、`settings.ocr.credentials.<ref>`、`settings.ocr.googleCloudKeys.<ref>`、`settings.tts.credentials.<ref>`、`settings.languageDetection.googleCloud.<ref>`、`settings.wordbook.anki.credentials.<ref>`。失败码同理：`TtsFailure` 用 `Exclude` 给 Google 打补丁（`synthesis.ts:30-54`），OCR 有两个 `mapXxxFailure` 的穷举 `switch`（`recognize.ts:143-164`、`218-233`），生词本有两套 `Record<Failure, string>`（`wordbook-section.tsx:11-20`、`session.ts:92-109`）。

### 2.3 其它证据

- **分层倒置**：`modules/deepl/languages.ts:1` 与 `modules/google-cloud-translation/client.ts:2` 反向 import `features/presets/languages`。模块层不该依赖功能层，这条边是迁移预设引擎时必须一并切掉的。
- **注册表单例**：`features/models/store.ts:5-6` 直接 import `aiClient` / `aiRegistry` 两个模块级单例，`add-channel-dialog.tsx:10`、`editor/controller.ts:10`、`provider-settings.tsx:4` 等 20 余处 UI 也直连单例。后果是渠道 store 与页面无法在测试里换一套注册表，也让「注册表由 app 装配」的约定只对了一半。
- **跨功能耦合是健康的**：除上面的 `modules → features` 反向边外，功能之间几乎不互相 import，全部经 `src/app` 组合（`quick-translate.tsx` 把 store 与 client 接线）。这意味着迁移可以逐域进行，不需要一次动全局。
- **存储是明文 KV**：NSH `Storage` 是设备的字符串键值存储，上限 5 MB，不含加密（`.nsh/types/nsh/index.d.ts:475-492`）。现有凭据只是「与记录分开存」，并非加密。

## 3. 目标架构

### 3.1 分层与依赖规则

```
src/app/                组合根：注册所有内置贡献、装配 store 与页面
src/contributions/      贡献实现：provider / protocol / preset engine / capability channel / wordbook
src/framework/          契约 + 注册表 + 通用 store / 设置页宿主 / 凭据仓库 / 链式执行
src/features/           运行时与页面：只依赖 framework 契约与注册表，不 import 具体贡献
src/modules/*           API 客户端：协议实现与厂商 HTTP 客户端
src/components/ui       设计系统
```

规则（可写成 lint 或 CI 检查）：

1. `framework` 不 import `contributions`、`features`、`app`。
2. `features` 只从 `framework` 取注册表，不 import 具体贡献实现。
3. `contributions/*` 只 import `framework` 契约、`modules/*` 客户端、`components/ui`；不 import `features`。
4. 只有 `app` 可以同时 import `contributions` 与 `features`。

### 3.2 五类贡献契约

共同信封（所有轴复用）：

```ts
interface ContributionMeta {
  id: string;            // 稳定标识：openai-compatible / deepl / azure-speech / anki
  labelKey: string;      // i18n key；宿主渲染，缺失时回退到 id
  icon: ImageAsset;
  order?: number;        // 目录顺序；用户排序另存
}
```

| 轴 | 契约要点 | 与现状的关系 |
| --- | --- | --- |
| 协议 | `ProtocolDefinition`（已有）+ 新增 `requestParams` 声明 | 直接复用 |
| 渠道 | `ProviderDefinition`（已有）+ 新增 `params` 绑定 | 直接复用 |
| 预设引擎 | `{ kind, config, credential?, validate, execute, summary, Settings }` | 替代 `PresetEngine` 联合与 `translate.ts` 分支 |
| 能力渠道 | `{ capability, config, credential?, readiness, execute, failureKey, describe, Settings }`，`capability ∈ {tts, ocr, detect}` | 替代三套 store + 三个设置页 |
| 生词本 | `{ config, credential?, connect, add(entry), capabilities }` | 替代单一 Anki target |

通用配置形状：

```ts
interface ConfigSchema<C> {
  parse(raw: unknown): C | null;   // 存储真相与迁移点；不认识就返回 null（沿用现有 skipped 计数）
  defaults(): C;
}
```

关键取舍：**配置的存储真相由贡献的 `parse` 决定，不由 UI 决定**。今天的校验散在 store / validation / UI 三层（如 `editor.tsx:60-69` 的 `canSave` 与 `validation.ts` 各管一半），插件化后收敛为「契约校验 + UI 只提示」。

两类边界情况必须在契约里写清：

- **无配置渠道**：语言检测的免费 Google 不保存任何配置，加入后立即可用（`language-detection/settings.ts:23-25`、`:120-121`）。契约要允许 `config: null` 且跳过凭据步骤。
- **存量判别字段**：预设记录里的判别字段叫 `engine.kind`，其余域叫 `binding.kind`，新契约统一为贡献 `id`；迁移时做一次映射，不要同时保留两套命名。

生词本的契约草案（现状只有「一个 Anki 目标 + 两个字符串」，没有词条概念）：

```ts
interface WordEntry {
  sourceText: string; translatedText: string;
  sourceLanguage: string; targetLanguage: string;
  modelId?: string; presetId?: string; templateId?: string; createdAt: string;
}

interface WordbookContribution extends ContributionMeta {
  config: ConfigSchema<unknown>;
  connect(config: unknown): Promise<ConnectResult>;
  add(config: unknown, entry: WordEntry): Promise<AddResult>;
  capabilities: { fields: boolean; tags: boolean; audio: boolean };
  Settings: (props: WordbookSettingsProps) => JSX.Element;
}
```

`WordEntry` 是生词本插件化的前提：多个目的地要写同一份数据。Quick Translate 已经持有 `modelId`、语言对与 `presetId`（`session.ts:63-69`、`:117-120`），但目前只把 `sourceText / translatedText` 传给 Anki（`session.ts:1336-1393`），其余丢弃。

### 3.3 公共设施 A：注册表

```ts
interface ContributionRegistry {
  register<T>(axis: Axis, contribution: T): void;   // 重复 id / 空 id 立刻失败
  get<T>(axis: Axis, id: string): T;                 // 未知 id 抛 typed error
  list<T>(axis: Axis): T[];
  listByCapability(capability: CapabilityId): CapabilityChannelContribution[];
  validate(): Diagnostic[];                          // 依赖检查：渠道声明的协议必须已注册
}
```

`aiRegistry` 已有这套校验（`runtime/registry.ts:70-90`：`allowedProtocolIds` 必须全部已注册、`defaultProtocolId` 必须在白名单内），把它下沉成通用实现即可。需要补的是现在的缺口：注册表不强制「每个渠道都有配置页」，而宿主用会抛错的 `get`（`editor/provider-settings.tsx:15`），崩溃前没有兜底；`validate()` 应当把这类跨轴依赖也报成诊断。

注册顺序仍由 `app/ai-setup.ts` 唯一负责，扩成 `app/contributions-setup.ts`：协议 → 渠道 → 预设引擎 → 能力渠道 → 生词本。

配套改一处：`features` 不再直接 import 单例注册表，而是从 `framework` 取一个可注入的容器（`app` 负责注入，测试可换）。这是把 `aiRegistry` 单例下沉为通用注册表时必须同时做的，否则新注册表只是换了个名字。

跨域依赖同理，走宿主服务而不是反向 import：

```ts
interface HostServices {
  models: { resolveSaved(modelId: string, purpose: "text" | "image"): Promise<SavedModelRequest> };
  http: JsonHttpClient;
  log: Logger;
}
```

OCR 的 `ai` 渠道（`recognize.ts:5`）与语言检测的 `ai` 渠道（`detect.ts:15`）现在直接 import `features/models/store`；迁移后从 `HostServices` 取，否则 `contributions → features` 的反向边会重新出现。

### 3.4 公共设施 B：渠道集合存储 + 凭据仓库

替掉 TTS / OCR / 检测三套 store 的通用形状：

```ts
interface ChannelCollectionStore<C> {
  order(): readonly string[];                 // 用户优先级
  available(): readonly string[];             // 目录中尚未加入的
  binding(id: string): { enabled: boolean; config: C; credentialRef?: string } | null;
  add(id): Promise<Result>; remove(id): Promise<Result>;
  save(id, config, credentialChange): Promise<Result>;
  setEnabled(id, enabled): Promise<Result>; moveTo(id, index): Promise<Result>;
  readCredential(ref: string): Promise<unknown | null>;
}
```

存储形态改成与渠道无关的映射，加渠道不再改 schema：

```json
{ "version": 1, "order": ["google-cloud", "azure"],
  "channels": { "google-cloud": { "enabled": true, "config": {...}, "credentialRef": "..." } } }
```

凭据仓库：`CredentialVault`，接口 `put(scope, secret) → ref`、`read(ref)`、`delete(ref)`、`sweepOrphans(scope)`。今天的 8 组键族收敛为 `secret.<scope>.<ref>`。顺带修掉两处现存缺陷：检测的 `enabled` 映射要求包含全部 kind（`language-detection/settings.ts:254-263`），加渠道必须升版本；OCR 的 Cloud 字段却允许缺省（`ocr/settings.ts:274-284`），两者不一致，改成 `channels` 映射后都不再需要。**仍是明文 KV**，这一点必须在文档和 UI 上说清楚；要加密只能走原生钥匙串，属于独立立项。

### 3.5 公共设施 C：设置页宿主

用一个 `CapabilitySection` 取代三个手写 section：

```tsx
<CapabilitySection
  capability="tts"
  extra={<LanguagePreferencesCard />}   // 段级额外卡片，语言检测需要
/>
```

宿主负责：列表与拖拽 / 键盘重排、添加对话框、详情壳（名称、启用、保存、删除）、凭据可读性检测、面包屑与焦点恢复、离开守卫。贡献只提供 `Settings` 组件与 `describe()`，契约照抄已验证的 `ProviderSettingsProps`（`modules/ai/ui/contracts.ts:15-40`）：宿主持有值，贡献通过回调上报编辑。宿主还要容纳贡献声明的动作：TTS 的试听、生词本的「测试连接」、DeepL 的用量面板各不相同，现状各写各的。

这一条的价值最直接：三份 1100–1300 行的 section 合成一份宿主 + 三个原有详情组件，模板代码可删约 2000 行；`page.tsx` 的 3 个 `selectedChannel` signal、3 段面包屑、3 个添加按钮（`page.tsx:314-319`、`348-409`、`412-423`）也一并消失。

### 3.6 运行时：优先级链

OCR（`recognize.ts:367-406`）、语言检测（`detect.ts:308-341`）、预设模型链（`translate.ts:317-375`）是同一段逻辑的三份拷贝：按序执行 → 取消即停 → 失败分类 → 继续下一个 → 汇总首个失败。抽成：

```ts
interface ChainPolicy { retryable(failure): boolean; continueOn(failure): boolean; }
runChain(entries, (entry, ctx) => Promise<Outcome>, policy, signal)
```

失败码按 capability 归一（`tts/malformed`、`ocr/quota`…），由贡献提供 `failureKey(failure)` 映射到 i18n；不再像 `TtsFailure` 那样用 `Exclude` 在公共联合里打补丁。

### 3.7 专题：协议自定义请求参数

现状：几乎没有。唯一已有的参数化痕迹是目录请求的 `queryExtras`（`contracts/protocol.ts:14`），供协议内部分页使用（Anthropic 的 `after_id`、Gemini 的 `pageToken`），应用发现流程并不传它。`TextGenerationRequest` 只有 `modelId / system / user / temperature / maxOutputTokens / disableReasoning`（`contracts/protocol.ts:18-27`），`AiClientInput` 只有 `providerTypeId / protocolId / baseUrl / credential`（`runtime/client.ts:22-28`），请求体在协议内写死（`openai-chat/index.ts:64-87`）。

建议：由协议声明参数，渠道存值，运行时合并。

```ts
interface RequestParamSpec {
  key: string;                              // 存储键与 URL 名
  target: "body" | "header" | "query";
  type: "string" | "number" | "boolean" | "json";
  labelKey: string;
  default?: JsonValue;
  apply(payload: RequestPayload, value: JsonValue): void;   // 协议自带序列化
}
```

落地要点：

1. 存储挂在渠道 × 协议上：`channel.params[protocolId][key]`，因为同一渠道的不同协议支持的参数不同（`custom` 渠道有 4 个协议，`deepseek` 只有 3 个）。
2. 合并顺序：协议默认 → 渠道覆盖 → 单次调用覆盖（后者留给 Quick Translate 的 `disableReasoning` 一类场景）。
3. 未知键保留但不应用，避免旧版本渠道配置在协议升级后被清空。
4. 高级参数默认折叠在同一张「高级请求参数」卡片里，由宿主根据 `requestParams` 渲染，贡献不需要写 UI；协议也可提供 `ParamSettings` 覆盖个别参数的特殊控件。
5. 安全边界：参数只允许 body / header / query 三类非密钥值；密钥仍走 `credential`，禁止把凭据塞进参数。更深一层的问题在信任边界：协议模块拿到的是明文凭据和任意 `JsonHttpClient`，同源校验只约束 `resolveBaseUrl`（`runtime/client.ts:103-115`），协议自己可以请求任何 origin。一旦允许外部贡献，就必须给协议加域名白名单，并把凭据换成只能用于已声明 host 的句柄。

## 4. 取舍与反例

- **不要为抽象而抽象**：TTS 与生词本各自只有 2 / 1 个实现。判据应是「第三个实现已排期」或「重复代码超过 800 行」。按此判据，**能力渠道（3634 行设置页 + 1896 行 store 的重复）与预设引擎（12 文件改动面）必须先做**，生词本可以等它的第二个类型立项时再做。
- **schema 与组件并存**：纯描述式表单（字段 + 校验）能覆盖请求参数和简单渠道；Google 语音偏好、Anki deck 发现、DeepL 用量这类必须自定义组件。二者同时存在，别硬统一。
- **类型安全的代价**：现在的 `Record<TtsFailure, string>` 一类穷举能在编译期逼出漏改。注册表把实现变成运行时数据后，需要补「每个贡献的失败码必须被映射」的注册期校验，否则会退化。
- **不做运行时插件加载**：动态加载要求贡献不 import 宿主内部、有沙箱与能力声明，成本远高于收益。本方案只保证契约足够干净，将来要接外部插件时不用重写贡献。

## 5. 迁移路径

| 阶段 | 范围 | 删除 / 新增 | 验收 |
| --- | --- | --- | --- |
| P0 地基 | `framework/contributions`：通用注册表、`CredentialVault`、`runChain` | 新增约 600–900 行，不改行为 | 现有测试全绿；`ai-setup` 改用通用注册表 |
| P1 能力渠道 | TTS + OCR + 检测 三域迁到 `ChannelCollectionStore` + `CapabilitySection` | 删约 3000 行，新增宿主约 900 行 | 三域设置页交互（拖拽、焦点、面包屑、脏守卫）逐条对齐；`settings.test.tsx` 相应段落重写 |
| P2 预设引擎 | `PresetEngine` 联合 → 引擎贡献；`translate.ts` 分支 → `engine.execute` | 删约 400 行，新增约 250 行 | 三类预设的保存 / 校验 / 运行时行为不变；`engine_type_locked` 语义保留 |
| P3 AI 请求参数 | 协议声明 `requestParams`，渠道存储与配置页 | 新增约 400 行 | 自定义参数能到达 body / header / query；未知键不清空 |
| P4 生词本 | 词条模型 + 生词本贡献 | 视是否升级为多目的地而定 | 第二个类型立项时再做 |

每个阶段独立可发布，不需要一次性切换。P1 是最大的一块，也是收益最大的一块。

## 6. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 通用设置页宿主难对齐现有交互细节 | 回归面大（拖拽、键盘重排、a11y、焦点恢复） | 先写宿主的行为测试，再逐域切换；三份现有代码可作为对照物 |
| 破坏性存储变更丢配置 | Demo 阶段可接受，但用户会重配 | 提供一次性导入器（读旧键写新键），或在设置页显示「需要重新配置」 |
| 注册表削弱编译期完备性 | 漏改从编译错误变成运行时错误 | 注册期做完整性校验（依赖、失败码、i18n key） |
| 一个坏贡献拖垮启动 | 现在重复 ID 直接抛错，`App.tsx:30` 会把应用带进 StartupError | 注册失败只隔离该贡献并记诊断；设置页留一个「已停用的集成」视图 |
| 抽象过度 | 为 2 个实现写一套框架 | 见第 4 节的判据；生词本推迟 |
| 凭据仍是明文 | 安全预期落空 | 在文档与 UI 明示；钥匙串作为独立议题 |

## 7. 待决策

1. 插件边界：只做编译期内置贡献（推荐），还是现在就要运行时加载？
2. 生词本是否借这次升级为「多目的地 + 词条模型」？现 `DESIGN.md:21` 写的是单 Anki 目的地。
3. 存储切换要不要导入器，还是接受清空重配？
4. 凭据是否引入系统钥匙串？若引入，是本次一起做还是单独立项？
5. `modules/deepl` 等模块反向依赖 `features/presets/languages` 这条边，是否本轮一并切到 `framework/domain/languages`？

## 8. 附录：关键文件索引

| 主题 | 文件 |
| --- | --- |
| AI 契约 | `src/modules/ai/contracts/{protocol,provider,channel,model,errors}.ts` |
| AI 注册与装配 | `src/modules/ai/runtime/registry.ts`、`src/modules/ai/ui/registry.ts`、`src/app/ai-setup.ts` |
| AI 渠道配置页宿主 | `src/features/models/editor/channel-editor.tsx`、`provider-settings.tsx`、`src/modules/ai/ui/contracts.ts` |
| 预设 | `src/features/presets/{types,store,validation,draft,editor,page}.tsx`、`src/features/quick-translate/translate.ts` |
| TTS | `src/features/tts/{synthesis,channels,settings}.ts`、`src/features/settings/tts-section.tsx` |
| OCR | `src/features/ocr/{settings,recognize}.ts`、`src/features/settings/ocr-section.tsx` |
| 语言检测 | `src/features/language-detection/{settings,detect,resolve}.ts`、`src/features/settings/language-detection-section.tsx` |
| 生词本 | `src/features/wordbook/{settings,anki-client}.ts`、`src/features/settings/wordbook-section.tsx` |
| 设置页装配 | `src/features/settings/page.tsx` |
