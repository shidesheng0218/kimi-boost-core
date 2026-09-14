<div align="center">

# 核心护栏（core）

**AI 编程助手的"安全带"：拦直推主干、拦危险命令、拦密钥写入、拦凭证读取。任何项目都该装的最小保险。**

[![auto-mirrored](https://img.shields.io/badge/auto--mirrored%20from-kimi--boost-7c3aed?style=flat-square)](https://github.com/shidesheng0218/kimi-boost)
[![plugin compat](https://img.shields.io/github/actions/workflow/status/shidesheng0218/kimi-boost/verify.yml?style=flat-square&label=%E6%8F%92%E4%BB%B6%E5%85%BC%E5%AE%B9)](https://github.com/shidesheng0218/kimi-boost/actions/workflows/verify.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/shidesheng0218/kimi-boost/blob/main/LICENSE)

</div>

---

## 安装

**Kimi Code CLI**（TUI 内，无需安装任何工具）：

```
/plugins install https://github.com/shidesheng0218/kimi-boost-core
```

装完运行 `/reload` 或开新会话生效。

**或用安装器**（支持 Kimi Code / Claude Code / Codex 三端，含更新、体检与卸载）：

```bash
npx kimi-boost install core
```

## 五个守卫

| 守卫 | 拦截什么 |
|---|---|
| `protect-main` | 直推 `main`/`master` 分支 |
| `block-dangerous` | 危险 shell 命令：`rm -rf /`、`mkfs`、`dd` 写盘、`curl \| sh` |
| `git-destructive` | 丢弃工作区的 git 操作：`reset --hard`、`clean -f`、`checkout -- .` |
| `secret-scan` | 把硬编码密钥（AWS key、私钥、GitHub token…）写进文件 |
| `protect-credentials` | 把 `~/.ssh`、`~/.aws/credentials`、`*.pem` 等凭证读进上下文 |

全部 **fail-open**：守卫自身出错时放行，绝不阻塞 agent 正常工作。

## 看得见的护栏

```bash
kimi-boost guard          # 每个守卫的状态 + 拦截次数
kimi-boost guard --log    # 最近的拦截明细
```

每次拦截都会记录在 `~/.kimi-boost/guard-log.jsonl`（脱敏，绝不记录密钥本身）。也可用 `kimi-boost guard --disable <名称>` 临时关掉某个守卫、`--add-pattern <正则>` 加自定义拦截模式——不重装即生效。

## 与技术栈预设的关系

装了某个技术栈预设（如 `vue3`、`go`）会顺带带上其中一部分守卫；`core` 是**与技术栈无关的最小集合**，适合在任何项目、任何语言下安装。

## 说明

本仓库是 [kimi-boost](https://github.com/shidesheng0218/kimi-boost) monorepo 的**只读镜像**，由 CI 从 `presets/core/` 自动同步，请勿直接提 PR；贡献请到主仓库。MIT License。