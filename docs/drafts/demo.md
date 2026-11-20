该项目计划做一个桌面AI翻译App，初步计划功能如下:

- 兼容主流模型API协议：`Openai Respones/Chat Completion`、`Anthropic Messages`, `Gemini`
- 多窗口应用：
  - 主窗口: 管理模型提供商，按提供商接入模型，提供商可能同时支持多种API协议，例如 Deepseek/Openrouter 等
  - 翻译全局弹窗：快捷翻译窗口，快捷键触发，通过读取鼠标划词/或剪贴板内容进行自动翻译
- 需要高度自定义系统功能，例如鼠标划词检测等，OCR 屏幕截图，`Ctrl + Double C` 全局监听等
- 翻译功能：
  - 文本翻译
  - 文本转语音
  - OCR 翻译
  - 词典
  - 生词本(可外接Anki/欧陆生词本等)

## 主窗口

- Models: 模型渠道配置页
- Presets: 翻译预设，用于实际翻译时使用的配置
  - 对于使用 AI 模型翻译时，配置使用的 AI 模型，参数，Prompt 等
  - 除了可以配置 AI 模型预设外，还可以提供传统的翻译API，如 DeepL/Google Cloud Translate API
- OCR: 配置图像文本识别服务
- TTS: 配置语音合成服务
