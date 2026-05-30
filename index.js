app.post("/plan/generate", async (req, res) => {
  const { subject, examDate, topics } = req.body;
  const apiKey = process.env.OPENROUTER_API_KEY;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash:free",
        messages: [{ role: "user", content: `План для ${subject}. Верни только JSON. Тема: ${topics.join(", ")}` }]
      })
    });

    const data = await response.json();
    let rawContent = data.choices[0].message.content;

    // ВАЖНО: Вырезаем markdown и лишние пробелы
    const cleanJson = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
    
    // Парсим результат
    const plan = JSON.parse(cleanJson);
    
    // Возвращаем успех
    res.json({ plan });
  } catch (err) {
    console.error("PARSING ERROR:", err);
    res.status(500).json({ error: "Ошибка формата данных от ИИ" });
  }
});