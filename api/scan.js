export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const { text } = req.body;

  if (!text || text.length < 20) {
    return res.status(400).json({ error: 'text too short' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: `You are a content authenticity analyzer. Analyze the following text and determine how likely it is to be human-written vs AI-generated.

Return ONLY a JSON object with this exact structure, no other text:
{
  "humanScore": <number 0-100, where 100 is definitely human>,
  "signals": [
    {"name": "sentence entropy", "value": <0-100>, "flagged": <true if suspicious>},
    {"name": "hedging language", "value": <0-100>, "flagged": <true if suspicious>},
    {"name": "vocabulary distribution", "value": <0-100>, "flagged": <true if suspicious>},
    {"name": "structural variance", "value": <0-100>, "flagged": <true if suspicious>},
    {"name": "semantic coherence", "value": <0-100>, "flagged": <true if suspicious>}
  ],
  "tags": [<2-3 short signal labels>, ...],
  "narrative": "<2 sentences explaining the verdict in plain English>"
}

Text to analyze:
${text}`
        }]
      })
    });

    const data = await response.json();
    const raw = data.content[0].text;
    const clean = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    return res.status(200).json(result);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'scan failed' });
  }
}
