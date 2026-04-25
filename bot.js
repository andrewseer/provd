import { TwitterApi } from 'twitter-api-v2';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const SCAN_ENDPOINT = process.env.SCAN_ENDPOINT || 'https://provd-five.vercel.app/api/scan';
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
try {
  if (existsSync('/app/last_mention_id.txt')) {
    lastMentionId = readFileSync('/app/last_mention_id.txt', 'utf8').trim();
    console.log(`Resuming from mention ID: ${lastMentionId}`);
  } else if (process.env.LAST_MENTION_ID) {
    lastMentionId = process.env.LAST_MENTION_ID;
    console.log(`Starting from env mention ID: ${lastMentionId}`);
  }
} catch (e) {
  console.log('No saved mention ID found, starting fresh');
}

async function checkMentions() {
  try {
    const params = {
      expansions: ['referenced_tweets.id', 'author_id'],
      'tweet.fields': ['text', 'author_id', 'referenced_tweets'],
      max_results: 10
    };

    if (lastMentionId) params.since_id = lastMentionId;

    const mentions = await client.v2.userMentionTimeline(process.env.X_BOT_USER_ID, params);

    if (!mentions.data?.data?.length) {
      console.log('No new mentions.');
      return;
    }

    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
lastMentionId = tweet.id;
try { writeFileSync('/app/last_mention_id.txt', tweet.id); } catch (e) {}
      const authorId = tweet.author_id;

      console.log(`Processing mention ${tweet.id} from ${authorId}`);
      if (authorId === process.env.X_BOT_USER_ID) {
  console.log(`Skipping own tweet ${tweet.id}`);
  continue;
}

    if (hasUsedDailyScan(authorId)) {
  console.log(`Rate limited user ${authorId} -- skipping silently`);
  continue;
}

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
        await client.v2.tweet({
          text: `That post is too short to scan reliably.\n\nTag @provdit on a longer post to verify.`,
          reply: { in_reply_to_tweet_id: tweet.id }
        });
        continue;
      }

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

      markDailyScan(authorId);

      const reply = buildReply(result);
      await client.v2.tweet({
        text: reply,
        reply: { in_reply_to_tweet_id: tweet.id }
      });

      console.log(`Replied to ${tweet.id} -- human score: ${result.humanScore} -- signal: ${result.botSignal}`);
    }

  } catch (err) {
    console.error('Bot error:', err.message || err);
  }
}

console.log('Provd bot starting...');
checkMentions();
setInterval(checkMentions, 2 * 60 * 1000);
