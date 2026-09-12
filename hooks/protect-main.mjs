import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "protect-main";
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

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const command = String(payload.tool_input?.command ?? "");
    if (!/git push/i.test(command)) process.exit(0);

    let branch = "";
    try {
      branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
    } catch {
      /* not a git repo */
    }

    if (branch === "main" || branch === "master") {
      logBlock(GUARD_NAME, "Bash", command);
      console.error(
        `[kimi-boost] Blocked: direct push to ${branch}. Use a feature branch and open a PR instead.`,
      );
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
