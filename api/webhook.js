const axios = require("axios");

export default async function handler(req, res) {
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
      await sendSMS(senderNumber, "Please send a photo of a grocery item and I'll identify it for you!");
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

    // Send image to Claude
    const claudeResponse = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
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
                text: "What grocery product is shown in this image? Reply in one short sentence, maximum 100 characters.",
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

    // Send reply via Twilio
    await sendSMS(senderNumber, analysisResult);

    return res.status(200).send("OK");

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