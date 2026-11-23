export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let visitor = null;
  let supabaseUrl = "";
  let supabaseKey = "";

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

  try {
    // 1. Verify Telegram webhook secret
    const secret = req.headers["x-telegram-bot-api-secret-token"];

    if (!secret || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const update = req.body || {};
    const joinRequest = update.chat_join_request;

    // 2. Only process join requests
    if (!joinRequest) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Not a join request"
      });
    }

    // 3. Verify channel
    if (
      String(joinRequest.chat.id) !==
      String(process.env.CHANNEL_ID)
    ) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Wrong channel"
      });
    }

    // 4. Get unique invite link
    const inviteLink = joinRequest.invite_link?.invite_link;

    if (!inviteLink) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Invite link missing"
      });
    }

    // 5. Supabase configuration
    supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
    supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables missing");
    }

    // 6. Find visitor using unique invite link
    const search = new URLSearchParams({
      invite_link: `eq.${inviteLink}`,
      select: "id,visitor_id,fbp,fbc,ip_address,user_agent,meta_event_sent",
      limit: "1"
    });

    const lookup = await dbRequest(
      `telegram_visitors?${search.toString()}`
    );

    if (!lookup.ok) {
      throw new Error(
        "Supabase lookup failed: " + await lookup.text()
      );
    }

    const rows = await lookup.json();
    visitor = rows[0];

    if (!visitor) {
      console.log("Visitor not found for invite link");

      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Visitor not found"
      });
    }

    // 7. Prevent duplicate event
    // Claim the event before sending it.
    const claimParams = new URLSearchParams({
      id: `eq.${visitor.id}`,
      meta_event_sent: "eq.false"
    });

    const claim = await dbRequest(
      `telegram_visitors?${claimParams.toString()}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          meta_event_sent: true,
          telegram_user_id: joinRequest.from.id,
          telegram_username: joinRequest.from.username || null
        })
      }
    );

    if (!claim.ok) {
      throw new Error(
        "Could not claim visitor: " + await claim.text()
      );
    }

    const claimedRows = await claim.json();

    if (!claimedRows.length) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Subscribe event already claimed"
      });
    }

    // 8. Meta credentials
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      throw new Error("Meta credentials missing");
    }

    // 9. Prepare matching data
    const userData = {};

    if (visitor.fbp) userData.fbp = visitor.fbp;
    if (visitor.fbc) userData.fbc = visitor.fbc;

    if (visitor.ip_address) {
      userData.client_ip_address = visitor.ip_address;
    }

    if (visitor.user_agent) {
      userData.client_user_agent = visitor.user_agent;
    }

    // 10. Send Subscribe event to Meta CAPI
    const eventData = {
      data: [{
        event_name: "Subscribe",
        event_time: Math.floor(Date.now() / 1000),
        event_id: `telegram_subscribe_${visitor.visitor_id}`,
        action_source: "website",
        user_data: userData
      }]
    };

    // Test Events support
    if (process.env.META_TEST_EVENT_CODE) {
      eventData.test_event_code =
        process.env.META_TEST_EVENT_CODE.trim();
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
      // Release claim so a later Telegram retry can try again
      const releaseParams = new URLSearchParams({
        id: `eq.${visitor.id}`,
        meta_event_sent: "eq.true"
      });

      await dbRequest(
        `telegram_visitors?${releaseParams.toString()}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            meta_event_sent: false
          })
        }
      );

      console.error("Meta API error:", metaResult);
      throw new Error(
        metaResult.error?.message || "Meta CAPI failed"
      );
    }

    console.log("Subscribe event sent:", {
      visitor_id: visitor.visitor_id,
      events_received: metaResult.events_received
    });

    return res.status(200).json({
      ok: true,
      join_request_received: true,
      event_name: "Subscribe",
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
