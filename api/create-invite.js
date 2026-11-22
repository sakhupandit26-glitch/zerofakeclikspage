import { randomUUID } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const {
    BOT_TOKEN,
    CHANNEL_ID,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
  } = process.env;

  if (!BOT_TOKEN || !CHANNEL_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Missing required environment variables");
    return res.status(500).json({
      error: "Missing environment variables"
    });
  }

  let stage = "starting";

  try {
    const baseUrl = SUPABASE_URL.trim();
    const parsedUrl = new URL(baseUrl);

    if (parsedUrl.protocol !== "https:") {
      throw new Error("SUPABASE_URL must start with https://");
    }

    const visitorId = randomUUID();
    const fbp = req.body?.fbp || null;
    const fbc = req.body?.fbc || null;

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null;

    const userAgent = req.headers["user-agent"] || null;

    // STEP 1: Telegram invite link
    stage = "telegram";

    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          name: visitorId,
          creates_join_request: true
        })
      }
    );

    const telegramData = await telegramResponse.json();

    if (!telegramResponse.ok || !telegramData.ok) {
      console.error("Telegram API error:", telegramData);

      return res.status(502).json({
        error: "Telegram invite creation failed"
      });
    }

    const inviteLink = telegramData.result.invite_link;

    // STEP 2: Save visitor in Supabase
    stage = "supabase";

    const supabaseResponse = await fetch(
      `${baseUrl.replace(/\/+$/, "")}/rest/v1/telegram_visitors`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          visitor_id: visitorId,
          invite_link: inviteLink,
          fbp,
          fbc,
          ip_address: ip,
          user_agent: userAgent
        })
      }
    );

    if (!supabaseResponse.ok) {
      const errorText = await supabaseResponse.text();

      console.error("Supabase insert error:", errorText);

      return res.status(502).json({
        error: "Supabase visitor save failed"
      });
    }

    return res.status(200).json({
      success: true,
      visitor_id: visitorId,
      invite_link: inviteLink
    });

  } catch (error) {
    console.error("Create invite failed:", {
      stage,
      message: error.message,
      cause: error.cause?.message
    });

    return res.status(500).json({
      error: "Server error",
      stage,
      details: error.cause?.message || error.message
    });
  }
}
