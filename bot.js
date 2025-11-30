// bot.js
import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
if (COINGECKO_API_KEY) {
  console.log('🔑 CoinGecko API key найден');
} else {
  console.log('⚠️ CoinGecko API key НЕ установлен — будет использоваться безключевой режим (ограниченные лимиты)');
}

// Основной конфиг сигналов
const CONFIG = {
  topCoins: 30,              // Кол-во топ монет по объему
  vsCurrency: 'usd',
  schedule: '*/5 * * * *',   // каждые 5 минут
  maxSignalsPerRun: 5,       // максимум сигналов за запуск

  // Базовые пороги
  minConfidence: 60,         // минимальная "уверенность" сигнала (0–100)
  minQualityScore: 4,        // минимальное качество (1–10)
  minRRRatio: 2.0,           // минимальный R:R

  // Условия уровней
  godTier: {
    minConfidence: 75,
    minQualityScore: 6,
    minRRRatio: 3.0
  },
  premiumTier: {
    minConfidence: 60,
    minQualityScore: 4,
    minRRRatio: 2.0
  }
};

// Стейблкоины, которые мы не торгуем
const STABLECOINS = [
  'usdt', 'usdc', 'dai', 'busd', 'tusd',
  'usdp', 'frax', 'ustc', 'eurs'
];

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatNumber(num, digits = 4) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  const fixed = Number(num).toFixed(digits);
  // Убираем лишние нули
  return fixed.replace(/\.?0+$/, '');
}

function formatPercent(num, digits = 2, sign = true) {
  if (num === null || num === undefined || isNaN(num)) return '-';
  const v = Number(num);
  const s = sign && v > 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}

function calcStdDev(values) {
  if (!values || values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// ==================== ИНДИКАТОРЫ ====================
function calculateSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      const loss = -diff;
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// “Псевдо-MACD”: разница быстрой и медленной EMA
function calculateMacdMomentum(prices, fast = 12, slow = 26) {
  const fastEma = calculateEMA(prices, fast);
  const slowEma = calculateEMA(prices, slow);
  if (fastEma === null || slowEma === null) return null;
  return fastEma - slowEma;
}

function calculateBollingerBands(prices, period = 20, mult = 2) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const sma = calculateSMA(slice, period);
  const std = calcStdDev(slice);
  return {
    middle: sma,
    upper: sma + mult * std,
    lower: sma - mult * std,
    width: (std * 2) / sma // относительная ширина
  };
}

// ==================== ЗАПРОСЫ К COINGECKO ====================
async function fetchMarketData() {
  const url = `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=${CONFIG.vsCurrency}` +
    `&order=volume_desc` +
    `&per_page=${CONFIG.topCoins}` +
    `&page=1` +
    `&sparkline=false` +
    `&price_change_percentage=1h,24h`;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'CryptoSignalsBot/1.0'
  };

  if (COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
  }

  console.log('📡 Запрос к CoinGecko: /coins/markets');
  const response = await axios.get(url, { headers });

  if (response.status !== 200) {
    throw new Error(`CoinGecko вернул статус ${response.status}`);
  }

  return response.data;
}

async function fetchCoinIntradayChart(coinId) {
  // 1 день с минутным интервалом — хорошо подходит для внутридня
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart` +
    `?vs_currency=${CONFIG.vsCurrency}` +
    `&days=1` +
    `&interval=minute`;

  const headers = {
    'Accept': 'application/json',
    'User-Agent': 'CryptoSignalsBot/1.0'
  };

  if (COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
  }

  console.log(`📡 Интрадей-данные для ${coinId} (1D, minute)`);
  const response = await axios.get(url, { headers });

  if (response.status !== 200) {
    throw new Error(`market_chart для ${coinId} вернул статус ${response.status}`);
  }

  return response.data;
}

// Превращаем market_chart.prices в массив цен и простых "свечей"
function buildIntradaySeries(chartData) {
  if (!chartData || !chartData.prices || chartData.prices.length < 30) {
    return null;
  }

  const prices = chartData.prices.map(p => p[1]); // [timestamp, price]
  const timestamps = chartData.prices.map(p => p[0]);

  // Для простоты делаем псевдо-high/low как +/- небольшой шум от close
  const candles = prices.map((price, idx) => {
    const prev = prices[idx - 1] ?? price;
    const high = Math.max(price, prev);
    const low = Math.min(price, prev);
    return {
      time: timestamps[idx],
      open: prev,
      high,
      low,
      close: price
    };
  });

  return { prices, candles };
}

// ==================== ЛОГИКА АНАЛИЗА И СИГНАЛОВ ====================
function analyzeCoin(coin, series) {
  const { prices, candles } = series;
  if (!prices || prices.length < 50) return null;

  const symbol = coin.symbol.toUpperCase();
  const pair = `${symbol}/USDT`;
  const currentPrice = prices[prices.length - 1];

  // Основные индикаторы
  const ema20 = calculateEMA(prices, 20);
  const ema50 = calculateEMA(prices, 50);
  const ema100 = calculateEMA(prices, 100);
  const sma50 = calculateSMA(prices, 50);
  const rsi = calculateRSI(prices, 14);
  const bb = calculateBollingerBands(prices, 20, 2);
  const macdMomentum = calculateMacdMomentum(prices, 12, 26);

  if (!ema20 || !ema50 || !ema100 || !rsi || !bb || macdMomentum === null) {
    return null;
  }

  // Оценка волатильности через стандартное отклонение доходностей
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  const volatility = calcStdDev(returns.slice(-60)); // последние ~час
  const volatilityPct = volatility * 100;
  const volNorm = Math.min(Math.max(volatilityPct / 0.5, 0.5), 2.0); // нормализуем, 0.5–2

  // Направление тренда
  const isUpTrend = ema20 > ema50 && ema50 > ema100;
  const isDownTrend = ema20 < ema50 && ema50 < ema100;

  // RSI зоны
  const isBullRsi = rsi > 45 && rsi < 70;
  const isBearRsi = rsi < 55 && rsi > 30;
  const isOverbought = rsi >= 70;
  const isOversold = rsi <= 30;

  // Относительное положение цены в Bollinger Bands
  const bbPos = (currentPrice - bb.lower) / (bb.upper - bb.lower); // 0–1

  // Направление "MACD-вектора"
  const macdBull = macdMomentum > 0;
  const macdBear = macdMomentum < 0;

  // Проценты изменения
  const ch1h = coin.price_change_percentage_1h_in_currency;
  const ch24h = coin.price_change_percentage_24h_in_currency;

  // Решение: пробуем LONG/SHORT
  let direction = null;
  const reasons = [];

  if (isUpTrend && macdBull && isBullRsi && !isOverbought && bbPos > 0.3 && bbPos < 0.85 && ch1h > -1) {
    direction = 'LONG';
    reasons.push('EMA20 выше EMA50 и EMA100 — устойчивый бычий тренд.');
    reasons.push('RSI в здоровой бычьей зоне без перекупленности.');
    reasons.push('Цена торгуется между серединой и верхней полосой Bollinger — импульс сохраняется.');
    if (macdBull) reasons.push('Разница быстрой и медленной EMA положительная — бычий вектор (аналог MACD).');
    if (ch1h > 0) reasons.push(`Цена за последний час растёт (${formatPercent(ch1h)}).`);
    if (ch24h > 0) reasons.push(`Суточный тренд также бычий (${formatPercent(ch24h)}), что усиливает сетап.`);
  }

  if (!direction && isDownTrend && macdBear && isBearRsi && !isOversold && bbPos < 0.7 && bbPos > 0.15 && ch1h < 1) {
    direction = 'SHORT';
    reasons.push('EMA20 ниже EMA50 и EMA100 — устойчивый медвежий тренд.');
    reasons.push('RSI в здоровой медвежьей зоне без перепроданности.');
    reasons.push('Цена торгуется между серединой и нижней полосой Bollinger — давление продавцов сохраняется.');
    if (macdBear) reasons.push('Разница быстрой и медленной EMA отрицательная — медвежий вектор (аналог MACD).');
    if (ch1h < 0) reasons.push(`Цена за последний час снижается (${formatPercent(ch1h)}).`);
    if (ch24h < 0) reasons.push(`Суточный тренд также медвежий (${formatPercent(ch24h)}), что усиливает сетап.`);
  }

  if (!direction) {
    // Нет красивого направленного сетапа
    return null;
  }

  // Расчет ценовых уровней (интрадей логика)
  const baseRiskPct = 0.0075; // 0.75% базовый риск
  const riskPct = baseRiskPct * volNorm; // учитываем волатильность

  let entryFrom, entryTo, stopLoss, tp1, tp2, tp3;

  if (direction === 'LONG') {
    entryFrom = currentPrice * (1 - riskPct * 0.4);
    entryTo = currentPrice * (1 + riskPct * 0.2);
    stopLoss = currentPrice * (1 - riskPct * 1.6);
    tp1 = currentPrice * (1 + riskPct * 2.2);
    tp2 = currentPrice * (1 + riskPct * 3.0);
    tp3 = currentPrice * (1 + riskPct * 4.0);
  } else {
    entryFrom = currentPrice * (1 + riskPct * 0.4);
    entryTo = currentPrice * (1 - riskPct * 0.2);
    stopLoss = currentPrice * (1 + riskPct * 1.6);
    tp1 = currentPrice * (1 - riskPct * 2.2);
    tp2 = currentPrice * (1 - riskPct * 3.0);
    tp3 = currentPrice * (1 - riskPct * 4.0);
  }

  const avgEntry = (entryFrom + entryTo) / 2;

  let risk;
  let reward;

  if (direction === 'LONG') {
    risk = avgEntry - stopLoss;
    reward = tp2 - avgEntry;
  } else {
    risk = stopLoss - avgEntry;
    reward = avgEntry - tp2;
  }

  const rrRatio = risk > 0 ? reward / risk : null;

  // Оценка "уверенности" и качества
  let confidence = 40;
  let qualityScore = 3;

  // Чем больше совпадений — тем выше оценки
  if (isUpTrend || isDownTrend) {
    confidence += 10;
    qualityScore += 1;
  }
  if ((direction === 'LONG' && macdBull) || (direction === 'SHORT' && macdBear)) {
    confidence += 10;
    qualityScore += 1;
  }
  if ((direction === 'LONG' && isBullRsi) || (direction === 'SHORT' && isBearRsi)) {
    confidence += 10;
    qualityScore += 1;
  }
  if ((direction === 'LONG' && ch1h > 0) || (direction === 'SHORT' && ch1h < 0)) {
    confidence += 5;
  }
  if ((direction === 'LONG' && ch24h > 0) || (direction === 'SHORT' && ch24h < 0)) {
    confidence += 5;
  }
  if (bb.width < 0.08 && bb.width > 0.02) {
    // адекватная волатильность, не супер флет и не ультра разнос
    qualityScore += 1;
  }

  // Нормируем
  confidence = Math.max(0, Math.min(100, confidence));
  qualityScore = Math.max(1, Math.min(10, qualityScore));

  // Отсекаем мусорные сетапы
  if (confidence < CONFIG.minConfidence || qualityScore < CONFIG.minQualityScore || (rrRatio !== null && rrRatio < CONFIG.minRRRatio)) {
    return null;
  }

  // Определяем тIER
  let tier = 'INFO';
  if (rrRatio !== null) {
    if (
      confidence >= CONFIG.godTier.minConfidence &&
      qualityScore >= CONFIG.godTier.minQualityScore &&
      rrRatio >= CONFIG.godTier.minRRRatio
    ) {
      tier = 'GOD';
    } else if (
      confidence >= CONFIG.premiumTier.minConfidence &&
      qualityScore >= CONFIG.premiumTier.minQualityScore &&
      rrRatio >= CONFIG.premiumTier.minRRRatio
    ) {
      tier = 'PREMIUM';
    }
  }

  // Дополнительные комментарии
  if (isOverbought && direction === 'LONG') {
    reasons.push('RSI близок к перекупленности — вход агрессивный, возможен откат.');
  }
  if (isOversold && direction === 'SHORT') {
    reasons.push('RSI близок к перепроданности — вход агрессивный, возможен откат.');
  }

  const explanation = reasons.join('\n• ');

  return {
    tier,
    pair,
    symbol,
    name: coin.name,
    direction,
    currentPrice,
    entryFrom,
    entryTo,
    stopLoss,
    tp1,
    tp2,
    tp3,
    rrRatio,
    confidence,
    qualityScore,
    ch1h,
    ch24h,
    rsi,
    ema20,
    ema50,
    ema100,
    bb,
    volatilityPct,
    explanation,
    generatedAt: new Date()
  };
}

async function generateSignals(limit = CONFIG.maxSignalsPerRun) {
  console.log('🔍 Генерация сигналов...');

  let marketData;
  try {
    marketData = await fetchMarketData();
  } catch (e) {
    console.error('❌ Ошибка получения рынка:', e.message);
    return [];
  }

  if (!marketData || marketData.length === 0) {
    console.log('❌ Пустые данные с рынка.');
    return [];
  }

  // Фильтруем стейблы
  const filtered = marketData.filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()));

  const signals = [];

  for (const coin of filtered) {
    if (signals.length >= limit) break;

    try {
      const chart = await fetchCoinIntradayChart(coin.id);
      const series = buildIntradaySeries(chart);
      if (!series) continue;

      const signal = analyzeCoin(coin, series);
      if (signal) {
        signals.push(signal);
      }

      // Лёгкая задержка, чтобы не душить API
      await sleep(200);
    } catch (e) {
      console.error(`⚠️ Ошибка по монете ${coin.id}:`, e.message);
    }
  }

  if (signals.length === 0) {
    console.log('ℹ️ Подходящих сигналов не найдено.');
    return [];
  }

  // Сортируем: сначала GOD, потом PREMIUM, затем по уверенности
  const tierWeight = (tier) => {
    if (tier === 'GOD') return 3;
    if (tier === 'PREMIUM') return 2;
    return 1;
  };

  signals.sort((a, b) => {
    const diffTier = tierWeight(b.tier) - tierWeight(a.tier);
    if (diffTier !== 0) return diffTier;
    return b.confidence - a.confidence;
  });

  console.log(`✅ Сгенерировано сигналов: ${signals.length}`);
  return signals;
}

// ==================== TELEGRAM ====================
const bot = new Telegraf(BOT_TOKEN);

function formatSignalMessage(signal) {
  const {
    tier,
    pair,
    name,
    direction,
    currentPrice,
    entryFrom,
    entryTo,
    stopLoss,
    tp1,
    tp2,
    tp3,
    rrRatio,
    confidence,
    qualityScore,
    ch1h,
    ch24h,
    rsi,
    ema20,
    ema50,
    ema100,
    bb,
    volatilityPct,
    explanation,
    generatedAt
  } = signal;

  const tierTitle =
    tier === 'GOD'
      ? '🔥 <b>GOD TIER SIGNAL</b>'
      : tier === 'PREMIUM'
        ? '⭐️ <b>PREMIUM SIGNAL</b>'
        : '📊 <b>MARKET SIGNAL</b>';

  const dirLine = direction === 'LONG'
    ? '🟢 <b>LONG</b>'
    : '🔴 <b>SHORT</b>';

  const timeStr = generatedAt.toISOString().replace('T', ' ').slice(0, 19);

  const msg = `
${tierTitle}
${dirLine} <b>${escapeHtml(pair)}</b> (${escapeHtml(name)})

💰 <b>Текущая цена:</b> $${formatNumber(currentPrice, 4)}

📥 <b>Вход (зона):</b> $${formatNumber(entryFrom, 4)} — $${formatNumber(entryTo, 4)}
⛔️ <b>Stop Loss:</b> $${formatNumber(stopLoss, 4)}
🎯 <b>Take Profit 1:</b> $${formatNumber(tp1, 4)}
🎯 <b>Take Profit 2:</b> $${formatNumber(tp2, 4)}
🎯 <b>Take Profit 3:</b> $${formatNumber(tp3, 4)}

📈 <b>Соотношение риск/профит (R:R):</b> ~${rrRatio ? rrRatio.toFixed(2) : '-'}
🎚 <b>Качество сетапа:</b> ${qualityScore}/10
📊 <b>Уверенность модели:</b> ~${confidence}%

⏱ <b>Изменение за 1ч:</b> ${formatPercent(ch1h)}
📆 <b>Изменение за 24ч:</b> ${formatPercent(ch24h)}
📉 <b>RSI (14):</b> ${rsi ? rsi.toFixed(1) : '-'}
📐 <b>EMA20 / EMA50 / EMA100:</b>
    ${formatNumber(ema20, 4)} / ${formatNumber(ema50, 4)} / ${formatNumber(ema100, 4)}
📊 <b>Bollinger width:</b> ~${(bb.width * 100).toFixed(1)}%
🌪 <b>Интрадей волатильность:</b> ~${volatilityPct.toFixed(2)}%

🧠 <b>Обоснование входа:</b>
• ${escapeHtml(explanation)}

🕒 <i>Сигнал сгенерирован (UTC):</i> ${escapeHtml(timeStr)}

⚠️ <i>Не является финансовой рекомендацией. Управляй риском и проверяй сетап самостоятельно.</i>
  `.trim();

  return msg;
}

async function sendSignalToTelegram(signal, targetChatId = CHAT_ID) {
  if (!targetChatId) {
    console.error('❌ CHAT_ID не установлен, сигнал некуда отправлять.');
    return;
  }

  const text = formatSignalMessage(signal);

  try {
    await bot.telegram.sendMessage(targetChatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    console.log(`📤 Сигнал по ${signal.pair} отправлен в чат ${targetChatId}`);
  } catch (e) {
    console.error('❌ Ошибка отправки сообщения в Telegram:', e.message);
  }
}

// ==================== КОМАНДЫ БОТА ====================

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';

  console.log(`💬 /start от ${chatId} (${firstName} ${username})`);

  ctx.reply(
    `🤖 <b>Crypto Signals Bot</b>\n\n` +
    `Привет, ${escapeHtml(firstName)}!\n\n` +
    `Этот бот каждые 5 минут анализирует топовые крипто-активы по данным CoinGecko и выдаёт продуманные внутридневные сигналы (LONG/SHORT) с:\n` +
    `• зонами входа\n` +
    `• стоп-зоной\n` +
    `• несколькими тейками\n` +
    `• оценкой риска/профита\n` +
    `• обоснованием на основе EMA, RSI, Bollinger и волатильности\n\n` +
    `Для получения автосигналов бот использует CHAT_ID из переменной окружения.\n` +
    `Твой текущий chat_id: <code>${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// /chatid — подсказать, что поставить в переменную окружения
bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(
    `🆔 Твой chat_id: <code>${chatId}</code>\n\n` +
    `Добавь его в переменные окружения как:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// /test — принудительно сгенерировать несколько сигналов и отправить в текущий чат
bot.command('test', async (ctx) => {
  console.log('🧪 Запрос тестовых сигналов через /test');
  await ctx.reply('🧪 Генерирую тестовые сигналы (может занять 5–15 секунд)...');

  const signals = await generateSignals(3);

  if (!signals || signals.length === 0) {
    await ctx.reply('⚠️ Сейчас нет подходящих сигналов по заданным фильтрам.');
    return;
  }

  for (const signal of signals) {
    await sendSignalToTelegram(signal, ctx.chat.id);
    await sleep(500);
  }

  await ctx.reply('✅ Тестовые сигналы отправлены.');
});

// /signals — то же самое, что /test, но более логичное название
bot.command('signals', async (ctx) => {
  console.log('📥 /signals от', ctx.chat.id);
  await ctx.reply('🔍 Ищу актуальные внутридневные сигналы...');

  const signals = await generateSignals(5);

  if (!signals || signals.length === 0) {
    await ctx.reply('⚠️ Сейчас нет сильных сетапов по текущим условиям.');
    return;
  }

  for (const signal of signals) {
    await sendSignalToTelegram(signal, ctx.chat.id);
    await sleep(500);
  }

  await ctx.reply('✅ Актуальные сигналы отправлены.');
});

// ==================== ПЛАНОВЫЙ ЗАПУСК СИГНАЛОВ ====================

async function runSignalsTask() {
  if (!CHAT_ID) {
    console.warn('⚠️ CHAT_ID не указан — автосигналы не будут отправляться.');
    return;
  }

  console.log('⏳ Плановый запуск генерации сигналов (cron)...');
  const signals = await generateSignals(CONFIG.maxSignalsPerRun);

  if (!signals || signals.length === 0) {
    console.log('ℹ️ На этот запуск подходящих сигналов нет.');
    return;
  }

  for (const signal of signals) {
    await sendSignalToTelegram(signal, CHAT_ID);
    await sleep(500);
  }

  console.log('✅ Плановая рассылка сигналов завершена.');
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    await bot.launch();
    console.log('🤖 Бот запущен и слушает обновления Telegram');

    // Cron: каждые 5 минут
    cron.schedule(CONFIG.schedule, () => {
      runSignalsTask().catch(err => {
        console.error('❌ Ошибка в cron-задаче:', err.message);
      });
    });

    console.log(`⏱ Cron-задача настроена: "${CONFIG.schedule}" (каждые 5 минут)`);

    // Первый запуск через 10 секунд после старта
    if (CHAT_ID) {
      console.log('⏳ Первый автозапуск сигналов через 10 секунд...');
      setTimeout(() => {
        runSignalsTask().catch(err => {
          console.error('❌ Ошибка первого запуска:', err.message);
        });
      }, 10000);
    } else {
      console.log('⚠️ CHAT_ID не задан — автосигналы запускаться не будут, но команды /test и /signals доступны.');
    }

  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => {
  console.log('👋 SIGINT, останавливаем бота...');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('👋 SIGTERM, останавливаем бота...');
  bot.stop('SIGTERM');
});

// Запуск
start();
