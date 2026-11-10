---
name: agent-status
description: 查看当前身份能不能用 Agent、缺什么条件。用于「问答能不能用」「为什么问不了」这类排查。
metadata:
  id: agent.status
  category: system
  mode: request
---
# Agent 状态

查看当前身份能不能用 Agent，以及缺什么条件。

## 做什么

服务端判定：管理员看是否配了 API Key，访客还要看管理员有没有开放 Agent。「不可用」时 reason 会指出具体原因（NO_API_KEY / GUEST_DISABLED）。

## 输入

- 无参数

## 返回

可用性、原因、模型名、是否已配置 API Key、是否开放访客。

## 怎么用

填好参数、跑一次，拿到结果就结束。

## 边界

- 可以进「一句话任务」：由 agent 依据需求自动挑起并串联。
