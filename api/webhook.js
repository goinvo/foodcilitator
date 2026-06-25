const axios = require("axios");

export default async function handler(req, res) {
 // Allow GET requests for URL validation (ClickSend pings the URL to verify it)
if (req.method === "GET") {
    return res.status(200).send("OK");
  }
  
  // Only accept POST requests from ClickSend
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }
  try {
    // 1. Extract the sender's phone number and image URL from ClickSend's payload
    const senderNumber = req.body.from;
    const imageUrl = req.body.media_url; // The image the user sent

    if (!imageUrl) {
      return res.status(200).send("No image received");
    }

    // 2. Download the image and convert it to base64
    const imageResponse = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });
    const base64Image = Buffer.from(imageResponse.data).toString("base64");
    const mimeType = imageResponse.headers["content-type"] || "image/jpeg";

    // 3. Send the image to Claude for analysis
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
                text: "What grocery product is shown in this image? Identify it as specifically as possible in 1-2 sentences.",
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

    // 4. Extract Claude's text response
    const analysisResult = claudeResponse.data.content[0].text;

    // 5. Send the result back to the user via ClickSend SMS
    await axios.post(
      "https://rest.clicksend.com/v3/sms/send",
      {
        messages: [
          {
            to: senderNumber,
            body: analysisResult,
            source: "groceryapp",
          },
        ],
      },
      {
        auth: {
          username: process.env.CLICKSEND_USERNAME,
          password: process.env.CLICKSEND_API_KEY,
        },
      }
    );

    // 6. Tell ClickSend everything went fine
    return res.status(200).send("OK");

  } catch (error) {
    console.error("Error:", error.response?.data || error.message);
    return res.status(500).send("Something went wrong");
  }
}