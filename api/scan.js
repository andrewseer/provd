export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const { text, image } = req.body;

  if (!text && !image) {
    return res.status(400).json({ error: 'no content provided' });
  }

  try {
    const results = {};

    // Text scoring via Claude
    if (text && text.length >= 20) {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
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
  "tags": [<2-3 short signal labels>],
  "narrative": "<2 sentences explaining the verdict in plain English>"
}

Text to analyze:
${text}`
          }]
        })
      });

      const claudeData = await claudeRes.json();
      const raw = claudeData.content[0].text;
      const clean = raw.replace(/```json|```/g, '').trim();
      results.text = JSON.parse(clean);
    }

    // Image scoring via BitMind
    if (image) {
     const bitmindRes = await fetch('https://api.bitmind.ai/oracle/v1/34/detect-image', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${process.env.BITMIND_KEY}`
  },
  body: JSON.stringify({ image, rich: true })
});

      const bitmindData = await bitmindRes.json();
      // BitMind returns a probability that the image is AI-generated
      const aiProbability = bitmindData?.prediction ?? 0.5;
      results.image = {
        humanScore: Math.round((1 - aiProbability) * 100),
        aiProbability: Math.round(aiProbability * 100)
      };
    }

    // Build unified response
    if (results.text && results.image) {
      // Both text and image -- blend scores 50/50
      const blended = Math.round((results.text.humanScore + results.image.humanScore) / 2);
      return res.status(200).json({
        humanScore: blended,
        signals: results.text.signals,
        tags: results.text.tags,
        narrative: results.text.narrative,
        breakdown: {
          text: results.text.humanScore,
          image: results.image.humanScore
        }
      });
    }

    if (results.text) {
      return res.status(200).json(results.text);
    }

    if (results.image) {
      return res.status(200).json({
        humanScore: results.image.humanScore,
        signals: [
          { name: "deepfake probability", value: results.image.aiProbability, flagged: results.image.aiProbability > 50 },
          { name: "image authenticity", value: results.image.humanScore, flagged: results.image.humanScore < 50 }
        ],
        tags: results.image.aiProbability > 50 ? ["ai generated", "deepfake detected"] : ["likely authentic", "no deepfake"],
        narrative: results.image.aiProbability > 50
          ? `This image has a ${results.image.aiProbability}% probability of being AI-generated or manipulated. BitMind's deepfake detection flagged synthetic patterns in the visual data.`
          : `This image appears authentic. BitMind's deepfake detection found no significant synthetic patterns, returning a ${results.image.humanScore}% human score.`
      });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'scan failed' });
  }
}
