export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Verify Telegram webhook secret
    const secret = req.headers["x-telegram-bot-api-secret-token"];

    if (
      !secret ||
      secret !== process.env.TELEGRAM_WEBHOOK_SECRET
    ) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const update = req.body;

    // 2. Check actual channel membership update
    const memberUpdate = update.chat_member;

    if (!memberUpdate) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const chatId = String(memberUpdate.chat.id);
    const expectedChatId = String(process.env.CHANNEL_ID);

    if (chatId !== expectedChatId) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const oldMember = memberUpdate.old_chat_member;
    const newMember = memberUpdate.new_chat_member;

    const isMember = (member) => {
      return (
        member.status === "member" ||
        member.status === "administrator" ||
        member.status === "creator" ||
        (member.status === "restricted" && member.is_member === true)
      );
    };

    // Only count a transition from non-member to member
    if (isMember(oldMember) || !isMember(newMember)) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // 3. Get invite link used by visitor
    const inviteLink = memberUpdate.invite_link?.invite_link;

    if (!inviteLink) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "No invite link"
      });
    }

    // 4. Find visitor in Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables missing");
    }

    const searchUrl = new URL(
      "/rest/v1/telegram_visitors",
      supabaseUrl
    );

    searchUrl.searchParams.set("invite_link", `eq.${inviteLink}`);
    searchUrl.searchParams.set("select", "*");
    searchUrl.searchParams.set("limit", "1");

    const lookup = await fetch(searchUrl, {
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`
      }
    });

    if (!lookup.ok) {
      throw new Error("Supabase lookup failed");
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

    // 5. Prevent duplicate conversions
    if (visitor.meta_event_sent || visitor.joined) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Already processed"
      });
    }

    const telegramUser = newMember.user;
    const joinedAt = new Date().toISOString();

    // 6. Update actual join status
    const updateUrl = new URL(
      "/rest/v1/telegram_visitors",
      supabaseUrl
    );

    updateUrl.searchParams.set("id", `eq.${visitor.id}`);
    updateUrl.searchParams.set("joined", "eq.false");

    const dbUpdate = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        joined: true,
        joined_at: joinedAt,
        telegram_user_id: telegramUser.id,
        telegram_username: telegramUser.username || null
      })
    });

    if (!dbUpdate.ok) {
      throw new Error("Could not update visitor");
    }

    const updatedRows = await dbUpdate.json();

    if (!updatedRows.length) {
      return res.status(200).json({
        ok: true,
        ignored: true,
        reason: "Already processed"
      });
    }

    // 7. Send Lead event to Meta CAPI
    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;

    if (!pixelId || !accessToken) {
      throw new Error("Meta credentials missing");
    }

    const crypto = await import("node:crypto");

    const eventId = crypto.randomUUID();

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
      throw new Error("Meta CAPI failed: " +
        JSON.stringify(metaResult));
    }

    // 8. Mark conversion as sent
    const markUrl = new URL(
      "/rest/v1/telegram_visitors",
      supabaseUrl
    );

    markUrl.searchParams.set("id", `eq.${visitor.id}`);

    const markResponse = await fetch(markUrl, {
      method: "PATCH",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        meta_event_sent: true
      })
    });

    if (!markResponse.ok) {
      throw new Error("Could not mark Meta event as sent");
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
