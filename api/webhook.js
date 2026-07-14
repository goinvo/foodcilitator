const axios = require("axios");

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
    if (body.toLowerCase() === "report") {
      await sendSMS(from, "Hi, I'm Heard! Message and data rates may apply. Reply STOP to opt out anytime.\n\nTo get started, text your concern and zip code together — e.g.: 'The crosswalk near my house has been broken for months. 02476'");
      return res.status(200).send("OK");
    }

    // Look up representatives via Google Civic Information API
    // Extract zip code from the end of the message (last word that looks like a zip)
    const zipMatch = body.match(/\b(\d{5})\b/);
    if (!zipMatch) {
      await sendSMS(from, "Please include your zip code at the end of your message so I can find your representatives.");
      return res.status(200).send("OK");
    }
    const zip = zipMatch[1];

    const civicRes = await axios.get("https://www.googleapis.com/civicinfo/v2/representatives", {
      params: { address: zip, key: process.env.GOOGLE_CIVIC_API_KEY },
    }).catch(() => null);

    if (!civicRes) {
      await sendSMS(from, "I couldn't look up your representatives right now. Please try again in a moment.");
      return res.status(200).send("OK");
    }

    const { offices, officials } = civicRes.data;

    // Build labeled list of officials with phones and jurisdiction level
    const repList = [];
    for (const office of offices) {
      for (const idx of office.officialIndices) {
        const official = officials[idx];
        const phone = (official.phones || [])[0] || null;
        const level = (office.levels || []).join("/") || "unknown";
        repList.push(`${office.name} [${level}]: ${official.name}${phone ? ` — ${phone}` : " — no phone listed"}`);
      }
    }

    // Ask Claude to identify the right rep and generate a call script
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: `You are Heard, a civic SMS assistant. Given a constituent's concern and their list of representatives, identify the single official with jurisdiction and generate a call script.

Respond ONLY with valid JSON — no explanation, no markdown — in this exact format:
{
  "repName": "Full name",
  "repTitle": "Official title or office",
  "officePhone": "phone number exactly as listed, or null if not listed",
  "summary": "One sentence describing the concern and why it matters",
  "script": "Plain-text call script under 280 characters. Open with: Hi, I am a constituent calling about [issue]. End with a specific ask."
}`,
        messages: [
          {
            role: "user",
            content: `Constituent concern: ${body}\n\nRepresentatives:\n${repList.join("\n")}`,
          },
        ],
      },
      {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      }
    );

    const result = JSON.parse(claudeRes.data.content[0].text);

    const msg1 = `${result.repName}, ${result.repTitle}${result.officePhone ? ` — ${result.officePhone}` : ""}.\n\n${result.summary}`;
    const msg2 = `When you call:\n"${result.script}"`;

    await sendSMS(from, msg1);
    await sendSMS(from, msg2);

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
