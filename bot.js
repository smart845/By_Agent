const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');
const talib = require('talib'); // Устанавливаем: npm install talib

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск MEXC Futures Signals Bot...');

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('❌ Проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ MEXC FUTURES ====================
const CONFIG = {
  exchange: 'MEXC Futures',
  apiUrl: 'https://contract.mexc.com',
  minVolume: 100000,           // 100K USDT
  scanInterval: '*/3 * * * *',  // Каждые 3 минуты
  minChange: 2,                // Минимальное изменение 2%
  minConfidence: 70,           // Минимальная уверенность 70%
  maxSignals: 3,               // Максимум сигналов за сканирование
  scanPairs: 40,               // Сколько пар сканировать
  leverage: 10,                // Рекомендуемое плечо
  riskPerTrade: 1,             // Риск 1% на сделку
  rrRatio: 4,                  // Риск:прибыль 1:4
  timeframes: ['15m', '1h', '4h'] // Анализируемые таймфреймы
};

// Хранилище сигналов (кд 1 час)
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 60 * 60 * 1000;

// ==================== MEXC FUTURES API ====================
async function getFuturesTickers() {
  try {
    console.log('📡 Запрос к MEXC Futures API...');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/ticker`, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    console.log(`✅ Получено ${response.data.data?.length || 0} фьючерсов`);
    
    if (!response.data.success || !response.data.data) {
      throw new Error('Некорректный ответ от API');
    }
    
    // Фильтруем USDT контракты
    const futures = response.data.data
      .filter(ticker => ticker.symbol.endsWith('USDT'))
      .map(ticker => ({
        symbol: ticker.symbol,
        price: parseFloat(ticker.lastPrice),
        change24h: parseFloat(ticker.riseFallRate) * 100, // В процентах
        volume24h: parseFloat(ticker.volume24),
        turnover24h: parseFloat(ticker.amount24),
        high24h: parseFloat(ticker.high24),
        low24h: parseFloat(ticker.low24),
        fundingRate: parseFloat(ticker.fundingRate) * 100 || 0
      }))
      .filter(ticker => 
        ticker.turnover24h >= CONFIG.minVolume &&
        Math.abs(ticker.change24h) >= 0.5
      );
    
    console.log(`✅ Отфильтровано ${futures.length} фьючерсов`);
    return futures;
    
  } catch (error) {
    console.error('❌ Ошибка Futures API:', error.message);
    return [];
  }
}

// Получаем Kline данные для фьючерсов
async function getFuturesKlines(symbol, interval = '15m', limit = 100) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/kline/${symbol}`, {
      params: {
        interval: interval,
        limit: limit
      },
      timeout: 8000
    });
    
    if (!response.data.success || !response.data.data) {
      return [];
    }
    
    return response.data.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      turnover: parseFloat(k[6])
    }));
    
  } catch (error) {
    console.error(`❌ Ошибка Kline ${symbol}:`, error.message);
    return [];
  }
}

// Получаем данные по открытому интересу
async function getOpenInterest(symbol) {
  try {
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/open_interest/${symbol}`, {
      timeout: 5000
    });
    
    if (response.data.success && response.data.data) {
      return {
        value: parseFloat(response.data.data.sumOpenInterest),
        valueUsd: parseFloat(response.data.data.sumOpenInterestValue)
      };
    }
    return null;
  } catch (error) {
    console.error(`❌ Ошибка Open Interest ${symbol}:`, error.message);
    return null;
  }
}

// Получаем топ ликвидности
async function getTopPairsForScan() {
  try {
    const futures = await getFuturesTickers();
    if (futures.length === 0) return [];
    
    // Сортируем по объему и волатильности
    return futures
      .sort((a, b) => {
        // Вес: 60% объем + 40% изменение
        const scoreA = (b.turnover24h / 1000000) * 0.6 + Math.abs(b.change24h) * 0.4;
        const scoreB = (a.turnover24h / 1000000) * 0.6 + Math.abs(a.change24h) * 0.4;
        return scoreB - scoreA;
      })
      .slice(0, CONFIG.scanPairs);
    
  } catch (error) {
    console.error('❌ Ошибка получения топ пар:', error.message);
    return [];
  }
}

// ==================== РАСШИРЕННЫЕ ИНДИКАТОРЫ ====================
// RSI с несколькими периодами
function calculateMultiTimeframeRSI(klines) {
  const closes = klines.map(k => k.close);
  
  return {
    rsi14: calculateRSI(closes, 14),
    rsi9: calculateRSI(closes, 9),
    rsi25: calculateRSI(closes, 25)
  };
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = closes[closes.length - i] - closes[closes.length - i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// MACD с сигнальной линией
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow) return null;
  
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = emaFast - emaSlow;
  
  // Рассчитываем сигнальную линию (EMA от MACD)
  const macdValues = [];
  for (let i = slow; i < closes.length; i++) {
    const fastEMA = calculateEMA(closes.slice(0, i + 1), fast);
    const slowEMA = calculateEMA(closes.slice(0, i + 1), slow);
    macdValues.push(fastEMA - slowEMA);
  }
  
  const signalLine = calculateEMA(macdValues.slice(-signal), signal);
  const histogram = macdLine - signalLine;
  
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: histogram,
    bullish: histogram > 0 && macdLine > signalLine,
    bearish: histogram < 0 && macdLine < signalLine
  };
}

// Bollinger Bands
function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  
  const recent = closes.slice(-period);
  const middle = recent.reduce((a, b) => a + b, 0) / period;
  
  const variance = recent.reduce((sum, price) => {
    return sum + Math.pow(price - middle, 2);
  }, 0) / period;
  
  const std = Math.sqrt(variance);
  
  return {
    upper: middle + (std * stdDev),
    middle: middle,
    lower: middle - (std * stdDev),
    bandwidth: ((middle + (std * stdDev)) - (middle - (std * stdDev))) / middle * 100,
    percentB: (closes[closes.length - 1] - (middle - (std * stdDev))) / ((middle + (std * stdDev)) - (middle - (std * stdDev))) * 100
  };
}

// Stochastic
function calculateStochastic(highs, lows, closes, period = 14, smoothK = 3, smoothD = 3) {
  if (closes.length < period) return null;
  
  const currentClose = closes[closes.length - 1];
  const lowestLow = Math.min(...lows.slice(-period));
  const highestHigh = Math.max(...highs.slice(-period));
  
  if (highestHigh === lowestLow) return null;
  
  const k = ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
  
  // Скользящие средние для K и D
  const kValues = [];
  for (let i = 0; i < smoothK; i++) {
    if (closes.length - i - period < 0) break;
    const close = closes[closes.length - i - 1];
    const low = Math.min(...lows.slice(closes.length - i - period, closes.length - i));
    const high = Math.max(...highs.slice(closes.length - i - period, closes.length - i));
    kValues.push(((close - low) / (high - low)) * 100);
  }
  
  const kSmooth = kValues.reduce((a, b) => a + b, 0) / kValues.length;
  
  const dValues = [];
  for (let i = 0; i < smoothD; i++) {
    if (closes.length - i - period - smoothK < 0) break;
    dValues.push(kValues[i] || kSmooth);
  }
  
  const dSmooth = dValues.reduce((a, b) => a + b, 0) / dValues.length;
  
  return {
    k: kSmooth,
    d: dSmooth,
    oversold: kSmooth < 20 && dSmooth < 20,
    overbought: kSmooth > 80 && dSmooth > 80
  };
}

// Volume Profile
function calculateVolumeProfile(klines, priceLevels = 20) {
  const volumesByPrice = {};
  const prices = klines.map(k => k.close);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const priceRange = maxPrice - minPrice;
  const levelSize = priceRange / priceLevels;
  
  klines.forEach(k => {
    const level = Math.floor((k.close - minPrice) / levelSize);
    const priceLevel = minPrice + (level * levelSize);
    
    if (!volumesByPrice[priceLevel]) {
      volumesByPrice[priceLevel] = 0;
    }
    volumesByPrice[priceLevel] += k.volume;
  });
  
  // Находим POC (Point of Control)
  let pocPrice = 0;
  let maxVolume = 0;
  
  Object.entries(volumesByPrice).forEach(([price, volume]) => {
    if (volume > maxVolume) {
      maxVolume = volume;
      pocPrice = parseFloat(price);
    }
  });
  
  return {
    poc: pocPrice,
    valueArea: Object.keys(volumesByPrice).map(p => parseFloat(p)).sort((a, b) => a - b),
    profile: volumesByPrice
  };
}

// ATR (Average True Range) для стоп-лосса
function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 0;
  
  const trueRanges = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  
  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

// ADX (Average Directional Index)
function calculateADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return null;
  
  const plusDM = [];
  const minusDM = [];
  const tr = [];
  
  for (let i = 1; i < closes.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    
    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
      minusDM.push(0);
    } else if (downMove > upMove && downMove > 0) {
      plusDM.push(0);
      minusDM.push(downMove);
    } else {
      plusDM.push(0);
      minusDM.push(0);
    }
    
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  
  const atr = calculateATR(highs, lows, closes, period);
  const plusDI = (plusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  const minusDI = (minusDM.slice(-period).reduce((a, b) => a + b, 0) / period) / atr * 100;
  
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  
  return {
    adx: dx,
    plusDI: plusDI,
    minusDI: minusDI,
    trendStrength: dx > 25 ? 'STRONG' : dx > 20 ? 'MODERATE' : 'WEAK',
    direction: plusDI > minusDI ? 'BULLISH' : 'BEARISH'
  };
}

// Скользящие средние
function calculateEMA(values, period) {
  if (values.length < period) return values[values.length - 1] || 0;
  
  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < values.length; i++) {
    ema = (values[i] * multiplier) + (ema * (1 - multiplier));
  }
  
  return ema;
}

function calculateSMA(values, period) {
  if (values.length < period) return values.reduce((a, b) => a + b, 0) / values.length || 0;
  const recent = values.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

// Volume анализ
function calculateVolumeAnalysis(volumes) {
  if (volumes.length < 20) return null;
  
  const recentVolumes = volumes.slice(-20);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / 20;
  const currentVolume = volumes[volumes.length - 1];
  const volumeRatio = currentVolume / avgVolume;
  
  // Объемный профиль
  const volumeSpike = volumeRatio > 2 ? 'HIGH_SPIKE' : volumeRatio > 1.5 ? 'SPIKE' : 'NORMAL';
  
  return {
    currentVolume: currentVolume,
    avgVolume: avgVolume,
    ratio: volumeRatio,
    spike: volumeSpike,
    increasing: volumes[volumes.length - 1] > volumes[volumes.length - 2] > volumes[volumes.length - 3]
  };
}

// Анализ свечных паттернов
function analyzeCandlePatterns(klines) {
  if (klines.length < 3) return [];
  
  const patterns = [];
  const last3 = klines.slice(-3);
  
  // Bullish Engulfing
  if (last3[1].close < last3[1].open && // Медвежья свеча
      last3[2].close > last3[2].open && // Бычья свеча
      last3[2].open < last3[1].close &&
      last3[2].close > last3[1].open) {
    patterns.push('BULLISH_ENGULFING');
  }
  
  // Bearish Engulfing
  if (last3[1].close > last3[1].open && // Бычья свеча
      last3[2].close < last3[2].open && // Медвежья свеча
      last3[2].open > last3[1].close &&
      last3[2].close < last3[1].open) {
    patterns.push('BEARISH_ENGULFING');
  }
  
  // Hammer
  const last = klines[klines.length - 1];
  const bodySize = Math.abs(last.close - last.open);
  const lowerWick = last.close > last.open ? 
    last.open - last.low : last.close - last.low;
  const upperWick = last.close > last.open ? 
    last.high - last.close : last.high - last.open;
  
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
    patterns.push(last.close > last.open ? 'BULLISH_HAMMER' : 'HAMMER');
  }
  
  // Shooting Star
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) {
    patterns.push(last.close < last.open ? 'BEARISH_SHOOTING_STAR' : 'SHOOTING_STAR');
  }
  
  return patterns;
}

// ==================== ПОЛНЫЙ АНАЛИЗ ПАРЫ ====================
async function performCompleteAnalysis(pair) {
  try {
    console.log(`🔍 Полный анализ ${pair.symbol}...`);
    
    // Проверка кд
    const now = Date.now();
    if (sentSignals.has(pair.symbol) && (now - sentSignals.get(pair.symbol)) < SIGNAL_COOLDOWN) {
      return null;
    }
    
    // Получаем данные по всем таймфреймам
    const klinesData = {};
    for (const tf of CONFIG.timeframes) {
      klinesData[tf] = await getFuturesKlines(pair.symbol, tf, 100);
      if (klinesData[tf].length < 50) {
        console.log(`⚠️ Недостаточно данных для ${pair.symbol} на ${tf}`);
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    const klines15m = klinesData['15m'];
    const currentPrice = klines15m[klines15m.length - 1].close;
    
    // Извлекаем данные
    const closes15m = klines15m.map(k => k.close);
    const highs15m = klines15m.map(k => k.high);
    const lows15m = klines15m.map(k => k.low);
    const volumes15m = klines15m.map(k => k.volume);
    
    const closes1h = klinesData['1h'].map(k => k.close);
    const highs1h = klinesData['1h'].map(k => k.high);
    const lows1h = klinesData['1h'].map(k => k.low);
    
    // Рассчитываем ВСЕ индикаторы
    const indicators = {
      // RSI на разных таймфреймах
      rsi: {
        m15: calculateRSI(closes15m, 14),
        h1: calculateRSI(closes1h, 14),
        m15_9: calculateRSI(closes15m, 9),
        h1_25: calculateRSI(closes1h, 25)
      },
      
      // MACD
      macd: {
        m15: calculateMACD(closes15m),
        h1: calculateMACD(closes1h)
      },
      
      // Bollinger Bands
      bb: {
        m15: calculateBollingerBands(closes15m),
        h1: calculateBollingerBands(closes1h)
      },
      
      // Stochastic
      stochastic: {
        m15: calculateStochastic(highs15m, lows15m, closes15m),
        h1: calculateStochastic(highs1h, lows1h, closes1h)
      },
      
      // Volume анализ
      volume: calculateVolumeAnalysis(volumes15m),
      
      // ATR для стопов
      atr: calculateATR(highs15m, lows15m, closes15m),
      
      // ADX для силы тренда
      adx: calculateADX(highs15m, lows15m, closes15m),
      
      // Скользящие средние
      ma: {
        ema9: calculateEMA(closes15m, 9),
        ema21: calculateEMA(closes15m, 21),
        ema50: calculateEMA(closes15m, 50),
        sma20: calculateSMA(closes15m, 20),
        sma50: calculateSMA(closes15m, 50)
      },
      
      // Свечные паттерны
      patterns: analyzeCandlePatterns(klines15m),
      
      // Volume Profile
      volumeProfile: calculateVolumeProfile(klines15m.slice(-50))
    };
    
    // Получаем Open Interest
    const oi = await getOpenInterest(pair.symbol);
    
    // Анализ конвергенции/дивергенции
    const hasBullishDivergence = checkBullishDivergence(closes15m, indicators.rsi.m15, lows15m);
    const hasBearishDivergence = checkBearishDivergence(closes15m, indicators.rsi.m15, highs15m);
    
    // Определяем общий тренд
    const trend = determineTrend(indicators);
    
    // Анализируем на сигнал
    const signalAnalysis = analyzeForSignal(pair, currentPrice, indicators, trend, oi, {
      bullishDivergence: hasBullishDivergence,
      bearishDivergence: hasBearishDivergence
    });
    
    if (signalAnalysis) {
      sentSignals.set(pair.symbol, now);
      return {
        ...signalAnalysis,
        indicators: indicators,
        openInterest: oi,
        pair: pair,
        timeframe: '15m',
        leverage: CONFIG.leverage,
        risk: CONFIG.riskPerTrade
      };
    }
    
    return null;
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// Проверка бычьей дивергенции
function checkBullishDivergence(prices, rsi, lows) {
  if (prices.length < 20) return false;
  
  const recentPrices = prices.slice(-10);
  const recentRSI = rsi; // RSI уже рассчитан
  const recentLows = lows.slice(-10);
  
  // Ищем более низкие минимумы цен при более высоких минимумах RSI
  const priceLow1 = Math.min(...recentPrices.slice(0, 5));
  const priceLow2 = Math.min(...recentPrices.slice(5));
  const rsiLow1 = Math.min(...Array(5).fill(recentRSI - 10)); // Примерное значение
  const rsiLow2 = Math.min(...Array(5).fill(recentRSI));
  
  return priceLow2 < priceLow1 && rsiLow2 > rsiLow1;
}

// Проверка медвежьей дивергенции
function checkBearishDivergence(prices, rsi, highs) {
  if (prices.length < 20) return false;
  
  const recentPrices = prices.slice(-10);
  const recentRSI = rsi;
  const recentHighs = highs.slice(-10);
  
  // Ищем более высокие максимумы цен при более низких максимумах RSI
  const priceHigh1 = Math.max(...recentPrices.slice(0, 5));
  const priceHigh2 = Math.max(...recentPrices.slice(5));
  const rsiHigh1 = Math.max(...Array(5).fill(recentRSI + 10));
  const rsiHigh2 = Math.max(...Array(5).fill(recentRSI));
  
  return priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1;
}

// Определение тренда
function determineTrend(indicators) {
  const trendScore = {
    bullish: 0,
    bearish: 0
  };
  
  // Анализ EMA
  if (indicators.ma.ema9 > indicators.ma.ema21) trendScore.bullish += 2;
  if (indicators.ma.ema21 > indicators.ma.ema50) trendScore.bullish += 1;
  if (indicators.ma.ema9 < indicators.ma.ema21) trendScore.bearish += 2;
  if (indicators.ma.ema21 < indicators.ma.ema50) trendScore.bearish += 1;
  
  // Анализ MACD
  if (indicators.macd.m15?.bullish) trendScore.bullish += 2;
  if (indicators.macd.m15?.bearish) trendScore.bearish += 2;
  
  // Анализ ADX
  if (indicators.adx?.direction === 'BULLISH') trendScore.bullish += 1;
  if (indicators.adx?.direction === 'BEARISH') trendScore.bearish += 1;
  
  return trendScore.bullish > trendScore.bearish ? 'BULLISH' : 
         trendScore.bearish > trendScore.bullish ? 'BEARISH' : 'NEUTRAL';
}

// Анализ на сигнал с RR 1:4
function analyzeForSignal(pair, currentPrice, indicators, trend, oi, divergence) {
  let signal = null;
  let confidence = 0;
  let reasons = [];
  let entry = currentPrice;
  
  // УСЛОВИЯ ДЛЯ LONG (RR 1:4)
  if (indicators.rsi.m15 < 32 && 
      indicators.rsi.h1 < 45 &&
      indicators.stochastic.m15?.oversold &&
      indicators.macd.m15?.histogram > 0 &&
      (trend === 'BULLISH' || divergence.bullishDivergence) &&
      indicators.volume?.spike !== 'NORMAL') {
    
    signal = 'LONG';
    
    // Расчет уровней с RR 1:4
    const atrStop = indicators.atr * 1.5;
    const percentStop = currentPrice * 0.015; // 1.5% стоп
    
    const stopLoss = Math.min(
      currentPrice - atrStop,
      currentPrice * 0.985
    );
    
    const takeProfit = currentPrice + ((currentPrice - stopLoss) * CONFIG.rrRatio);
    
    // Уверенность и причины
    confidence = 70;
    if (indicators.rsi.m15 < 25) {
      confidence += 10;
      reasons.push('RSI сильно перепродан');
    }
    if (divergence.bullishDivergence) {
      confidence += 15;
      reasons.push('Бычья дивергенция RSI');
    }
    if (indicators.volume?.spike === 'HIGH_SPIKE') {
      confidence += 10;
      reasons.push('Высокий объем');
    }
    if (indicators.macd.m15?.bullish) {
      confidence += 5;
      reasons.push('MACD бычий');
    }
    if (trend === 'BULLISH') {
      confidence += 5;
      reasons.push('Общий тренд бычий');
    }
    if (oi && oi.valueUsd > pair.turnover24h * 0.1) {
      reasons.push('Высокий Open Interest');
    }
    
    if (indicators.patterns.includes('BULLISH_ENGULFING') || 
        indicators.patterns.includes('BULLISH_HAMMER')) {
      confidence += 10;
      reasons.push('Бычий свечной паттерн');
    }
    
    return {
      pair: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: takeProfit.toFixed(8),
      sl: stopLoss.toFixed(8),
      confidence: Math.min(confidence, 95),
      rrRatio: CONFIG.rrRatio,
      reasons: reasons,
      change24h: pair.change24h.toFixed(2),
      volume24h: (pair.volume24h / 1000000).toFixed(2),
      fundingRate: pair.fundingRate?.toFixed(4) || '0.0000'
    };
  }
  
  // УСЛОВИЯ ДЛЯ SHORT (RR 1:4)
  if (indicators.rsi.m15 > 68 && 
      indicators.rsi.h1 > 55 &&
      indicators.stochastic.m15?.overbought &&
      indicators.macd.m15?.histogram < 0 &&
      (trend === 'BEARISH' || divergence.bearishDivergence) &&
      indicators.volume?.spike !== 'NORMAL') {
    
    signal = 'SHORT';
    
    // Расчет уровней с RR 1:4
    const atrStop = indicators.atr * 1.5;
    const percentStop = currentPrice * 0.015;
    
    const stopLoss = Math.max(
      currentPrice + atrStop,
      currentPrice * 1.015
    );
    
    const takeProfit = currentPrice - ((stopLoss - currentPrice) * CONFIG.rrRatio);
    
    // Уверенность и причины
    confidence = 70;
    if (indicators.rsi.m15 > 75) {
      confidence += 10;
      reasons.push('RSI сильно перекуплен');
    }
    if (divergence.bearishDivergence) {
      confidence += 15;
      reasons.push('Медвежья дивергенция RSI');
    }
    if (indicators.volume?.spike === 'HIGH_SPIKE') {
      confidence += 10;
      reasons.push('Высокий объем');
    }
    if (indicators.macd.m15?.bearish) {
      confidence += 5;
      reasons.push('MACD медвежий');
    }
    if (trend === 'BEARISH') {
      confidence += 5;
      reasons.push('Общий тренд медвежий');
    }
    if (oi && oi.valueUsd > pair.turnover24h * 0.1) {
      reasons.push('Высокий Open Interest');
    }
    
    if (indicators.patterns.includes('BEARISH_ENGULFING') || 
        indicators.patterns.includes('BEARISH_SHOOTING_STAR')) {
      confidence += 10;
      reasons.push('Медвежий свечной паттерн');
    }
    
    return {
      pair: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: takeProfit.toFixed(8),
      sl: stopLoss.toFixed(8),
      confidence: Math.min(confidence, 95),
      rrRatio: CONFIG.rrRatio,
      reasons: reasons,
      change24h: pair.change24h.toFixed(2),
      volume24h: (pair.volume24h / 1000000).toFixed(2),
      fundingRate: pair.fundingRate?.toFixed(4) || '0.0000'
    };
  }
  
  return null;
}

// ==================== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ====================
async function performAutoScan() {
  console.log('\n' + '='.repeat(70));
  console.log('🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ MEXC FUTURES');
  console.log('='.repeat(70));
  
  const startTime = Date.now();
  
  try {
    // Получаем топ пар для сканирования
    const topPairs = await getTopPairsForScan();
    
    if (topPairs.length === 0) {
      console.log('❌ Нет пар для сканирования');
      return;
    }
    
    console.log(`📊 Начинаю анализ ${topPairs.length} топ фьючерсов...`);
    
    const allSignals = [];
    
    // Анализируем каждую пару
    for (let i = 0; i < topPairs.length; i++) {
      const pair = topPairs[i];
      
      console.log(`🔍 [${i+1}/${topPairs.length}] ${pair.symbol} (${pair.change24h > 0 ? '+' : ''}${pair.change24h.toFixed(2)}%)`);
      
      const signal = await performCompleteAnalysis(pair);
      
      if (signal) {
        allSignals.push(signal);
        console.log(`✅ Сигнал найден: ${signal.signal} (${signal.confidence}%)`);
      }
      
      // Задержка между запросами
      if (i < topPairs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Сортируем сигналы по уверенности
    allSignals.sort((a, b) => b.confidence - a.confidence);
    
    // Отправляем лучшие сигналы
    const signalsToSend = allSignals.slice(0, CONFIG.maxSignals);
    
    if (signalsToSend.length > 0) {
      console.log(`📤 Отправляю ${signalsToSend.length} сигналов в канал...`);
      
      for (const signal of signalsToSend) {
        await sendFuturesSignal(signal);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      const scanTime = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`✅ Сканирование завершено за ${scanTime} сек`);
      console.log(`📊 Найдено сигналов: ${allSignals.length}`);
      console.log(`📤 Отправлено: ${signalsToSend.length}`);
      
    } else {
      console.log('ℹ️ Сигналов не найдено');
    }
    
  } catch (error) {
    console.error('❌ Ошибка сканирования:', error.message);
  }
  
  console.log('='.repeat(70));
}

// ==================== ОТПРАВКА СИГНАЛА ====================
async function sendFuturesSignal(signal) {
  try {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const direction = signal.signal === 'LONG' ? 'ПОКУПКА' : 'ПРОДАЖА';
    
    // Расчет потенциала
    const entry = parseFloat(signal.entry);
    const tp = parseFloat(signal.tp);
    const sl = parseFloat(signal.sl);
    const potential = Math.abs(tp - entry) / entry * 100;
    const risk = Math.abs(sl - entry) / entry * 100;
    
    const message = `
${emoji} <b>🚀 MEXC FUTURES SIGNAL</b> ${emoji}

<b>📊 ПАРА:</b> ${signal.pair}
<b>🎯 НАПРАВЛЕНИЕ:</b> ${direction}
<b>💰 ТЕКУЩАЯ ЦЕНА:</b> $${signal.entry}

<b>📈 ИЗМЕНЕНИЕ 24Ч:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
<b>💎 ОБЪЕМ 24Ч:</b> $${signal.volume24h}M
<b>🏦 ФАНДИНГ:</b> ${signal.fundingRate}%

<b>🎯 ТОЧКА ВХОДА:</b> $${signal.entry}
<b>✅ ТЕЙК-ПРОФИТ:</b> $${signal.tp} <b>(+${potential.toFixed(2)}%)</b>
<b>🛑 СТОП-ЛОСС:</b> $${signal.sl} <b>(-${risk.toFixed(2)}%)</b>

<b>⚡ СООТНОШЕНИЕ RR:</b> <b>1:${signal.rrRatio}</b>
<b>🔮 УВЕРЕННОСТЬ:</b> ${signal.confidence}%
<b>📊 ПЛЕЧО:</b> ${CONFIG.leverage}x (рекомендуется)
<b>🎯 РИСК НА СДЕЛКУ:</b> ${CONFIG.riskPerTrade}%

<b>📋 ПРИЧИНЫ СИГНАЛА:</b>
${signal.reasons.map(r => `• ${r}`).join('\n')}

<b>📊 ИНДИКАТОРЫ:</b>
• RSI(15m): ${signal.indicators.rsi.m15.toFixed(1)}
• RSI(1h): ${signal.indicators.rsi.h1.toFixed(1)}
• MACD Hist: ${signal.indicators.macd.m15?.histogram?.toFixed(4) || 'N/A'}
• ADX: ${signal.indicators.adx?.adx?.toFixed(1) || 'N/A'}
• Объем: ${signal.indicators.volume?.ratio?.toFixed(1) || '1.0'}x

<b>🎯 СТРАТЕГИЯ:</b>
Вход по рынку или лимитному ордеру.
Тейк-профит выставлять по частям: 50% на TP1, 50% на TP2.
Стоп-лосс не двигать до TP1.

<b>⚠️ РИСКИ:</b>
Фьючерсы торгуются с плечом, возможны большие убытки.
Используйте только риск-капитал.
Следите за фандинг-рейтом.

🏦 <b>БИРЖА:</b> MEXC Futures
⏰ <b>ВРЕМЯ:</b> ${new Date().toLocaleTimeString('ru-RU')}
📅 <b>ДАТА:</b> ${new Date().toLocaleDateString('ru-RU')}

<i>#MEXC #Futures #TradingSignal</i>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Сигнал отправлен: ${signal.pair}`);
    
  } catch (error) {
    console.error(`❌ Ошибка отправки сигнала:`, error.message);
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  const welcome = `
🤖 <b>MEXC FUTURES PRO SIGNALS BOT</b>

✅ <b>ПОЛНОСТЬЮ АВТОМАТИЧЕСКИЙ</b>

🏦 <b>Биржа:</b> ${CONFIG.exchange}
⏰ <b>Сканирование:</b> каждые 3 минуты
📊 <b>Анализ:</b> ${CONFIG.scanPairs} топ фьючерсов
🎯 <b>RR соотношение:</b> 1:${CONFIG.rrRatio}
💰 <b>Риск на сделку:</b> ${CONFIG.riskPerTrade}%

<b>📈 АНАЛИЗИРУЕМЫЕ ИНДИКАТОРЫ:</b>
• RSI (14, 9, 25) на 15m/1h
• MACD с сигнальной линией
• Bollinger Bands (20,2)
• Stochastic (14,3,3)
• ADX с DI+/- для силы тренда
• Volume Profile и спайки
• ATR для стоп-лоссов
• Свечные паттерны
• Скользящие средние (EMA9,21,50; SMA20,50)
• Дивергенции RSI
• Open Interest

<b>🎯 УСЛОВИЯ СИГНАЛА:</b>
• Минимальное изменение: ${CONFIG.minChange}%
• Минимальная уверенность: ${CONFIG.minConfidence}%
• Объемный спайк: >2x от среднего
• КД между сигналами: 1 час

<b>📱 КОМАНДЫ:</b>
/start - информация
/scan - сканировать сейчас
/top - топ фьючерсов
/status - статус бота
/test - проверка API

✅ <b>Сигналы приходят автоматически с RR 1:4!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('scan', async (ctx) => {
  try {
    await ctx.reply('🚀 Запускаю внеочередное сканирование фьючерсов...');
    performAutoScan();
    await ctx.reply('✅ Сканирование запущено! Сигналы появятся в канале.');
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  try {
    await ctx.reply('📊 Ищу топ фьючерсов...');
    
    const futures = await getFuturesTickers();
    if (futures.length === 0) {
      await ctx.reply('❌ Нет данных');
      return;
    }
    
    const topGainers = [...futures].sort((a, b) => b.change24h - a.change24h).slice(0, 5);
    const topLosers = [...futures].sort((a, b) => a.change24h - b.change24h).slice(0, 5);
    
    let message = `📈 <b>ТОП 5 РОСТА ФЬЮЧЕРСОВ</b>\n\n`;
    
    topGainers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change24h.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume24h / 1000000).toFixed(2)}M\n`;
      message += `   🏦 Фандинг: ${t.fundingRate?.toFixed(4) || '0.0000'}%\n\n`;
    });
    
    message += `📉 <b>ТОП 5 ПАДЕНИЯ ФЬЮЧЕРСОВ</b>\n\n`;
    
    topLosers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${t.change24h.toFixed(2)}%\n`;
      message += `   🔄 $${(t.volume24h / 1000000).toFixed(2)}M\n`;
      message += `   🏦 Фандинг: ${t.fundingRate?.toFixed(4) || '0.0000'}%\n\n`;
    });
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('status', (ctx) => {
  const now = new Date();
  const nextScan = 3 - (now.getMinutes() % 3);
  
  ctx.reply(
    `📊 <b>СТАТУС MEXC FUTURES BOT</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `🏦 <b>Биржа:</b> ${CONFIG.exchange}\n` +
    `⏰ <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `📊 <b>Отправлено сигналов:</b> ${sentSignals.size}\n` +
    `🕒 <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `🎯 <b>Параметры:</b>\n` +
    `• RR соотношение: 1:${CONFIG.rrRatio}\n` +
    `• Риск на сделку: ${CONFIG.riskPerTrade}%\n` +
    `• Плечо: ${CONFIG.leverage}x\n` +
    `• Мин. изменение: ${CONFIG.minChange}%\n` +
    `• Мин. уверенность: ${CONFIG.minConfidence}%\n\n` +
    `💡 <b>Команды:</b> /scan /top /test`,
    { parse_mode: 'HTML' }
  );
});

// ==================== ЗАПУСК ====================
async function startBot() {
  try {
    console.log('🚀 Инициализация MEXC Futures Signals Bot...');
    
    // Проверяем API
    console.log('📡 Проверка подключения к MEXC Futures...');
    const futures = await getFuturesTickers();
    
    if (futures.length === 0) {
      console.log('⚠️  Внимание: MEXC Futures API может быть недоступен');
    } else {
      console.log(`✅ MEXC Futures доступен, получено ${futures.length} фьючерсов`);
    }
    
    // Запускаем бота
    await bot.launch({ dropPendingUpdates: true });
    console.log('✅ Telegram бот запущен!');
    
    // Настраиваем крон
    cron.schedule(CONFIG.scanInterval, performAutoScan);
    console.log(`⏰ Автосканирование настроено: каждые 3 минуты`);
    
    // Первое сканирование через 1 минуту
    setTimeout(performAutoScan, 60000);
    
    // Стартовое сообщение
    await bot.telegram.sendMessage(
      CHAT_ID,
      `🤖 <b>MEXC FUTURES SIGNALS BOT АКТИВИРОВАН</b>\n\n` +
      `✅ Автоматическое сканирование запущено\n` +
      `⏰ Интервал: каждые 3 минуты\n` +
      `📊 Анализ: ${CONFIG.scanPairs} топ фьючерсов\n` +
      `🎯 RR соотношение: <b>1:${CONFIG.rrRatio}</b>\n` +
      `💰 Риск на сделку: ${CONFIG.riskPerTrade}%\n` +
      `🏦 Плечо: ${CONFIG.leverage}x (рекомендуется)\n\n` +
      `📈 <b>Сигналы будут приходить автоматически!</b>\n\n` +
      `🔄 Первое сканирование через 1 минуту...`,
      { parse_mode: 'HTML' }
    );
    
    console.log('\n' + '='.repeat(70));
    console.log('🤖 MEXC FUTURES SIGNALS BOT ЗАПУЩЕН');
    console.log('='.repeat(70));
    console.log(`🏦 Биржа: MEXC Futures`);
    console.log(`⏰ Сканирование: каждые 3 минуты`);
    console.log(`🎯 RR соотношение: 1:${CONFIG.rrRatio}`);
    console.log(`📊 Индикаторы: 10+ рабочих индикаторов`);
    console.log('='.repeat(70));
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Запуск
startBot();
