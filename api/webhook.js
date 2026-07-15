const axios = require("axios");
const { Redis } = require("@upstash/redis");
const serviceCategories = require("./service-request-categories.json");
const arlingtonOfficials = require("./arlington-officials.json");

const CATEGORIES_SUMMARY = serviceCategories.map((c) => {
  const fields = c.requiredFields.join(", ");
  const dropdowns = Object.entries(c.dropdownOptions)
    .map(([field, opts]) => `${field}: [${opts.join(" / ")}]`)
    .join("; ");
  return `- ${c.type}: collect ${fields}${dropdowns ? `. Options: ${dropdowns}` : ""}`;
}).join("\n");

const DIRECTORY_SUMMARY = arlingtonOfficials.map((o) =>
  `- ${o.area}: ${o.name}, ${o.title} - ${o.phone}`
).join("\n");

const SYSTEM_PROMPT = `You are Heard, a civic SMS assistant for Arlington, MA. You help residents file service requests by collecting the right details and connecting them with the correct town official.

SERVICE REQUEST CATEGORIES (use these to know what fields to collect):
${CATEGORIES_SUMMARY}

ARLINGTON DEPARTMENT DIRECTORY (use this to identify the correct official to contact):
${DIRECTORY_SUMMARY}

YOUR BEHAVIOR:

Step 1 - Categorize: When a user describes a concern, silently identify which service request category it falls under.

Step 2 - Collect fields: Ask for each required field ONE AT A TIME in plain conversational language. For fields with options, list them as: "Is this 1) Option A 2) Option B 3) Option C?" Skip fields the user already mentioned. Never ask for email.

Step 3 - Output: Once all required fields are collected, send one message with:
Line 1: Brief summary of the request (what and where).
Line 2: The correct official name, title, and phone number from the directory above.
Line 3: When you call: [script under 200 characters using the specific details collected]

RULES: Plain ASCII text only. No markdown, no asterisks, no em dashes, no bullet points. Keep every response under 320 characters. If a concern does not clearly match a category, ask a clarifying question.`;

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  try {
    const redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });

    // Load user record: { email, history }
    const record = (await redis.get(from)) || { email: null, history: [] };

    // "report" resets history but keeps email
    if (body.toLowerCase() === "report") {
      await redis.set(from, { email: record.email, history: [] });
      await sendSMS(from, "Hi, I'm Heard! Msg & data rates may apply. Reply STOP to opt out.\n\nDescribe a town concern and I'll help you file it with the right Arlington official.");
      return res.status(200).send("OK");
    }

    // Email gate — ask once, store forever
    if (!record.email) {
      const emailMatch = body.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
      if (emailMatch) {
        const email = emailMatch[0];
        await redis.set(from, { email, history: [] });
        await sendSMS(from, `Got it! Now describe your concern and I'll help you file it with the right Arlington official.`);
      } else {
        await sendSMS(from, "Welcome to Heard! To file service requests, I need your email address first. What is it?");
      }
      return res.status(200).send("OK");
    }

    // Build conversation history, capped at last 10 messages
    const updatedHistory = [
      ...record.history,
      { role: "user", content: body },
    ].slice(-10);

    // Call Claude with full conversation history
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: updatedHistory,
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const reply = claudeRes.data.content[0].text;

    // Save updated history with Claude's reply
    await redis.set(from, {
      email: record.email,
      history: [...updatedHistory, { role: "assistant", content: reply }].slice(-10),
    });

    await sendSMS(from, reply);
    return res.status(200).send("OK");

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    await sendSMS(from, "Something went wrong on our end. Please try again in a moment.").catch(() => {});
    return res.status(500).send("Error");
  }
};

async function sendSMS(to, body) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body }),
    {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    }
  );
}
