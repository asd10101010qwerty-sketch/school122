import { sendTodayGreeting } from "../lib/bot.js";

// Called by Vercel Cron (see vercel.json). Vercel sends "Authorization: Bearer $CRON_SECRET"
// when CRON_SECRET is set. Even without it, the greeting goes out only on its date and only once.
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).send("unauthorized");
  }
  try {
    const result = await sendTodayGreeting();
    console.log("greet", result);
    res.status(200).json(result);
  } catch (e) {
    console.error("greet failed", e);
    res.status(500).send("error");
  }
}
