// GET /api/feed[?before=ID] -> live posts of the public Telegram channel as JSON.
// Reads the public preview page t.me/s/<channel> (no bot token needed) and parses it.
const CHANNEL = "maaktaab_122";
// Posts whose photos are certificates with pupils' personal data: show text only.
const HIDE_MEDIA = new Set([9, 10]);

const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Site rule: no emoji anywhere in the UI.
const EMOJI = /(\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}️‍⃣])/gu;

// Keep only safe inline formatting + links; everything else becomes escaped text.
function cleanText(html) {
  html = html
    .replace(/<i class="emoji"[^>]*>[\s\S]*?<\/i>/g, "")
    .replace(/<tg-emoji[^>]*>[\s\S]*?<\/tg-emoji>/g, "");
  let out = "";
  const re = /<(\/?)([a-z0-9-]+)([^>]*)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) { out += esc(decode(m[4]).replace(EMOJI, "")); continue; }
    const [, close, tag0, attrs] = m;
    const tag = tag0.toLowerCase();
    if (tag === "br") { out += "<br>"; continue; }
    if (["b", "strong", "i", "em", "u", "s", "code", "pre", "blockquote"].includes(tag)) { out += `<${close}${tag}>`; continue; }
    if (tag === "a") {
      if (close) { out += "</a>"; continue; }
      const href = decode((attrs.match(/href="([^"]*)"/) || [])[1] || "");
      out += /^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener">` : "<a>";
    }
  }
  return out.replace(/<br>[ \t]+/g, "<br>").replace(/^(\s|<br>)+|(\s|<br>)+$/g, "").replace(/(<br>\s*){3,}/g, "<br><br>");
}

function parse(page) {
  const posts = [];
  for (const block of page.split('<div class="tgme_widget_message_wrap').slice(1)) {
    const id = +((block.match(/data-post="[^/"]+\/(\d+)"/) || [])[1] || 0);
    if (!id || /class="tgme_widget_message[^"]*service_message/.test(block)) continue;

    const media = [];
    const mediaRe = /<a class="tgme_widget_message_(photo_wrap|video_player)[\s\S]*?(?=<a class="tgme_widget_message_(?:photo_wrap|video_player)|<div class="tgme_widget_message_(?:text|footer|link_preview)|$)/g;
    let mm;
    while ((mm = mediaRe.exec(block))) {
      const chunk = mm[0];
      const bg = (chunk.match(/background-image:url\('([^']+)'\)/) || [])[1];
      if (mm[1] === "photo_wrap") { if (bg) media.push({ type: "photo", src: bg }); }
      else {
        const src = (chunk.match(/<video src="([^"]+)"/) || [])[1];
        media.push({ type: "video", src: src ? decode(src) : null, thumb: bg || null,
          duration: (chunk.match(/message_video_duration[^>]*>([^<]+)</) || [])[1] || null });
      }
    }

    const textHtml = (block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const text = textHtml ? cleanText(textHtml) : "";
    if (!text && !media.length) continue;

    posts.push({
      id,
      url: `https://t.me/${CHANNEL}/${id}`,
      date: (block.match(/<time datetime="([^"]+)"/) || [])[1] || null,
      views: (block.match(/tgme_widget_message_views">([^<]+)</) || [])[1] || null,
      text,
      media: HIDE_MEDIA.has(id) ? [] : media,
    });
  }
  return posts;
}

export default async function handler(req, res) {
  const before = parseInt(req.query?.before, 10);
  const url = `https://t.me/s/${CHANNEL}` + (before > 0 ? `?before=${before}` : "");
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SchoolSiteFeed/1.0)", "Accept-Language": "en" } });
    if (!r.ok) throw new Error("telegram " + r.status);
    const page = await r.text();
    const posts = parse(page).sort((a, b) => a.id - b.id);
    const title = decode((page.match(/<div class="tgme_channel_info_header_title"><span[^>]*>([^<]*)</) || [])[1] || "122-Maktab");
    const avatar = (page.match(/<i class="tgme_page_photo_image[^"]*"[^>]*><img src="([^"]+)"/) || [])[1] || null;
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=30");
    res.status(200).json({ channel: CHANNEL, title, avatar, posts, hasOlder: /tme_messages_more[^>]*data-before=/.test(page) });
  } catch (e) {
    console.error("feed failed", e);
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: "feed_unavailable" });
  }
}

export { parse };
