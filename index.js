import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/plan/generate", async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  console.log("DEBUG: API Key exists:", !!apiKey); // Проверим, видит ли сервер ключ

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash:free",
        messages: [{ role: "user", content: "Привет, просто ответь 'OK' одним словом." }]
      })
    });

    const data = await response.json();
    console.log("DEBUG: OpenRouter Response:", JSON.stringify(data));

    if (!response.ok) throw new Error(data.error?.message || "Ошибка API");
    res.json({ status: "OK", ai: data.choices[0].message.content });
  } catch (err) {
    console.error("CRITICAL ERROR:", err.message);
    res.status(500).json({ error: "Ошибка: " + err.message });
  }
});

app.listen(8787, () => console.log("Server ready"));