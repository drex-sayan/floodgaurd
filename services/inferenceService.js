// Persistent Python inference bridge. One long-lived child process loads all
// ML artifacts once and handles newline-delimited JSON requests.
// This replaces per-request Python process creation for M3/M4/M5.
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");

const python = process.env.M3_PYTHON || process.env.M4_PYTHON || process.env.M5_PYTHON || "python";
const script = path.join(__dirname, "..", "ml", "inference_service.py");

let child = null;
let rl = null;
let nextId = 1;
const pending = new Map();
let startPromise = null;

function rejectAll(err) {
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function start() {
  if (process.env.VERCEL) {
    console.warn("Python ML service skipped on Vercel. Mock predictions will be used.");
    return Promise.resolve();
  }
  if (child && !child.killed) return Promise.resolve();
  if (startPromise) return startPromise;
  startPromise = new Promise((resolve, reject) => {
    child = spawn(python, [script], {
      cwd: path.join(__dirname, "..", "ml"),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    rl = readline.createInterface({ input: child.stdout });
    rl.on("line", line => {
      try {
        const msg = JSON.parse(line);
        const item = pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id);
        if (msg.ok) item.resolve(msg.result);
        else item.reject(new Error(msg.error || "Inference service failed."));
      } catch (err) {
        console.error("Invalid inference-service response:", err.message);
      }
    });
    child.stderr.on("data", data => console.error("[ML service]", String(data).trim()));
    child.on("error", err => { rejectAll(err); if (startPromise) { startPromise = null; } });
    child.on("exit", (code, signal) => {
      const err = new Error(`Inference service stopped (code=${code}, signal=${signal}).`);
      rejectAll(err); child = null; rl = null; startPromise = null;
    });
    const timer = setTimeout(() => reject(new Error("Inference service startup timed out.")), 15000);
    const onReady = line => {
      try {
        const msg = JSON.parse(line);
        if (msg.ready) {
          clearTimeout(timer);
          rl.off("line", onReady);
          resolve();
        }
      } catch {}
    };
    rl.on("line", onReady);
  }).finally(() => { startPromise = null; });
  return startPromise;
}

async function predict(model, payload) {
  await start();
  return new Promise((resolve, reject) => {
    if (process.env.VERCEL) {
      if (model === "versions") return resolve({ "m3": "mock", "m4": "mock", "m5": "mock" });
      if (model === "m4") return resolve({ 
        landslide_probability: 0.15, 
        risk_level: "Green", 
        risk_color: "#2ecc71",
        model_version: "mock_m4",
        data_is_synthetic: true
      });
      if (model === "m5") return resolve({
        forecast_1h: 0.55,
        forecast_3h: 0.60,
        forecast_6h: 0.65,
        model_version: "mock_m5",
        data_is_synthetic: true
      });
      // Default to M3
      return resolve({
        flood_probability: 0.45,
        risk_level: "Yellow",
        risk_color: "#f1c40f",
        confidence: 0.9,
        model_version: "mock_m3",
        data_is_synthetic: true
      });
    }

    const id = nextId++;
    pending.set(id, { resolve, reject });
    try {
      child.stdin.write(JSON.stringify({ id, model, data: payload }) + "\n");
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  });
}

async function getVersions() {
  await start();
  return predict("versions", {});
}

async function stop() {
  if (!child) return;
  child.stdin.end();
  await new Promise(resolve => {
    const timer = setTimeout(() => { if (child) child.kill(); resolve(); }, 2000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  child = null;
  rl = null;
}

module.exports = { start, predict, getVersions, stop };
