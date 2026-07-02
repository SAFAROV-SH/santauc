const TelegramBot = require('node-telegram-bot-api');

// =============================================================
// SOZLAMALAR
// =============================================================
const CONFIG = {
  GAME_STYLES: {
    1: { style: 'primary', icon_custom_emoji_id: '5204252919565657978' },
    2: { style: 'success', icon_custom_emoji_id: '5870633910337015697' },
    // yangi o'yin qo'shsangiz shu yerga yozing:
    // 3: { style: 'danger', icon_custom_emoji_id: '...' },
  },
  
  BOT_TOKEN: '8701078642:AAGGkhmpEWdiaREB28b6W0SVMQQptlbKxno',
  API_URL: 'https://connectuz.uz/userbot/api.php',
  WEB_APP_URL: 'https://connectuz.uz/userbot/index.php',
  BOT_USERNAME: 'SantaUcShop_bot',
  START_IMAGE: 'https://connectuz.uz/userbot/images/santa.png',
  SUPPORT_USERNAME: '@uc_santa',
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

const sessions = new Map();

// =============================================================
// YORDAMCHI — tezlashtirilgan
// =============================================================
function fmt(n) {
  return Math.round(Number(n || 0)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function userLink(user) {
  return user.username ? `https://t.me/${user.username}` : `tg://user?id=${user.id}`;
}

// API — abort controller bilan timeout
async function apiCall(action, telegramId, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, telegram_id: telegramId, ...payload }),
      signal: controller.signal,
    });
    return await res.json();
  } catch (e) {
    console.error('[api]', action, e.message);
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// Profil rasmi — fire-and-forget emas, faqat /start da
async function getPhotoUrl(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos?.total_count > 0) return await bot.getFileLink(photos.photos[0][0].file_id);
  } catch (_) {}
  return '';
}

// Sessiya — minimal auth
function getSession(userId) {
  return sessions.get(userId) || null;
}

async function ensureSession(user, chatId, messageId, opts = {}) {
  let s = sessions.get(user.id);
  if (s) {
    if (chatId) s.chatId = chatId;
    if (messageId) s.messageId = messageId;
    // Agar allaqachon dbUserId bor va save kerak emas — API chaqirmaymiz
    if (s.dbUserId && !opts.save) return s;
  } else {
    s = { chatId, messageId, dbUserId: null, balance: 0, game: null, packages: [], buy: null, awaiting: null };
    sessions.set(user.id, s);
  }

  // Auth — faqat kerak bo'lganda
  // Rasm faqat save=true da olinadi, parallel bilan emas (ketma-ket emas)
  const photoPromise = opts.save ? getPhotoUrl(user.id) : Promise.resolve('');
  const photoUrl = await photoPromise;

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
  return s;
}

// editUI — xatolikni yutadi
function editUI(s, caption, keyboard) {
  return bot.editMessageCaption(caption, {
    chat_id: s.chatId,
    message_id: s.messageId,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard },
  }).catch(() => {});
}

// =============================================================
// EKRANLAR — har biri return bilan tugatiladi
// =============================================================
function mainMenuCaption(user) {
  return (
    `<b>'<tg-emoji emoji-id="5397981293512243749">✨</tg-emoji>Assalomu alaykum <a href="${userLink(user)}">${esc(user.first_name || 'Foydalanuvchi')}</a></b>\n\n` +
    `<tg-emoji emoji-id="5461117441612462242">🙂</tg-emoji> O'yinlar chun ideal donat tizimi\n` +
    `Bo'limlarni tanlang:`
  );
}
function mainMenuKeyboard() {
  return [
    [
      { text: "O'yinlar", callback_data: 'games', style: 'primary', icon_custom_emoji_id: '5226513232549664618' },
      { text: 'Pul kiritish', callback_data: 'topup', style: 'primary', icon_custom_emoji_id: '5870633910337015697' },
    ],
    [
      { text: 'Hisobim', callback_data: 'account', style: 'primary', icon_custom_emoji_id: '5258204546391351475' },
      { text: "Qo'llanma", callback_data: 'guide', style: 'primary', icon_custom_emoji_id: '6039422865189638057' },
    ],
    [
      { text: 'Murojat', callback_data: 'contact', style: 'primary', icon_custom_emoji_id: '5260535596941582167' },
    ],
    [
      { text: 'Webda ochish', web_app: { url: CONFIG.WEB_APP_URL }, style: 'primary' },
    ],
  ];
}

function showMain(user, s) {
  s.awaiting = null;
  s.buy = null;
  return editUI(s, mainMenuCaption(user), mainMenuKeyboard());
}

async function showGames(user, s) {
  s.awaiting = null;
  const r = await apiCall('games', user.id);
  if (!r.ok || !r.games?.length) {
    return editUI(s, "🎮 <b>O'yinlar</b>\n\nHozircha o'yin yo'q.", [[{ text: 'Orqaga', callback_data: 'main', style: 'danger', icon_custom_emoji_id: '5258236805890710909' }]]);
  }
  const rows = [];
  for (let i = 0; i < r.games.length; i += 2) {
    rows.push(r.games.slice(i, i + 2).map(g => {
      const btn = { text: g.name, callback_data: `game:${g.id}` };
      const gs = CONFIG.GAME_STYLES[g.id];
      if (gs) {
        if (gs.style) btn.style = gs.style;
        if (gs.icon_custom_emoji_id) btn.icon_custom_emoji_id = gs.icon_custom_emoji_id;
      }
      return btn;
    }));
  }
  rows.push([{ text: 'Orqaga', callback_data: 'main', style: 'danger', icon_custom_emoji_id: '5258236805890710909' }]);
  return editUI(s, "🎮 <b>O'yinlar</b>\n\nO'yinni tanlang:", rows);
}

async function showPackages(user, s, gameId) {
  s.awaiting = null;
  const r = await apiCall('packages', user.id, { game_id: gameId });
  if (!r.ok) return editUI(s, '❌ Paketlar yuklanmadi.', [[{ text: 'Orqaga', callback_data: 'main'}]]);

  s.game = r.game;
  s.packages = r.packages || [];

  if (!s.packages.length) {
    return editUI(s, `🎮 <b>${esc(r.game.name)}</b>\n\nBu o'yinda paket yo'q.`, [[{ text: 'Orqaga', callback_data: 'games'  }]]);
  }

  const cur = r.game.currency;
  const rows = s.packages.map(p => ([{
    text: `${fmt(p.amount)} ${cur} — ${fmt(p.price)} so'm${p.is_popular ? ' ⭐' : ''}`,
    callback_data: `pkg:${p.id}`,
  }]));
  rows.push([{ text: 'Orqaga', callback_data: 'game',  }]);
  return editUI(s, `🎮 <b>${esc(r.game.name)}</b>\n\nPaketni tanlang:`, rows);
}

async function selectPackage(user, s, pkgId) {
  const pkg = s.packages.find(p => p.id === pkgId);
  if (!pkg) return showGames(user, s);

  // Balansni parallel tekshirmasdan — sessiyadan olamiz, kerak bo'lsa refreshlaymiz
  const bal = await apiCall('balance', user.id);
  if (bal.ok) s.balance = bal.balance;

  const cur = s.game?.currency || '';

  if (s.balance < pkg.price) {
    return editUI(
      s,
      `⚠️ <b>Balans yetarli emas</b>\n\n` +
      `Paket: <b>${fmt(pkg.amount)} ${cur}</b> — ${fmt(pkg.price)} so'm\n` +
      `Balansingiz: <b>${fmt(s.balance)} so'm</b>\n\n` +
      `Hisobingizni to'ldiring.`,
      [
        [{ text: 'Pul kiritish', callback_data: 'topup', style: 'success' }],
        [{ text: 'Orqaga', callback_data: `game:${s.game.id}`  }],
      ]
    );
  }

  s.buy = { pkg };
  s.awaiting = 'player_id';
  return editUI(
    s,
    `🎮 <b>${esc(s.game.name)}</b>\n` +
    `Paket: <b>${fmt(pkg.amount)} ${cur}</b> — ${fmt(pkg.price)} so'm\n\n` +
    `🆔 <b>${esc(s.game.name)} ID</b> raqamingizni yuboring:`,
    [[{ text: '❌ Bekor qilish', callback_data: `game:${s.game.id}` }]]
  );
}

async function showTopup(user, s) {
  s.awaiting = null;
  const amounts = [10000, 20000, 50000, 100000];
  const rows = [];
  for (let i = 0; i < amounts.length; i += 2) {
    rows.push(amounts.slice(i, i + 2).map(a => ({ text: `${fmt(a)} so'm`, callback_data: `amt:${a}`, style: 'success' })));
  }
  rows.push([{ text: 'Boshqa summa', callback_data: 'amt_custom', style: 'primary' }]);
  rows.push([{ text: 'Orqaga', callback_data: 'main' }]);
  return editUI(
    s,
    `💳 <b>Pul kiritish</b>\n\nSummani tanlang yoki o'zingiz kiriting.\n<i>Minimal: 1 000 so'm</i>`,
    rows
  );
}

async function createPayment(user, s, amount) {
  s.awaiting = null;
  if (!amount || amount < 1000) {
    return editUI(s, "⚠️ Minimal summa 1 000 so'm.", [[{ text: 'Orqaga', callback_data: 'topup' }]]);
  }
  const r = await apiCall('create_payment', user.id, { amount });
  if (!r.ok) {
    return editUI(s, `❌ Xatolik: ${esc(r.error || '')}`, [[{ text: 'Orqaga', callback_data: 'topup' }]]);
  }

  let ttl = '15 daqiqa';
  if (r.expires_unix) {
    ttl = `${Math.max(1, Math.round((r.expires_unix * 1000 - Date.now()) / 60000))} daqiqa`;
  }
  return editUI(
    s,
    `💳 <b>To'lov ma'lumotlari</b>\n\n` +
    `🔢 Karta: <code>${esc(r.card_number)}</code>\n` +
    `👤 Egasi: <b>${esc(r.card_owner)}</b>\n` +
    `💰 Aniq summa: <b>${fmt(r.exact_amount)} so'm</b>\n` +
    `⏳ Amal qiladi: <b>${ttl}</b>\n\n` +
    `❗️ Aynan <b>${fmt(r.exact_amount)} so'm</b> yuboring — 1 daqiqada avtomatik tushadi.`,
    [
      [{ text: 'To\'ladim', callback_data: 'paid', style: 'success' }],
      [{ text: 'Balansni tekshirish', callback_data: 'account', style: 'primary' }],
      [{ text: 'Orqaga', callback_data: 'main'  }],
    ]
  );
}

async function showAccount(user, s) {
  s.awaiting = null;
  // Parallel: balans + referral bir vaqtda
  const [bal, ref] = await Promise.all([
    apiCall('balance', user.id),
    apiCall('referrals', user.id),
  ]);
  if (bal.ok) s.balance = bal.balance;

  let refBlock = '';
  let refLink = `https://t.me/${CONFIG.BOT_USERNAME}`;
  if (ref.ok) {
    refLink = `https://t.me/${CONFIG.BOT_USERNAME}?start=${ref.ref_user_id}`;
    refBlock =
      `\n👥 Do'stlar: <b>${ref.ref_count}</b> ta\n` +
      `🎁 Referral havolangiz:\n<code>${esc(refLink)}</code>`;
  }
  return editUI(
    s,
    `👛 <b>Hisobim</b>\n\n💰 Balans: <b>${fmt(s.balance)} so'm</b>${refBlock}`,
    [
      [{ text: 'Pul kiritish', callback_data: 'topup', style: 'success' }],
      [{ text: 'Havolani ulashish', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('SantaUc — arzon donat!')}`, style: 'primary' }],
      [{ text: 'Orqaga', callback_data: 'main'  }],
    ]
  );
}

function showGuide(s) {
  s.awaiting = null;
  return editUI(s, CONFIG.GUIDE_TEXT, [[{ text: 'Orqaga', callback_data: 'main'}]]);
}

function showContact(s) {
  s.awaiting = null;
  const uname = CONFIG.SUPPORT_USERNAME.replace(/^@/, '');
  return editUI(
    s,
    `✉️ <b>Murojat</b>\n\nSavol yoki muammo bo'lsa, admin bilan bog'laning:\n👉 ${esc(CONFIG.SUPPORT_USERNAME)}`,
    [
      [{ text: 'Adminga yozish', url: `https://t.me/${uname}`, style: 'primary' }],
      [{ text: 'Orqaga', callback_data: 'main'  }],
    ]
  );
}

// =============================================================
// /start
// =============================================================
bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const startParam = match?.[1]?.trim() || '';

  let sent;
  try {
    sent = await bot.sendPhoto(chatId, CONFIG.START_IMAGE, {
      caption: mainMenuCaption(user),
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: mainMenuKeyboard() },
    });
  } catch (_) {
    sent = await bot.sendMessage(chatId, mainMenuCaption(user), {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: mainMenuKeyboard() },
    });
  }

  // Auth — background da, UI allaqachon ko'ringan
  ensureSession(user, chatId, sent.message_id, { save: true, ref: startParam });
});

// =============================================================
// CALLBACK QUERY — tez router
// =============================================================
const HANDLERS = {
  main:    (user, s) => showMain(user, s),
  games:   (user, s) => showGames(user, s),
  topup:   (user, s) => showTopup(user, s),
  account: (user, s) => showAccount(user, s),
  guide:   (_u, s)   => showGuide(s),
  contact: (_u, s)   => showContact(s),
  amt_custom: (_u, s) => {
    s.awaiting = 'amount';
    return editUI(s, "✏️ <b>Summa kiriting</b>\n\nTo'ldirmoqchi bo'lgan summangizni yuboring (so'mda).\n<i>Minimal: 1 000</i>",
      [[{ text: 'Orqaga', callback_data: 'topup'  }]]);
  },
};

bot.on('callback_query', async (q) => {
  const user = q.from;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data || '';

  const s = await ensureSession(user, chatId, messageId);

  try {
    // "paid" — faqat alert, UI o'zgarmaydi
    if (data === 'paid') {
      return void bot.answerCallbackQuery(q.id, {
        text: "To'lov qilingan bo'lsa 1 daqiqada balansga tushadi.",
        show_alert: true,
      });
    }

    // Statik handlerlar
    const handler = HANDLERS[data];
    if (handler) {
      await handler(user, s);
      return void bot.answerCallbackQuery(q.id).catch(() => {});
    }

    // Dinamik (prefixli) handlerlar
    const colon = data.indexOf(':');
    if (colon !== -1) {
      const prefix = data.substring(0, colon);
      const val = parseInt(data.substring(colon + 1));

      if (prefix === 'game') await showPackages(user, s, val);
      else if (prefix === 'pkg') await selectPackage(user, s, val);
      else if (prefix === 'amt') await createPayment(user, s, val);
    }
  } catch (e) {
    console.error('[cb]', data, e.message);
  }

  bot.answerCallbackQuery(q.id).catch(() => {});
});

// =============================================================
// MATNLI KIRITISH
// =============================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const user = msg.from;
  const s = sessions.get(user.id);
  if (!s?.awaiting) return;

  const text = msg.text.trim();
  if (!text) return;

  // Xabarni o'chirish — kutmasdan (fire-and-forget)
  bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});

  // ---- Custom summa ----
  if (s.awaiting === 'amount') {
    const val = parseInt(text.replace(/\D/g, ''));
    if (!val || val < 1000) {
      return editUI(s, "⚠️ Noto'g'ri summa. Minimal 1 000 so'm.\n\nQaytadan yuboring:",
        [[{ text: 'Orqaga', callback_data: 'topup'}]]);
    }
    return createPayment(user, s, val);
  }

  // ---- Player ID ----
  if (s.awaiting === 'player_id') {
    s.buy.player_id = text;
    s.awaiting = 'player_nick';
    const cur = s.game?.currency || '';
    return editUI(
      s,
      `🎮 <b>${esc(s.game.name)}</b>\n` +
      `Paket: <b>${fmt(s.buy.pkg.amount)} ${cur}</b>\n` +
      `🆔 ID: <b>${esc(text)}</b>\n\n` +
      `👤 <b>Nik (taxallus)</b> yuboring:`,
      [[{ text: '❌ Bekor qilish', callback_data: `game:${s.game.id}` }]]
    );
  }

  // ---- Player nick → buy ----
  if (s.awaiting === 'player_nick') {
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
        [[{ text: 'Orqaga', callback_data: `game:${s.game.id}` }]]);
    }

    s.balance = r.new_balance;
    const cur = s.game?.currency || '';
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
        [{ text: "Yana sotib olish", callback_data: `game:${s.game.id}`, style: 'success' }],
        [{ text: 'Asosiy menyu', callback_data: 'main', style: 'primary' }],
      ]
    );
  }
});

// =============================================================
bot.on('polling_error', (e) => console.error('[polling]', e.code, e.message));
console.log('🤖 SantaUc bot ishga tushdi (optimized).');
