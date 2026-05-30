app.post("/plan/generate", async (req, res) => {
    try {
        const { subject, examDate, topics } = req.body;
        
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "google/gemini-2.5-flash:free",
                messages: [{ 
                    role: "user", 
                    content: `Составь план подготовки для ${subject} до ${examDate} по темам: ${topics.join(", ")}. 
                    ВЕРНИ ОТВЕТ ТОЛЬКО В ВИДЕ ЧИСТОГО JSON-ОБЪЕКТА. 
                    Никаких пояснений, никакой разметки markdown, только сам JSON.
                    Структура должна быть: {"subject": "...", "examDate": "...", "days": [{"day": 1, "topic": "...", "minutes": 60, "difficulty": "Средний", "whatIs": "...", "basicRules": ["1"], "practiceTasks": [{"prompt": "...", "solution": "..."}]}]}` 
                }]
            })
        });

        const data = await response.json();
        const rawContent = data.choices[0].message.content;
        
        // Очищаем ответ от markdown блоков, если ИИ их все-таки пришлет
        const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
        
        // Превращаем текст в объект и отдаем фронтенду
        res.json({ plan: JSON.parse(cleanJson) });
        
    } catch (e) {
        console.error("Ошибка генерации:", e);
        res.status(500).json({ error: "Сервер не смог распарсить план от ИИ" });
    }
});