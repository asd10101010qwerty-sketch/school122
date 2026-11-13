import { bot, ready } from "../lib/bot.js";

// Telegram -> POST /api/webhook. Long work (broadcasts) continues via waitUntil after we reply.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("122-maktab bot is running");
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.WEBHOOK_SECRET) {
    return res.status(401).send("unauthorized");
  }
  try {
    await ready();
    const update = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    await bot.handleUpdate(update);
  } catch (e) {
    console.error("update failed", e);
  }
  res.status(200).end();
}
