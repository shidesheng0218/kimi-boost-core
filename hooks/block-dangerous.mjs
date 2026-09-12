import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "block-dangerous";
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
// ---- end guard runtime ----

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const command = String(payload.tool_input?.command ?? "");
    const blocked = [
      // rm 带递归/强制参数,目标为 / 、 /* 、 * 、 . 、 ./ 、 .. 、 ../ 等危险路径
      /(^|[\s|;&])rm(\s+-[a-zA-Z]*[rRfF][a-zA-Z]*)+\s+(?:\/\*?|\*|\.\.?\/?)(\s|$)/,
      // rm -rf 路径里含未加引号的 $变量(变量为空时会误删,如 rm -rf $HOME 的悲剧)
      /(^|[\s|;&])rm(\s+-[a-zA-Z]*[rRfF][a-zA-Z]*)+\s+[^|;&]*\$\w+/,
      /(^|[\s|;&])mkfs/,
      /(^|[\s|;&])dd\s+if=.*of=\/dev\/sd/,
      /curl\s+.*\|\s*(ba)?sh/,
    ];
    // 用户自定义拦截模式(guards.json 的 customPatterns,由 kimi-boost guard add-pattern 写入)
    for (const p of guardsConfig().customPatterns ?? []) {
      try {
        blocked.push(new RegExp(p));
      } catch {
        /* 非法正则忽略 */
      }
    }
    const hit = blocked.find((re) => re.test(command));
    if (hit) {
      logBlock(GUARD_NAME, "Bash", command);
      console.error(`[kimi-boost] Blocked dangerous shell command (${hit})`);
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
