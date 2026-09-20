import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "protect-credentials";
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

// 高敏凭证文件(读进上下文=密钥外泄给模型)。普通 .env 不拦(开发中常用),只拦真正的凭证库。
const SENSITIVE = [
  /(^|[\\/])\.ssh([\\/]|$)/, // ~/.ssh/*
  /(^|[\\/])\.aws[\\/]credentials$/, // ~/.aws/credentials
  /(^|[\\/])\.gnupg([\\/]|$)/,
  /(^|[\\/])\.netrc$/,
  /(^|[\\/])id_rsa$/,
  /\.pem$/,
  /\.key$/,
];

// preset.json 用 --tool=read|bash 注册两条,脚本按此决定读哪个字段
const toolArg = process.argv.slice(2).find((a) => a.startsWith("--tool="));
const TOOL = toolArg ? toolArg.slice("--tool=".length).toLowerCase() : "";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const ti = payload.tool_input ?? {};
    // Read 工具看 file_path;Bash 看 command(里面可能 cat 敏感文件)
    const target = TOOL === "read" ? String(ti.file_path ?? "") : String(ti.command ?? "");
    if (!target) process.exit(0);

    const hit = SENSITIVE.find((re) => re.test(target));
    if (hit) {
      blockOrWarn(
        GUARD_NAME,
        TOOL || "read",
        target,
        `Blocked: reading sensitive credentials (${target}). 凭证绝不能进入 agent 上下文;需要时让 agent 用环境变量名引用,而不是读内容。`,
      );
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});