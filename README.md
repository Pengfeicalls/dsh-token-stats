# dsh-token-stats

**Token 实时监控与统计**：主页侧栏常驻卡片，实时显示当前会话的 Token 消耗与 RMB 金额；点击展开详情卡——全部会话汇总、按模型统计、按对话统计，价格与汇率可配置持久化。

## 功能

| 能力 | 说明 |
|---|---|
| 🃏 主页常驻卡片 | 左侧栏设置上方，实时显示当前会话 Token 数 + RMB 金额，对话过程中自动刷新 |
| 📊 详情卡 | 点击卡片展开：全部会话汇总 + 按模型统计（各模型 Token/金额）+ 按对话统计（逐轮消耗） |
| 💱 金额换算 | 默认人民币（¥），汇率可配置；按模型 PriceMap 精确计价 |
| ⚡ 缓存命中率 | 输入/输出/缓存读拆分展示 |
| ⚙️ 配置持久化 | 价格表与汇率保存在本地，重启不丢 |

## 安装

```powershell
# 需要：dsh CLI（npm install -g @deepseek-ai/dsh）
dsh plugin --profile web add github:Pengfeicalls/dsh-token-stats#v1.0.1
# 重启 Harness 生效
```

## 使用

1. 装好后主页左侧栏设置上方出现 Token 卡片（无数据时显示占位，对话后自动更新）；
2. 点击卡片右上角展开详情卡，查看按模型 / 按对话的消耗清单；
3. 需要调价格/汇率时，在设置页 Token 统计里修改并保存（即时生效）。

## 技术

- host 侧会话用量聚合 + 同源 HTTP 路由（POST `/dsh-token-stats/snapshot` / `/list` / `/save-config`）
- 配置存 `~/.dsh/dsh-token-stats/`（PriceMap + 汇率，默认 DeepSeek 官方定价、汇率 7.2）
- 客户端 `sidebar.footer.action` 插槽挂载卡片，主题自适应深浅色

MIT License
