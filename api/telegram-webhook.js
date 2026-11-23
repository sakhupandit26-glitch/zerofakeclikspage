export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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
    // 1. Verify Telegram secret
    const receivedSecret = String(
      req.headers["x-telegram-bot-api-secret-token"] || ""
    ).trim();

    const expectedSecret = String(
      process.env.TELEGRAM_WEBHOOK_SECRET || ""
    ).trim();

    if (!receivedSecret || !expectedSecret ||
        receivedSecret !== expectedSecret) {
      console.log("Webhook secret verification failed");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const update = req.body || {};

    console.log("Telegram update keys:", Object.keys(update));

    // 2. Supabase configuration
    supabaseUrl = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
    supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables missing");
    }

    // 3. JOIN REQUEST: Save user only, NO Subscribe event
    if (update.chat_join_request) {
      const request = update.chat_join_request;

      if (String(request.chat.id) !== String(process.env.CHANNEL_ID)) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Wrong channel"
        });
      }

      const inviteLink = request.invite_link?.invite_link;

      if (!inviteLink) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Invite link missing"
        });
      }

      const search = new URLSearchParams({
        invite_link: `eq.${inviteLink}`,
        select: "id,visitor_id",
        limit: "1"
      });

      const lookup = await dbRequest(
        `telegram_visitors?${search.toString()}`
      );

      if (!lookup.ok) {
        throw new Error("Supabase lookup failed: " + await lookup.text());
      }

      const rows = await lookup.json();
      const visitor = rows[0];

      if (!visitor) {
        console.log("Visitor not found for join request");

        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Visitor not found"
        });
      }

      const save = await dbRequest(
        `telegram_visitors?id=eq.${encodeURIComponent(visitor.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            telegram_user_id: request.from.id,
            telegram_username: request.from.username || null
          })
        }
      );

      if (!save.ok) {
        throw new Error("Could not save join request: " + await save.text());
      }

      console.log("Join request saved. Waiting for admin approval:", {
        visitor_id: visitor.visitor_id
      });

      return res.status(200).json({
        ok: true,
        join_request_saved: true,
        subscribe_sent: false,
        message: "Waiting for admin approval"
      });
    }

    // 4. CHAT MEMBER: Fire event only after approval
    if (update.chat_member) {
      const memberUpdate = update.chat_member;

      if (String(memberUpdate.chat.id) !== String(process.env.CHANNEL_ID)) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Wrong channel"
        });
      }

      const oldStatus = memberUpdate.old_chat_member?.status;
      const newStatus = memberUpdate.new_chat_member?.status;
      const telegramUser = memberUpdate.new_chat_member?.user;

      const memberStatuses = ["member", "administrator", "creator"];

      const wasMember = memberStatuses.includes(oldStatus);
      const isNowMember = memberStatuses.includes(newStatus);

      if (wasMember || !isNowMember || !telegramUser?.id) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Not a new membership approval"
        });
      }

      console.log("Join request approved:", telegramUser.id);

      // 5. Find pending visitor by Telegram user ID
      const search = new URLSearchParams({
        telegram_user_id: `eq.${telegramUser.id}`,
        meta_event_sent: "eq.false",
        select: "id,visitor_id,fbp,fbc,ip_address,user_agent,meta_event_sent",
        order: "created_at.desc",
        limit: "1"
      });

      const lookup = await dbRequest(
        `telegram_visitors?${search.toString()}`
      );

      if (!lookup.ok) {
        throw new Error("Supabase lookup failed: " + await lookup.text());
      }

      const rows = await lookup.json();
      const visitor = rows[0];

      if (!visitor) {
        console.log("No pending visitor found for approved user");

        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "No pending visitor found"
        });
      }

      console.log("Approved visitor found:", visitor.visitor_id);

      // 6. Check Meta credentials before claiming event
      const pixelId = process.env.META_PIXEL_ID;
      const accessToken = process.env.META_ACCESS_TOKEN;

      if (!pixelId || !accessToken) {
        throw new Error("Meta credentials missing");
      }

      // 7. Claim event to prevent duplicates
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
            joined: true,
            joined_at: new Date().toISOString()
          })
        }
      );

      if (!claim.ok) {
        throw new Error("Could not claim visitor: " + await claim.text());
      }

      const claimedRows = await claim.json();

      if (!claimedRows.length) {
        return res.status(200).json({
          ok: true,
          ignored: true,
          reason: "Subscribe already claimed"
        });
      }

      // 8. Prepare Meta matching data
      const userData = {};

      if (visitor.fbp) userData.fbp = visitor.fbp;
      if (visitor.fbc) userData.fbc = visitor.fbc;

      if (visitor.ip_address) {
        userData.client_ip_address = visitor.ip_address;
      }

      if (visitor.user_agent) {
        userData.client_user_agent = visitor.user_agent;
      }

      // 9. Send Subscribe ONLY after approval
      const eventData = {
        data: [{
          event_name: "Subscribe",
          event_time: Math.floor(Date.now() / 1000),
          event_id: `telegram_subscribe_${visitor.visitor_id}`,
          action_source: "website",
          user_data: userData
        }]
      };

      if (process.env.META_TEST_EVENT_CODE) {
        eventData.test_event_code =
          process.env.META_TEST_EVENT_CODE.trim();
      }

      const metaUrl =
        `https://graph.facebook.com/v22.0/${pixelId}/events` +
        `?access_token=${encodeURIComponent(accessToken)}`;

      console.log("Sending approved Subscribe event to Meta");

      const metaResponse = await fetch(metaUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(eventData)
      });

      const metaResult = await metaResponse.json();

      if (!metaResponse.ok || metaResult.error) {
        await dbRequest(
          `telegram_visitors?id=eq.${encodeURIComponent(visitor.id)}`,
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

      // 10. FINAL META DEBUG
      console.log("META FINAL DEBUG:", {
        pixel_id: pixelId,
        test_code_attached: !!eventData.test_event_code,
        test_code: eventData.test_event_code || "MISSING",
        meta_response: metaResult
      });

      console.log("Approved Subscribe event sent:", {
        visitor_id: visitor.visitor_id,
        events_received: metaResult.events_received
      });

      return res.status(200).json({
        ok: true,
        event_name: "Subscribe",
        fired_after_approval: true,
        meta_event_sent: true,
        meta_events_received: metaResult.events_received
      });
    }

    // 11. Ignore unrelated Telegram updates
    return res.status(200).json({
      ok: true,
      ignored: true,
      reason: "Unrelated Telegram update"
    });

  } catch (error) {
    console.error("Telegram webhook error:", error.message);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
}
