import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---- kimi-boost guard runtime(GENERATED:改 scripts/hook-runtime/guard-runtime.tpl 后运行 npm run sync:hooks) ----
const GUARD_NAME = "protect-paths";
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

// 手改 lockfile / 生成物目录:lockfile 应由包管理器生成,手改会破坏依赖可复现性
const LOCKFILES = [
  /(^|[\\/])package-lock\.json$/,
  /(^|[\\/])yarn\.lock$/,
  /(^|[\\/])pnpm-lock\.yaml$/,
  /(^|[\\/])go\.sum$/,
  /(^|[\\/])Cargo\.lock$/,
  /(^|[\\/])poetry\.lock$/,
  /(^|[\\/])Pipfile\.lock$/,
  /(^|[\\/])Gemfile\.lock$/,
  /(^|[\\/])composer\.lock$/,
  /(^|[\\/])bun\.lockb?$/,
];

const GENERATED_DIRS = [
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])\.git([\\/]|$)/, // .git 内部(含 hooks)绝不该被 agent 直接写
];

// 经 shell 改写受保护路径(重定向 / tee);用捕获组直接取出目标文件
const SHELL_REDIRECT = /(?:^|[\s|;&])(?:cat|echo|printf|perl|python3?|sed\s+-i)\b[^|;&]*?>{1,2}\s*["']?([^\s"'|;&<>]+)/;
const SHELL_TEE = /(?:^|[\s|;&])tee\s+(?:-a\s+)?["']?([^\s"'|;&<>]+)/;

const toolArg = process.argv.slice(2).find((a) => a.startsWith("--tool="));
const TOOL = toolArg ? toolArg.slice("--tool=".length).toLowerCase() : "";

function checkTarget(target) {
  const lock = LOCKFILES.find((re) => re.test(target));
  if (lock) {
    blockOrWarn(
      GUARD_NAME,
      "Write/Edit",
      target,
      `lockfile 不应手改:${target}。请用包管理器重新生成(npm install / yarn / go mod tidy / cargo update)`,
    );
  }
  const gen = GENERATED_DIRS.find((re) => re.test(target));
  if (gen) {
    blockOrWarn(GUARD_NAME, "Write/Edit", target, `生成物/内部目录不应直接写入:${target}`);
  }
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const ti = payload.tool_input ?? {};

    if (TOOL === "bash") {
      const command = String(ti.command ?? "");
      const m = command.match(SHELL_REDIRECT) ?? command.match(SHELL_TEE);
      const target = m?.[1] ?? "";
      if (target && (LOCKFILES.some((re) => re.test(target)) || GENERATED_DIRS.some((re) => re.test(target)))) {
        blockOrWarn(GUARD_NAME, "Bash", command, `经 shell 改写受保护路径:${target}`);
      }
      process.exit(0);
    }

    const target = String(ti.file_path ?? "");
    if (!target) process.exit(0);
    checkTarget(target);
  } catch {
    /* fail-open */
  }
  process.exit(0);
});