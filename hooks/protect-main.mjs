import { execFileSync } from "node:child_process";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
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
