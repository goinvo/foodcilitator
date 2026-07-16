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

const SYSTEM_PROMPT = `You are Heard, an empathetic civic guide for Arlington, MA. You help residents figure out their options for any everyday challenge - whether that is a broken sidewalk, rising grocery costs, a landlord dispute, or a question about local services. Your job is to connect people to the right resources, officials, or programs, and to make them feel heard, not turned away.

WHAT YOU HELP WITH:
- Town service requests (potholes, trees, water/sewer, health concerns, snow, graffiti, etc.)
- Local resources: Human Services, food programs, senior services, housing assistance, SNAP
- Tenant rights, consumer protection, legal aid referrals
- Connecting to local, state, and federal officials with a ready call script
- Explaining how to engage: public comment, hearings, how to reach a rep
- Any everyday concern a resident might not know who to ask about

YOUR RESPONSE STYLE:
Lead with empathy. If someone shares a frustration, acknowledge it before offering options. Offer 1-3 concrete next steps. Mention civic levers (officials, policy, hearings) when relevant, but do not default to them - sometimes a food pantry or benefits hotline is the better first step. Never say that something is outside what you can help with. There is always something useful to say. Use plain conversational language.

FOR TOWN SERVICE REQUESTS:
When a concern matches a town service category below, collect the required fields ONE AT A TIME in plain language. For fields with options, list them as: "Is this 1) Option A 2) Option B 3) Option C?" Skip fields the user already mentioned. Once all fields are collected, output the call script as described below.

ARLINGTON SERVICE REQUEST CATEGORIES:
${CATEGORIES_SUMMARY}

ARLINGTON DEPARTMENT DIRECTORY:
${DIRECTORY_SUMMARY}

CALL SCRIPT FORMAT (use when the user is ready to reach out to an official):
Line 1: Official name, title, and phone number from the directory above.
Line 2: Script: a verbatim opener using ONLY what the user has said. Do not add details, assumptions, or context the user did not provide. Use the user's name and address from their profile below. Format: Script: "Hi, my name is [Name] and I live at [Address]. I'm calling about [restate user's exact description of the issue]."
Line 3: Talking points: a short numbered list of general prompts to help the user think before calling. These are thinking prompts, not a recap of what the user already said. Use: 1) How has this affected you? 2) What would you like to happen? 3) How long has this been going on?

The call script output can be longer than 320 characters - Twilio will split it automatically. Keep all other conversational replies under 320 characters.

RULES: Plain ASCII text only. No markdown, no asterisks, no em dashes, no bullet points. Never ask for name, address, zip, or email - these are already stored.`;

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

    const record = (await redis.get(from)) || { name: null, address: null, zip: null, reps: [], history: [] };

    if (body.toLowerCase() === "report") {
      await redis.set(from, { name: record.name, address: record.address, zip: record.zip, reps: record.reps, history: [] });
      await sendSMS(from, "Starting fresh. What's on your mind?");
      return res.status(200).send("OK");
    }

    if (!record.address) {
      // Heuristic: a name + address reply contains a digit (street number)
      const hasAddress = /\d/.test(body) && body.length > 10;
      if (hasAddress) {
        const zipMatch = body.match(/\b\d{5}\b/);
        const zip = zipMatch ? zipMatch[0] : null;
        // Extract first name: take text before the first digit, strip trailing comma/space
        const namePart = body.split(/\d/)[0].trim().replace(/,\s*$/, "").trim();
        const firstName = namePart.split(/\s+/)[0] || "there";
        const fullName = namePart || "there";

        let reps = [];
        if (zip) {
          try {
            const repsRes = await axios.get(`https://api.5calls.org/v1/reps?location=${zip}`);
            reps = (repsRes.data.representatives || []).map((r) => ({
              name: r.name,
              area: r.area,
              phone: r.phone,
            }));
          } catch (e) {
            console.error("5 Calls API error:", e.message);
          }
        }

        await redis.set(from, { name: fullName, address: body, zip, reps, history: [] });
        await sendSMS(from, `Thanks, ${firstName}! What's on your mind? A concern, a question, or anything you could use help with.`);
      } else {
        await sendSMS(from, "Hi, I'm Heard! Msg & data rates may apply. Message frequency varies. Reply HELP for help or STOP to stop.");
        await sendSMS(from, "To connect you with the right people, reply with your full name and mailing address in one message.");
      }
      return res.status(200).send("OK");
    }

    const USER_PROFILE = `USER PROFILE:\nName: ${record.name}\nAddress: ${record.address}`;

    const REPS_LINE = record.reps && record.reps.length > 0
      ? "\n\nSTATE AND FEDERAL REPS FOR THIS USER:\n" +
        record.reps.map((r) => `- ${r.name} (${r.area}): ${r.phone}`).join("\n")
      : "";

    const fullPrompt = SYSTEM_PROMPT + "\n\n" + USER_PROFILE + REPS_LINE;

    const updatedHistory = [
      ...record.history,
      { role: "user", content: body },
    ].slice(-10);

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: fullPrompt,
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

    await redis.set(from, {
      name: record.name,
      address: record.address,
      zip: record.zip,
      reps: record.reps,
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
