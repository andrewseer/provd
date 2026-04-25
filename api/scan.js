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
"narrative": "<2 sentences explaining the verdict in plain English>",
"botSignal": "<one plain English phrase about the writing itself, max 8 words, no jargon. Ignore truncation, ellipses, URLs, or formatting artifacts -- focus only on word choice, sentence rhythm, and voice.>"
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
          'Authorization': `Bearer ${process.env.BITMIND_KEY}`,
          'Content-Type': 'application/json',
          'x-bitmind-application': 'oracle-api'
        },
        body: JSON.stringify({ image, rich: true })
      });

      const bitmindData = await bitmindRes.json();
      console.log('BitMind raw response:', JSON.stringify(bitmindData));

      const isAI = bitmindData?.isAI === true;
      const confidence = bitmindData?.confidence ?? 0.5;
      const aiProbability = isAI ? confidence : confidence;

      results.image = {
        humanScore: Math.round((1 - aiProbability) * 100),
        aiProbability: Math.round(aiProbability * 100)
      };
    }

    // Build unified response
    if (results.text && results.image) {
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
      const h = results.image.humanScore;
      const a = results.image.aiProbability;
      return res.status(200).json({
        humanScore: h,
        signals: [
          { name: 'AI-generated confidence', value: a, flagged: a > 50 }
        ],
        tags: a > 50 ? ['AI-generated', 'manipulation detected'] : ['likely authentic', 'no manipulation'],
        narrative: a > 50
          ? `This image was flagged as AI-generated with ${a}% confidence. Patterns in the visual data match known AI-generated image signatures.`
          : `No significant signs of AI generation were detected. The image scored ${h}% likely human-created.`
      });
    }

  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'scan failed' });
  }
}
