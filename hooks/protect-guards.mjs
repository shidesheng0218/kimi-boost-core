import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "protect-guards";
const HOME = process.env.KIMI_BOOST_HOME ?? join(homedir(), ".kimi-boost");
const GUARDS_FILE = join(HOME, "guards.json");
const GUARD_LOG = join(HOME, "guard-log.jsonl");

function guardsConfig() {
  try {
    if (!existsSync(GUARDS_FILE)) return {};
    return JSON.parse(readFileSync(GUARDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function guardDisabled(name) {
  const cfg = guardsConfig();
  return Array.isArray(cfg.disabled) && cfg.disabled.includes(name);
}

function logBlock(name, tool, preview) {
  try {
    mkdirSync(HOME, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), guard: name, tool, preview: String(preview ?? "").slice(0, 40) });
    let lines = [];
    if (existsSync(GUARD_LOG)) lines = readFileSync(GUARD_LOG, "utf8").split("\n").filter(Boolean);
    lines.push(line);
    if (lines.length > 1000) lines = lines.slice(-1000);
    writeFileSync(GUARD_LOG, lines.join("\n") + "\n");
  } catch {
    /* 日志失败不影响拦截 */
  }
}

/** 统一收尾:block 模式 exit 2;warn 模式记录+提示但放行 */
function blockOrWarn(name, tool, preview, message) {
  logBlock(name, tool, preview);
  const mode = guardsConfig().modes?.[name];
  if (mode === "warn") {
    console.error(`[kimi-boost][warn] ${message} (warn 模式:已放行)`);
    process.exit(0);
  }
  console.error(`[kimi-boost] ${message} — false positive? run: kimi-boost guard --disable ${name}`);
  process.exit(2);
}
// ---- end guard runtime ----

// 自保护:agent 不该能改护栏自己的配置、或经 shell 关闭护栏。
// 阻止的是 agent 的工具调用;你本人在终端里直接跑 kimi-boost guard --disable 不受影响。
const PROTECTED_PATHS = [
  /(^|[\\/])\.kimi-boost([\\/]|$)/, // guards.json / guard-log / preset 存储 / manifest
  /(^|[\\/])\.kimi-code[\\/]config\.toml$/, // Kimi 的 hook 挂载配置
  /(^|[\\/])\.claude[\\/]settings\.json$/, // Claude 的 hook 配置
  /(^|[\\/])\.claude[\\/]commands([\\/]|$)/,
  /(^|[\\/])\.codex[\\/]config\.toml$/,
  /(^|[\\/])\.claude([\\/]|$)/, // 项目级 .claude/(hooks 就挂在这里)
  /(^|[\\/])AGENTS\.md$/,
];

// Bash 通道:直接改写上述路径、或调用 kimi-boost guard 关闭守卫
const SHELL_PATTERNS = [
  /(^|[\s|;&])(cat|echo|printf|tee|sed|perl|python3?)\b[^|;&]*>{1,2}\s*["']?[^"'\s]*\.kimi-boost/,
  /(^|[\s|;&])(cat|echo|printf|tee|sed|perl|python3?)\b[^|;&]*>{1,2}\s*["']?[^"'\s]*\.claude[\\/]settings\.json/,
  /(^|[\s|;&])rm\s+[^|;&]*\.kimi-boost/,
  /(^|[\s|;&])sed\s+-i[^|;&]*\.kimi-boost/,
  /(^|[\s|;&])kimi-boost\s+guard\s+(--disable|--warn)/,
];

const toolArg = process.argv.slice(2).find((a) => a.startsWith("--tool="));
const TOOL = toolArg ? toolArg.slice("--tool=".length).toLowerCase() : "";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const ti = payload.tool_input ?? {};

    if (TOOL === "bash") {
      const command = String(ti.command ?? "");
      const hit = SHELL_PATTERNS.find((re) => re.test(command));
      if (hit) {
        blockOrWarn(GUARD_NAME, "Bash", command, "guardrails 自保护:检测到关闭/改写护栏配置的命令");
      }
      process.exit(0);
    }

    // Write/Edit:看目标路径
    const target = String(ti.file_path ?? "");
    if (!target) process.exit(0);
    const hit = PROTECTED_PATHS.find((re) => re.test(target));
    if (hit) {
      blockOrWarn(
        GUARD_NAME,
        "Write/Edit",
        target,
        `guardrails 自保护:${target} 属于护栏/CLI 配置,不应由 agent 改写。要调整护栏请在终端里自己运行 kimi-boost guard`,
      );
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});