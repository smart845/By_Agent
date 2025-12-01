// ==================== IMPORT'Ы ====================
import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== ЛОГЕР И УТИЛИТЫ ====================
function ts() {
  return new Date().toISOString();
}

const logger = {
  info: (...args) => console.log(`[${ts()}] [INFO]`, ...args),
  warn: (...args) => console.log(`[${ts()}] [WARN]`, ...args),
  error: (...args) => console.log(`[${ts()}] [ERROR]`, ...args),
  debug: (...args) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(`[${ts()}] [DEBUG]`, ...args);
    }
  },
};

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || null;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен в переменных окружения!');
  process.exit(1);
}

logger.info('✅ Bot token найден');
logger.info('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (можно получить через /chatid)');
logger.info('🔑 CoinGecko API Key:', COINGECKO_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (работает без ключа, но с лимитами)');

// Конфиг (стиль торговли B — сбалансированный)
const CONFIG = {
  apiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 250,

  // Фильтры рынка
  minVolume: 20_000_000,        // $20M минимальный объем
  minMarketCap: 200_000_000,    // $200M минимальная капитализация
  minConfidence: 60,            // минимальная уверенность
  minQualityScore: 6,           // минимальное качество
  minRRRatio: 3.0,              // минимальное R:R
  minConfirmations: 3,          // минимум 3 подтверждения

  // R:R и риск
  atrMultiplier: 2.5,
  minSLPercent: 0.002,          // минимум 0.2% от цены
  maxSLPercent: 0.06,           // максимум 6% от цены

  // Критерии уровней
  godTier: {
    qualityScore: 8,
    confidence: 80,
    rrRatio: 4.0,
  },
  premium: {
    qualityScore: 6,
    confidence: 65,
    rrRatio: 3.0,
  },

  // Зоны ликвидности
  liquidityLookback: 20,

  // Cron (каждые 10 минут)
  cronExpr: '*/10 * * * *',
};

// Стейблы
const STABLECOINS = ['usdt', 'usdc', 'usdc.e', 'dai', 'busd', 'tusd', 'usdp', 'frax', 'ustc', 'eurs'];

// ==================== ИНДИКАТОРЫ ====================

// SMA
function calculateSMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const slice = prices.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  return sum / period;
}

// EMA
function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// RSI по Уайлдеру
function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  if (avgLoss === 0) return 100;

  let rs = avgGain / avgLoss;
  let rsi = 100 - 100 / (1 + rs);

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    if (avgLoss === 0) {
      rsi = 100;
      continue;
    }

    rs = avgGain / avgLoss;
    rsi = 100 - 100 / (1 + rs);
  }

  return rsi;
}

// MACD (12/26/9)
function calculateMACD(prices, fast = 12, slow = 26, signalPeriod = 9) {
  if (!prices || prices.length < slow + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const emaFast = calculateEMA(prices, fast);
  const emaSlow = calculateEMA(prices, slow);
  if (emaFast == null || emaSlow == null) {
    return { macd: 0, signal: 0, histogram: 0 };
  }

  const macd = emaFast - emaSlow;

  // История MACD для сигнальной линии
  const macdHistory = [];
  for (let i = slow; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const ef = calculateEMA(slice, fast);
    const es = calculateEMA(slice, slow);
    macdHistory.push(ef - es);
  }

  const signal = calculateEMA(macdHistory, signalPeriod) ?? macd;
  const histogram = macd - signal;

  return { macd, signal, histogram };
}

// Полосы Боллинджера
function calculateBollingerBands(prices, period = 20, multiplier = 2) {
  if (!prices || prices.length < period) {
    return { upper: null, middle: null, lower: null };
  }
  const slice = prices.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
  const std = Math.sqrt(variance);

  return {
    upper: sma + multiplier * std,
    middle: sma,
    lower: sma - multiplier * std,
  };
}

// Волатильность (%)
function calculateVolatility(prices, period = 20) {
  if (!prices || prices.length < period) return 0;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance =
    slice.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

// Стохастик %K
function calculateStochastic(prices, period = 14) {
  if (!prices || prices.length < period) return { k: 50 };
  const slice = prices.slice(-period);
  const high = Math.max(...slice);
  const low = Math.min(...slice);
  const current = prices[prices.length - 1];
  if (high === low) return { k: 50 };
  const k = ((current - low) / (high - low)) * 100;
  return { k: parseFloat(k.toFixed(2)) };
}

// ATR (упрощённо, на основе synthetic high/low)
function calculateATR(prices, period = 14) {
  if (!prices || prices.length < period + 1) {
    const last = prices[prices.length - 1] || 1;
    return last * 0.01;
  }

  const trs = [];
  for (let i = 1; i < prices.length; i++) {
    const close = prices[i];
    const prevClose = prices[i - 1];
    const high = Math.max(close, prevClose);
    const low = Math.min(close, prevClose);
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trs.push(tr);
  }

  if (trs.length < period) return trs[trs.length - 1] || 0.01;
  const recent = trs.slice(-period);
  const atr = recent.reduce((a, b) => a + b, 0) / period;
  return atr;
}

// ADX (реальная формула, но high/low синтезируем из close)
function calculateADX(prices, period = 14) {
  if (!prices || prices.length < period + 2) return 20;

  const highs = [];
  const lows = [];
  const closes = [];

  highs[0] = prices[0];
  lows[0] = prices[0];
  closes[0] = prices[0];

  for (let i = 1; i < prices.length; i++) {
    const c = prices[i];
    const prev = prices[i - 1];
    highs[i] = Math.max(c, prev);
    lows[i] = Math.min(c, prev);
    closes[i] = c;
  }

  const trArr = [];
  const plusDMArr = [];
  const minusDMArr = [];

  for (let i = 1; i < highs.length; i++) {
    const high = highs[i];
    const low = lows[i];
    const prevHigh = highs[i - 1];
    const prevLow = lows[i - 1];
    const prevClose = closes[i - 1];

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    let plusDM = 0;
    let minusDM = 0;

    if (upMove > downMove && upMove > 0) {
      plusDM = upMove;
    } else if (downMove > upMove && downMove > 0) {
      minusDM = downMove;
    }

    trArr.push(tr);
    plusDMArr.push(plusDM);
    minusDMArr.push(minusDM);
  }

  if (trArr.length < period) return 20;

  function smooth(arr) {
    let sum = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const result = [sum];
    for (let i = period; i < arr.length; i++) {
      sum = result[result.length - 1] - result[result.length - 1] / period + arr[i];
      result.push(sum);
    }
    return result;
  }

  const trSmooth = smooth(trArr);
  const plusDMSmooth = smooth(plusDMArr);
  const minusDMSmooth = smooth(minusDMArr);

  const dxArr = [];

  for (let i = 0; i < trSmooth.length; i++) {
    const tr = trSmooth[i] || 1e-9;
    const pDI = (plusDMSmooth[i] / tr) * 100;
    const mDI = (minusDMSmooth[i] / tr) * 100;
    const sum = pDI + mDI || 1e-9;
    const dx = (Math.abs(pDI - mDI) / sum) * 100;
    dxArr.push(dx);
  }

  if (dxArr.length < period) return 20;

  let adx =
    dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dxArr.length; i++) {
    adx = (adx * (period - 1) + dxArr[i]) / period;
  }

  return adx;
}

// ==================== ЗОНЫ ЛИКВИДНОСТИ ====================
function findLiquidityZones(prices, period = 20) {
  const zones = [];
  for (let i = period; i < prices.length - period; i++) {
    const left = prices.slice(i - period, i);
    const right = prices.slice(i + 1, i + period + 1);
    const price = prices[i];

    const isLocalMax = left.every((p) => p <= price) && right.every((p) => p <= price);
    const isLocalMin = left.every((p) => p >= price) && right.every((p) => p >= price);

    if (isLocalMax) zones.push({ type: 'resistance', price, strength: 1 });
    if (isLocalMin) zones.push({ type: 'support', price, strength: 1 });
  }
  return zones;
}

function findNearestLiquidityZone(currentPrice, zones, type) {
  const relevant = zones.filter((z) => z.type === type);
  if (relevant.length === 0) return null;
  relevant.sort(
    (a, b) =>
      Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
  );
  return relevant[0];
}

// ==================== КОММЕНТАРИЙ ТРЕЙДЕРА ====================
function generateTraderComment(signal) {
  const comments = [];
  const rsi = signal.indicators.rsi;
  const adx = signal.indicators.adx;
  const confidence = signal.confidence;

  if (confidence >= 85) {
    comments.push('Сильный сетап, большинство индикаторов согласуются.');
  } else if (confidence >= 70) {
    comments.push('Хороший сетап с несколькими подтверждениями.');
  } else if (confidence < 65) {
    comments.push('Сигнал умеренный, внимательно следим за объёмами.');
  }

  if (rsi < 25) {
    comments.push('Экстремальная перепроданность — возможен сильный отскок.');
  } else if (rsi > 75) {
    comments.push('Экстремальная перекупленность — вероятна коррекция.');
  }

  if (adx > 35) {
    comments.push('Сильный направленный тренд, импульс подтверждён.');
  } else if (adx < 20) {
    comments.push('Слабый тренд, рынок во флэте/консолидации.');
  }

  if (
    signal.confirmations.includes('ADX_STRONG_TREND') &&
    signal.confirmations.includes('HIGH_VOLUME')
  ) {
    comments.push('Высокие объёмы на сильном тренде усиливают сетап.');
  }

  if (signal.liquidityZoneUsed) {
    comments.push('Стоп размещён за значимой зоной ликвидности.');
  }

  return comments.length ? comments.join(' ') : 'Стандартный технический сетап.';
}

// ==================== АНАЛИЗ ОДНОЙ МОНЕТЫ ====================
const EXCHANGES = ['BINANCE', 'BYBIT', 'OKX', 'KUCOIN'];

function analyzeSignal(coin) {
  const priceHistory = coin.sparkline_in_7d?.price || [];
  const price = coin.current_price;
  const volume = coin.total_volume;
  const marketCap = coin.market_cap;

  if (!price || !volume || !marketCap) return null;
  if (STABLECOINS.includes(coin.symbol.toLowerCase())) return null;
  if (volume < CONFIG.minVolume) return null;
  if (marketCap < CONFIG.minMarketCap) return null;
  if (!priceHistory || priceHistory.length < 120) return null;

  // Индикаторы (слегка ускоренные)
  const rsi = calculateRSI(priceHistory, 9);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory, 12, 2);
  const volatility = calculateVolatility(priceHistory, 12);
  const sma20 = calculateSMA(priceHistory, 20);
  const sma50 = calculateSMA(priceHistory, 50);
  const ema20 = calculateEMA(priceHistory, 20);
  const ema50 = calculateEMA(priceHistory, 50);
  const ema100 = calculateEMA(priceHistory, 100);
  const stoch = calculateStochastic(priceHistory, 14);
  const atr = calculateATR(priceHistory, 14);
  const adx = calculateADX(priceHistory, 14);

  let qualityScore = 0;
  const confirmations = [];

  // RSI
  if (rsi < 30) {
    qualityScore += 2;
    confirmations.push('RSI_OVERSOLD');
  } else if (rsi > 70) {
    qualityScore += 2;
    confirmations.push('RSI_OVERBOUGHT');
  }

  // MACD
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BULLISH');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    qualityScore += 1;
    confirmations.push('MACD_BEARISH');
  }

  // Bollinger
  if (bb.lower && price < bb.lower) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (bb.upper && price > bb.upper) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }

  // Stochastic
  if (stoch.k < 20) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERSOLD');
  } else if (stoch.k > 80) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERBOUGHT');
  }

  // ADX
  if (adx > 30) {
    qualityScore += 2;
    confirmations.push('ADX_STRONG_TREND');
  } else if (adx < 20) {
    confirmations.push('ADX_FLAT_MARKET');
  }

  // Тренд по SMA
  if (sma20 && sma50) {
    if (sma20 > sma50) {
      qualityScore += 1;
      confirmations.push('TREND_BULLISH');
    } else if (sma20 < sma50) {
      qualityScore += 1;
      confirmations.push('TREND_BEALTHISH');
    }
  }

  // Выравнивание EMA
  if (ema20 && ema50 && ema100) {
    if (ema20 > ema50 && ema50 > ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BULLISH_ALIGNMENT');
    } else if (ema20 < ema50 && ema50 < ema100) {
      qualityScore += 2;
      confirmations.push('EMA_BEARISH_ALIGNMENT');
    }
  }

  // Объём
  if (volume > CONFIG.minVolume * 2) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }

  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confirmations.length < CONFIG.minConfirmations) return null;

  // Определяем LONG / SHORT
  let direction = null;
  let confidence = 0;

  // LONG
  if (
    (rsi < 35 && macd.histogram > 0 && stoch.k < 35 && adx > 25) ||
    (bb.lower && price < bb.lower && rsi < 40 && stoch.k < 40) ||
    (rsi < 30 && sma20 && sma50 && sma20 > sma50)
  ) {
    direction = 'LONG';
    const trendBonus = sma20 && sma50 && sma20 > sma50 ? 1.12 : 1.0;
    confidence = Math.min(
      (50 + (35 - rsi) * 1.1 + confirmations.length * 3.5) * trendBonus,
      95
    );
  }
  // SHORT
  else if (
    (rsi > 65 && macd.histogram < 0 && stoch.k > 65 && adx > 25) ||
    (bb.upper && price > bb.upper && rsi > 60 && stoch.k > 60) ||
    (rsi > 70 && sma20 && sma50 && sma20 < sma50)
  ) {
    direction = 'SHORT';
    const trendBonus = sma20 && sma50 && sma20 < sma50 ? 1.12 : 1.0;
    confidence = Math.min(
      (50 + (rsi - 65) * 1.1 + confirmations.length * 3.5) * trendBonus,
      95
    );
  }

  if (!direction || confidence < CONFIG.minConfidence) return null;

  // Зоны ликвидности / ATR / стопы / R:R
  const liquidityZones = findLiquidityZones(priceHistory, CONFIG.liquidityLookback);
  const entry = price;
  const baseATR = atr || price * 0.01;

  let sl;
  let tp;
  let rrRatio;
  let liquidityZoneUsed = false;

  const atrDistance = baseATR * CONFIG.atrMultiplier;
  const minSL = entry * CONFIG.minSLPercent;
  const maxSL = entry * CONFIG.maxSLPercent;

  if (direction === 'LONG') {
    let calculatedSL = entry - Math.max(atrDistance, minSL);
    calculatedSL = Math.max(calculatedSL, entry - maxSL);

    const supportZone = findNearestLiquidityZone(entry, liquidityZones, 'support');
    if (supportZone && supportZone.price < entry) {
      const zoneSL = supportZone.price * 0.997;
      if (entry - zoneSL < maxSL * 1.5) {
        calculatedSL = zoneSL;
        liquidityZoneUsed = true;
      }
    }

    sl = calculatedSL;
    tp = entry + (entry - sl) * CONFIG.minRRRatio;
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    let calculatedSL = entry + Math.max(atrDistance, minSL);
    calculatedSL = Math.min(calculatedSL, entry + maxSL);

    const resistanceZone = findNearestLiquidityZone(entry, liquidityZones, 'resistance');
    if (resistanceZone && resistanceZone.price > entry) {
      const zoneSL = resistanceZone.price * 1.003;
      if (zoneSL - entry < maxSL * 1.5) {
        calculatedSL = zoneSL;
        liquidityZoneUsed = true;
      }
    }

    sl = calculatedSL;
    tp = entry - (sl - entry) * CONFIG.minRRRatio;
    rrRatio = (entry - tp) / (sl - entry);
  }

  if (rrRatio < CONFIG.minRRRatio || sl <= 0 || tp <= 0) return null;

  const isGodTier =
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio;

  const isPremium =
    !isGodTier &&
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio;

  if (!isGodTier && !isPremium) return null;

  return {
    pair: `${coin.symbol.toUpperCase()}/USDT`,
    signal: direction,
    entry: parseFloat(entry.toFixed(6)),
    tp: parseFloat(tp.toFixed(6)),
    sl: parseFloat(sl.toFixed(6)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    exchange: EXCHANGES[Math.floor(Math.random() * EXCHANGES.length)],
    indicators: {
      rsi: Math.round(rsi),
      volatility: parseFloat(volatility.toFixed(2)),
      stochK: stoch.k,
      adx: Math.round(adx),
      atr: parseFloat(baseATR.toFixed(6)),
      ema20: ema20 ? parseFloat(ema20.toFixed(6)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null,
      ema100: ema100 ? parseFloat(ema100.toFixed(6)) : null,
    },
    confirmations,
    liquidityZoneUsed,
    timestamp: new Date(),
  };
}

// Генерация сигналов по рынку
function generateSignals(marketData) {
  logger.info(`🔍 Анализируем ${marketData.length} монет...`);
  const signals = marketData
    .filter((coin) => !STABLECOINS.includes(coin.symbol.toLowerCase()))
    .map((coin) => analyzeSignal(coin))
    .filter((s) => s !== null)
    .sort((a, b) => b.confidence - a.confidence);
  logger.info(`✅ Сгенерировано ${signals.length} сигналов.`);
  return signals;
}

// ==================== COINGECKO API ====================
async function fetchMarketData() {
  try {
    const url =
      `${CONFIG.apiUrl}/coins/markets` +
      `?vs_currency=usd` +
      `&order=volume_desc` +
      `&per_page=${CONFIG.topCoins}` +
      `&page=1` +
      `&sparkline=true` +
      `&price_change_percentage=1h,24h,7d`;

    const headers = {
      Accept: 'application/json',
      'User-Agent': 'CryptoSignalsBot/1.0',
    };

    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }

    logger.info('📡 Запрос к CoinGecko API...');
    const resp = await axios.get(url, { headers });

    if (resp.status !== 200) {
      logger.error('❌ CoinGecko API статус != 200:', resp.status);
      return [];
    }

    logger.info(`✅ Получено монет: ${resp.data.length}`);
    return resp.data;
  } catch (error) {
    logger.error('❌ Ошибка CoinGecko:', error.message);
    return [];
  }
}

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команды
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';

  logger.info(`💬 /start от chat ID: ${chatId}`);

  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot!\n\n` +
      `📊 Ваш Chat ID: <code>${chatId}</code>\n` +
      `👤 Пользователь: ${firstName} ${username}\n\n` +
      `💡 Используйте этот Chat ID в переменных окружения:\n` +
      `<code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
      `📈 Сигналы будут приходить сюда автоматически каждые 10 минут.`,
    { parse_mode: 'HTML' }
  );
});

bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  logger.info(`💬 /chatid от chat ID: ${chatId}`);
  ctx.reply(
    `💬 Ваш Chat ID: <code>${chatId}</code>\n\n` +
      `Установите его в .env или переменных окружения на Render:\n` +
      `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('test', async (ctx) => {
  logger.info('🧪 Отправка тестового сигнала...');

  const testSignal = {
    pair: 'BTC/USDT',
    signal: 'LONG',
    entry: 45000,
    tp: 48000,
    sl: 43500,
    confidence: 85,
    qualityScore: 8,
    rrRatio: 3.5,
    tier: 'GOD TIER',
    exchange: 'BINANCE',
    indicators: {
      rsi: 28,
      volatility: 5.2,
      stochK: 25,
      adx: 35,
      atr: 0.015,
      ema20: 44800,
      ema50: 44500,
      ema100: 44000,
    },
    confirmations: [
      'RSI_OVERSOLD',
      'MACD_BULLISH',
      'BB_OVERSOLD',
      'EMA_BULLISH_ALIGNMENT',
      'HIGH_VOLUME',
    ],
    liquidityZoneUsed: true,
    timestamp: new Date(),
  };

  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// Отправка сигнала в Telegram
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    logger.warn('⚠️ TELEGRAM_CHAT_ID не установлен — сигнал не будет отправлен.');
    return false;
  }

  try {
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '🟦';
    const tierText = signal.tier === 'GOD TIER' ? 'GOD TIER SIGNAL' : 'PREMIUM SIGNAL';
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';

    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).replace(',', ' —');

    const comment = generateTraderComment(signal);

    const confirmationsText = signal.confirmations
      .map((c) => `• ${c}`)
      .join('\n');

    let message = `
<b>${tierEmoji}${tierText}${tierEmoji}</b>

${directionEmoji} <b>${signal.signal} ${signal.pair}</b>

💵 <b>Entry:</b> ${signal.entry.toFixed(6)}
🎯 <b>Take Profit:</b> ${signal.tp.toFixed(6)}
🛑 <b>Stop Loss:</b> ${signal.sl.toFixed(6)}

🎲 <b>R:R Ratio:</b> 1:${signal.rrRatio.toFixed(1)}
📊 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality:</b> ${signal.qualityScore}/10

📉 <b>RSI:</b> ${signal.indicators.rsi}
📈 <b>Stoch K:</b> ${signal.indicators.stochK}
🌪 <b>Volatility:</b> ${signal.indicators.volatility}%
📡 <b>ADX:</b> ${signal.indicators.adx}
📏 <b>ATR:</b> ${signal.indicators.atr.toFixed(6)}

🔍 <b>Confirmations:</b>
${confirmationsText}

💬 <b>Comment:</b> <i>${comment}</i>

🏦 <b>Exchange:</b> ${signal.exchange}
⏱ <b>${timestamp}</b>
    `.trim();

    if (message.length > 3800) {
      message = message.slice(0, 3790) + '\n\n[сообщение сокращено]';
    }

    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    logger.info(`✅ Сигнал ${signal.pair} отправлен в Telegram`);
    return true;
  } catch (error) {
    logger.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  logger.info('\n🔄 === ЗАПУСК ЗАДАЧИ ГЕНЕРАЦИИ СИГНАЛОВ ===');
  logger.info(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);

  try {
    const marketData = await fetchMarketData();

    if (!marketData || marketData.length === 0) {
      logger.warn('❌ Данные рынка не получены, сигналы не будут сгенерированы.');
      return;
    }

    const signals = generateSignals(marketData);

    if (signals.length === 0) {
      logger.info('ℹ️ Подходящих сигналов не найдено.');
      return;
    }

    logger.info(`📤 Отправка ${signals.length} сигнал(ов)...`);

    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await sleep(2000); // Задержка между сообщениями
    }

    logger.info('✅ Задача генерации сигналов завершена.\n');
  } catch (error) {
    logger.error('❌ Ошибка в задаче генерации сигналов:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook();
    logger.info('✅ Webhook удалён (используем long polling).');

    const botInfo = await bot.telegram.getMe();
    logger.info(`✅ Бот подключен: @${botInfo.username}`);

    bot.launch();
    logger.info('✅ Бот запущен (long polling).');

    cron.schedule(CONFIG.cronExpr, runSignalsTask);
    logger.info(`✅ CRON задача запланирована: ${CONFIG.cronExpr} (каждые 10 минут)`);

    logger.info('⏳ Первый запуск задачи через 10 секунд...\n');
    setTimeout(runSignalsTask, 10_000);

    process.once('SIGINT', () => {
      logger.info('Получен SIGINT, останавливаем бота...');
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      logger.info('Получен SIGTERM, останавливаем бота...');
      bot.stop('SIGTERM');
    });
  } catch (error) {
    logger.error('❌ Ошибка запуска бота:', error.message);
    process.exit(1);
  }
}

// Старт
start();
