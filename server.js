const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const upload = multer({ storage: multer.memoryStorage() });

const DATA_DIR = path.join(__dirname, "data");
const KEY_FILE = path.join(DATA_DIR, "key.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== helpers: key =====
function getKey() {
  if (!fs.existsSync(KEY_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
    return j.key || null;
  } catch {
    return null;
  }
}
function setKey(key) {
  fs.writeFileSync(KEY_FILE, JSON.stringify({ key }, null, 2), "utf8");
}
function fpHeaders(apiKey) {
  return {
    "x-freepik-api-key": apiKey,
    "Content-Type": "application/json",
  };
}

// ===== helpers: jobs map (taskId -> provider) =====
function readJobs() {
  if (!fs.existsSync(JOBS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}
function writeJobs(obj) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(obj, null, 2), "utf8");
}
function saveJob(taskId, provider) {
  const jobs = readJobs();
  jobs[taskId] = { provider, createdAt: Date.now() };
  writeJobs(jobs);
}
function getJob(taskId) {
  const jobs = readJobs();
  return jobs[taskId] || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// retry fetch (atasi UND_ERR_SOCKET / koneksi putus)
async function fetchJsonRetry(url, opts, retries = 3) {
  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 45000);

      const r = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(t);

      const text = await r.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      lastErr = e;
      await sleep(900 + i * 1100);
    }
  }
  throw lastErr;
}

function normalizeStatus(statusRaw) {
  const s = String(statusRaw || "").toUpperCase();
  if (s === "COMPLETED") return "done";
  if (s === "FAILED") return "error";
  if (s === "CREATED" || s === "IN_PROGRESS") return "processing";
  return "processing";
}

function extractGeneratedUrl(resp) {
  const arr = resp?.data?.generated;
  if (Array.isArray(arr) && arr.length > 0) return arr[0];
  return null;
}

// ===== FREEPIK ENDPOINT MAP =====
const FREEPIK_BASE = "https://api.freepik.com";

const PROVIDERS = {
  "kling-2.5-pro": {
    // Create: /kling-v2-5-pro
    createUrl: `${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-5-pro`,
    // Status: /kling-v2-5-pro/{task-id}
    statusUrl: (taskId) => `${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-5-pro/${taskId}`,
  },

  "kling-2.1-pro": {
    // Create: /kling-v2-1-pro
    createUrl: `${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-1-pro`,
    // Status: /kling-v2-1/{task-id}  (INI YANG BEDANYA)
    statusUrl: (taskId) => `${FREEPIK_BASE}/v1/ai/image-to-video/kling-v2-1/${taskId}`,
  },
};

function pickProvider(p) {
  const key = String(p || "").trim();
  if (PROVIDERS[key]) return key;
  // default: yang sudah jalan dulu
  return "kling-2.5-pro";
}

// ===== routes =====
app.get("/ping", (req, res) => res.json({ ok: true }));

app.get("/key", (req, res) => res.json({ hasKey: !!getKey() }));

app.post("/key", (req, res) => {
  const key = (req.body?.key || "").trim();
  if (!key) return res.status(400).json({ error: "API key kosong" });
  setKey(key);
  res.json({ ok: true });
});

// CREATE TASK
app.post("/generate", upload.single("image"), async (req, res) => {
  try {
    const apiKey = getKey();
    if (!apiKey) return res.status(400).json({ error: "API key belum disimpan." });

    const provider = pickProvider(req.body?.provider);
    const cfg = PROVIDERS[provider];

    const {
      prompt = "",
      negative_prompt = "",
      duration = "5",
      cfg_scale = 0.5,
      // optional (buat future)
      image_tail = "",
      webhook_url = "",
    } = req.body;

    const img = req.file;
    if (!img) return res.status(400).json({ error: "Image wajib." });

    const imageBase64 = img.buffer.toString("base64");

    // payload general: works utk 2.5 & 2.1
    const payload = {
      duration: String(duration),        // "5" / "10"
      image: imageBase64,                // base64
      prompt: String(prompt || ""),
      negative_prompt: String(negative_prompt || ""),
      cfg_scale: Number(cfg_scale),      // 0..1
    };

    // Kling 2.1 Pro support image_tail (optional)
    if (provider === "kling-2.1-pro" && image_tail && image_tail !== "null") {
      payload.image_tail = String(image_tail);
    }

    // optional webhook
    if (webhook_url && String(webhook_url).trim()) {
      payload.webhook_url = String(webhook_url).trim();
    }

    const r = await fetchJsonRetry(cfg.createUrl, {
      method: "POST",
      headers: fpHeaders(apiKey),
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      return res.status(r.status).json({
        error: "Create task gagal",
        provider,
        detail: r.data,
      });
    }

    const taskId = r.data?.data?.task_id;
    if (!taskId) {
      return res.status(500).json({ error: "task_id tidak ditemukan", provider, detail: r.data });
    }

    // simpan mapping taskId -> provider
    saveJob(taskId, provider);

    res.json({ jobId: taskId, provider });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error generate", detail: String(e?.message || e) });
  }
});

// STATUS (GET by task-id)
app.get("/status/:jobId", async (req, res) => {
  try {
    const apiKey = getKey();
    if (!apiKey) return res.status(400).json({ status: "error", error: "API key belum disimpan." });

    const taskId = req.params.jobId;

    // ambil provider dari storage (kalau ga ada, default)
    const meta = getJob(taskId);
    const provider = meta?.provider ? pickProvider(meta.provider) : "kling-2.5-pro";
    const cfg = PROVIDERS[provider];

    const r = await fetchJsonRetry(cfg.statusUrl(taskId), {
      method: "GET",
      headers: { "x-freepik-api-key": apiKey },
    });

    if (!r.ok) {
      return res.status(r.status).json({
        status: "error",
        error: "Status gagal",
        provider,
        detail: r.data,
      });
    }

    const statusRaw = r.data?.data?.status;
    const status = normalizeStatus(statusRaw);

    res.json({
      status,
      raw_status: statusRaw,
      provider,
      progress: null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ status: "error", error: "Server error status", detail: String(e?.message || e) });
  }
});

// RESULT
app.get("/result/:jobId", async (req, res) => {
  try {
    const apiKey = getKey();
    if (!apiKey) return res.status(400).json({ error: "API key belum disimpan." });

    const taskId = req.params.jobId;

    const meta = getJob(taskId);
    const provider = meta?.provider ? pickProvider(meta.provider) : "kling-2.5-pro";
    const cfg = PROVIDERS[provider];

    const r = await fetchJsonRetry(cfg.statusUrl(taskId), {
      method: "GET",
      headers: { "x-freepik-api-key": apiKey },
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: "Result fetch gagal", provider, detail: r.data });
    }

    const statusRaw = r.data?.data?.status;
    if (String(statusRaw).toUpperCase() !== "COMPLETED") {
      return res.status(400).json({ error: "Belum selesai", provider, raw_status: statusRaw });
    }

    const url = extractGeneratedUrl(r.data);
    if (!url) return res.status(400).json({ error: "COMPLETED tapi generated URL kosong", provider, detail: r.data });

    res.json({ videoUrl: url, provider });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error result", detail: String(e?.message || e) });
  }
});

const PORT = process.env.PORT || 8787;

app.listen(PORT, () => {
  console.log("✅ Backend Kling jalan di port:", PORT);
  console.log("✅ Provider aktif:", Object.keys(PROVIDERS));
});

