// server.js (secure, ready)
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pkg from "validator";
const { escape } = pkg;
import axios from "axios";

dotenv.config();
const app = express();

// ===== config =====
const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean); // e.g. "chrome-extension://<ID>,https://yourdomain.com"

// ===== middleware =====
app.use(helmet());
app.use(express.json({ limit: "250kb" })); // limit payload size

// rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please try again later." },
});
app.use(limiter);

// CORS: if ALLOWED_ORIGINS empty -> allow all (dev). Otherwise strict.
if (ALLOWED_ORIGINS.length === 0) {
  app.use(cors());
} else {
  app.use(cors({
    origin: function(origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed"), false);
    }
  }));
}

// ===== helper to call OpenAI ChatCompletions via REST (chat/completions) =====
async function callOpenAIChat(messages, max_tokens = 500) {
  const url = "https://api.openai.com/v1/chat/completions";
  const payload = {
    model: "gpt-4o-mini",
    messages,
    max_tokens,
    temperature: 0.2
  };
  const resp = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    timeout: 120000
  });
  return resp.data;
}

// ===== health =====
app.get("/", (req, res) => res.json({ status: "ok" }));

// ===== /summarize endpoint =====
// Expects { text: "...", language: "en"|"es" }
app.post("/summarize", async (req, res) => {
  try {
    const { text, language } = req.body;
    if (!text || typeof text !== "string") return res.status(400).json({ error: "Invalid payload: text required" });

    const lang = (language === "es") ? "es" : "en";
    const trimmed = text.trim();
    if (trimmed.length < 50) return res.status(400).json({ error: "Text too short" });
    if (trimmed.length > 20000) return res.status(400).json({ error: "Text too long" });

    // sanitize reasonably
    const safeText = escape(trimmed).replace(/\s+/g, " ").slice(0, 20000);

    // Prompt: ask model to return strict JSON with fields summary, bullets, rating
    const system = { role: "system", content: `You are a helpful assistant that analyzes Terms & Conditions and returns a concise structured JSON result. Respond with JSON only.` };
    const user = {
      role: "user",
      content:
`Language: ${lang === 'es' ? 'Spanish' : 'English'}.

Task: Read the provided text (Terms & Conditions / Privacy Policy) and return JSON with this exact structure:

{
  "summary": "<one paragraph summary, ${lang === 'es' ? 'en Español' : 'in English'}>",
  "bullets": [
    {"type":"pro","text":"..."},
    {"type":"con","text":"..."},
    {"type":"warning","text":"..."}
  ],
  "rating":"Secure | Risky | Not secure"
}

Rules:
- Return valid JSON ONLY (no extra commentary).
- Provide a short paragraph in 'summary'.
- Provide a few bullets (no fixed count) with type = 'pro' | 'con' | 'warning'.
- rating must be exactly one of: "Secure", "Risky", or "Not secure".
- Use ${lang === 'es' ? 'Spanish' : 'English'} for all outputs.

Text:
${safeText}`
    };

    const aiResp = await callOpenAIChat([system, user], 500);

    const textResp = aiResp.choices?.[0]?.message?.content;
    if (!textResp) throw new Error("No response from OpenAI");

    // Try to parse JSON strictly. Model is asked to return JSON only.
    let parsed;
    try {
      parsed = JSON.parse(textResp);
    } catch (parseErr) {
      // fallback: try to extract JSON substring
      const m = textResp.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
      else throw new Error("OpenAI did not return parseable JSON.");
    }

    // Basic shape validation
    const summary = parsed.summary || "";
    const bullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
    const rating = parsed.rating || "Risky";

    // sanitize bullet objects
    const cleanedBullets = bullets.map(b => {
      const t = (b && b.type) ? String(b.type).toLowerCase() : "con";
      const txt = b && b.text ? String(b.text) : "";
      return { type: (t === "pro" ? "pro" : t === "warning" ? "warning" : "con"), text: txt };
    });

    // Minimal logging
    console.log("Summarize OK; length:", safeText.length);

    res.json({
      summary,
      bullets: cleanedBullets,
      rating
    });

  } catch (err) {
    console.error("Summarize error:", err.message || err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===== start =====
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
