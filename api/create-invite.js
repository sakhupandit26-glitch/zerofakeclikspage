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
    return res.status(500).json({ error: "Missing environment variables" });
  }

  try {
    const visitorId = crypto.randomUUID();

    const fbp = req.body?.fbp || null;
    const fbc = req.body?.fbc || null;

    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null;

    const userAgent = req.headers["user-agent"] || null;

    // Create a unique invite link requiring admin approval
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHANNEL_ID,
          name: visitorId,
          creates_join_request: true
        })
      }
    );

    const telegramData = await telegramResponse.json();

    if (!telegramData.ok) {
      console.error("Telegram error:", telegramData);
      return res.status(500).json({ error: "Could not create invite link" });
    }

    const inviteLink = telegramData.result.invite_link;

    // Save visitor and invite link in Supabase
    const supabaseResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/telegram_visitors`,
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
      const error = await supabaseResponse.text();
      console.error("Supabase error:", error);
      return res.status(500).json({ error: "Could not save visitor" });
    }

    return res.status(200).json({
      success: true,
      visitor_id: visitorId,
      invite_link: inviteLink
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Server error" });
  }
}
