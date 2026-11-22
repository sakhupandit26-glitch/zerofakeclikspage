export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Verify Telegram webhook secret
    const secret = req.headers["x-telegram-bot-api-secret-token"];

    if (!secret || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const update = req.body;
    const joinRequest = update.chat_join_request;

    // Only process new join requests
    if (!joinRequest) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Not a join request"
      });
    }

    // 2. Verify channel
    if (String(joinRequest.chat.id) !== String(process.env.CHANNEL_ID)) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Wrong channel"
      });
    }

    // 3. Get invite link
    const inviteLink = joinRequest.invite_link?.invite_link;

    if (!inviteLink) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Invite link missing"
      });
    }

    // 4. Supabase configuration
    const supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables missing");
    }

    async function dbRequest(path, options = {}) {
      return fetch(`${supabaseUrl}/rest/v1/${path}`, {
        ...options,
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
    }

    // 5. Find visitor using their unique invite link
    const search = new URLSearchParams({
      invite_link: `eq.${inviteLink}`,
      select: "id,visitor_id,fbp,fbc,ip_address,user_agent,meta_event_sent",
      limit: "1"
    });

    const lookup = await dbRequest(
      `telegram_visitors?${search.toString()}`
    );

    if (!lookup.ok) {
      throw new Error("Supabase visitor lookup failed: " + await lookup.text());
    }

    const rows = await lookup.json();
    const visitor = rows[0];

    if (!visitor) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Visitor not found"
      });
    }

    // 6. Prevent duplicate Lead events
    if (visitor.meta_event_sent) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Lead already sent"
      });
    }

    // 7. Meta credentials
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      throw new Error("Meta credentials missing");
    }

    const telegramUser = joinRequest.from;

    // 8. Prepare matching data
    const userData = {};

    if (visitor.fbp) userData.fbp = visitor.fbp;
    if (visitor.fbc) userData.fbc = visitor.fbc;

    if (visitor.ip_address) {
      userData.client_ip_address = visitor.ip_address;
    }

    if (visitor.user_agent) {
      userData.client_user_agent = visitor.user_agent;
    }

    // 9. Send Lead event immediately when request arrives
    const eventData = {
      data: [{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: `telegram_lead_${visitor.visitor_id}`,
        action_source: "website",
        user_data: userData
      }]
    };

    // Optional: show server event in Meta Test Events
    if (process.env.META_TEST_EVENT_CODE) {
      eventData.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const metaUrl =
      `https://graph.facebook.com/v22.0/${pixelId}/events` +
      `?access_token=${encodeURIComponent(accessToken)}`;

    const metaResponse = await fetch(metaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(eventData)
    });

    const metaResult = await metaResponse.json();

    if (!metaResponse.ok || metaResult.error) {
      console.error("Meta API error:", metaResult);
      throw new Error("Meta CAPI failed");
    }

    // 10. Save request details after Meta accepts the event
    const updateParams = new URLSearchParams({
      id: `eq.${visitor.id}`,
      meta_event_sent: "eq.false"
    });

    const save = await dbRequest(
      `telegram_visitors?${updateParams.toString()}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          telegram_user_id: telegramUser.id,
          telegram_username: telegramUser.username || null,
          meta_event_sent: true
        })
      }
    );

    if (!save.ok) {
      throw new Error("Could not save Lead status: " + await save.text());
    }

    console.log("Telegram join request Lead sent:", visitor.visitor_id);

    return res.status(200).json({
      ok: true,
      join_request_received: true,
      meta_event_sent: true,
      meta_events_received: metaResult.events_received
    });

  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
