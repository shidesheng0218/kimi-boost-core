import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(各守卫脚本内联同一份逻辑) ----
const GUARD_NAME = "secret-scan-post";
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