const axios = require("axios");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).send("OK");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // Twilio sends form-encoded data, extract the fields
    const senderNumber = req.body.From;
    const numMedia = parseInt(req.body.NumMedia || "0");
    const imageUrl = req.body.MediaUrl0;

    if (numMedia === 0 || !imageUrl) {
      // No image attached — send a helpful reply
      await sendSMS(senderNumber, "Hi! I'm Foodcilitator. Text me a photo of any grocery item and I'll explain why it costs what it does, trace the supply chain, and suggest a way to take civic action.");
      return res.status(200).send("OK");
    }

    // Download the image and convert to base64
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });
    const base64Image = Buffer.from(imageResponse.data).toString("base64");
    const mimeType = imageResponse.headers["content-type"] || "image/jpeg";

    // Send image to Claude for full Foodcilitator analysis
    const claudeResponse = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        system: `You are Foodcilitator, an SMS service. When sent a photo of a grocery item:
1. Identify the item in one short sentence.
2. Explain in 2-3 sentences why it currently costs what it does — tariffs, weather, supply chain issues, fuel costs, or corporate consolidation.
Reply in plain text only, no markdown. Keep the total under 400 characters. If you cannot identify a grocery item, say so and ask for a clearer photo.`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64Image,
                },
              },
              {
                type: "text",
                text: "Analyze this grocery item photo.",
              },
            ],
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

    const analysisResult = claudeResponse.data.content[0].text;
    console.log("Claude response:", analysisResult);

    // Send reply via Twilio
    await sendSMS(senderNumber, analysisResult);

    return res.status(200).json({ result: analysisResult });

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    return res.status(500).send("Something went wrong");
  }
}

async function sendSMS(to, body) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({
      To: to,
      From: process.env.TWILIO_PHONE_NUMBER,
      Body: body,
    }),
    {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    }
  );
}