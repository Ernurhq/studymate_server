import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/plan/generate", async (req, res) => {
    // Выводим ключ в консоль, чтобы увидеть, видит ли его сервер
    console.log("Ключ есть:", !!process.env.OPENROUTER_API_KEY);
    
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.5-flash:free",
                messages: [{ role: "user", content: "Привет. Напиши план подготовки в формате JSON." }]
            })
        });

        const text = await response.text();
        console.log("Ответ от API:", text); // ВСЯ ПРАВДА БУДЕТ В ЛОГАХ
        
        res.status(200).send(text);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.listen(8787);