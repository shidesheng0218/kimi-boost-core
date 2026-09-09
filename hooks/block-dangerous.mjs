let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
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
    const hit = blocked.find((re) => re.test(command));
    if (hit) {
      console.error(`[kimi-boost] Blocked dangerous shell command (${hit})`);
      process.exit(2);
    }
  } catch {
    /* fail-open */
  }
  process.exit(0);
});
