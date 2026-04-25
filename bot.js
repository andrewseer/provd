import { TwitterApi } from 'twitter-api-v2';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// X API client
const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// Config
const SCAN_ENDPOINT = process.env.SCAN_ENDPOINT || 'https://provd-five.vercel.app/api/scan';
const MENTION_ID_FILE = '/app/last_mention_id.txt';

// @andrewseer gets unlimited scans for testing
const UNLIMITED_USERS = ['719210624'];

// Daily scan tracking (in-memory, resets on container restart)
const dailyScans = {};

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

function hasUsedDailyScan(userId) {
  return dailyScans[`${userId}-${getTodayKey()}`] === true;
}

function markDailyScan(userId) {
  dailyScans[`${userId}-${getTodayKey()}`] = true;
}

// Build the reply tweet based on score
function buildReply(result) {
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

1 free scan per account daily. Tag @provdit on any post.`;
  }

  if (isHuman) {
    return `PROVD HUMAN ✓

This reads as human-written.
Confidence: ${confidence}%${signal ? `\nSigns of life: ${signal}` : ''}

1 free scan per account daily. Tag @provdit on any post.`;
  }

  return `PROVD UNCLEAR ◎

Can't call this one. Origin uncertain.
Confidence too low to verdict.

1 free scan per account daily. Tag @provdit on any post.`;
}

// Load last processed mention ID from disk (survives restarts)
let lastMentionId = null;
try {
  if (existsSync(MENTION_ID_FILE)) {
    lastMentionId = readFileSync(MENTION_ID_FILE, 'utf8').trim();
    console.log(`Resuming from saved mention ID: ${lastMentionId}`);
  } else if (process.env.LAST_MENTION_ID) {
    lastMentionId = process.env.LAST_MENTION_ID;
    console.log(`Bootstrapping from env mention ID: ${lastMentionId}`);
  }
} catch (e) {
  console.log('No saved mention ID, starting fresh');
}

function saveMentionId(id) {
  try {
    writeFileSync(MENTION_ID_FILE, id);
  } catch (e) {
    console.error('Failed to save mention ID:', e.message);
  }
}

async function checkMentions() {
  try {
    const params = {
      expansions: ['referenced_tweets.id', 'author_id'],
      'tweet.fields': ['text', 'author_id', 'referenced_tweets'],
      max_results: 10
    };

    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await client.v2.userMentionTimeline(
      process.env.X_BOT_USER_ID,
      params
    );

    if (!mentions.data?.data?.length) {
      console.log('No new mentions.');
      return;
    }

    // Process oldest first so lastMentionId advances correctly
    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
      const authorId = tweet.author_id;

      // Always advance the marker so we never reprocess this tweet
      lastMentionId = tweet.id;
      saveMentionId(tweet.id);

      // Skip our own tweets (the bot mentions itself in replies)
      if (authorId === process.env.X_BOT_USER_ID) {
        console.log(`Skipping own tweet ${tweet.id}`);
        continue;
      }

      console.log(`Processing mention ${tweet.id} from ${authorId}`);

      // Daily rate limit, with bypass for unlimited users
      if (hasUsedDailyScan(authorId) && !UNLIMITED_USERS.includes(authorId)) {
        console.log(`Rate limited user ${authorId} -- skipping silently`);
        continue;
      }

      // Find the parent post being referenced
      const ref = tweet.referenced_tweets?.find(r => r.type === 'replied_to');
      if (!ref) {
        console.log(`No parent post found for ${tweet.id} -- skipping`);
        continue;
      }

      const parentTweet = mentions.data.includes?.tweets?.find(
        t => t.id === ref.id
      );

      if (!parentTweet?.text) {
        console.log(`Could not fetch parent post text -- skipping`);
        continue;
      }

      const textToScan = parentTweet.text;

      if (textToScan.length < 20) {
        console.log(`Parent too short to scan -- skipping silently`);
        continue;
      }

      // Call Provd scan API
      const scanRes = await fetch(SCAN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToScan, botMode: true })
      });

      if (!scanRes.ok) {
        console.error(`Scan API error: ${scanRes.status}`);
        continue;
      }

      const result = await scanRes.json();

      if (result.error) {
        console.error(`Scan returned error: ${result.error}`);
        continue;
      }

      // Mark scan as used, then post reply
      markDailyScan(authorId);

      const reply = buildReply(result);
      await client.v2.tweet({
        text: reply,
        reply: { in_reply_to_tweet_id: tweet.id }
      });

      console.log(`Replied to ${tweet.id} -- score: ${result.humanScore} -- signal: ${result.botSignal}`);
    }

  } catch (err) {
    console.error('Bot error:', err.message || err);
  }
}

// Boot and poll every 2 minutes
console.log('Provd bot starting...');
checkMentions();
setInterval(checkMentions, 2 * 60 * 1000);
