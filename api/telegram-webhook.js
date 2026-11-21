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
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables missing");
    }

    const expectedChatId = String(process.env.CHANNEL_ID);

    // Helper: Supabase request
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

    // 2. Handle incoming join request
    const joinRequest = update.chat_join_request;

    if (joinRequest) {
      if (String(joinRequest.chat.id) !== expectedChatId) {
        return res.status(200).json({ ok: true, ignored: true });
      }

      const inviteLink = joinRequest.invite_link?.invite_link;

      if (!inviteLink) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Join request has no invite link"
        });
      }

      const search = new URLSearchParams({
        invite_link: `eq.${inviteLink}`,
        select: "id",
        limit: "1"
      });

      const lookup = await dbRequest(
        `telegram_visitors?${search.toString()}`
      );

      if (!lookup.ok) {
        throw new Error("Supabase join-request lookup failed");
      }

      const rows = await lookup.json();

      if (!rows.length) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Visitor not found"
        });
      }

      const user = joinRequest.from;

      const saveUser = await dbRequest(
        `telegram_visitors?id=eq.${rows[0].id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            telegram_user_id: user.id,
            telegram_username: user.username || null
          })
        }
      );

      if (!saveUser.ok) {
        throw new Error("Could not save Telegram join-request user");
      }

      return res.status(200).json({
        ok: true,
        join_request_received: true
      });
    }

    // 3. Handle actual membership update after approval
    const memberUpdate = update.chat_member;

    if (!memberUpdate) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    if (String(memberUpdate.chat.id) !== expectedChatId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const oldMember = memberUpdate.old_chat_member;
    const newMember = memberUpdate.new_chat_member;

    function isMember(member) {
      return (
        member.status === "member" ||
        member.status === "administrator" ||
        member.status === "creator" ||
        (member.status === "restricted" && member.is_member === true)
      );
    }

    // Only count a transition from non-member to member
    if (isMember(oldMember) || !isMember(newMember)) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const telegramUser = newMember.user;
    const inviteLink = memberUpdate.invite_link?.invite_link;

    // 4. Find visitor by invite link, or by saved Telegram user ID
    let searchParams;

    if (inviteLink) {
      searchParams = new URLSearchParams({
        invite_link: `eq.${inviteLink}`,
        select: "*",
        limit: "1"
      });
    } else {
      searchParams = new URLSearchParams({
        telegram_user_id: `eq.${telegramUser.id}`,
        select: "*",
        limit: "1"
      });
    }

    const lookup = await dbRequest(
      `telegram_visitors?${searchParams.toString()}`
    );

    if (!lookup.ok) {
      throw new Error("Supabase visitor lookup failed");
    }

    const visitors = await lookup.json();
    const visitor = visitors[0];

    if (!visitor) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Visitor not found"
      });
    }

    if (visitor.meta_event_sent || visitor.joined) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Already processed"
      });
    }

    // 5. Check Meta credentials
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      throw new Error("Meta credentials missing");
    }

    // Stable event ID helps with retry deduplication
    const eventId = `telegram_lead_${visitor.visitor_id}`;

    const userData = {};

    if (visitor.fbp) userData.fbp = visitor.fbp;
    if (visitor.fbc) userData.fbc = visitor.fbc;

    if (visitor.ip_address) {
      userData.client_ip_address = visitor.ip_address;
    }

    if (visitor.user_agent) {
      userData.client_user_agent = visitor.user_agent;
    }

    const eventData = {
      data: [{
        event_name: "Lead",
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        action_source: "website",
        user_data: userData
      }]
    };

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

    // 6. Mark joined only after Meta accepts the event
    const updateParams = new URLSearchParams({
      id: `eq.${visitor.id}`,
      meta_event_sent: "eq.false"
    });

    const dbUpdate = await dbRequest(
      `telegram_visitors?${updateParams.toString()}`,
      {
        method: "PATCH",
        headers: {
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          joined: true,
          joined_at: new Date().toISOString(),
          telegram_user_id: telegramUser.id,
          telegram_username: telegramUser.username || null,
          meta_event_sent: true
        })
      }
    );

    if (!dbUpdate.ok) {
      throw new Error("Could not mark visitor as processed");
    }

    return res.status(200).json({
      ok: true,
      joined: true,
      meta_event_sent: true
    });

  } catch (error) {
    console.error("Telegram webhook error:", error);

    return res.status(500).json({
      ok: false,
      error: "Webhook processing failed"
    });
  }
}
