# 谈判防坑助手

一个可安装到手机的 PWA：像聊天一样把谈判截图发到输入框，先在浏览器内 OCR 识别文字，再通过服务端代理调用 DeepSeek，输出风险提示和回应参考。

## 本地运行

```powershell
npm.cmd install
Copy-Item .env.example .env
```

把 `.env` 里的 `DEEPSEEK_API_KEY` 换成你的 DeepSeek API Key，然后启动：

```powershell
npm.cmd run dev
```

打开 `http://127.0.0.1:5173/`。

## 安装到手机

1. 让电脑和手机在同一局域网。
2. 启动服务后，用手机访问电脑的局域网地址，例如 `http://你的电脑IP:5173/`。
3. 在 Chrome/Edge/Safari 里选择“添加到主屏幕”。

## 设计说明

DeepSeek 的 `/chat/completions` 对话接口处理文本最稳妥，所以应用架构是：

聊天框发送截图 -> 浏览器 OCR -> 服务端 DeepSeek 代理 -> 提示与回应参考。

API Key 只在服务端读取，不会打包进前端。
