import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;

// --- МАРШРУТЫ АВТОРИЗАЦИИ (Чтобы ушла ошибка 404) ---
app.post("/auth/register", (req, res) => {
    // Временная заглушка, чтобы 404 пропала. 
    // Если у тебя должна быть реальная БД, добавь логику здесь.
    console.log("Регистрация:", req.body);
    res.status(201).json({ message: "Успешно (заглушка)", token: "fake-token" });
});

app.post("/auth/login", (req, res) => {
    res.json({ token: "fake-token" });
});

// --- МАРШРУТ ГЕНЕРАЦИИ ПЛАНА ---
app.post("/plan/generate", async (req, res) => {
    try {
        const { subject, examDate, topics } = req.body;
        const apiKey = process.env.OPENROUTER_API_KEY;

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.5-flash:free",
                messages: [{ 
                    role: "user", 
                    content: `Составь план подготовки для ${subject} до ${examDate}. Темы: ${topics.join(", ")}. Верни только JSON. Структура: {"subject": "${subject}", "examDate": "${examDate}", "days": [{"day": 1, "topic": "Тема", "minutes": 60, "difficulty": "Средний", "whatIs": "Описание", "basicRules": ["Правило"], "practiceTasks": [{"prompt": "Задача", "solution": "Решение"}]}]}`
                }]
            })
        });

        const data = await response.json();
        
        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        const rawContent = data.choices[0].message.content;
        const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
        
        res.json({ plan: JSON.parse(cleanJson) });
        
    } catch (e) {
        console.error("Ошибка:", e);
        res.status(500).json({ error: "Ошибка сервера: " + e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));