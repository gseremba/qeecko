require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));


// =========================
// HEALTH CHECK
// =========================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});


// =========================
// IMAGE GENERATION
// =========================
app.post("/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: prompt,
        size: "1024x1024"
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || "Image generation failed"
      });
    }

    res.json(data);

  } catch (err) {
    console.error("IMAGE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});


// =========================
// AI PROMPT SUGGESTIONS
// =========================
app.post("/suggest-prompts", async (req, res) => {
  try {
    const { input } = req.body;

    if (!input) {
      return res.json({ suggestions: [] });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You generate creative short image prompts."
          },
          {
            role: "user",
            content: `Give 5 short creative image prompts based on: "${input}". Return ONLY a JSON array.`
          }
        ],
        temperature: 0.8
      })
    });

    const data = await response.json();

    let suggestions = [];

    try {
      const text = data.choices?.[0]?.message?.content || "[]";
      suggestions = JSON.parse(text);
    } catch {
      suggestions = [];
    }

    res.json({ suggestions });

  } catch (err) {
    console.error("SUGGEST ERROR:", err);
    res.json({ suggestions: [] });
  }
});


// =========================
// PROMPT ENHANCER (WITH STYLES)
// =========================
app.post("/enhance-prompt", async (req, res) => {
  try {
    const { input, style } = req.body;

    if (!input) {
      return res.json({ enhanced: "" });
    }

    const apiKey = process.env.OPENAI_API_KEY?.trim();

    const styles = {
      cinematic: "cinematic, dramatic lighting, film still",
      anime: "anime style, vibrant colors, stylized characters",
      realistic: "photorealistic, natural lighting, high detail",
      fantasy: "fantasy world, magical, epic scenery",
      cyberpunk: "cyberpunk, neon lights, futuristic city",
      default: "highly detailed and visually rich"
    };

    const styleText = styles[style] || styles.default;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "You enhance image prompts."
          },
          {
            role: "user",
            content: `Enhance this prompt: "${input}" with ${styleText}. Return ONLY the improved prompt.`
          }
        ],
        temperature: 0.9
      })
    });

    const data = await response.json();

    const enhanced =
      data.choices?.[0]?.message?.content?.trim() || input;

    res.json({ enhanced });

  } catch (err) {
    console.error("ENHANCE ERROR:", err);
    res.json({ enhanced: "" });
  }
});

let requests = {};

app.use((req, res, next) => {
  const ip = req.ip;

  requests[ip] = requests[ip] || 0;
  requests[ip]++;

  if (requests[ip] > 20) {
    return res.status(429).json({ error: "Too many requests" });
  }

  next();
});

// =========================
// SERVE FRONTEND
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


// =========================
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});