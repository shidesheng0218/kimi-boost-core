import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(GENERATED:改 scripts/hook-runtime/guard-runtime.tpl 后运行 npm run sync:hooks) ----
const GUARD_NAME = "secret-scan-post";
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
// ---- end guard runtime ----

// PostToolUse 补扫:PreToolUse 只看得到 Write/Edit 的内容,经 shell 重定向
// (echo key > .env、cat > f、tee f)落盘的密钥会漏网。这里在动作完成后
// 回读刚落盘的文件补扫,发现即记录并提醒 agent 修正(动作已完成,属于告知而非阻断)。

const SECRET_PATTERNS = [
  { name: "AWS Access Key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "hardcoded credential",
    re: /\b(?:api[_-]?key|api[_-]?secret|client[_-]?secret|secret|access[_-]?token|auth[_-]?token|password|passwd)\b\s*[:=]\s*["'][A-Za-z0-9/_+=.-]{16,}["']/i,
  },
];

/** 从 Bash 命令里粗略提取重定向/tee 的目标文件(只做保守识别,漏掉优于误报) */
function bashTargets(command) {
  const targets = [];
  const re = /(?:>>?|tee\s+(?:-a\s+)?)\s*["']?([^\s"'|;&<>]+)/g;
  let m;
  while ((m = re.exec(command)) !== null) {
    const t = m[1];
    // 排除 /dev/null、纯数字 fd 重定向等
    if (t && !/^\/dev\//.test(t) && !/^\d+$/.test(t) && !t.startsWith("&")) targets.push(t);
  }
  return targets;
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const ti = payload.tool_input ?? {};

    // Write/Edit:直接看目标文件;其他工具(含 Bash)尝试从命令里提取
    const candidates = [];
    if (ti.file_path) candidates.push(String(ti.file_path));
    if (ti.command) candidates.push(...bashTargets(String(ti.command)));
    if (candidates.length === 0) process.exit(0);

    for (const file of [...new Set(candidates)]) {
      let text;
      try {
        const st = statSync(file);
        if (!st.isFile() || st.size > 1_000_000) continue;
        text = readFileSync(file, "utf8");
      } catch {
        continue; // 文件不存在/不可读:正常放行
      }
      if (text.includes("\u0000")) continue;
      const hit = SECRET_PATTERNS.find((p) => p.re.test(text));
      if (hit) {
        logBlock(GUARD_NAME, "PostToolUse", `${file} (${hit.name})`);
        console.error(
          `[kimi-boost] 补扫发现 ${file} 里含疑似密钥(${hit.name})。文件已写入——` +
            `请立即改为从环境变量读取并重写该文件;若已提交,吊销并轮换这把密钥。` +
            ` — false positive? run: kimi-boost guard --disable ${GUARD_NAME}`,
        );
        process.exit(2);
      }
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});