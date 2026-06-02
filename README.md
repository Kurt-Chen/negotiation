# 谈判防坑助手

一个可安装到手机的 PWA：先在左侧和 AI 聊清谈判背景，也可以上传背景截图；再在右侧发送对方话术或聊天截图。服务端会调用 DeepSeek，并结合本地五本书知识库给出风险判断、回应参考和引用来源。

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

## 配置知识库

仓库会提交知识库脚本、书目模板和索引元数据，但不会提交 PDF、API key、本地 PDF 路径和全文索引。

在新电脑上：

```powershell
Copy-Item knowledge/books.example.json knowledge/books.local.json
```

编辑 `knowledge/books.local.json`，把每本书的 `path` 改成这台电脑上的 PDF 路径，然后生成本地索引：

```powershell
npm.cmd run knowledge:build
```

生成后的 `knowledge/index.jsonl` 会留在本机，不会进入 Git。

## 当前知识库书目

- Negotiation Genius — Deepak Malhotra; Max H. Bazerman
- Influence, New and Expanded: The Psychology of Persuasion — Robert B. Cialdini
- Secrets of Power Negotiating — Roger Dawson
- Never Split the Difference — Chris Voss; Tahl Raz
- Getting to Yes — Roger Fisher; William Ury; Bruce Patton

## 安装到手机

1. 让电脑和手机在同一局域网。
2. 启动服务后，用手机访问电脑的局域网地址，例如 `http://你的电脑IP:5173/`。
3. 在 Chrome/Edge/Safari 里选择“添加到主屏幕”。

## 架构说明

截图或文字 -> 浏览器 OCR -> 服务端 DeepSeek 代理 -> 本地书籍知识库检索 -> 带引用的谈判建议。

API Key 只在服务端 `.env` 读取，不会打包进前端。
