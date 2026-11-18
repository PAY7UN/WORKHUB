---
name: doc-to-markdown
description: 把厂家给的协议文档（PDF、Word、网页、表格、纯文本）转成 Markdown，必要时绑到某套协议上当标准文档。用于「这份协议文档转成 md」「把 PDF 变成能读的 markdown」「给这套协议配一份标准文档」这类请求。
metadata:
  id: doc.to-markdown
  category: content
  mode: request
---
# 文档转 Markdown

把一份厂家文档转成 Markdown。协议文档就该是 Markdown：能贴进编辑器，能被检索，能跟着代码走版本管理。

## 做什么

1. 拿到文档来源（本地文件路径，或 http/https 网址）；
2. 取出正文并整理成 Markdown：
   - 网页：保留标题、列表、表格这些结构；
   - Word/Excel/PPT：抽文字，表格会散成行；
   - PDF：抽文字，跨页表格可能错位；
   - CSV/TSV：转成 Markdown 表格；
   - 纯文本：按空行分段，「一、帧结构」这类行提上来当标题；
3. 给了协议 id 的，把转好的文档写进记录区里那套协议的**内置说明书**（`protocolId` 必填时才会写）。

## 输入

- `source`：文档来源（必填）。本地文件路径，或 http/https 网址。
- `title`：文档标题（选填）。留空就用文件名或网页标题。
- `protocolId`：绑到哪套协议（选填）。填了才写盘，写的是记录区里那篇内置说明书。

## 返回

- 转出来的 Markdown 正文；
- `kind`：走了哪条路（html / csv / text / markdown / docx / pdf / url）；
- `warnings`：哪里可能没转好——PDF 错位、Word 表格散了、图片没转过来，这些都要说清楚。

## 怎么用

填好 `source` 跑一次；看到 warnings 就按它提示的地方再核一遍。
要存成协议文档，就一起给 `protocolId`——写盘只对管理员开放，写进去的是记录区里那篇内置说明书的正文。

## 边界

- 扫描件 PDF 抽不出文字：这条路走不通，别硬转，让人先把 PDF 另存为 Word 或文本。
- 图片里的内容转不出来：图片不会变成文字，需要人补。
- 转换是有损的：转完的 Markdown 是一份**草稿**，字段顺序、字节位宽这类关键内容要人核。
- 不要拿它给一段已经整理好的 Markdown「再转一次」——直接用原文。
