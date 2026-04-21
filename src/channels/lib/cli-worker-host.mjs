import { spawn } from "child_process";
function hasCliWorker() {
  return true;
}
function startCliWorker(_options) {
}
async function stopCliWorker() {
}
function runCliWorkerTask(task) {
  return new Promise((resolve, reject) => {
    const command = String(task.command ?? "").trim();
    const args = Array.isArray(task.args) ? task.args.map(String) : [];
    const timeoutMs = Math.max(1e3, Number(task.timeout ?? 12e4));
    const isWin = process.platform === "win32";
    const safeArgs = isWin ? args.map((a) => /\s/.test(a) ? `"${a}"` : a) : args;
    const child = spawn(command, safeArgs, {
      cwd: task.cwd ?? process.cwd(),
      env: { ...process.env, ...task.env ?? {} },
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGTERM");
      } catch {
      }
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new Error(`spawn ${command} failed: ${err.message}`));
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
    });
    const stdin = task.stdin;
    if (stdin != null) {
      child.stdin.write(String(stdin));
    }
    child.stdin.end();
  });
}
export {
  hasCliWorker,
  runCliWorkerTask,
  startCliWorker,
  stopCliWorker
};
