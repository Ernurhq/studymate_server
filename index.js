import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 8787;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = "google/gemini-2.5-flash:free";

// УНИВЕРСАЛЬНЫЙ ЗАПРОС К ИИ (БЕЗ JSON-ФОРМАТА, ЧТОБЫ НЕ БЫЛО 403)
async function getAiResponse(prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://studymate-server-9shn.onrender.com",
      "X-Title": "StudyMate AI"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Ошибка API");
  return data.choices[0].message.content;
}

app.post("/plan/generate", async (req, res) => {
  const { subject, examDate, topics } = req.body;
  const prompt = `Составь план подготовки для "${subject}" до ${examDate} по темам: ${topics.join(", ")}. 
  ОТВЕТЬ ТОЛЬКО JSON-ом (без markdown-кодов), структура: {"subject":"${subject}","examDate":"${examDate}","days":[{"day":1,"topic":"...","minutes":60,"difficulty":"Средний","whatIsTitle":"...","whatIs":"...","basicRules":["1","2"],"applicationExamples":"...","explanation":"...","practiceTasks":[{"prompt":"...","solution":"..."}]}]}`;
  
  try {
    const rawAiResponse = await getAiResponse(prompt);
    // Очищаем ответ от лишних символов, если вдруг ИИ пришлет markdown
    const cleanJson = rawAiResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    res.json({ plan: JSON.parse(cleanJson) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));