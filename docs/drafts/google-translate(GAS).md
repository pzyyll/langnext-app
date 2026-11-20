要彻底解决免 Key、免费、稳定的谷歌翻译需求，最优雅且治本的方案是使用 **Google Apps Script（GAS）**。

---

### 为什么选择 Google Apps Script？

* **官方免 Key 接口**：Google 官方为脚本环境提供了内置的 `LanguageApp.translate()` 函数，完全不需要申请付费 API Key。
* **永远不会被 429 拦截**：代码直接运行在**谷歌自家的服务器**内部，走的是官方内部通道，IP 就是谷歌内网，绝不会触发反爬风控。
* **完全免费**：个人 Google 账号每天享有数万次的免费调用配额，足够个人翻译工具重度使用。

---

### 3 分钟部署教程

#### 第一步：创建脚本

1. 打开并登录 [Google Apps Script 控制台](https://script.google.com/)。
2. 点击左上角的 **「新项目」**（New project）。
3. 清空编辑器里的默认代码，粘贴以下代码（格式完全匹配你的要求）：

```javascript
function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  var corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  try {
    var text = "";
    var sl = "auto";
    var tl = "zh-CN";

    // 支持 POST JSON 载荷
    if (e.postData && e.postData.contents) {
      var body = JSON.parse(e.postData.contents);
      text = body.text || "";
      sl = body.source_lang || sl;
      tl = body.target_lang || tl;
    }
    // 也支持 URL 查询参数
    else if (e.parameter) {
      text = e.parameter.text || "";
      sl = e.parameter.source_lang || sl;
      tl = e.parameter.target_lang || tl;
    }

    if (!text) {
      return ContentService.createTextOutput(
        JSON.stringify({ code: 400, error: "Missing text parameter" })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    // 调用谷歌官方翻译服务
    var translatedText = LanguageApp.translate(text, sl === "auto" ? "" : sl, tl);

    return ContentService.createTextOutput(
      JSON.stringify({
        code: 200,
        data: translatedText,
      })
    ).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({
        code: 500,
        error: err.toString(),
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

```

#### 第二步：发布为 Web 应用程序

1. 点击右上角的 **「部署」**（Deploy）按钮，选择 **「新建部署」**（New deployment）。
2. 在弹窗左侧齿轮图标选择 **「Web 应用」**（Web app）。
3. 进行以下配置：
* **说明**：填写任意名称（例如 `Google Translate API`）。
* **执行身份**（Execute as）：选择 **「我」**（Me）。
* **谁可以访问**（Who has access）：务必修改为 **「任何人」**（Anyone）。


4. 点击 **「部署」**（Deploy）。
5. 复制弹窗中生成的 **Web 应用网址**（URL 格式为 `[https://script.google.com/macros/s/AKfycb.../exec](https://script.google.com/macros/s/AKfycb.../exec)`）。

---

### 测试验证

拿到这串 URL 后，回到 CMD 终端中执行测试（注意替换为你自己的完整脚本 URL）：

```cmd
curl -L -X POST "https://script.google.com/macros/s/你的脚本ID/exec" -H "Content-Type: application/json" -d "{\"text\":\"Hello world\",\"source_lang\":\"en\",\"target_lang\":\"zh-CN\"}"

```

*(注：Google 脚本的请求有一次 302 重定向，所以 curl 命令中加入了 `-L` 参数跟随跳转)*

**预期返回：**

```json
{"code":200,"data":"你好世界"}

```

这个生成的 `https://script.google.com/macros/s/.../exec` 地址即为你翻译小工具可以直接填入并长期稳定使用的免授权 API 地址。