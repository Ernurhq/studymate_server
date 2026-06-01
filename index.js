import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;

// --- Добавь эти маршруты, чтобы фронтенд перестал получать 404 ---
app.post("/auth/register", (req, res) => {
    console.log("Попытка регистрации:", req.body);
    // Отвечаем фронтенду, что всё ок, чтобы ушла ошибка "Некорректный ответ"
    res.status(200).json({ success: true, message: "Регистрация прошла успешно" });
});

app.post("/auth/login", (req, res) => {
    res.status(200).json({ success: true, token: "fake-token" });
});

// --- Твой существующий маршрут ---
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
                messages: [{ role: "user", content: `План для ${subject}. Темы: ${topics.join(", ")}.` }]
            })
        });

        const data = await response.json();
        const rawContent = data.choices[0].message.content;
        const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
        
        res.json({ plan: JSON.parse(cleanJson) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));