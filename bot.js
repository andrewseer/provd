import { TwitterApi } from 'twitter-api-v2';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const client = new TwitterApi({
  appKey: process.env.X_CONSUMER_KEY,
  appSecret: process.env.X_CONSUMER_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

const SCAN_ENDPOINT = process.env.SCAN_ENDPOINT || 'https://provd-five.vercel.app/api/scan';
const DATA_DIR = '/app/data';
const MENTION_ID_FILE = `${DATA_DIR}/last_mention_id.txt`;
const SCANNED_PARENTS_FILE = `${DATA_DIR}/scanned_parents.json`;
const SCAN_CACHE_DAYS = 7;

try { mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

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

let scannedParents = {};
try {
  if (existsSync(SCANNED_PARENTS_FILE)) {
    scannedParents = JSON.parse(readFileSync(SCANNED_PARENTS_FILE, 'utf8'));
    const cutoff = Date.now() - SCAN_CACHE_DAYS * 24 * 60 * 60 * 1000;
    for (const id of Object.keys(scannedParents)) {
      if (scannedParents[id] < cutoff) delete scannedParents[id];
    }
  }
} catch (e) {
  console.error('Could not load scanned parents:', e.message);
  scannedParents = {};
}

function hasScannedParent(parentId) {
  return scannedParents[parentId] !== undefined;
}

function markParentScanned(parentId) {
  scannedParents[parentId] = Date.now();
  try {
    writeFileSync(SCANNED_PARENTS_FILE, JSON.stringify(scannedParents));
  } catch (e) {
    console.error('Failed to save scanned parents:', e.message);
  }
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

let lastMentionId = null;
let bootstrapped = false;

try {
  if (existsSync(MENTION_ID_FILE)) {
    lastMentionId = readFileSync(MENTION_ID_FILE, 'utf8').trim();
    bootstrapped = true;
    console.log(`Resuming from saved mention ID: ${lastMentionId}`);
  } else {
    console.log('No saved mention ID. Will bootstrap on first run.');
  }
} catch (e) {
  console.error('Error reading mention ID file:', e.message);
}

function saveMentionId(id) {
  try {
    writeFileSync(MENTION_ID_FILE, id);
  } catch (e) {
    console.error('Failed to save mention ID:', e.message);
  }
}

async function bootstrapMentionId() {
  try {
    console.log('Bootstrapping: fetching most recent mention to mark starting point...');
    const mentions = await client.v2.userMentionTimeline(process.env.X_BOT_USER_ID, { max_results: 5 });

    if (mentions.data?.data?.length) {
      const newest = mentions.data.data[0];
      lastMentionId = newest.id;
      saveMentionId(newest.id);
      console.log(`Bootstrapped lastMentionId to ${newest.id}. Bot will only respond to mentions newer than this.`);
    } else {
      console.log('No mentions found. Will start fresh from next mention.');
    }

    bootstrapped = true;
  } catch (err) {
    console.error('Bootstrap failed:', err.message);
  }
}

async function checkMentions() {
  try {
    writeFileSync(`${DATA_DIR}/.write_test`, 'ok');
  } catch (e) {
    console.error('CRITICAL: cannot write to data volume. Refusing to run.');
    return;
  }

  if (!bootstrapped) {
    await bootstrapMentionId();
    if (!bootstrapped) return;
  }

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

    const tweets = [...mentions.data.data].reverse();

    for (const tweet of tweets) {
      const authorId = tweet.author_id;

      lastMentionId = tweet.id;
      saveMentionId(tweet.id);

      if (authorId === process.env.X_BOT_USER_ID) {
        console.log(`Skipping own tweet ${tweet.id}`);
        continue;
      }

      console.log(`Processing mention ${tweet.id} from ${authorId}`);

      // Only respond if @provdit was explicitly tagged in THIS tweet's text
      const tweetText = tweet.text || '';
      if (!tweetText.toLowerCase().includes('@provdit')) {
        console.log(`No explicit @provdit tag in tweet text -- skipping`);
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

      if (hasScannedParent(ref.id)) {
        console.log(`Parent ${ref.id} already scanned -- skipping silently`);
        continue;
      }

      const parentTweet = mentions.data.includes?.tweets?.find(t => t.id === ref.id);

      if (!parentTweet?.text) {
        console.log(`Could not fetch parent post text -- skipping`);
        continue;
      }

      const textToScan = parentTweet.text;

      if (textToScan.length < 20) {
        console.log(`Parent too short to scan -- skipping silently`);
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
      markParentScanned(ref.id);

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

console.log('Provd bot starting...');
checkMentions();
setInterval(checkMentions, 2 * 60 * 1000);
