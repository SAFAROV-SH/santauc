
const TelegramBot = require('node-telegram-bot-api');

// =============================================================
// SOZLAMALAR — o'zingizga moslang
// =============================================================
const CONFIG = {
  // Bot tokeni (config.php dagi BOT_TOKEN bilan bir xil bo'lsin)
   BOT_TOKEN: '8701078642:AAGGkhmpEWdiaREB28b6W0SVMQQptlbKxno',
  // api.php manzili (to'liq URL) — barcha amallar (auth, buy, payment...) shu orqali
   API_URL: 'https://connectuz.uz/userbot/api.php',
  // "Webda ochish" tugmasi ochadigan Mini App havolasi (O'ZINGIZ KIRITASIZ)
    WEB_APP_URL: 'https://connectuz.uz/userbot/index.php',
  BOT_USERNAME: 'SantaUcShop_bot',
  START_IMAGE: 'https://connectuz.uz/userbot/images/santa.png',
  SUPPORT_USERNAME: '@uc_santa',

  // Qo'llanma matni (HTML)
  GUIDE_TEXT:
    "<b>📖 Qo'llanma</b>\n\n" +
    "1️⃣ <b>O'yinlar</b> — o'yinni va paketni tanlab, ID va nik kiriting.\n" +
    "2️⃣ <b>Pul kiritish</b> — summani tanlang, kelgan kartaga ko'rsatilgan " +
    "<b>aniq summani</b> o'tkazing. 1 daqiqada balansga tushadi.\n" +
    "3️⃣ <b>Hisobim</b> — balansingiz va referral havolangiz.\n\n" +
    "❗ To'lovda albatta <b>ko'rsatilgan aniq summani</b> yuboring, aks holda " +
    "avtomatik tushmaydi.",
};

// =============================================================
// BOT
// =============================================================
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// Foydalanuvchi sessiyalari (RAM da). Kalit: telegram user id
// { chatId, messageId, dbUserId, balance, game, packages, buy, awaiting }
const sessions = new Map();

// Foydalanuvchining profil rasmini olishga urinadi (ixtiyoriy — auth ga uzatiladi)
async function getPhotoUrl(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos && photos.total_count > 0) {
      const fileId = photos.photos[0][0].file_id;
      return await bot.getFileLink(fileId); // telegram fayl havolasi
    }
  } catch (e) { /* rasm yo'q yoki yopiq */ }
  return '';
}

// =============================================================
// YORDAMCHI FUNKSIYALAR
// =============================================================
function fmt(n) {
  return Math.round(Number(n || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Foydalanuvchi profiliga havola (lichkasi)
function userLink(user) {
  if (user.username) return `https://t.me/${user.username}`;
  return `tg://user?id=${user.id}`;
}

// api.php ga so'rov — WEB bilan bir xil endpoint
async function apiCall(action, telegramId, payload = {}) {
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, telegram_id: telegramId, ...payload }),
    });
    return await res.json();
  } catch (e) {
    console.error('[api]', action, e.message);
    return { ok: false, error: 'network' };
  }
}

// Sessiyani olish yoki yaratish + foydalanuvchini API orqali saqlash
// Foydalanuvchi users jadvaliga api.php ('auth' amali) orqali qo'shiladi —
// web bilan 100% bir xil (getOrCreateUser).
//   opts.save = true  -> /start: to'liq saqlash (rasm + referral bilan)
//   opts.ref          -> referral user_id (/start payload)
async function ensureSession(user, chatId, messageId, opts = {}) {
  let s = sessions.get(user.id);
  if (!s) {
    s = { chatId, messageId, dbUserId: null, balance: 0, game: null, packages: [], buy: null, awaiting: null };
    sessions.set(user.id, s);
  }
  if (chatId) s.chatId = chatId;
  if (messageId) s.messageId = messageId;

  // /start da yoki user hali aniqlanmagan bo'lsa — api.php 'auth' orqali saqlaymiz
  if (opts.save || !s.dbUserId) {
    let photoUrl = '';
    if (opts.save) photoUrl = await getPhotoUrl(user.id);

    const auth = await apiCall('auth', user.id, {
      first_name: user.first_name || '',
      last_name: user.last_name || '',
      username: user.username || '',
      photo_url: photoUrl,
      ref_user_id: opts.ref ? (parseInt(opts.ref) || null) : null,
    });
    if (auth.ok) {
      s.dbUserId = auth.user_id;
      s.balance = auth.balance;
    }
  }
  return s;
}

// Balansni api.php orqali yangilash (web bilan bir xil manba)
async function refreshBalance(user, s) {
  const r = await apiCall('balance', user.id);
  if (r.ok) s.balance = r.balance;
  return s.balance;
}

// Asosiy UI edit: rasm o'zgarmaydi, faqat caption + tugmalar
async function editUI(s, caption, keyboard) {
  try {
    await bot.editMessageCaption(caption, {
      chat_id: s.chatId,
      message_id: s.messageId,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    // "message is not modified" — e'tiborsiz qoldiramiz
    if (!/not modified/i.test(e.message)) console.error('[editUI]', e.message);
  }
}

// =============================================================
// EKRANLAR (render)
// =============================================================

// --- Asosiy menyu ---
function mainMenuCaption(user) {
  const link = userLink(user);
  const name = esc(user.first_name || 'Foydalanuvchi');
  return (
    `<b>'<tg-emoji emoji-id="5397981293512243749">✨</tg-emoji>Assalomu alaykum <a href="${link}">${name}</a></b>\n\n` +
    `Donat qilish uchun botga hush kelibsiz\n` +
    `Bo'limlarni tanlang:`
  );
}
function mainMenuKeyboard() {
  return [
    [ { text: "🎮 O'yinlar", callback_data: 'games' }, { text: ' Pul kiritish', callback_data: 'topup' } ],
    [ { text: '👛 Hisobim', callback_data: 'account' }, { text: "📖 Qo'llanma", callback_data: 'guide' } ],
    [ { text: '✉️ Murojat', callback_data: 'contact' } ],
    [ { text: '🌐 Webda ochish', web_app: { url: CONFIG.WEB_APP_URL } } ],
  ];
}
async function showMain(user, s) {
  s.awaiting = null;
  s.buy = null;
  await editUI(s, mainMenuCaption(user), mainMenuKeyboard());
}

// --- O'yinlar ro'yxati ---
async function showGames(user, s) {
  s.awaiting = null;
  const r = await apiCall('games', user.id);
  if (!r.ok || !r.games || r.games.length === 0) {
    return editUI(s, "🎮 <b>O'yinlar</b>\n\nHozircha o'yin yo'q.", [[{ text: '⬅️ Orqaga', callback_data: 'main' }]]);
  }
  const rows = [];
  for (let i = 0; i < r.games.length; i += 2) {
    const row = [];
    for (const g of r.games.slice(i, i + 2)) row.push({ text: g.name, callback_data: `game:${g.id}` });
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Orqaga', callback_data: 'main' }]);
  await editUI(s, "🎮 <b>O'yinlar</b>\n\nO'yinni tanlang:", rows);
}

// --- Tanlangan o'yin paketlari ---
async function showPackages(user, s, gameId) {
  s.awaiting = null;
  const r = await apiCall('packages', user.id, { game_id: gameId });
  if (!r.ok) return editUI(s, '❌ Paketlar yuklanmadi.', [[{ text: '⬅️ Orqaga', callback_data: 'games' }]]);

  s.game = r.game;
  s.packages = r.packages || [];
  const cur = r.game.currency;

  if (s.packages.length === 0) {
    return editUI(s, `🎮 <b>${esc(r.game.name)}</b>\n\nBu o'yinda paket yo'q.`, [[{ text: '⬅️ Orqaga', callback_data: 'games' }]]);
  }

  const rows = s.packages.map((p) => ([{
    text: `${fmt(p.amount)} ${cur} — ${fmt(p.price)} so'm${p.is_popular ? ' ⭐' : ''}`,
    callback_data: `pkg:${p.id}`,
  }]));
  rows.push([{ text: '⬅️ Orqaga', callback_data: 'games' }]);

  await editUI(s, `🎮 <b>${esc(r.game.name)}</b>\n\nPaketni tanlang:`, rows);
}

// --- Paket tanlandi → sotib olish (ID so'rash) ---
async function selectPackage(user, s, pkgId) {
  const pkg = s.packages.find((p) => p.id === pkgId);
  if (!pkg) return showGames(user, s);

  await refreshBalance(user, s);
  const cur = s.game ? s.game.currency : '';

  // Balans yetarli emas — web dagidek
  if (s.balance < pkg.price) {
    return editUI(
      s,
      `⚠️ <b>Balans yetarli emas</b>\n\n` +
      `Paket: <b>${fmt(pkg.amount)} ${cur}</b> — ${fmt(pkg.price)} so'm\n` +
      `Balansingiz: <b>${fmt(s.balance)} so'm</b>\n\n` +
      `Hisobingizni to'ldiring.`,
      [
        [{ text: '💳 Pul kiritish', callback_data: 'topup' }],
        [{ text: '⬅️ Orqaga', callback_data: `game:${s.game.id}` }],
      ]
    );
  }

  s.buy = { pkg };
  s.awaiting = 'player_id';
  await editUI(
    s,
    `🎮 <b>${esc(s.game.name)}</b>\n` +
    `Paket: <b>${fmt(pkg.amount)} ${cur}</b> — ${fmt(pkg.price)} so'm\n\n` +
    `🆔 <b>${esc(s.game.name)} ID</b> raqamingizni yuboring:`,
    [[{ text: '❌ Bekor qilish', callback_data: `game:${s.game.id}` }]]
  );
}

// --- Pul kiritish: summa tanlash ---
async function showTopup(user, s) {
  s.awaiting = null;
  const amounts = [10000, 20000, 50000, 100000];
  const rows = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(amounts.slice(i, i + 2).map((a) => ({ text: `${fmt(a)} so'm`, callback_data: `amt:${a}` })));
  }
  rows.push([{ text: '✏️ Boshqa summa', callback_data: 'amt_custom' }]);
  rows.push([{ text: '⬅️ Orqaga', callback_data: 'main' }]);
  await editUI(
    s,
    `💳 <b>Pul kiritish</b>\n\nSummani tanlang yoki o'zingiz kiriting.\n<i>Minimal: 1 000 so'm</i>`,
    rows
  );
}

// --- To'lov cheki yaratish (create_payment) ---
async function createPayment(user, s, amount) {
  s.awaiting = null;
  if (!amount || amount < 1000) {
    return editUI(s, "⚠️ Minimal summa 1 000 so'm.", [[{ text: '⬅️ Orqaga', callback_data: 'topup' }]]);
  }
  const r = await apiCall('create_payment', user.id, { amount });
  if (!r.ok) {
    return editUI(s, `❌ Xatolik: ${esc(r.error || '')}`, [[{ text: '⬅️ Orqaga', callback_data: 'topup' }]]);
  }

  // Qolgan vaqt (daqiqa) — expires_unix absolyut UNIX timestamp
  let ttl = '15 daqiqa';
  if (r.expires_unix) {
    const leftMin = Math.max(1, Math.round((r.expires_unix * 1000 - Date.now()) / 60000));
    ttl = `${leftMin} daqiqa`;
  }
  await editUI(
    s,
    `💳 <b>To'lov ma'lumotlari</b>\n\n` +
    `🔢 Karta: <code>${esc(r.card_number)}</code>\n` +
    `👤 Egasi: <b>${esc(r.card_owner)}</b>\n` +
    `💰 Aniq summa: <b>${fmt(r.exact_amount)} so'm</b>\n` +
    `⏳ Amal qiladi: <b>${ttl}</b>\n\n` +
    `❗️ Aynan <b>${fmt(r.exact_amount)} so'm</b> yuboring — 1 daqiqada avtomatik tushadi.`,
    [
      [{ text: '✅ To\'ladim', callback_data: 'paid' }],
      [{ text: '🔄 Balansni tekshirish', callback_data: 'account' }],
      [{ text: '⬅️ Orqaga', callback_data: 'main' }],
    ]
  );
}

// --- Hisobim (balans + referral) ---
async function showAccount(user, s) {
  s.awaiting = null;
  await refreshBalance(user, s);
  const ref = await apiCall('referrals', user.id);
  let refBlock = '';
  let refLink = `https://t.me/${CONFIG.BOT_USERNAME}`;
  if (ref.ok) {
    refLink = `https://t.me/${CONFIG.BOT_USERNAME}?start=${ref.ref_user_id}`;
    refBlock =
      `\n👥 Do'stlar: <b>${ref.ref_count}</b> ta\n` +
      `🎁 Referral havolangiz:\n<code>${esc(refLink)}</code>`;
  }
  await editUI(
    s,
    `👛 <b>Hisobim</b>\n\n` +
    `💰 Balans: <b>${fmt(s.balance)} so'm</b>` +
    refBlock,
    [
      [{ text: '💳 Pul kiritish', callback_data: 'topup' }],
      [{ text: '📤 Havolani ulashish', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('SantaUc — arzon donat!')}` }],
      [{ text: '⬅️ Orqaga', callback_data: 'main' }],
    ]
  );
}

// --- Qo'llanma ---
async function showGuide(user, s) {
  s.awaiting = null;
  await editUI(s, CONFIG.GUIDE_TEXT, [[{ text: '⬅️ Orqaga', callback_data: 'main' }]]);
}

// --- Murojat ---
async function showContact(user, s) {
  s.awaiting = null;
  const uname = CONFIG.SUPPORT_USERNAME.replace(/^@/, '');
  await editUI(
    s,
    `✉️ <b>Murojat</b>\n\nSavol yoki muammo bo'lsa, admin bilan bog'laning:\n👉 ${esc(CONFIG.SUPPORT_USERNAME)}`,
    [
      [{ text: '💬 Adminga yozish', url: `https://t.me/${uname}` }],
      [{ text: '⬅️ Orqaga', callback_data: 'main' }],
    ]
  );
}

// =============================================================
// /start — rasm + asosiy menyu YUBORISH (yangi xabar)
// =============================================================
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const startParam = (match && match[1]) ? match[1].trim() : '';

  // Rasmni yuboramiz — keyingi barcha navigatsiya SHU xabarni edit qiladi
  let sent;
  try {
    sent = await bot.sendPhoto(chatId, CONFIG.START_IMAGE, {
      caption: mainMenuCaption(user),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: mainMenuKeyboard() },
    });
  } catch (e) {
    // Rasm yuborilmasa — matn bilan (fallback)
    console.error('[sendPhoto]', e.message);
    sent = await bot.sendMessage(chatId, mainMenuCaption(user), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: mainMenuKeyboard() },
    });
  }

  // Foydalanuvchini users jadvaliga saqlaymiz (rasm + referral bilan)
  await ensureSession(user, chatId, sent.message_id, { save: true, ref: startParam });
});

// =============================================================
// INLINE TUGMALAR — callback_query
// Rasm o'chirilmaydi, faqat caption + tugmalar EDIT bo'ladi
// =============================================================
bot.on('callback_query', async (q) => {
  const user = q.from;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data || '';

  // Sessiyani tiklaymiz (bot qayta ishga tushgan bo'lsa ham)
  const s = await ensureSession(user, chatId, messageId);

  try {
    if (data === 'main')            await showMain(user, s);
    else if (data === 'games')      await showGames(user, s);
    else if (data.startsWith('game:'))  await showPackages(user, s, parseInt(data.split(':')[1]));
    else if (data.startsWith('pkg:'))   await selectPackage(user, s, parseInt(data.split(':')[1]));
    else if (data === 'topup')      await showTopup(user, s);
    else if (data.startsWith('amt:'))   await createPayment(user, s, parseInt(data.split(':')[1]));
    else if (data === 'amt_custom') {
      s.awaiting = 'amount';
      await editUI(s, "✏️ <b>Summa kiriting</b>\n\nTo'ldirmoqchi bo'lgan summangizni yuboring (so'mda).\n<i>Minimal: 1 000</i>",
        [[{ text: '⬅️ Orqaga', callback_data: 'topup' }]]);
    }
    else if (data === 'account')    await showAccount(user, s);
    else if (data === 'guide')      await showGuide(user, s);
    else if (data === 'contact')    await showContact(user, s);
    else if (data === 'paid') {
      await bot.answerCallbackQuery(q.id, {
        text: "To'lov qilingan bo'lsa 1 daqiqada balansga tushadi.",
        show_alert: true,
      });
      return;
    }
  } catch (e) {
    console.error('[callback]', data, e.message);
  }

  try { await bot.answerCallbackQuery(q.id); } catch (e) {}
});

// =============================================================
// MATNLI KIRITISH — buy (ID/nik) va custom summa
// =============================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return; // buyruqlar boshqa joyda
  const user = msg.from;
  const s = sessions.get(user.id);
  if (!s || !s.awaiting) return;

  const text = msg.text.trim();

  // Foydalanuvchi kiritgan xabarni o'chirib, ekranni toza saqlaymiz
  try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}

  // ---- Custom summa ----
  if (s.awaiting === 'amount') {
    const val = parseInt(text.replace(/\D/g, ''));
    if (!val || val < 1000) {
      return editUI(s, "⚠️ Noto'g'ri summa. Minimal 1 000 so'm.\n\nQaytadan yuboring:",
        [[{ text: '⬅️ Orqaga', callback_data: 'topup' }]]);
    }
    return createPayment(user, s, val);
  }

  // ---- Buy: O'yin ID ----
  if (s.awaiting === 'player_id') {
    if (!text) return;
    s.buy.player_id = text;
    s.awaiting = 'player_nick';
    const cur = s.game ? s.game.currency : '';
    return editUI(
      s,
      `🎮 <b>${esc(s.game.name)}</b>\n` +
      `Paket: <b>${fmt(s.buy.pkg.amount)} ${cur}</b>\n` +
      `🆔 ID: <b>${esc(text)}</b>\n\n` +
      `👤 <b>Nik (taxallus)</b> yuboring:`,
      [[{ text: '❌ Bekor qilish', callback_data: `game:${s.game.id}` }]]
    );
  }

  // ---- Buy: Nik → api buy ----
  if (s.awaiting === 'player_nick') {
    if (!text) return;
    s.buy.player_nick = text;
    s.awaiting = null;

    const r = await apiCall('buy', user.id, {
      game_id: s.game.id,
      package_id: s.buy.pkg.id,
      player_id: s.buy.player_id,
      player_nick: s.buy.player_nick,
    });

    if (!r.ok) {
      if (r.error === 'insufficient_balance') return selectPackage(user, s, s.buy.pkg.id);
      const map = {
        player_id_required: 'ID kiriting',
        player_nick_required: 'Nik kiriting',
        package_required: 'Paket tanlanmadi',
        order_failed: 'Buyurtma yaratilmadi',
      };
      return editUI(s, `❌ ${esc(map[r.error] || r.error || 'Xatolik')}`,
        [[{ text: '⬅️ Orqaga', callback_data: `game:${s.game.id}` }]]);
    }

    s.balance = r.new_balance;
    const cur = s.game ? s.game.currency : '';
    const pkg = s.buy.pkg;
    const nick = s.buy.player_nick;
    s.buy = null;
    return editUI(
      s,
      `✅ <b>Muvaffaqiyatli!</b>\n\n` +
      `<b>${fmt(pkg.amount)} ${cur}</b> — @${esc(nick)} akkauntiga yuborildi.\n` +
      `💰 Yangi balans: <b>${fmt(s.balance)} so'm</b>\n\n` +
      `Buyurtmangiz tez orada bajariladi.`,
      [
        [{ text: "🎮 Yana sotib olish", callback_data: `game:${s.game.id}` }],
        [{ text: '🏠 Asosiy menyu', callback_data: 'main' }],
      ]
    );
  }
});

// =============================================================
bot.on('polling_error', (e) => console.error('[polling]', e.code, e.message));
console.log('🤖 SantaUc bot ishga tushdi (api.php bilan bir tizimda).');
