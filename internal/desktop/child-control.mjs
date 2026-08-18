import process from "node:process";

let requested = false;
function requestGracefulShutdown(source) {
  if (requested) return;
  requested = true;
  process.stderr.write(`[desktop] graceful shutdown requested by ${source}\n`);
  process.emit("SIGTERM");
}

process.stdin.setEncoding("utf8");
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (;;) {
    const index = pending.indexOf("\n");
    if (index < 0) break;
    const line = pending.slice(0, index).trim();
    pending = pending.slice(index + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message?.type === "shutdown") requestGracefulShutdown("parent message");
    } catch {
      process.stderr.write("[desktop] ignored invalid child-control message\n");
    }
  }
});
process.stdin.on("end", () => requestGracefulShutdown("parent pipe EOF"));
process.stdin.resume();
