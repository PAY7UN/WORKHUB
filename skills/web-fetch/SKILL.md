---
name: web-fetch
description: 按 URL 请求网页或接口，取回内容并抽成可读正文（HTML 抽正文、JSON 解析成结构化数据）。用于「帮我看看这个页面写了什么」「把这个接口的数据取下来」「这个 URL 返回了什么」这类问题。
metadata:
  id: web.fetch
  category: web
  mode: request
---
# 网页请求

按 URL 请求网页或接口，取回内容并整理好。

## 做什么

发一次 HTTP 请求，按响应类型分流：

- **HTML**：去掉脚本、样式、导航标签，留下标题与正文段落；
- **JSON**：解析成结构化数据；
- **其他**：按纯文本处理。

结果是「能读的内容」，不是原始字节——模型读原始 HTML 既费钱，又容易把菜单当正文。

## 输入

- `url`：要请求的地址（必填）。只支持 http/https。
- `method`：请求方法，默认 GET。
- `headers`：请求头，JSON 对象字符串，例如 `{"Authorization":"Bearer xxx"}`。
- `body`：请求体（GET 忽略）。
- `timeoutSec`：超时秒数，默认 20，上限 60。
- `maxChars`：正文最多留多少字符，默认 20000。

## 返回

- `summary`：状态码、内容形态、体积、是否截断。
- `output`：标题、来源地址、正文。
- `data`：结构化结果（url、status、contentType、kind、title、text、truncated、bytes）。

## 怎么用

1. 确认地址与请求方法；需要鉴权就带上请求头。
2. 跑一次，拿到正文。
3. 正文若是 JSON 且要算数，接着用 `data.analyze` 算——别自己心算。

## 边界

- 单次最多读 2 MB，超了会截断并在摘要里标明。
- 只放行 http/https；`file:` 之类的协议一律拒绝。
- 请求失败时给出的是人话原因（地址不合法、超时、状态码错误），据此换下一个地址，而不是原样重试。
