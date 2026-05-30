import { config } from "./config.js";
import { logEvent } from "./logger.js";

function telegramConfigured() {
  return Boolean(config.telegram.botToken && config.telegram.chatId);
}

export async function notifySellerTelegram({ body }) {
  if (!telegramConfigured()) {
    logEvent("telegram_seller_skipped", {
      hasBotToken: Boolean(config.telegram.botToken),
      hasChatId: Boolean(config.telegram.chatId)
    });
    return { skipped: true };
  }

  const text = String(body || "").trim() || "Notifica ExpoCar";
  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegram.chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    const message = data.description || `Telegram error ${response.status}`;
    logEvent("telegram_seller_failed", { error: message });
    throw new Error(message);
  }

  logEvent("telegram_seller_sent", {
    chatId: config.telegram.chatId,
    messageId: data.result?.message_id
  });
  return data.result || { ok: true };
}

export async function getTelegramUpdates() {
  if (!config.telegram.botToken) {
    return { skipped: true, updates: [] };
  }

  const response = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/getUpdates`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.description || `Telegram error ${response.status}`);
  }

  return {
    skipped: false,
    updates: (data.result || []).map((update) => ({
      updateId: update.update_id,
      chatId: update.message?.chat?.id || update.channel_post?.chat?.id || update.my_chat_member?.chat?.id,
      chatType: update.message?.chat?.type || update.channel_post?.chat?.type || update.my_chat_member?.chat?.type,
      from: update.message?.from?.username || update.message?.from?.first_name || "",
      text: update.message?.text || ""
    }))
  };
}
