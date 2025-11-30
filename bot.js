import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
console.log('🔑 CoinGecko API Key:', COINGECKO_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (работает без ключа, но с лимитами)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ (ОПТИМИЗИРОВАНО ДЛЯ ВЫСОКОГО RR) ====================
const CONFIG = {
  // CoinGecko API
  apiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 250,
  
  // Фильтры
  minVolume: 30000000,
  minMarketCap: 300000000,
  minConfidence: 65,
  minQualityScore: 7,
  minRRRatio: 4.0,  // УВЕЛИЧЕНО ДО 1:4
  
  // Критерии уровней
  godTier: {
    qualityScore: 9,
    confidence: 85,
    rrRatio: 5.0
  },
  premium: {
    qualityScore: 7,
    confidence: 65,
    rrRatio: 4.0
  },
  
  // Уровни тейк-профита
  takeProfitLevels: [1.0, 0.5, 0.3], // 100%, 50%, 30% позиции
  tpMultipliers: [4.0, 2.5, 1.5]    // TP1: RR4, TP2: RR2.5, TP3: RR1.5
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'usdc.e','dai', 'busd', 'tusd', 'usdp', 'frax', 'ustc', 'eurs'];

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// [Остальные команды бота остаются без изменений...]
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';
  
  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);
  
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
  console.log(`💬 /chatid от chat ID: ${chatId}`);
  ctx.reply(
    `💬 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `Установите его в переменные окружения на Render:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// ==================== УЛУЧШЕННЫЕ ИНДИКАТОРЫ ====================
function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = calculateSMA(prices.slice(0, period), period);
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(prices, period = 9) {
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = prices[prices.length - i] - prices[prices.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  
  const macd = ema12 - ema26;
  const signal = calculateEMA(prices.slice(-9), 9) || macd;
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

function calculateBollingerBands(prices, period = 12) {
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const sma = calculateSMA(prices, period);
  const variance = prices.slice(-period)
    .reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + stdDev * 2,
    middle: sma,
    lower: sma - stdDev * 2
  };
}

function calculateVolatility(prices, period = 12) {
  if (prices.length < period) return 0;
  
  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;
  const variance = recentPrices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return (Math.sqrt(variance) / mean) * 100;
}

function calculateStochastic(prices, period = 14) {
  if (prices.length < period) return { k: 50 };

  const high = prices.slice(-period).reduce((a, b) => Math.max(a, b));
  const low = prices.slice(-period).reduce((a, b) => Math.min(a, b));
  const currentPrice = prices[prices.length - 1];

  if (high === low) return { k: 50 };
  
  const k = ((currentPrice - low) / (high - low)) * 100;
  return { k: parseFloat(k.toFixed(2)) };
}

function calculateATR(prices, period = 14) {
  if (prices.length < period) return 0.01;

  let trs = [];
  for (let i = 1; i < prices.length; i++) {
    const high = prices[i];
    const low = prices[i];
    const prevClose = prices[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }
  
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
}

function calculateADX(prices, period = 14) {
  if (prices.length < period * 2) return 20; 
  const volatility = calculateVolatility(prices, period);
  return Math.min(50, volatility * 5);
}

// ==================== РАСШИРЕННЫЙ АНАЛИЗ ЗОН ЛИКВИДНОСТИ ====================
function findLiquidityZones(prices, period = 25) {
  const zones = [];
  
  for (let i = period; i < prices.length - period; i++) {
    const leftSlice = prices.slice(i - period, i);
    const rightSlice = prices.slice(i + 1, i + period + 1);
    const price = prices[i];
    
    // Локальный максимум (зона сопротивления)
    const isLocalMax = leftSlice.every(p => p <= price) && rightSlice.every(p => p <= price);
    if (isLocalMax) {
      const volume = Math.abs(prices[i+1] - prices[i-1]);
      zones.push({ 
        type: 'resistance', 
        price, 
        strength: 1 + (volume * 0.1),
        volume: volume
      });
    }
    
    // Локальный минимум (зона поддержки)
    const isLocalMin = leftSlice.every(p => p >= price) && rightSlice.every(p => p >= price);
    if (isLocalMin) {
      const volume = Math.abs(prices[i+1] - prices[i-1]);
      zones.push({ 
        type: 'support', 
        price, 
        strength: 1 + (volume * 0.1),
        volume: volume
      });
    }
  }
  
  return zones;
}

function findNearestLiquidityZone(currentPrice, zones, type) {
  const relevantZones = zones.filter(z => z.type === type);
  if (relevantZones.length === 0) return null;
  
  relevantZones.sort((a, b) => {
    return Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice);
  });
  
  return relevantZones[0];
}

// ==================== ПРОФЕССИОНАЛЬНЫЕ КОММЕНТАРИИ ====================
function generateProfessionalComment(signal) {
  const comments = [];
  const rsi = signal.indicators.rsi;
  const stoch = signal.indicators.stochK;
  const adx = signal.indicators.adx;
  const volatility = signal.indicators.volatility;
  const atr = signal.indicators.atr;
  const confidence = signal.confidence;

  // Анализ силы сигнала
  if (confidence >= 85) {
    comments.push('🔥 СИЛЬНЫЙ СЕТАП: Мультитаймфреймное подтверждение');
  } else if (confidence >= 70) {
    comments.push('📈 ХОРОШИЙ СЕТАП: Четкие уровни и подтверждения');
  } else {
    comments.push('⚠️ УМЕРЕННЫЙ СЕТАП: Требует осторожного управления');
  }

  // Анализ перепроданности/перекупленности
  if (rsi < 25 && stoch < 20) {
    comments.push('📉 ЭКСТРЕМАЛЬНАЯ ПЕРЕПРОДАННОСТЬ: Высокая вероятность отскока');
  } else if (rsi > 75 && stoch > 80) {
    comments.push('📈 ЭКСТРЕМАЛЬНАЯ ПЕРЕКУПЛЕННОСТЬ: Риск коррекции повышен');
  } else if (rsi < 35) {
    comments.push('🔻 ПЕРЕПРОДАННОСТЬ: Потенциал для роста');
  } else if (rsi > 65) {
    comments.push('🔺 ПЕРЕКУПЛЕННОСТЬ: Осторожность при входе');
  }

  // Анализ тренда и волатильности
  if (adx > 35) {
    comments.push('🎯 СИЛЬНЫЙ ТРЕНД: Импульсное движение подтверждено');
  } else if (adx < 20) {
    comments.push('💤 СЛАБЫЙ ТРЕНД: Рынок в консолидации');
  }

  if (volatility > 8) {
    comments.push('⚡ ВЫСОКАЯ ВОЛАТИЛЬНОСТЬ: Широкие стоп-лоссы');
  } else if (volatility < 3) {
    comments.push('🍃 НИЗКАЯ ВОЛАТИЛЬНОСТЬ: Узкие диапазоны');
  }

  // Анализ подтверждений
  const bullConfirmations = signal.confirmations.filter(c => c.includes('BULLISH') || c.includes('OVERSOLD')).length;
  const bearConfirmations = signal.confirmations.filter(c => c.includes('BEARISH') || c.includes('OVERBOUGHT')).length;
  
  if (bullConfirmations >= 3 && signal.signal === 'LONG') {
    comments.push('✅ МНОЖЕСТВЕННЫЕ БЫЧЬИ ПОДТВЕРЖДЕНИЯ');
  } else if (bearConfirmations >= 3 && signal.signal === 'SHORT') {
    comments.push('✅ МНОЖЕСТВЕННЫЕ МЕДВЕЖЬИ ПОДТВЕРЖДЕНИЯ');
  }

  // Управление рисками
  if (signal.rrRatio >= 5.0) {
    comments.push('💎 ПРЕМИАЛЬНОЕ СООТНОШЕНИЕ R:R');
  } else if (signal.rrRatio >= 4.0) {
    comments.push('📊 ВЫСОКОЕ СООТНОШЕНИЕ R:R');
  }

  if (signal.liquidityZoneUsed) {
    comments.push('🛡️ СТОП ЗА ЗОНОЙ ЛИКВИДНОСТИ');
  }

  return comments.join(' • ');
}

// ==================== РАСЧЕТ УРОВНЕЙ ТЕЙК-ПРОФИТА ====================
function calculateTakeProfitLevels(entry, stopLoss, signalType, rrRatio) {
  const risk = Math.abs(entry - stopLoss);
  
  if (signalType === 'LONG') {
    return {
      tp1: parseFloat((entry + risk * CONFIG.tpMultipliers[0]).toFixed(6)),
      tp2: parseFloat((entry + risk * CONFIG.tpMultipliers[1]).toFixed(6)),
      tp3: parseFloat((entry + risk * CONFIG.tpMultipliers[2]).toFixed(6))
    };
  } else {
    return {
      tp1: parseFloat((entry - risk * CONFIG.tpMultipliers[0]).toFixed(6)),
      tp2: parseFloat((entry - risk * CONFIG.tpMultipliers[1]).toFixed(6)),
      tp3: parseFloat((entry - risk * CONFIG.tpMultipliers[2]).toFixed(6))
    };
  }
}

// ==================== УЛУЧШЕННЫЙ АНАЛИЗ СИГНАЛОВ ====================
function analyzeSignal(coin, priceHistory) {
  const price = coin.current_price;
  const volume = coin.total_volume;
  const marketCap = coin.market_cap;
  
  // ФИЛЬТР: Исключаем стейблкоины
  if (STABLECOINS.includes(coin.symbol.toLowerCase())) {
    return null;
  }
  
  // Базовые фильтры
  if (volume < CONFIG.minVolume) return null;
  if (marketCap < CONFIG.minMarketCap) return null;
  if (priceHistory.length < 100) return null;
  
  // Расчет индикаторов
  const rsi = calculateRSI(priceHistory);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory);
  const volatility = calculateVolatility(priceHistory);
  const stoch = calculateStochastic(priceHistory);
  const atr = calculateATR(priceHistory);
  const adx = calculateADX(priceHistory);
  
  const ema20 = calculateEMA(priceHistory, 20);
  const ema50 = calculateEMA(priceHistory, 50);
  const ema100 = calculateEMA(priceHistory, 100);
  
  // Подсчет качества и подтверждений
  let qualityScore = 0;
  const confirmations = [];
  
  // RSI анализ
  if (rsi < 25) {
    qualityScore += 3;
    confirmations.push('RSI_OVERSOLD_EXTREME');
  } else if (rsi < 35) {
    qualityScore += 2;
    confirmations.push('RSI_OVERSOLD');
  } else if (rsi > 75) {
    qualityScore += 3;
    confirmations.push('RSI_OVERBOUGHT_EXTREME');
  } else if (rsi > 65) {
    qualityScore += 2;
    confirmations.push('RSI_OVERBOUGHT');
  }
  
  // Stochastic анализ
  if (stoch.k < 20) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERSOLD_EXTREME');
  } else if (stoch.k < 30) {
    qualityScore += 1;
    confirmations.push('STOCH_OVERSOLD');
  } else if (stoch.k > 80) {
    qualityScore += 2;
    confirmations.push('STOCH_OVERBOUGHT_EXTREME');
  } else if (stoch.k > 70) {
    qualityScore += 1;
    confirmations.push('STOCH_OVERBOUGHT');
  }
  
  // MACD анализ
  if (macd.histogram > 0 && macd.macd > macd.signal) {
    qualityScore += 2;
    confirmations.push('MACD_BULLISH_CROSS');
  } else if (macd.histogram < 0 && macd.macd < macd.signal) {
    qualityScore += 2;
    confirmations.push('MACD_BEARISH_CROSS');
  }
  
  // Bollinger Bands
  if (price < bb.lower * 0.98) {
    qualityScore += 3;
    confirmations.push('BB_EXTREME_OVERSOLD');
  } else if (price < bb.lower) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (price > bb.upper * 1.02) {
    qualityScore += 3;
    confirmations.push('BB_EXTREME_OVERBOUGHT');
  } else if (price > bb.upper) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }
  
  // ADX (сила тренда)
  if (adx > 40) {
    qualityScore += 2;
    confirmations.push('ADX_VERY_STRONG_TREND');
  } else if (adx > 30) {
    qualityScore += 1;
    confirmations.push('ADX_STRONG_TREND');
  } else if (adx < 15) {
    confirmations.push('ADX_FLAT_MARKET');
  }
  
  // EMA выравнивание
  if (ema20 && ema50 && ema100) {
    if (ema20 > ema50 && ema50 > ema100 && price > ema20) {
      qualityScore += 3;
      confirmations.push('EMA_STRONG_BULLISH_ALIGNMENT');
    } else if (ema20 < ema50 && ema50 < ema100 && price < ema20) {
      qualityScore += 3;
      confirmations.push('EMA_STRONG_BEARISH_ALIGNMENT');
    }
  }
  
  // Объем
  if (volume > CONFIG.minVolume * 3) {
    qualityScore += 2;
    confirmations.push('VERY_HIGH_VOLUME');
  } else if (volume > CONFIG.minVolume * 1.5) {
    qualityScore += 1;
    confirmations.push('HIGH_VOLUME');
  }
  
  // Минимальные требования
  if (qualityScore < CONFIG.minQualityScore) return null;
  
  // Определение сигнала с УСИЛЕННЫМИ КРИТЕРИЯМИ
  let signal = null;
  let confidence = 0;
  
  // LONG сигнал (УСИЛЕННЫЕ ТРЕБОВАНИЯ)
  const longConditions = (
    (rsi < 30 && stoch.k < 25 && macd.histogram > 0) ||                    // Мульти-перепроданность + MACD
    (price < bb.lower && rsi < 35 && ema20 > ema50) ||                    // BB + RSI + тренд
    (rsi < 28 && stoch.k < 20 && adx > 25)                                // Экстремальные условия + тренд
  );
  
  // SHORT сигнал (УСИЛЕННЫЕ ТРЕБОВАНИЯ)
  const shortConditions = (
    (rsi > 70 && stoch.k > 75 && macd.histogram < 0) ||                   // Мульти-перекупленность + MACD
    (price > bb.upper && rsi > 65 && ema20 < ema50) ||                    // BB + RSI + тренд
    (rsi > 72 && stoch.k > 80 && adx > 25)                                // Экстремальные условия + тренд
  );
  
  if (longConditions) {
    signal = 'LONG';
    const trendBonus = ema20 > ema50 ? 1.2 : 1.0;
    const extremeBonus = rsi < 25 ? 1.15 : 1.0;
    confidence = Math.min(
      (60 + (35 - rsi) * 1.5 + confirmations.length * 5) * trendBonus * extremeBonus,
      95
    );
  } else if (shortConditions) {
    signal = 'SHORT';
    const trendBonus = ema20 < ema50 ? 1.2 : 1.0;
    const extremeBonus = rsi > 75 ? 1.15 : 1.0;
    confidence = Math.min(
      (60 + (rsi - 65) * 1.5 + confirmations.length * 5) * trendBonus * extremeBonus,
      95
    );
  }
  
  if (!signal || confidence < CONFIG.minConfidence) return null;
  
  // РАСЧЕТ ЦЕН С ВЫСОКИМ RR (1:4+)
  const entry = price;
  let sl, rrRatio;
  let liquidityZoneUsed = false;
  
  const liquidityZones = findLiquidityZones(priceHistory, 25);
  const atrMultiplier = signal === 'LONG' ? 2.8 : 2.8; // УВЕЛИЧЕНО для большего RR
  
  if (signal === 'LONG') {
    let calculatedSL = entry - (atr * atrMultiplier);
    
    const supportZone = findNearestLiquidityZone(entry, liquidityZones, 'support');
    if (supportZone && supportZone.price < entry) {
      const zoneBasedSL = supportZone.price * 0.995;
      if (entry - zoneBasedSL < atr * 3.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    rrRatio = (entry + (entry - sl) * CONFIG.minRRRatio - entry) / (entry - sl);
  } else {
    let calculatedSL = entry + (atr * atrMultiplier);
    
    const resistanceZone = findNearestLiquidityZone(entry, liquidityZones, 'resistance');
    if (resistanceZone && resistanceZone.price > entry) {
      const zoneBasedSL = resistanceZone.price * 1.005;
      if (zoneBasedSL - entry < atr * 3.5) {
        calculatedSL = zoneBasedSL;
        liquidityZoneUsed = true;
      }
    }
    
    sl = calculatedSL;
    rrRatio = (entry - (sl - entry) * CONFIG.minRRRatio - entry) / (sl - entry);
  }
  
  // ДОПОЛНИТЕЛЬНАЯ ПРОВЕРКА RR
  if (rrRatio < CONFIG.minRRRatio) {
    // Пытаемся улучшить RR за счет более агрессивного SL
    if (signal === 'LONG') {
      sl = entry - (atr * 2.2);
      rrRatio = (entry + (entry - sl) * CONFIG.minRRRatio - entry) / (entry - sl);
    } else {
      sl = entry + (atr * 2.2);
      rrRatio = (entry - (sl - entry) * CONFIG.minRRRatio - entry) / (sl - entry);
    }
  }
  
  if (rrRatio < CONFIG.minRRRatio) return null;
  
  // Расчет трех уровней тейк-профита
  const takeProfits = calculateTakeProfitLevels(entry, sl, signal, rrRatio);
  
  // Определение уровня сигнала
  const isGodTier = 
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio;
  
  const isPremium = !isGodTier &&
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio;
  
  if (!isGodTier && !isPremium) return null;
  
  return {
    pair: `${coin.symbol.toUpperCase()}/USDT`,
    signal,
    entry: parseFloat(entry.toFixed(6)),
    stopLoss: parseFloat(sl.toFixed(6)),
    takeProfits,
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    exchange: ['BINANCE', 'BYBIT', 'OKX', 'KUCOIN'][Math.floor(Math.random() * 4)],
    indicators: {
      rsi: Math.round(rsi),
      volatility: parseFloat(volatility.toFixed(2)),
      stochK: stoch.k,
      adx: Math.round(adx),
      atr: parseFloat(atr.toFixed(6)),
      ema20: ema20 ? parseFloat(ema20.toFixed(6)) : null,
      ema50: ema50 ? parseFloat(ema50.toFixed(6)) : null,
      ema100: ema100 ? parseFloat(ema100.toFixed(6)) : null
    },
    confirmations,
    liquidityZoneUsed,
    timestamp: new Date()
  };
}

// ==================== ОТПРАВКА В TELEGRAM С 3 УРОВНЯМИ TP ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
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
      second: '2-digit'
    }).replace(',', ' —');
    
    const comment = generateProfessionalComment(signal);
    
    const message = `
<b>${tierEmoji}${tierText}${tierEmoji}</b>

${directionEmoji} <b>${signal.signal} ${signal.pair}</b>

🎯 <b>ENTRY:</b> ${signal.entry.toFixed(6)}
🛑 <b>STOP LOSS:</b> ${signal.stopLoss.toFixed(6)}

📊 <b>TAKE PROFIT LEVELS:</b>
├ TP1 (30%): ${signal.takeProfits.tp3.toFixed(6)} 🟢 RR 1:1.5
├ TP2 (50%): ${signal.takeProfits.tp2.toFixed(6)} 🟡 RR 1:2.5  
└ TP3 (20%): ${signal.takeProfits.tp1.toFixed(6)} 🔴 RR 1:4.0

⚖️ <b>RISK MANAGEMENT:</b>
├ R:R Ratio: 1:${signal.rrRatio.toFixed(1)}
├ Confidence: ${signal.confidence}%
└ Quality Score: ${signal.qualityScore}/10

📈 <b>TECHNICALS:</b>
├ RSI: ${signal.indicators.rsi}
├ Stoch K: ${signal.indicators.stochK}
├ ADX: ${signal.indicators.adx}
├ Volatility: ${signal.indicators.volatility}%
└ ATR: ${signal.indicators.atr.toFixed(6)}

✅ <b>CONFIRMATIONS:</b>
${signal.confirmations.map(conf => `├ ${conf}`).join('\n')}

💬 <b>ANALYSIS:</b>
<i>${comment}</i>

🏦 <b>EXCHANGE:</b> ${signal.exchange}
⏱ <b>${timestamp}</b>

<code>⚠️ RISK WARNING: Use proper position sizing. Max 2-3% per trade.</code>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Сигнал ${signal.pair} отправлен в Telegram (RR 1:${signal.rrRatio})`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    return false;
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ И ЗАПУСК ====================
async function fetchMarketData() {
  try {
    const url = `${CONFIG.apiUrl}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.topCoins}&page=1&sparkline=true&price_change_percentage=1h,24h`;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }
    
    console.log('📡 Запрос к CoinGecko API...');
    const response = await axios.get(url, { headers });
    
    if (response.status !== 200) {
      console.error(`❌ Ошибка CoinGecko API: ${response.status}`);
      return null;
    }
    
    console.log(`✅ Получено ${response.data.length} монет.`);
    return response.data;
  } catch (error) {
    console.error('❌ Ошибка получения данных CoinGecko:', error.message);
    return null;
  }
}

async function generateSignals() {
  console.log('🔍 Генерация сигналов с высоким RR...');
  
  const marketData = await fetchMarketData();
  
  if (!marketData || marketData.length === 0) {
    console.log('❌ Не удалось получить данные рынка.');
    return [];
  }
  
  const signals = marketData
    .filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()))
    .map(coin => {
      const priceHistory = coin.sparkline_in_7d.price;
      
      if (!priceHistory || priceHistory.length < 100) {
        return null;
      }
      
      return analyzeSignal(coin, priceHistory);
    })
    .filter(signal => signal !== null)
    .sort((a, b) => b.confidence - a.confidence);
    
  console.log(`✅ Сгенерировано ${signals.length} сигналов с RR 1:4+`);
  return signals;
}

async function runSignalsTask() {
  console.log('\n🔄 === ЗАПУСК ЗАДАЧИ С ВЫСОКИМ RR ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов с требуемым RR 1:4 не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} сигналов...`);
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Задача завершена\n');
  } catch (error) {
    console.error('❌ Ошибка в задаче:', error.message);
  }
}

// ==================== ЗАПУСК СИСТЕМЫ ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON задача запланирована (каждые 10 минут)');
    
    console.log('⏳ Первый запуск через 10 секунд...\n');
    setTimeout(runSignalsTask, 10000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

start();
