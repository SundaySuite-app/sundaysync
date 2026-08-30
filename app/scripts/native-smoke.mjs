/**
 * Native smoke runner — launch the BUILT app and prove it renders. D-093.
 *
 * Chromium is not the runtime. Everything this repo verified about the frontend ran in
 * headless Chromium with the Tauri IPC mocked; the app a user installs runs in WKWebView
 * (macOS) or WebView2 (Windows). SundayEdit shipped a renderer 42× slower in real WKWebView
 * because the UA carries no `Safari` token — invisible from Chromium by construction. This
 * script closes that gap for SundaySync.
 *
 * What it does:
 *   1. launches the real binary with `SUNDAYSYNC_SMOKE=1`,
 *   2. waits for the app itself to write its readiness JSON (`smoke.rs`) — no screen
 *      scraping, no WebDriver, no window-title polling,
 *   3. grabs a best-effort screenshot while the window is still held open,
 *   4. waits for the process to exit,
 *   5. asserts the report: the app mounted, the root has a real laid-out box, the stylesheet
 *      applied, NOTHING threw during boot, and the user agent is the engine this platform is
 *      supposed to be running.
 *
 * Any of those failing fails the job, loudly, with the app's own stdout/stderr printed.
 *
 * Usage: node scripts/native-smoke.mjs --binary <path> --out <dir> [--hold-ms N] [--timeout-ms N]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Which engine each platform must be running, expressed as claims about the UA string.
 *
 * The `forbid` list is the half that would have caught the SundayEdit class of bug: a macOS
 * run whose UA mentions Chrome is not WKWebView, which means the smoke test was measuring
 * the wrong engine and every conclusion drawn from it is void.
 */
export const ENGINES = {
  darwin: {
    name: "WKWebView",
    require: [/AppleWebKit\//],
    forbid: [/Chrome\//, /Chromium/],
  },
  win32: {
    name: "WebView2",
    require: [/Edg\//, /Chrome\//],
    forbid: [],
  },
  linux: {
    name: "WebKitGTK",
    require: [/AppleWebKit\//],
    forbid: [/Chrome\//],
  },
};

/** A background that is absent or fully transparent means the stylesheet never applied. */
const TRANSPARENT = new Set(["", "transparent", "rgba(0, 0, 0, 0)", "(unavailable)"]);

/** Below this the document is a shell, not the app. */
export const MIN_ELEMENT_COUNT = 20;

/**
 * `lib.rs`'s startup message when the bundled ffmpeg cannot be found next to the executable.
 *
 * Worth gating on here because this is the first check that runs the app AS BUNDLED: every
 * other test resolves the sidecar from a source tree, so D-031's «ffmpeg travels inside the
 * app» claim has never been exercised on the artefact a user actually gets.
 */
const SIDECAR_FAILURE = "ffmpeg could not be resolved at startup";

/**
 * The whole verdict, as a pure function — so the rules are unit-tested rather than only
 * exercised on a runner where a mistake reads as a green job.
 *
 * @returns {{ok: boolean, failures: string[], notes: string[]}}
 */
export function validateSmoke(envelope, platform, exitCode, output = "") {
  const failures = [];
  const notes = [];

  if (String(output).includes(SIDECAR_FAILURE)) {
    failures.push(
      "the bundled app could not resolve its own ffmpeg sidecar at startup (D-031) — see the app output below",
    );
  }

  if (!envelope || typeof envelope !== "object") {
    failures.push("no smoke report was produced at all");
    return { ok: false, failures, notes };
  }

  if (envelope.smoke === "timeout") {
    failures.push(
      `the webview never reported ready — the process started but did not render (${envelope.detail ?? "no detail"})`,
    );
  } else if (envelope.smoke !== "ready") {
    failures.push(`unexpected report kind: ${JSON.stringify(envelope.smoke)}`);
  }

  if (exitCode !== 0) failures.push(`the app exited ${exitCode}, expected 0`);

  const fe = envelope.frontend;
  if (!fe) {
    failures.push("the report carries no frontend section — the webview never spoke");
    return { ok: failures.length === 0, failures, notes };
  }

  if (!fe.mounted) failures.push("React never mounted anything under #root");
  if (!(fe.rootWidth > 0) || !(fe.rootHeight > 0)) {
    failures.push(`#root laid out at ${fe.rootWidth}×${fe.rootHeight} — mounted but not rendered`);
  }
  if (!(fe.elementCount >= MIN_ELEMENT_COUNT)) {
    failures.push(
      `only ${fe.elementCount} elements in the document (expected at least ${MIN_ELEMENT_COUNT}) — the app did not build its tree`,
    );
  }
  if (TRANSPARENT.has(String(fe.bodyBackground).trim())) {
    failures.push(
      `<body> background is ${JSON.stringify(fe.bodyBackground)} — the bundled stylesheet never applied`,
    );
  }
  if (Array.isArray(fe.bootErrors) && fe.bootErrors.length > 0) {
    for (const err of fe.bootErrors) failures.push(`JS error during boot: ${err}`);
  }

  const engine = ENGINES[platform];
  const ua = String(fe.userAgent ?? "");
  if (!engine) {
    notes.push(`no engine expectation for platform ${platform}; user agent not checked`);
  } else if (!ua) {
    failures.push("the report carries no user agent");
  } else {
    for (const re of engine.require) {
      if (!re.test(ua)) {
        failures.push(`user agent does not look like ${engine.name} (missing ${re}): ${ua}`);
      }
    }
    for (const re of engine.forbid) {
      if (re.test(ua)) {
        failures.push(
          `user agent matches ${re}, so this is NOT ${engine.name} — the smoke test ran against the wrong engine: ${ua}`,
        );
      }
    }
    if (failures.length === 0) notes.push(`engine confirmed: ${engine.name}`);
  }

  return { ok: failures.length === 0, failures, notes };
}

// ── runner ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { holdMs: 4000, timeoutMs: 120000 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--binary") (out.binary = value), (i += 1);
    else if (flag === "--out") (out.out = value), (i += 1);
    else if (flag === "--hold-ms") (out.holdMs = Number(value)), (i += 1);
    else if (flag === "--timeout-ms") (out.timeoutMs = Number(value)), (i += 1);
  }
  return out;
}

/** Where tauri leaves the thing we want to launch, per platform. */
export function defaultBinary(platform, targetDir) {
  if (platform === "win32") {
    // The NSIS installer ships this exact file; there is nothing extra to install first,
    // and running the installer would want UAC and several minutes.
    return path.join(targetDir, "sundaysync-app.exe");
  }
  if (platform === "darwin") {
    // The bundle, not the bare binary: the .app is what a user gets, and it is the bundle
    // that carries Info.plist and the bundle identifier the webview inherits.
    //
    // The executable is NOT named after productName — the sidecars (ffmpeg, ffprobe) live in
    // the same directory, so "take the first entry" picks ffmpeg. Info.plist is the only
    // authority on which of the three files macOS would launch.
    const contents = path.join(targetDir, "bundle", "macos", "SundaySync.app", "Contents");
    const macos = path.join(contents, "MacOS");
    const plist = path.join(contents, "Info.plist");
    if (fs.existsSync(plist)) {
      const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(
        fs.readFileSync(plist, "utf8"),
      );
      if (m) return path.join(macos, m[1]);
    }
    return path.join(macos, "sundaysync-app");
  }
  return path.join(targetDir, "sundaysync-app");
}

function screenshot(platform, file) {
  try {
    if (platform === "darwin") {
      const r = spawnSync("screencapture", ["-x", file], { encoding: "utf8", timeout: 30000 });
      return r.status === 0;
    }
    if (platform === "win32") {
      const ps = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;",
        "$g=[System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);",
        `$bmp.Save('${file.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png);`,
      ].join(" ");
      const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], {
        encoding: "utf8",
        timeout: 60000,
      });
      return r.status === 0;
    }
  } catch {
    /* best effort only — the gate is the report, never the picture */
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platform = process.platform;
  // fileURLToPath, not `new URL(...).pathname`: the latter is percent-encoded, and this
  // repo's own checkout lives under a path with a space in it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const targetDir = path.resolve(here, "..", "src-tauri", "target", "debug");
  const binary = args.binary ? path.resolve(args.binary) : defaultBinary(platform, targetDir);
  const outDir = path.resolve(args.out ?? path.join(here, "..", "..", "native-smoke"));
  fs.mkdirSync(outDir, { recursive: true });

  const reportFile = path.join(outDir, "smoke.json");
  const logFile = path.join(outDir, "app-output.log");
  const shotFile = path.join(outDir, "screen.png");
  for (const f of [reportFile, logFile, shotFile]) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  console.log(`native-smoke: platform=${platform}`);
  console.log(`native-smoke: launching ${binary}`);
  if (!fs.existsSync(binary)) {
    console.error(`native-smoke: FAIL — no binary at ${binary}. Did the build step run?`);
    process.exit(1);
  }

  const child = spawn(binary, [], {
    env: {
      ...process.env,
      SUNDAYSYNC_SMOKE: "1",
      SUNDAYSYNC_SMOKE_OUT: reportFile,
      SUNDAYSYNC_SMOKE_HOLD_MS: String(args.holdMs),
      SUNDAYSYNC_SMOKE_TIMEOUT_MS: String(args.timeoutMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const capture = (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  let exitCode = null;
  let exitSignal = null;
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
    child.on("error", (err) => {
      output += `\nspawn error: ${err.message}\n`;
      exitCode = -1;
      resolve();
    });
  });

  // Wait for the app's own readiness file, or for it to die trying.
  const deadline = Date.now() + args.timeoutMs + 30000;
  let shot = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(reportFile)) {
      // The window is still up (the shell holds it open for `--hold-ms`); this is the only
      // moment there is anything to photograph.
      shot = screenshot(platform, shotFile);
      break;
    }
    if (exitCode !== null) break;
    await sleep(250);
  }

  // Give the held window its exit; then stop waiting.
  const hardStop = setTimeout(() => {
    console.error("native-smoke: the app did not exit; killing it");
    child.kill("SIGKILL");
  }, args.timeoutMs + 60000);
  await exited;
  clearTimeout(hardStop);

  fs.writeFileSync(logFile, output);

  let envelope = null;
  if (fs.existsSync(reportFile)) {
    try {
      envelope = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    } catch (e) {
      console.error(`native-smoke: the report file is not JSON: ${e.message}`);
    }
  }

  console.log("─".repeat(72));
  console.log(`native-smoke: exit code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ""}`);
  if (envelope) console.log(`native-smoke: report ${JSON.stringify(envelope, null, 2)}`);
  if (envelope?.frontend?.userAgent) {
    console.log(`native-smoke: USER AGENT → ${envelope.frontend.userAgent}`);
    console.log(`native-smoke: webview version → ${envelope.webviewVersion}`);
  }
  console.log(`native-smoke: screenshot ${shot ? `saved to ${shotFile}` : "not available"}`);

  const verdict = validateSmoke(envelope, platform, exitCode, output);
  for (const note of verdict.notes) console.log(`native-smoke: ${note}`);
  if (!verdict.ok) {
    console.error("native-smoke: FAIL");
    for (const f of verdict.failures) console.error(`  ✗ ${f}`);
    console.error("native-smoke: the app's own output follows");
    console.error(output || "(the app printed nothing at all)");
    process.exit(1);
  }
  console.log("native-smoke: PASS — the built app launched and rendered.");
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`native-smoke: unexpected failure — ${e.stack ?? e}`);
    process.exit(1);
  });
}
