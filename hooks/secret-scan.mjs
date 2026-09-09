let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
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
      console.error(
        `[kimi-boost] Blocked: content looks like a hardcoded secret (${hit.name}). ` +
          "Move it to an env var or a secrets manager instead of writing it into a file.",
      );
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
