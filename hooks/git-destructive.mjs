import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "git-destructive";
const HOME = process.env.KIMI_BOOST_HOME ?? join(homedir(), ".kimi-boost");
const GUARDS_FILE = join(HOME, "guards.json");
const GUARD_LOG = join(HOME, "guard-log.jsonl");

function guardDisabled(name) {
  try {
    if (!existsSync(GUARDS_FILE)) return false;
    const cfg = JSON.parse(readFileSync(GUARDS_FILE, "utf8"));
    return Array.isArray(cfg.disabled) && cfg.disabled.includes(name);
  } catch {
    return false;
  }
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
      logBlock(GUARD_NAME, "Bash", command);
      console.error(
        `[kimi-boost] Blocked: destructive git op (${command.slice(0, 60)}) 会丢弃未提交的工作。` +
          "如确需丢弃,请先 git stash 或确认改动已提交。",
      );
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
