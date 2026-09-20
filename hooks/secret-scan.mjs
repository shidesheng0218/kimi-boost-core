import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "secret-scan";
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

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    // Write 工具用 tool_input.content,Edit 用 tool_input.new_string;都取不到则放行
    const ti = payload.tool_input ?? {};
    const content = String(ti.content ?? ti.new_string ?? "");
    if (!content) process.exit(0);

    const patterns = [
      { name: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
      { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
      { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
      { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
      {
        name: "hardcoded credential",
        re: /\b(?:api[_-]?key|api[_-]?secret|client[_-]?secret|secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*["'][A-Za-z0-9/_+=.-]{16,}["']/i,
      },
    ];
    const hit = patterns.find((p) => p.re.test(content));
    if (hit) {
      // 日志只记命中的模式名,绝不记录密钥内容本身
      blockOrWarn(
        GUARD_NAME,
        "Write/Edit",
        `pattern:${hit.name}`,
        `Blocked: content looks like a hardcoded secret (${hit.name}). Move it to an env var or a secrets manager instead of writing it into a file.`,
      );
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});