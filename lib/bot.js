// 122-maktab bot — serverless (Vercel webhook) version.
// Storage: Upstash Redis.
//   user:<id>        hash  grade, letter, surname, name, username, created_at
//   users:active     set   ids that receive channel posts
//   users:all        set   every registered id
//   state:<id>       json  registration progress (expires in 1 day)
//   post:<chat>:<id> flag  dedupe for Telegram webhook retries
//   album:<gid>      list  message ids of one channel album
import { Bot, InlineKeyboard, InputFile, GrammyError } from "grammy";
import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";

const env = process.env;
const redis = new Redis({
  url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL,
  token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN,
});
const CHANNEL = (env.CHANNEL || "@maaktaab_122").trim();
const ADMIN_IDS = new Set((env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean).map(Number));
const LETTERS = ["A", "B", "V", "G", "D", "E"];
const NAME_RE = /^[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳʻʼ'‘’`\- ]{2,40}$/u;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const bot = new Bot(env.BOT_TOKEN);
let initPromise;
export const ready = () => (initPromise ??= bot.init());

// ---------- storage ----------
const getState = uid => redis.get(`state:${uid}`);
const setState = (uid, s) => redis.set(`state:${uid}`, s, { ex: 86400 });
const clearState = uid => redis.del(`state:${uid}`);

async function getUser(uid) {
  const u = await redis.hgetall(`user:${uid}`);
  return u && u.surname ? u : null;
}

async function saveUser(uid, d, username) {
  const p = redis.pipeline();
  p.hset(`user:${uid}`, {
    grade: String(d.grade), letter: d.letter, surname: d.surname, name: d.name,
    username: username || "", created_at: new Date().toISOString().slice(0, 19),
  });
  p.sadd("users:active", uid);
  p.sadd("users:all", uid);
  await p.exec();
}

const deactivate = uid => redis.srem("users:active", uid);

async function loadUsers(setKey) {
  const ids = await redis.smembers(setKey);
  if (!ids.length) return [];
  const p = redis.pipeline();
  ids.forEach(id => p.hgetall(`user:${id}`));
  const rows = await p.exec();
  return rows.map((u, i) => ({ id: ids[i], ...u })).filter(u => u.surname);
}

// ---------- texts & keyboards ----------
const profileText = u => `Sinf: ${u.grade}-${u.letter}\nFamiliya: ${u.surname}\nIsm: ${u.name}`;
const cleanName = s => { s = s.trim().replace(/\s+/g, " "); return s.charAt(0).toUpperCase() + s.slice(1); };

function kbGrades() {
  const kb = new InlineKeyboard();
  for (let g = 1; g <= 11; g++) {
    kb.text(`${g}-sinf`, `g:${g}`);
    if (g % 4 === 0) kb.row();
  }
  return kb;
}
const kbLetters = () => {
  const kb = new InlineKeyboard();
  LETTERS.forEach(l => kb.text(l, `l:${l}`));
  return kb.row().text("Orqaga", "back");
};
const kbConfirm = () => new InlineKeyboard().text("Tasdiqlash", "ok").text("Qayta kiritish", "redo");

async function askGrade(ctx) {
  await setState(ctx.from.id, { step: "grade" });
  await ctx.reply("Sinfingizni tanlang:", { reply_markup: kbGrades() });
}

// ---------- private chat ----------
const pm = bot.chatType("private");

pm.command("start", async ctx => {
  const u = await getUser(ctx.from.id);
  if (u) {
    await clearState(ctx.from.id);
    return ctx.reply("Siz ro‘yxatdan o‘tgansiz.\n\n" + profileText(u) +
      "\n\nMaktab kanalidagi barcha e’lonlar shu yerga keladi.\nMa’lumotlarni o‘zgartirish: /edit");
  }
  await ctx.reply("Assalomu alaykum! 122-maktab botiga xush kelibsiz.\n" +
    "Ro‘yxatdan o‘tganingizdan so‘ng maktab e’lonlari shu yerga keladi.");
  await askGrade(ctx);
});

pm.command("edit", askGrade);

pm.command("profile", async ctx => {
  const u = await getUser(ctx.from.id);
  await ctx.reply(u ? profileText(u) + "\n\nO‘zgartirish: /edit" : "Siz hali ro‘yxatdan o‘tmagansiz. /start");
});

// ---------- admin ----------
const admin = pm.filter(ctx => ADMIN_IDS.has(ctx.from.id));

admin.command("stats", async ctx => {
  const users = await loadUsers("users:active");
  const counts = {};
  users.forEach(u => { const k = `${u.grade}-${u.letter}`; counts[k] = (counts[k] || 0) + 1; });
  const lines = Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([k, n]) => `${k}: ${n}`);
  await ctx.reply(`Faol foydalanuvchilar: ${users.length}\n\n` + (lines.join("\n") || "Hali hech kim yo‘q"));
});

admin.command("export", async ctx => {
  const all = await loadUsers("users:all");
  const active = new Set((await redis.smembers("users:active")).map(String));
  all.sort((a, b) => (+a.grade - +b.grade) || String(a.letter).localeCompare(b.letter) ||
    String(a.surname).localeCompare(b.surname) || String(a.name).localeCompare(b.name));
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Sinf", "Familiya", "Ism", "Telegram", "Faol", "Ro‘yxatdan o‘tgan"].map(esc).join(";")];
  for (const u of all) {
    lines.push([`${u.grade}-${u.letter}`, u.surname, u.name, u.username ? "@" + u.username : "",
      active.has(String(u.id)) ? "ha" : "yo‘q", u.created_at].map(esc).join(";"));
  }
  const data = Buffer.from("﻿" + lines.join("\r\n"), "utf8"); // BOM for Excel
  await ctx.replyWithDocument(new InputFile(data, "122-maktab-users.csv"));
});

// ---------- registration buttons ----------
bot.on("callback_query:data", async ctx => {
  const uid = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const st = (await getState(uid)) || {};

  if (st.step === "grade" && data.startsWith("g:")) {
    const grade = data.slice(2);
    await setState(uid, { step: "letter", grade });
    await ctx.editMessageText(`${grade}-sinf. Endi sinf harfini tanlang:`, { reply_markup: kbLetters() });
  } else if (st.step === "letter" && data === "back") {
    await setState(uid, { step: "grade" });
    await ctx.editMessageText("Sinfingizni tanlang:", { reply_markup: kbGrades() });
  } else if (st.step === "letter" && data.startsWith("l:")) {
    const letter = data.slice(2);
    await setState(uid, { ...st, step: "surname", letter });
    await ctx.editMessageText(`Sinf: ${st.grade}-${letter}`);
    await ctx.reply("Familiyangizni yozing:");
  } else if (st.step === "confirm" && data === "ok") {
    await saveUser(uid, st, ctx.from.username);
    await clearState(uid);
    await ctx.editMessageText("Rahmat! Siz ro‘yxatdan o‘tdingiz.\n\n" + profileText(st) +
      "\n\nEndi maktab kanalidagi barcha e’lonlar shu yerga keladi.");
    console.log("registered", uid, `${st.grade}-${st.letter}`, st.surname, st.name);
  } else if (st.step === "confirm" && data === "redo") {
    await ctx.editMessageReplyMarkup();
    await askGrade(ctx);
  } else {
    return ctx.answerCallbackQuery({ text: "Bu tugma eskirgan. /start ni bosing.", show_alert: true });
  }
  await ctx.answerCallbackQuery();
});

// ---------- registration text input & fallback ----------
pm.on("message", async ctx => {
  const uid = ctx.from.id;
  const st = await getState(uid);
  const text = ctx.message.text?.trim();

  if (st?.step === "surname" || st?.step === "name") {
    const what = st.step === "surname" ? "Familiya" : "Ism";
    if (!text) return ctx.reply("Iltimos, matn ko‘rinishida yozing.");
    if (!NAME_RE.test(text)) return ctx.reply(`${what}ni faqat harflar bilan yozing (2–40 ta belgi). Qaytadan kiriting:`);
    if (st.step === "surname") {
      await setState(uid, { ...st, step: "name", surname: cleanName(text) });
      return ctx.reply("Ismingizni yozing:");
    }
    const next = { ...st, step: "confirm", name: cleanName(text) };
    await setState(uid, next);
    return ctx.reply("Ma’lumotlaringizni tekshiring:\n\n" + profileText(next), { reply_markup: kbConfirm() });
  }
  if (st?.step) return ctx.reply("Iltimos, yuqoridagi tugmalardan birini tanlang.");

  if (await getUser(uid)) return ctx.reply("E’lonlar maktab kanalidan avtomatik keladi.\nMa’lumotlaringiz: /profile");
  return ctx.reply("Ro‘yxatdan o‘tish uchun /start ni bosing.");
});

// ---------- channel posts -> users ----------
function isOurChannel(chat) {
  if (/^-?\d+$/.test(CHANNEL)) return String(chat.id) === CHANNEL;
  return (chat.username || "").toLowerCase() === CHANNEL.replace(/^@/, "").toLowerCase();
}

async function sendTo(uid, fromChat, ids) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (ids.length === 1) await bot.api.copyMessage(uid, fromChat, ids[0]);
      else await bot.api.copyMessages(uid, fromChat, ids);
      return true;
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.error_code === 429) { await sleep(((e.parameters?.retry_after) || 1) * 1000 + 500); continue; }
        if (e.error_code === 403 || /chat not found/i.test(e.description)) { await deactivate(uid); return false; }
      }
      console.warn("send failed", uid, e.description || e.message);
      return false;
    }
  }
  return false;
}

async function broadcast(fromChat, ids) {
  const users = await redis.smembers("users:active");
  let ok = 0;
  for (const uid of users) {
    if (await sendTo(uid, fromChat, ids)) ok++;
    await sleep(40); // ~25 msg/s, under Telegram's limit
  }
  console.log(`post ${ids.join(",")} delivered to ${ok}/${users.length}`);
}

async function flushAlbum(gid, fromChat) {
  await sleep(2500); // let the other album parts arrive
  const ids = (await redis.lrange(`album:${gid}`, 0, -1)).map(Number).sort((a, b) => a - b);
  await broadcast(fromChat, [...new Set(ids)]);
}

bot.on("channel_post", async ctx => {
  const m = ctx.channelPost;
  if (!isOurChannel(m.chat)) return;
  // Telegram may retry a webhook — process each post only once
  const fresh = await redis.set(`post:${m.chat.id}:${m.message_id}`, 1, { nx: true, ex: 3 * 86400 });
  if (!fresh) return;

  if (m.media_group_id) {
    const gid = m.media_group_id;
    await redis.rpush(`album:${gid}`, m.message_id);
    await redis.expire(`album:${gid}`, 600);
    const leader = await redis.set(`album:${gid}:lead`, 1, { nx: true, ex: 600 });
    if (leader) waitUntil(flushAlbum(gid, m.chat.id));
    return;
  }
  waitUntil(broadcast(m.chat.id, [m.message_id]));
});

bot.catch(err => console.error("bot error", err.error));
