import { TwitterApi } from 'twitter-api-v2';

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const SCAN_ENDPOINT = process.env.SCAN_ENDPOINT || 'https://provd-five.vercel.app/api/scan';
const MAX_DAILY_SCANS_PER_USER = 1;
const dailyScans = {};

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function hasUsedDailyScan(userId) {
  const today = getTodayKey();
  return dailyScans[`${userId}-${today}`] === true;
}

function markDailyScan(userId) {
  const today = getTodayKey();
  dailyScans[`${userId}-${today}`] = true;
}

function buildReply(result, authorHandle) {
  const score = result.humanScore;
  const aiScore = 100 - score;
  const isAI = score < 40;
  const isHuman = score >= 70;
  const confidence = isAI ? aiScore : score;
  const signal = result.botSignal || '';

  if (isAI) {
    return `PROVD AI 🤖

✗ This reads as AI-generated.
Confidence: ${confidence}%${signal ? `\nDetected: ${signal}` : ''}

Tag @provdit on any post to verify.`;
  }

  if (isHuman) {
    return `PROVD HUMAN ✓

This reads as human-written.
Confidence: ${confidence}%${signal ? `\nSigns of life: ${signal}` : ''}

Tag @provdit on any post to verify.`;
  }

  return `PROVD UNCLEAR ◎

Can't call this one. Origin uncertain.
Confidence too low to verdict.

Tag @provdit on any post to verify.`;
}

let lastMentionId = null;

async function checkMentions() {
  try {
    const params = { expansions: ['referenced_tweets.id', 'author_id'], 'tweet.fields': ['text', 'author_id', 'referenced_tweets'], max_results: 10 };
    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await client.v2.mentionTimeline(process.env.X_BOT_USER_ID, params);

    if (!mentions.data?.data?.length) return;

    // Process oldest first
    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
      lastMentionId = tweet.id;

      const authorId = tweet.author_id;

      // Check daily limit
      if (hasUsedDailyScan(authorId)) {
        await client.v2.reply(
          `You've used your daily Provd scan. Come back tomorrow.\n\nTag @provdit on any post to verify.`,
          tweet.id
        );
        continue;
      }

      // Get the parent post being referenced
      const ref = tweet.referenced_tweets?.find(r => r.type === 'replied_to');
      if (!ref) continue;

      const parentTweet = mentions.data.includes?.tweets?.find(t => t.id === ref.id);
      if (!parentTweet?.text) continue;

      const textToScan = parentTweet.text;
      if (textToScan.length < 20) {
        await client.v2.reply(
          `That post is too short to scan reliably.\n\nTag @provdit on a longer post to verify.`,
          tweet.id
        );
        continue;
      }

      // Call scan API
      const scanRes = await fetch(SCAN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToScan, botMode: true })
      });

      if (!scanRes.ok) continue;

      const result = await scanRes.json();
      if (result.error) continue;

      markDailyScan(authorId);

      const reply = buildReply(result);
      await client.v2.reply(reply, tweet.id);

      console.log(`Replied to ${tweet.id} — human score: ${result.humanScore}`);
    }
  } catch (err) {
    console.error('Bot error:', err);
  }
}

// Run every 2 minutes
console.log('Provd bot starting...');
checkMentions();
setInterval(checkMentions, 2 * 60 * 1000);
