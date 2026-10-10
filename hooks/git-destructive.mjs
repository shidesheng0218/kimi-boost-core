import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(GENERATED:改 scripts/hook-runtime/guard-runtime.tpl 后运行 npm run sync:hooks) ----
const GUARD_NAME = "git-destructive";
const HOME = process.env.KIMI_BOOST_HOME ?? join(homedir(), ".kimi-boost");
const GUARDS_FILE = join(HOME, "guards.json");
const GUARD_LOG = join(HOME, "guard-log.jsonl");
const GUARD_LOG_MAX_BYTES = 256 * 1024;

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
    // 超限时轮转为 .1(rename 原子);随后单行 append,并行 hook 不会互相覆盖
    try {
      if (statSync(GUARD_LOG).size > GUARD_LOG_MAX_BYTES) renameSync(GUARD_LOG, GUARD_LOG + ".1");
    } catch {
      /* 日志文件还不存在 */
    }
    appendFileSync(GUARD_LOG, line + "\n");
  } catch {
    /* 日志失败不影响判定 */
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

// 丢弃本地未提交工作的操作(protect-main 管主干、block-force-push 管远端,这个管本地)
const DESTRUCTIVE = [
  /(^|[\s|;&])git\s+reset\s+--hard\b/, // git reset --hard(丢工作区+暂存区)
  /(^|[\s|;&])git\s+clean\s+-[a-zA-Z]*f/, // git clean -f / -fd / -fdx(删未跟踪文件)
  /(^|[\s|;&])git\s+checkout\s+(--\s+)?\.(\s|$)/, // git checkout -- . / git checkout .
  /(^|[\s|;&])git\s+restore\s+(--worktree\s+)?\.(\s|$)/, // git restore . / git restore --worktree .
];

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const command = String(payload.tool_input?.command ?? "");
    const hit = DESTRUCTIVE.find((re) => re.test(command));
    if (hit) {
      blockOrWarn(
        GUARD_NAME,
        "Bash",
        command,
        `Blocked: destructive git op (${command.slice(0, 60)}) 会丢弃未提交的工作。如确需丢弃,请先 git stash 或确认改动已提交。`,
      );
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});