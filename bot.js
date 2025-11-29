import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГ ====================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');

const CONFIG = {
  // фильтры по рынку
  minVolumeUSDT: 5_000_000,     // минимальный 24h объём в USDT
  minChangePercent: 4,          // минимум |24h change| в %
  maxChangePercent: 35,         // отбрасываем экстремальные движения

  // какие пары смотрим (по умолчанию только USDT)
  quoteAsset: 'USDT',

  // лимит сигналов
  maxSignalsPerRun: 5,

  // уровни
  godTier: {
    qualityScore: 7,
    confidence: 75,
    minChangePercent: 8,
    minVolumeUSDT: 30_000_000,
  },
  premiumTier: {
    qualityScore: 4,
    confidence: 60,
    minChangePercent: 5,
    minVolumeUSDT: 10_000_000,
  },

  // риск/прибыль (относительные уровни)
  riskReward: {
    long: { tpPct: 3, slPct: 1 },   // 3% профит, 1% стоп
    short: { tpPct: 3, slPct: 1 },
  },

  // CRON (по умолчанию — каждые 2 минуты)
  cron: '*/2 * * * *',
};

// ==================== TELEGRAM BOT ====================

const bot = new Telegraf(BOT_TOKEN);

// /start — показать chat id
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';

  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);

  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot!\n\n` +
      `📊 Ваш Chat ID: <code>${chatId}</code>\n` +
      `👤 Пользователь: ${firstName} ${username}\n\n` +
      `💡 Установите переменную окружения:\n` +
      `<code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
      `✅ Бот автоматически ищет сильные движения на биржах (Binance / Bybit / OKX / KuCoin / MEXC)\n` +
      `и присылает лучшие сигналы с фильтром по объёму и волатильности.`,
    { parse_mode: 'HTML' }
  );
});

// /chatid — просто вернуть chat id
bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(`📱 Ваш Chat ID: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

// ==================== ПОЛУЧЕНИЕ ДАННЫХ С БИРЖ ====================

// общий формат тикера:
// {
//   exchange: 'Binance',
//   symbol: 'BTCUSDT',
//   base: 'BTC',
//   quote: 'USDT',
//   price: Number,
//   volumeUSDT: Number,
//   change24h: Number,    // в %
// }

function normalizePair(symbol, quote = 'USDT') {
  if (symbol.endsWith(quote)) {
    return {
      base: symbol.slice(0, -quote.length),
      quote,
    };
  }
  // если формат типа BTC-USDT или BTC/USDT
  const clean = symbol.replace('/', '-');
  const parts = clean.split('-');
  if (parts.length === 2 && parts[1].toUpperCase() === quote) {
    return { base: parts[0].toUpperCase(), quote };
  }
  return null;
}

async function fetchFromBinance() {
  try {
    console.log('📡 Binance...');
    const url = 'https://api.binance.com/api/v3/ticker/24hr';
    const { data } = await axios.get(url, { timeout: 10_000 });

    return data
      .filter((t) => t.symbol.endsWith(CONFIG.quoteAsset))
      .map((t) => {
        const norm = normalizePair(t.symbol, CONFIG.quoteAsset);
        if (!norm) return null;
        return {
          exchange: 'Binance',
          symbol: t.symbol,
          base: norm.base,
          quote: norm.quote,
          price: Number(t.lastPrice),
          volumeUSDT: Number(t.quoteVolume),
          change24h: Number(t.priceChangePercent),
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('❌ Binance API error:', e.message);
    return [];
  }
}

async function fetchFromBybit() {
  try {
    console.log('📡 Bybit...');
    const url = 'https://api.bybit.com/v5/market/tickers?category=spot';
    const { data } = await axios.get(url, { timeout: 10_000 });

    const list = data?.result?.list || [];
    return list
      .filter((t) => t.symbol.endsWith(CONFIG.quoteAsset))
      .map((t) => {
        const norm = normalizePair(t.symbol, CONFIG.quoteAsset);
        if (!norm) return null;
        const changePct = Number(t.price24hPcnt) * 100; // 0.05 => 5%
        return {
          exchange: 'Bybit',
          symbol: t.symbol,
          base: norm.base,
          quote: norm.quote,
          price: Number(t.lastPrice),
          volumeUSDT: Number(t.volume24h) || Number(t.turnover24h) || 0,
          change24h: changePct,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('❌ Bybit API error:', e.message);
    return [];
  }
}

async function fetchFromOKX() {
  try {
    console.log('📡 OKX...');
    const url = 'https://www.okx.com/api/v5/market/tickers?instType=SPOT';
    const { data } = await axios.get(url, { timeout: 10_000 });

    const list = data?.data || [];
    return list
      .filter((t) => t.instId.endsWith('-' + CONFIG.quoteAsset))
      .map((t) => {
        const norm = normalizePair(t.instId.replace('-', '/'), CONFIG.quoteAsset);
        if (!norm) return null;
        const last = Number(t.last);
        const open24h = Number(t.open24h || t.sodUtc8 || last);
        const changePct = open24h ? ((last - open24h) / open24h) * 100 : 0;
        return {
          exchange: 'OKX',
          symbol: t.instId.replace('-', ''),
          base: norm.base,
          quote: norm.quote,
          price: last,
          volumeUSDT: Number(t.volCcy24h || 0),
          change24h: changePct,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('❌ OKX API error:', e.message);
    return [];
  }
}

async function fetchFromKuCoin() {
  try {
    console.log('📡 KuCoin...');
    const url = 'https://api.kucoin.com/api/v1/market/allTickers';
    const { data } = await axios.get(url, { timeout: 10_000 });

    const list = data?.data?.ticker || [];
    return list
      .filter((t) => t.symbol.endsWith('-' + CONFIG.quoteAsset))
      .map((t) => {
        const norm = normalizePair(t.symbol, CONFIG.quoteAsset);
        if (!norm) return null;
        const changePct = Number(t.changeRate) * 100; // 0.05 => 5%
        return {
          exchange: 'KuCoin',
          symbol: t.symbol.replace('-', ''),
          base: norm.base,
          quote: norm.quote,
          price: Number(t.last),
          volumeUSDT: Number(t.volValue || 0),
          change24h: changePct,
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('❌ KuCoin API error:', e.message);
    return [];
  }
}

async function fetchFromMEXC() {
  try {
    console.log('📡 MEXC...');
    const url = 'https://api.mexc.com/api/v3/ticker/24hr';
    const { data } = await axios.get(url, { timeout: 10_000 });

    return data
      .filter((t) => t.symbol.endsWith(CONFIG.quoteAsset))
      .map((t) => {
        const norm = normalizePair(t.symbol, CONFIG.quoteAsset);
        if (!norm) return null;
        return {
          exchange: 'MEXC',
          symbol: t.symbol,
          base: norm.base,
          quote: norm.quote,
          price: Number(t.lastPrice),
          volumeUSDT: Number(t.quoteVolume || 0),
          change24h: Number(t.priceChangePercent || 0),
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error('❌ MEXC API error:', e.message);
    return [];
  }
}

async function fetchAllMarkets() {
  console.log('🌐 Получаем данные с бирж...');

  const results = await Promise.allSettled([
    fetchFromBinance(),
    fetchFromBybit(),
    fetchFromOKX(),
    fetchFromKuCoin(),
    fetchFromMEXC(),
  ]);

  const all = [];
  for (const res of results) {
    if (res.status === 'fulfilled') {
      all.push(...res.value);
    }
  }

  console.log(`📊 Получено ${all.length} тикеров со всех бирж`);

  // базовая фильтрация по объему и волатильности
  const filtered = all.filter((t) => {
    const volOk = t.volumeUSDT >= CONFIG.minVolumeUSDT;
    const chAbs = Math.abs(t.change24h);
    const changeOk =
      chAbs >= CONFIG.minChangePercent && chAbs <= CONFIG.maxChangePercent;
    return volOk && changeOk;
  });

  console.log(`🔍 После фильтра: ${filtered.length} тикеров`);

  return filtered;
}

// ==================== ЛОГИКА СИГНАЛОВ ====================

function buildSignalFromTicker(ticker) {
  const { exchange, symbol, base, quote, price, volumeUSDT, change24h } = ticker;

  const direction = change24h >= 0 ? 'LONG' : 'SHORT';
  const chAbs = Math.abs(change24h);

  let confirmations = [];
  let qualityScore = 0;

  // волатильность
  if (chAbs >= CONFIG.minChangePercent) {
    qualityScore += 1;
    confirmations.push('STRONG_24H_MOVE');
  }
  if (chAbs >= 8) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLATILITY');
  }

  // объём
  if (volumeUSDT >= CONFIG.minVolumeUSDT) {
    qualityScore += 1;
    confirmations.push('GOOD_VOLUME');
  }
  if (volumeUSDT >= 20_000_000) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }
  if (volumeUSDT >= 50_000_000) {
    qualityScore += 1;
    confirmations.push('VERY_HIGH_VOLUME');
  }

  // биржа
  if (['Binance', 'Bybit', 'OKX'].includes(exchange)) {
    qualityScore += 1;
    confirmations.push('TOP_EXCHANGE');
  }

  // pseudo-RSI (просто чтобы был красивый индикатор в сообщении)
  let rsi = 50 + Math.max(-40, Math.min(40, change24h));
  rsi = Math.round(Math.max(0, Math.min(100, rsi)));

  // условная "волатильность"
  const volatility = chAbs.toFixed(2);

  // confidence 50–95%
  let confidence = 50 + qualityScore * 5;
  if (chAbs >= 8) confidence += 5;
  if (volumeUSDT >= 30_000_000) confidence += 5;
  confidence = Math.max(50, Math.min(95, Math.round(confidence)));

  // определяем tier
  let tier = null;
  if (
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    chAbs >= CONFIG.godTier.minChangePercent &&
    volumeUSDT >= CONFIG.godTier.minVolumeUSDT
  ) {
    tier = 'GOD TIER';
  } else if (
    qualityScore >= CONFIG.premiumTier.qualityScore &&
    confidence >= CONFIG.premiumTier.confidence &&
    chAbs >= CONFIG.premiumTier.minChangePercent &&
    volumeUSDT >= CONFIG.premiumTier.minVolumeUSDT
  ) {
    tier = 'PREMIUM';
  } else {
    return null; // слабый сигнал — отбрасываем
  }

  // уровни RR
  const rrConf = direction === 'LONG' ? CONFIG.riskReward.long : CONFIG.riskReward.short;
  const slPct = rrConf.slPct;
  const tpPct = rrConf.tpPct;

  const entry = price;
  const sl =
    direction === 'LONG'
      ? entry * (1 - slPct / 100)
      : entry * (1 + slPct / 100);
  const tp =
    direction === 'LONG'
      ? entry * (1 + tpPct / 100)
      : entry * (1 - tpPct / 100);

  const rrRatio = +(tpPct / slPct).toFixed(1);

  return {
    exchange,
    pair: `${base}/${quote}`,
    symbol,
    signal: direction, // LONG / SHORT
    tier,
    entry: +entry.toFixed(6),
    sl: +sl.toFixed(6),
    tp: +tp.toFixed(6),
    rrRatio,
    confidence,
    qualityScore,
    indicators: {
      rsi,
      volatility,
      change24h: +change24h.toFixed(2),
      volumeUSDT: Math.round(volumeUSDT),
    },
    confirmations,
    timestamp: new Date(),
  };
}

async function generateSignals() {
  console.log('🔍 Генерация сигналов...');

  const market = await fetchAllMarkets();
  if (!market.length) {
    console.log('⚠️ Нет данных с бирж');
    return [];
  }

  const signals = [];

  for (const ticker of market) {
    const signal = buildSignalFromTicker(ticker);
    if (signal) {
      signals.push(signal);
    }
  }

  if (!signals.length) {
    console.log('ℹ️ Подходящих сигналов не найдено после анализа');
    return [];
  }

  // сортируем по качеству / уверенности / объему
  signals.sort((a, b) => {
    if (b.qualityScore !== a.qualityScore) {
      return b.qualityScore - a.qualityScore;
    }
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    return (
      (b.indicators.volumeUSDT || 0) - (a.indicators.volumeUSDT || 0)
    );
  });

  console.log(`✅ Найдено ${signals.length} сигналов`);
  signals.slice(0, 10).forEach((s, i) => {
    console.log(
      `  ${i + 1}. ${s.pair} ${s.signal} | ${s.tier} | Q=${s.qualityScore} C=${s.confidence}% RR=1:${s.rrRatio} (${s.exchange})`
    );
  });

  return signals;
}

// ==================== ОТПРАВКА В TELEGRAM ====================

async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен, сигнал не отправлен');
    return false;
  }

  try {
    const direction = signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '⭐';

    const message = `
${tierEmoji} <b>${signal.tier} SIGNAL</b>
${direction} <b>${signal.pair}</b>

💵 Entry: $${signal.entry}
🎯 Take Profit: $${signal.tp}
🛑 Stop Loss: $${signal.sl}

📊 R:R Ratio: 1:${signal.rrRatio}
🎲 Confidence: ${signal.confidence}%
🏆 Quality: ${signal.qualityScore}/10

📈 24h Change: ${signal.indicators.change24h}%
📊 Volatility (approx): ${signal.indicators.volatility}%
💰 Volume: ~$${signal.indicators.volumeUSDT?.toLocaleString('en-US')}

🔍 Confirmations:
${signal.confirmations.map((c) => `  • ${c}`).join('\n')}

🏦 Exchange: ${signal.exchange}
⏰ ${signal.timestamp.toLocaleString('ru-RU')}
    `.trim();

    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    console.log(`📤 Сигнал отправлен: ${signal.pair} (${signal.exchange})`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================

async function runSignalsTask() {
  console.log('\n🔄 === ЗАПУСК ЗАДАЧИ ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);

  try {
    const signals = await generateSignals();

    if (!signals.length) {
      console.log('ℹ️ Сигналов для отправки нет');
      return;
    }

    const toSend = signals.slice(0, CONFIG.maxSignalsPerRun);
    console.log(`📤 Отправка ${toSend.length} сигналов в Telegram...`);

    for (const s of toSend) {
      // лёгкая задержка, чтобы не спамить Telegram
      await new Promise((res) => setTimeout(res, 1500));
      await sendSignalToTelegram(s);
    }

    console.log('✅ Задача завершена');
  } catch (e) {
    console.error('❌ Ошибка в runSignalsTask:', e.message);
  }
}

// ==================== ЗАПУСК ====================

async function start() {
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');

    const me = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${me.username}`);

    bot.launch();
    console.log('🤖 Бот запущен (long polling)');

    // cron-задача
    cron.schedule(CONFIG.cron, () => {
      runSignalsTask();
    });

    console.log(`⏰ CRON задача запланирована: "${CONFIG.cron}"`);
    console.log('⏳ Первый запуск через 10 секунд...\n');
    setTimeout(runSignalsTask, 10_000);
  } catch (e) {
    console.error('❌ Ошибка запуска бота:', e.message);
    process.exit(1);
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

start();
