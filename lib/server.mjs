// Run the app for the length of a capture: build if asked (or if there is no
// build), start it, wait until it answers, and always stop it afterwards.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function withServer(cfg, opts, log, fn) {
  if (!cfg.app?.start) {
    if (!(await isUp(cfg.origin))) {
      throw new Error(`Nothing is answering at ${cfg.origin}. Start the app, or give the config an app.start command.`);
    }
    log(`using the server already running at ${cfg.origin}`);
    return fn();
  }

  // Capturing whatever happens to hold the port is worse than failing.
  if (await isUp(cfg.origin)) {
    throw new Error(`${cfg.origin} is already answering. Stop that server or change app.port in the config.`);
  }

  const marker = path.join(cfg.app.cwd, cfg.app.buildMarker ?? ".next/BUILD_ID");
  if (cfg.app.build && (opts.build || !fs.existsSync(marker))) {
    await run(cfg.app.build, cfg.app.cwd, log, "build");
  }

  fs.mkdirSync(cfg.captureDir, { recursive: true });
  const logPath = path.join(cfg.captureDir, "server.log");
  const logFile = fs.createWriteStream(logPath);
  const port = new URL(cfg.origin).port || "80";
  const cmd = cfg.app.start.replaceAll("{port}", port);
  log(`start: ${cmd}  (cwd ${path.relative(process.cwd(), cfg.app.cwd) || "."})`);
  const child = spawn(cmd, {
    cwd: cfg.app.cwd,
    shell: true,
    detached: true,
    env: { ...process.env, PORT: port, ...(cfg.app.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  let exitCode = null;
  child.on("exit", (code) => (exitCode = code ?? -1));

  try {
    const t0 = Date.now();
    while (!(await isUp(cfg.origin))) {
      if (exitCode !== null) throw new Error(`The app exited (code ${exitCode}) before answering. See ${logPath}`);
      if (Date.now() - t0 > (cfg.app.startTimeoutMs ?? 90_000)) throw new Error(`Timed out waiting for ${cfg.origin}. See ${logPath}`);
      await new Promise((r) => setTimeout(r, 400));
    }
    log(`server up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return await fn();
  } finally {
    stop(child);
    logFile.end();
  }
}

// `next start` runs under a shell and a node child: stop the whole tree. POSIX
// has process groups (the child was spawned detached); Windows has taskkill.
function stop(child) {
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

async function isUp(origin) {
  try {
    await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, cwd, log, label) {
  log(`${label}: ${cmd}`);
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, { cwd, shell: true, stdio: "inherit" });
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
  });
}
