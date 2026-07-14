const axios = require("axios");
const { Redis } = require("@upstash/redis");
const arlingtonOfficials = require("./arlington-officials.json");

module.exports = async function handler(req, res) {
  const redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const from = req.body.From;
  const body = (req.body.Body || "").trim();

  try {
    // "report" resets the conversation and sends the welcome message
    if (body.toLowerCase() === "report") {
      await redis.del(from);
      await sendSMS(from, "Hi, I'm Heard! Msg & data rates may apply. Reply STOP to opt out.\n\nText your concern + zip code. Ex: The crosswalk near my house has been broken for months. 02476");
      return res.status(200).send("OK");
    }

    // Load conversation history from Redis (empty array for new users)
    const history = (await redis.get(from)) || [];

    // Build the message Claude will see this turn.
    // If the user included a zip code, fetch reps and append them.
    // The raw body (without rep list) is what gets stored in history.
    let claudeUserMessage = body;
    const zipMatch = body.match(/\b(\d{5})\b/);

    if (zipMatch) {
      const repsRes = await axios.get("https://api.5calls.org/v1/reps", {
        params: { location: zipMatch[1] },
      }).catch((err) => {
        console.error("5 Calls API error:", err.response?.data || err.message);
        return null;
      });

      if (repsRes) {
        const federalStateReps = repsRes.data.representatives.map((r) =>
          `${r.area} [federal/state]: ${r.name} (${r.party}) - ${r.phone}`
        );
        const localReps = arlingtonOfficials.map((r) =>
          `${r.area} [local]: ${r.name}, ${r.title} - ${r.phone}`
        );
        claudeUserMessage = `${body}\n\nRepresentatives:\n${[...localReps, ...federalStateReps].join("\n")}`;
      }
    }

    // Keep history clean (no rep lists) — cap at last 10 messages
    const trimmedHistory = [...history, { role: "user", content: body }].slice(-10);

    // For this Claude call, swap the last user message with the enriched version
    const messagesToSend = [
      ...trimmedHistory.slice(0, -1),
      { role: "user", content: claudeUserMessage },
    ];

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: `You are Heard, a civic SMS assistant helping constituents in Arlington, MA reach the right representative for their concern.

When a user describes a concern with a zip code, a list of representatives is provided. Identify the single best official and respond with their name, title, phone number, a one-sentence summary of the concern, and a plain-text call script under 280 characters.

For follow-up messages without a rep list, respond naturally. If the user wants to report a new concern, ask them to describe it and include their zip code.

Always use plain text only. No markdown, no asterisks. Keep all responses under 400 characters for SMS.`,
        messages: messagesToSend,
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

    // Save updated history (raw body + Claude reply, no rep list bloat)
    await redis.set(from, [
      ...trimmedHistory,
      { role: "assistant", content: reply },
    ]);

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
