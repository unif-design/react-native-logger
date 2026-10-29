# 安全策略

## 报告安全漏洞

请**不要**在 GitHub Issues 公开报告安全漏洞 —— 公开 issue 在修复前可能被人利用。

请通过以下任一**私下**渠道报告:

- **GitHub Security Advisory**(推荐):进对应 repo → Security tab → "Report a vulnerability"
- **邮件**:382724935@qq.com(主题加 `[security]`)

报告时请尽量包含:

- 受影响的 repo + 版本范围
- 漏洞类型 + 触发场景
- 复现步骤(若已有)
- 可能的影响 + 严重性评估

## 响应时间承诺

| 阶段 | 承诺时间 |
|---|---|
| 收到报告 → 维护者确认 | 7 天内 |
| 确认 → 修复方案 / 时间线公布 | 30 天内 |
| 高危漏洞修复后 | 按 [CVE 流程](https://www.cve.org/) 申请编号(如适用)+ GitHub Security Advisory 公示 |

## 支持的版本

各 repo 默认只对**最新 major 版本**提供安全更新。具体到 npm 包(如 `@unif/react-native-design`):

| 版本 | 是否支持 |
|---|---|
| 当前 minor(0.x.y)| ✅ 完整支持 |
| 旧 major(如 0.0.x 而当前是 0.2.x)| ⚠️ 仅 critical 漏洞回 patch,非 critical 建议升级 |

## 公开披露

漏洞修复后,我们会:

- 发新 patch 版本(走 `fix:` commit + 自动发版)
- 在 GitHub Security Advisory 公开漏洞细节(CVE 编号 / 影响 / 修复版本)
- 在 CHANGELOG 标注 security-related

我们不会在修复前公开漏洞信息。
