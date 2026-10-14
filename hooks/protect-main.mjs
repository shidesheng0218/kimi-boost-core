import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

// ---- kimi-boost guard runtime(GENERATED:改 src/hooks-runtime/ 后运行 npm run build:hooks) ----
const GUARD_NAME = "protect-main";
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

// 受保护的主干分支
const PROTECTED = new Set(["main", "master"]);
// `git push` 里带独立取值的选项(下一个 token 是值,不是 refspec)
const PUSH_VALUE_FLAGS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
// 命令前缀包装器:`sudo git push`、`FOO=1 git push`
const WRAPPERS = new Set(["command", "env", "sudo", "time", "nohup", "exec"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

/** 把命令行切成「段」(以 ; && || | & 换行 () 反引号分隔),每段是 shell 风格的 token 数组 */
function tokenize(cmd) {
  const segs = [];
  let cur = [];
  let tok = "";
  let has = false;
  let quote = null;
  const endTok = () => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
  };
  const endSeg = () => {
    endTok();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      // 双引号内:只有 \" 和 \\ 是转义,其余 \ 保留原样(Windows 路径如 C:\Users\...)
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) tok += cmd[++i];
      else tok += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      tok += cmd[++i];
      has = true;
    } else if (c === " " || c === "\t") {
      endTok();
    } else if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "`") {
      endSeg();
    } else if (c === "&" || c === "|") {
      endSeg();
      if (cmd[i + 1] === c) i++;
    } else {
      tok += c;
      has = true;
    }
  }
  endSeg();
  return segs;
}

/** 去掉重定向 token(`> f`、`2>&1`),它们不是 git 的参数 */
function stripRedirects(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d*[<>]+$/.test(t)) {
      i++; // 连同下一个文件名 token 一起丢
      continue;
    }
    if (/^\d*[<>]/.test(t)) continue;
    out.push(t);
  }
  return out;
}

/** 在一段 token 里找 git push;返回 [{ pre, args }],pre 是要回放给 git 的仓库定位选项(-C / --git-dir / --work-tree) */
function findPushes(cmd, depth = 0) {
  const found = [];
  if (depth > 3) return found;
  for (const rawSeg of tokenize(cmd)) {
    let toks = stripRedirects(rawSeg);
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || WRAPPERS.has(toks[i]))) {
      i++;
      while (i < toks.length && toks[i].startsWith("-") && WRAPPERS.has(toks[i - 1])) i++; // sudo -u / env -i 之类
    }
    toks = toks.slice(i);
    if (!toks.length) continue;
    const exe = basename(toks[0]).replace(/\.exe$/i, "");

    if (SHELLS.has(exe)) {
      const ci = toks.findIndex((t, idx) => idx > 0 && /^-[A-Za-z]*c$/.test(t));
      if (ci > 0 && toks[ci + 1]) found.push(...findPushes(toks[ci + 1], depth + 1));
      continue;
    }
    if (exe === "eval") {
      found.push(...findPushes(toks.slice(1).join(" "), depth + 1));
      continue;
    }
    if (exe !== "git") continue;

    // git 的全局选项,直到子命令
    const pre = [];
    let j = 1;
    while (j < toks.length && toks[j].startsWith("-")) {
      const t = toks[j];
      if (t === "-C" || t === "--git-dir" || t === "--work-tree") {
        pre.push(t, toks[j + 1] ?? ".");
        j += 2;
      } else if (t === "-c" || t === "--namespace" || t === "--super-prefix" || t === "--config-env") {
        j += 2;
      } else {
        if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) pre.push(t);
        j += 1;
      }
    }
    if (toks[j] === "push") found.push({ pre, args: toks.slice(j + 1) });
  }
  return found;
}

function gitOut(cwd, pre, args) {
  try {
    return execFileSync("git", [...pre, ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return ""; // 不是 git 仓库 / git 缺失:fail-open
  }
}

/** 判断一次 push 是否会更新受保护分支;是则返回原因,否则返回 undefined */
function violation(push, cwd) {
  const { pre, args } = push;
  const flags = new Set();
  const positional = [];
  let repoFlag = false;
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    if (t === "--") {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith("-") && t.length > 1) {
      flags.add(t.split("=")[0]);
      if (PUSH_VALUE_FLAGS.has(t)) {
        if (t === "--repo") repoFlag = true;
        k++;
      } else if (t.startsWith("--repo=")) {
        repoFlag = true;
      }
      continue;
    }
    positional.push(t);
  }

  if (flags.has("--mirror")) return "push --mirror overwrites every remote ref, including main";
  if (flags.has("--all")) {
    const hasProtected = [...PROTECTED].some((b) => gitOut(cwd, pre, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]));
    if (hasProtected) return "push --all would also push main";
  }

  const refspecs = repoFlag ? positional : positional.slice(1); // 第一个位置参数是 remote
  let current;
  const currentBranch = () => (current ??= gitOut(cwd, pre, ["branch", "--show-current"]));

  if (refspecs.length === 0) {
    const b = currentBranch();
    return PROTECTED.has(b) ? `the current branch is ${b}` : undefined;
  }
  for (const raw of refspecs) {
    const spec = raw.replace(/^\+/, "");
    const colon = spec.indexOf(":");
    let dst = colon >= 0 ? spec.slice(colon + 1) : spec;
    if (colon < 0 && dst === "HEAD") dst = currentBranch(); // `git push origin HEAD` 推到当前分支同名
    dst = dst.replace(/^refs\/heads\//, "");
    if (PROTECTED.has(dst)) return `the refspec '${raw}' targets ${dst}`;
  }
  return undefined;
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    if (guardDisabled(GUARD_NAME)) process.exit(0);
    const payload = JSON.parse(input);
    const command = String(payload.tool_input?.command ?? "");
    if (!/\bpush\b/i.test(command)) process.exit(0);
    const cwd = typeof payload.cwd === "string" && existsSync(payload.cwd) ? payload.cwd : process.cwd();

    for (const push of findPushes(command)) {
      const why = violation(push, cwd);
      if (why) {
        blockOrWarn(GUARD_NAME, "Bash", command, `Blocked: direct push to main/master (${why}). Use a feature branch and open a PR instead.`);
      }
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
