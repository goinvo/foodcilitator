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
      await sendSMS(from, "Hi, I'm Heard! Msg & data rates may apply. Reply STOP to opt out.\n\nText your concern + zip code. Ex: The crosswalk near my house has been broken for months. 02476");
      return res.status(200).send("OK");
    }

    const zipMatch = body.match(/\b(\d{5})\b/);
    if (!zipMatch) {
      await sendSMS(from, "Please include your zip code so I can find your representative. Ex: My street light has been out for months. 02476");
      return res.status(200).send("OK");
    }

    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 500,
        system: `You are Heard, a civic SMS assistant. Given a constituent's concern and zip code, identify the single government official with jurisdiction and generate a call script.

Determine the right level of government (local, state, or federal) based on the nature of the concern, then identify the specific official for that zip code.

Respond ONLY with valid JSON in this exact format with no markdown or explanation:
{
  "repName": "Full name",
  "repTitle": "Official title and jurisdiction",
  "officePhone": "office phone number from your knowledge, or null if unsure",
  "summary": "One sentence describing the concern and why it matters",
  "script": "Plain-text call script under 280 characters. Start: Hi, I am a constituent calling about [issue]. End with a specific ask."
}`,
        messages: [
          {
            role: "user",
            content: `Concern: ${body}`,
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

    const msg1 = `${result.repName}, ${result.repTitle}${result.officePhone ? ` - ${result.officePhone}` : ""}.\n\n${result.summary}`;
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
