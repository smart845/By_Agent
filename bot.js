import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');

// ==================== КОНФИГ ДЛЯ МУЛЬТИБИРЖЕВОГО СКАНИРОВАНИЯ ====================
const CONFIG = {
  // API URLs
  binanceUrl: 'https://fapi.binance.com/fapi/v1',
  bybitUrl: 'https://api.bybit.com/v5',
  mexcUrl: 'https://contract.mexc.com/api/v1',
  dexScreenerUrl: 'https://api.dexscreener.com',
  
  // Настройки сканирования
  scanLimit: 30,                   // Топ-30 по каждой бирже
  minPrice: 0.01,
  maxSignalsPerRun: 8,             // Увеличено для мультибиржи
  
  // Критерии хайп
  min24hChange: 7.0,
  min24hVolume: 3000000,
  minVolatility: 3.5,
  
  // Уровни сигналов
  godTier: {
    confidence: 88,
    qualityScore: 9,
    rrRatio: 4.0,
    confirmations: 5
  },
  premium: {
    confidence: 78,
    qualityScore: 7,
    rrRatio: 3.2,
    confirmations: 4
  },
  
  // Фьючерсы
  leverage: 10,
  positionSize: 2.5,
  
  // Включение/выключение бирж
  exchanges: {
    binance: true,
    bybit: true,
    mexc: true,
    dex: true
  }
};

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  console.log(`💬 /start от chat ID: ${chatId}`);
  
  ctx.reply(
    `🚀 <b>MULTI-EXCHANGE HYPE SCANNER</b>\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `🏦 <b>Биржи:</b>\n` +
    `• Binance Futures\n` +
    `• Bybit Futures\n` +
    `• MEXC Futures\n` +
    `• DEX Screener (DEX пары)\n\n` +
    `🎯 <b>Фокусировка:</b>\n` +
    `• Макс волатильность\n` +
    `• Трендовые движения\n` +
    `• Мультитаймфрейм анализ\n\n` +
    `🔧 Установите:\n<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(`💬 Ваш Chat ID: <code>${chatId}</code>`, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тестовый мультибиржевой сигнал...');
  
  const testSignal = {
    pair: 'BTCUSDT',
    exchange: 'Binance',
    signal: 'LONG',
    entry: 98500.00,
    tp: 101200.00,
    sl: 97800.00,
    confidence: 92,
    qualityScore: 9,
    rrRatio: 4.2,
    tier: 'GOD TIER',
    timeframe: 'MULTI-TF',
    leverage: 10,
    positionSize: 2.5,
    liqPrice: 97200.00,
    fundingRate: 0.0001,
    hypeScore: 95,
    trendMomentum: 'STRONG_UP',
    indicators: {
      rsi: 32,
      stochK: 28,
      adx: 52,
      atr: 450.00,
      volumeChange: 310,
      priceChange1h: 5.2,
      priceChange4h: 15.8
    },
    confirmations: ['RSI_OVERSOLD', 'BREAKOUT_CONFIRMED', 'VOLUME_SPIKE_300%', 'TREND_ACCELERATION', 'SUPPORT_HOLD'],
    timestamp: new Date()
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// ==================== BINANCE API ====================
async function getBinanceHypePairs() {
  try {
    console.log('🔍 [Binance] Поиск хайп пар...');
    const url = `${CONFIG.binanceUrl}/ticker/24hr`;
    const response = await axios.get(url);
    
    if (response.status !== 200) throw new Error(`Binance API Error: ${response.status}`);
    
    const pairs = response.data
      .filter(ticker => {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.lastPrice);
        const volume = parseFloat(ticker.quoteVolume);
        const priceChange = parseFloat(ticker.priceChangePercent);
        const high = parseFloat(ticker.highPrice);
        const low = parseFloat(ticker.lowPrice);
        
        if (!symbol.endsWith('USDT')) return false;
        if (price < CONFIG.minPrice) return false;
        if (volume < CONFIG.min24hVolume) return false;
        if (Math.abs(priceChange) < CONFIG.min24hChange) return false;
        
        const volatility = ((high - low) / low) * 100;
        if (volatility < CONFIG.minVolatility) return false;
        
        return true;
      })
      .map(ticker => {
        const priceChange = parseFloat(ticker.priceChangePercent);
        const volume = parseFloat(ticker.quoteVolume);
        const high = parseFloat(ticker.highPrice);
        const low = parseFloat(ticker.lowPrice);
        const volatility = ((high - low) / low) * 100;
        
        const volumeScore = Math.min(100, (volume / 50000000) * 100);
        const changeScore = Math.min(100, Math.abs(priceChange) * 3);
        const volatilityScore = Math.min(100, volatility * 5);
        const hypeScore = (changeScore * 0.4) + (volatilityScore * 0.4) + (volumeScore * 0.2);
        
        return {
          symbol: ticker.symbol,
          exchange: 'Binance',
          priceChange,
          volume,
          volatility,
          hypeScore: Math.round(hypeScore),
          lastPrice: parseFloat(ticker.lastPrice)
        };
      })
      .sort((a, b) => b.hypeScore - a.hypeScore)
      .slice(0, CONFIG.scanLimit);
    
    console.log(`✅ [Binance] Найдено ${pairs.length} хайп пар`);
    return pairs;
  } catch (error) {
    console.error('❌ [Binance] Ошибка:', error.message);
    return [];
  }
}

// ==================== BYBIT API ====================
async function getBybitHypePairs() {
  try {
    console.log('🔍 [Bybit] Поиск хайп пар...');
    const url = `${CONFIG.bybitUrl}/market/tickers?category=linear`;
    const response = await axios.get(url);
    
    if (response.retCode !== 0) throw new Error(`Bybit API Error: ${response.retMsg}`);
    
    const pairs = response.data.result.list
      .filter(ticker => {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.lastPrice);
        const volume = parseFloat(ticker.turnover24h);
        const priceChange = parseFloat(ticker.price24hPcnt) * 100;
        const high = parseFloat(ticker.highPrice24h);
        const low = parseFloat(ticker.lowPrice24h);
        
        if (!symbol.endsWith('USDT')) return false;
        if (price < CONFIG.minPrice) return false;
        if (volume < CONFIG.min24hVolume) return false;
        if (Math.abs(priceChange) < CONFIG.min24hChange) return false;
        
        const volatility = ((high - low) / low) * 100;
        if (volatility < CONFIG.minVolatility) return false;
        
        return true;
      })
      .map(ticker => {
        const priceChange = parseFloat(ticker.price24hPcnt) * 100;
        const volume = parseFloat(ticker.turnover24h);
        const high = parseFloat(ticker.highPrice24h);
        const low = parseFloat(ticker.lowPrice24h);
        const volatility = ((high - low) / low) * 100;
        
        const volumeScore = Math.min(100, (volume / 50000000) * 100);
        const changeScore = Math.min(100, Math.abs(priceChange) * 3);
        const volatilityScore = Math.min(100, volatility * 5);
        const hypeScore = (changeScore * 0.4) + (volatilityScore * 0.4) + (volumeScore * 0.2);
        
        return {
          symbol: ticker.symbol,
          exchange: 'Bybit',
          priceChange,
          volume,
          volatility,
          hypeScore: Math.round(hypeScore),
          lastPrice: parseFloat(ticker.lastPrice)
        };
      })
      .sort((a, b) => b.hypeScore - a.hypeScore)
      .slice(0, CONFIG.scanLimit);
    
    console.log(`✅ [Bybit] Найдено ${pairs.length} хайп пар`);
    return pairs;
  } catch (error) {
    console.error('❌ [Bybit] Ошибка:', error.message);
    return [];
  }
}

// ==================== MEXC API ====================
async function getMexcHypePairs() {
  try {
    console.log('🔍 [MEXC] Поиск хайп пар...');
    const url = `${CONFIG.mexcUrl}/contract/ticker`;
    const response = await axios.get(url);
    
    if (!response.data.success) throw new Error('MEXC API Error');
    
    const pairs = response.data.data
      .filter(ticker => {
        const symbol = ticker.symbol;
        const price = parseFloat(ticker.lastPrice);
        const volume = parseFloat(ticker.amount24);
        const priceChange = parseFloat(ticker.riseFallRate);
        const high = parseFloat(ticker.high24Price);
        const low = parseFloat(ticker.lower24Price);
        
        if (!symbol.includes('_USDT')) return false;
        if (price < CONFIG.minPrice) return false;
        if (volume < CONFIG.min24hVolume) return false;
        if (Math.abs(priceChange) < CONFIG.min24hChange) return false;
        
        const volatility = ((high - low) / low) * 100;
        if (volatility < CONFIG.minVolatility) return false;
        
        return true;
      })
      .map(ticker => {
        const priceChange = parseFloat(ticker.riseFallRate);
        const volume = parseFloat(ticker.amount24);
        const high = parseFloat(ticker.high24Price);
        const low = parseFloat(ticker.lower24Price);
        const volatility = ((high - low) / low) * 100;
        
        const volumeScore = Math.min(100, (volume / 50000000) * 100);
        const changeScore = Math.min(100, Math.abs(priceChange) * 3);
        const volatilityScore = Math.min(100, volatility * 5);
        const hypeScore = (changeScore * 0.4) + (volatilityScore * 0.4) + (volumeScore * 0.2);
        
        return {
          symbol: ticker.symbol.replace('_', ''),
          exchange: 'MEXC',
          priceChange,
          volume,
          volatility,
          hypeScore: Math.round(hypeScore),
          lastPrice: parseFloat(ticker.lastPrice)
        };
      })
      .sort((a, b) => b.hypeScore - a.hypeScore)
      .slice(0, CONFIG.scanLimit);
    
    console.log(`✅ [MEXC] Найдено ${pairs.length} хайп пар`);
    return pairs;
  } catch (error) {
    console.error('❌ [MEXC] Ошибка:', error.message);
    return [];
  }
}

// ==================== DEX SCREENER API ====================
async function getDexHypePairs() {
  try {
    console.log('🔍 [DEX] Поиск хайп пар...');
    const url = `${CONFIG.dexScreenerUrl}/token-boosts/top/v1`;
    const response = await axios.get(url);
    
    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('DEX Screener API Error');
    }
    
    const pairs = response.data
      .filter(item => {
        if (!item.tokenAddress || !item.chainId) return false;
        
        const priceChange = parseFloat(item.priceChange?.h24 || 0);
        const volume = parseFloat(item.volume?.h24 || 0);
        const liquidity = parseFloat(item.liquidity?.usd || 0);
        
        if (volume < 50000) return false;
        if (liquidity < 10000) return false;
        if (Math.abs(priceChange) < 5) return false;
        
        return true;
      })
      .map(item => {
        const priceChange = parseFloat(item.priceChange?.h24 || 0);
        const volume = parseFloat(item.volume?.h24 || 0);
        const liquidity = parseFloat(item.liquidity?.usd || 0);
        
        const volumeScore = Math.min(100, (volume / 500000) * 100);
        const changeScore = Math.min(100, Math.abs(priceChange) * 2);
        const liquidityScore = Math.min(100, (liquidity / 100000) * 100);
        const hypeScore = (changeScore * 0.5) + (volumeScore * 0.3) + (liquidityScore * 0.2);
        
        return {
          symbol: `${item.baseToken?.symbol || 'UNKNOWN'}/${item.quoteToken?.symbol || 'USD'}`,
          exchange: `DEX-${item.chainId}`,
          priceChange,
          volume,
          volatility: Math.abs(priceChange),
          hypeScore: Math.round(hypeScore),
          lastPrice: parseFloat(item.priceUsd || 0),
          dexInfo: {
            chainId: item.chainId,
            dexId: item.dexId,
            pairAddress: item.pairAddress
          }
        };
      })
      .sort((a, b) => b.hypeScore - a.hypeScore)
      .slice(0, CONFIG.scanLimit);
    
    console.log(`✅ [DEX] Найдено ${pairs.length} хайп пар`);
    return pairs;
  } catch (error) {
    console.error('❌ [DEX] Ошибка:', error.message);
    return [];
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ПО БИРЖЕ ====================
async function getFuturesData(symbol, exchange, interval = '5m', limit = 100) {
  try {
    let url, response, candles;
    
    if (exchange === 'Binance') {
      url = `${CONFIG.binanceUrl}/klines`;
      response = await axios.get(url, { params: { symbol, interval, limit } });
      candles = response.data.map(candle => ({
        timestamp: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }));
    } else if (exchange === 'Bybit') {
      url = `${CONFIG.bybitUrl}/market/kline`;
      response = await axios.get(url, { params: { category: 'linear', symbol, interval, limit } });
      if (response.data.retCode !== 0) throw new Error('Bybit kline error');
      candles = response.data.result.list.reverse().map(candle => ({
        timestamp: parseInt(candle[0]),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5])
      }));
    } else if (exchange === 'MEXC') {
      // MEXC использует другой формат интервалов
      const mexcInterval = interval === '5m' ? 'Min5' : interval === '15m' ? 'Min15' : 'Min60';
      url = `${CONFIG.mexcUrl}/contract/kline/${symbol.replace('USDT', '_USDT')}`;
      response = await axios.get(url, { params: { interval: mexcInterval, limit } });
      if (!response.data.success) throw new Error('MEXC kline error');
      candles = response.data.data.map(candle => ({
        timestamp: candle.time,
        open: parseFloat(candle.open),
        high: parseFloat(candle.high),
        low: parseFloat(candle.low),
        close: parseFloat(candle.close),
        volume: parseFloat(candle.vol)
      }));
    } else {
      return null;
    }
    
    return {
      symbol,
      exchange,
      interval,
      candles,
      currentPrice: candles[candles.length - 1].close,
      volume24h: candles.reduce((sum, c) => sum + c.volume, 0)
    };
  } catch (error) {
    console.error(`❌ [${exchange}] Ошибка данных для ${symbol}:`, error.message);
    return null;
  }
}

async function getFundingRate(symbol, exchange) {
  try {
    if (exchange === 'Binance') {
      const url = `${CONFIG.binanceUrl}/premiumIndex`;
      const response = await axios.get(url, { params: { symbol } });
      return parseFloat(response.data.lastFundingRate);
    } else if (exchange === 'Bybit') {
      const url = `${CONFIG.bybitUrl}/market/tickers`;
      const response = await axios.get(url, { params: { category: 'linear', symbol } });
      if (response.data.retCode !== 0) return 0;
      return parseFloat(response.data.result.list[0]?.fundingRate || 0);
    } else if (exchange === 'MEXC') {
      const url = `${CONFIG.mexcUrl}/contract/funding_rate/${symbol.replace('USDT', '_USDT')}`;
      const response = await axios.get(url);
      if (!response.data.success) return 0;
      return parseFloat(response.data.data.fundingRate || 0);
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

// ==================== ИНДИКАТОРЫ (из оригинального бота) ====================
function calculateRSI(prices, period = 14) {
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

function calculateEMA(prices, period) {
  if (prices.length < period) return null;
  
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateStochastic(highs, lows, closes, period = 14) {
  if (closes.length < period) return { k: 50 };
  
  const currentClose = closes[closes.length - 1];
  const periodHigh = Math.max(...highs.slice(-period));
  const periodLow = Math.min(...lows.slice(-period));
  
  if (periodHigh === periodLow) return { k: 50 };
  
  const k = ((currentClose - periodLow) / (periodHigh - periodLow)) * 100;
  return { k: parseFloat(k.toFixed(2)) };
}

function calculateADX(highs, lows, closes, period = 14) {
  if (closes.length < period * 2) return 25;
  
  let plusDM = 0;
  let minusDM = 0;
  
  for (let i = 1; i < period; i++) {
    const highDiff = highs[highs.length - i] - highs[highs.length - i - 1];
    const lowDiff = lows[lows.length - i - 1] - lows[lows.length - i];
    
    if (highDiff > lowDiff && highDiff > 0) plusDM += highDiff;
    if (lowDiff > highDiff && lowDiff > 0) minusDM += lowDiff;
  }
  
  const tr = Math.max(plusDM, minusDM);
  const dx = tr > 0 ? (Math.abs(plusDM - minusDM) / tr) * 100 : 0;
  
  return Math.min(60, 25 + dx * 0.5);
}

function calculateATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 0;
  
  let trSum = 0;
  for (let i = 1; i <= period; i++) {
    const high = highs[highs.length - i];
    const low = lows[lows.length - i];
    const prevClose = closes[closes.length - i - 1];
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trSum += tr;
  }
  
  return trSum / period;
}

function analyzeVolumeSpike(volumes, period = 20) {
  if (volumes.length < period) return 1.0;
  
  const currentVolume = volumes[volumes.length - 1];
  const averageVolume = volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
  
  return currentVolume / averageVolume;
}

function calculateMomentum(prices, period = 10) {
  if (prices.length < period) return 0;
  return ((prices[prices.length - 1] - prices[prices.length - period]) / prices[prices.length - period]) * 100;
}

// ==================== МУЛЬТИТАЙМФРЕЙМ АНАЛИЗ ====================
async function analyzeMultiTimeframe(symbol, exchange) {
  const timeframes = ['5m', '15m', '1h'];
  const timeframeData = {};
  
  for (const tf of timeframes) {
    const data = await getFuturesData(symbol, exchange, tf, 100);
    if (!data) continue;
    
    const closes = data.candles.map(c => c.close);
    const highs = data.candles.map(c => c.high);
    const lows = data.candles.map(c => c.low);
    const volumes = data.candles.map(c => c.volume);
    
    timeframeData[tf] = {
      rsi: calculateRSI(closes),
      stoch: calculateStochastic(highs, lows, closes).k,
      adx: calculateADX(highs, lows, closes),
      ema20: calculateEMA(closes, 20),
      ema50: calculateEMA(closes, 50),
      ema100: calculateEMA(closes, 100),
      volumeSpike: analyzeVolumeSpike(volumes),
      momentum1h: calculateMomentum(closes, 12),
      momentum4h: calculateMomentum(closes, 48),
      currentPrice: data.currentPrice
    };
    
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  return timeframeData;
}

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
function generateHypeSignal(pair, multiTFData, hypeScore, exchange) {
  const timeframes = Object.keys(multiTFData);
  if (timeframes.length === 0) return null;
  
  const avgRSI = timeframes.reduce((sum, tf) => sum + multiTFData[tf].rsi, 0) / timeframes.length;
  const avgStoch = timeframes.reduce((sum, tf) => sum + multiTFData[tf].stoch, 0) / timeframes.length;
  const avgADX = timeframes.reduce((sum, tf) => sum + multiTFData[tf].adx, 0) / timeframes.length;
  const avgVolumeSpike = timeframes.reduce((sum, tf) => sum + multiTFData[tf].volumeSpike, 0) / timeframes.length;
  
  const trendAlignment = analyzeTrendAlignment(multiTFData);
  
  let signal = null;
  let confidence = 50;
  const confirmations = [];
  
  if (avgRSI < 35 && avgStoch < 30 && trendAlignment.bullish >= 2) {
    signal = 'LONG';
    confidence = 70 + (35 - avgRSI) + (30 - avgStoch) * 0.5;
    confirmations.push('RSI_OVERSOLD', 'STOCH_OVERSOLD');
  } else if (avgRSI > 65 && avgStoch > 70 && trendAlignment.bearish >= 2) {
    signal = 'SHORT';
    confidence = 70 + (avgRSI - 65) + (avgStoch - 70) * 0.5;
    confirmations.push('RSI_OVERBOUGHT', 'STOCH_OVERBOUGHT');
  }
  
  if (!signal) return null;
  
  if (avgADX > 35) {
    confidence += 5;
    confirmations.push('STRONG_TREND');
  }
  
  if (avgVolumeSpike > 2.5) {
    confidence += 8;
    confirmations.push(`VOLUME_SPIKE_${Math.round(avgVolumeSpike * 100)}%`);
  }
  
  if (trendAlignment.bullish === 3 || trendAlignment.bearish === 3) {
    confidence += 7;
    confirmations.push('MULTI_TF_ALIGNMENT');
  }
  
  confidence = Math.min(95, confidence);
  
  const qualityScore = Math.round((confidence / 10) + (hypeScore / 20));
  const isGodTier = confidence >= CONFIG.godTier.confidence && qualityScore >= CONFIG.godTier.qualityScore;
  const isPremium = confidence >= CONFIG.premium.confidence && qualityScore >= CONFIG.premium.qualityScore;
  
  if (!isGodTier && !isPremium) return null;
  
  const currentPrice = multiTFData[timeframes[0]].currentPrice;
  const atr = calculateATR(
    Object.values(multiTFData).map(d => d.currentPrice),
    Object.values(multiTFData).map(d => d.currentPrice),
    Object.values(multiTFData).map(d => d.currentPrice)
  );
  
  const entry = currentPrice;
  const rrRatio = isGodTier ? CONFIG.godTier.rrRatio : CONFIG.premium.rrRatio;
  
  let tp, sl;
  if (signal === 'LONG') {
    sl = entry - (atr * 1.5);
    tp = entry + (entry - sl) * rrRatio;
  } else {
    sl = entry + (atr * 1.5);
    tp = entry - (sl - entry) * rrRatio;
  }
  
  const liqPrice = signal === 'LONG' 
    ? entry - (entry * 0.9 / CONFIG.leverage)
    : entry + (entry * 0.9 / CONFIG.leverage);
  
  const fundingRate = 0;
  
  const trendMomentum = multiTFData['5m'].momentum4h > 10 ? 'STRONG_UP' : 
                       multiTFData['5m'].momentum4h < -10 ? 'STRONG_DOWN' : 'CONSOLIDATION';
  
  return {
    pair,
    exchange,
    signal,
    entry: parseFloat(entry.toFixed(8)),
    tp: parseFloat(tp.toFixed(8)),
    sl: parseFloat(sl.toFixed(8)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    timeframe: 'MULTI-TF',
    leverage: CONFIG.leverage,
    positionSize: CONFIG.positionSize,
    liqPrice: parseFloat(liqPrice.toFixed(8)),
    fundingRate,
    hypeScore,
    trendMomentum,
    indicators: {
      rsi: Math.round(avgRSI),
      stochK: parseFloat(avgStoch.toFixed(2)),
      adx: Math.round(avgADX),
      atr: parseFloat(atr.toFixed(8)),
      volumeChange: Math.round(avgVolumeSpike * 100),
      priceChange1h: parseFloat(multiTFData['5m'].momentum1h.toFixed(2)),
      priceChange4h: parseFloat(multiTFData['5m'].momentum4h.toFixed(2))
    },
    confirmations,
    timestamp: new Date()
  };
}

function analyzeTrendAlignment(timeframeData) {
  let bullish = 0;
  let bearish = 0;
  
  for (const [tf, data] of Object.entries(timeframeData)) {
    if (data.ema20 > data.ema50 && data.ema50 > data.ema100) {
      bullish++;
    } else if (data.ema20 < data.ema50 && data.ema50 < data.ema100) {
      bearish++;
    }
  }
  
  return { bullish, bearish };
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '⚡';
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const directionText = signal.signal === 'LONG' ? 'LONG' : 'SHORT';
    
    const exchangeEmoji = signal.exchange === 'Binance' ? '🟡' : 
                         signal.exchange === 'Bybit' ? '🟠' : 
                         signal.exchange === 'MEXC' ? '🔵' : '🟣';
    
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const comment = generateHypeComment(signal);
    
    const message = `
${tierEmoji} <b>${signal.tier} HYPE SIGNAL</b> ${tierEmoji}

${exchangeEmoji} <b>${signal.exchange}</b> | ${directionEmoji} <b>${directionText} ${signal.pair}</b>
⭐ <b>Hype Score:</b> ${signal.hypeScore}/100

🎯 <b>ENTRY:</b> <code>${signal.entry}</code>
🏹 <b>TP:</b> <code>${signal.tp}</code> 
🛑 <b>SL:</b> <code>${signal.sl}</code>

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
💪 <b>Confidence:</b> ${signal.confidence}%
🏆 <b>Quality:</b> ${signal.qualityScore}/10

⚙️ <b>Leverage:</b> ${signal.leverage}x
💰 <b>Position:</b> ${signal.positionSize}%
💀 <b>Liq Price:</b> ${signal.liqPrice}

<b>TECHNICALS:</b>
• RSI: ${signal.indicators.rsi}
• Stoch: ${signal.indicators.stochK}  
• ADX: ${signal.indicators.adx}
• Volume: +${signal.indicators.volumeChange}%
• 1h Change: ${signal.indicators.priceChange1h}%
• 4h Change: ${signal.indicators.priceChange4h}%

<b>CONFIRMATIONS:</b>
${signal.confirmations.map(conf => `✅ ${conf}`).join('\n')}

💡 <b>Analysis:</b> <i>${comment}</i>

⏰ <b>${timestamp}</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ [${signal.exchange}] Сигнал ${signal.pair} отправлен!`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки:', error.message);
    return false;
  }
}

function generateHypeComment(signal) {
  const comments = [];
  
  if (signal.hypeScore >= 90) {
    comments.push('Экстремальный хайп');
  } else if (signal.hypeScore >= 80) {
    comments.push('Высокий хайп');
  } else {
    comments.push('Хороший хайп');
  }
  
  if (signal.indicators.volumeChange > 300) {
    comments.push('взрывной объем');
  } else if (signal.indicators.volumeChange > 200) {
    comments.push('сильный объем');
  }
  
  if (signal.indicators.priceChange1h > 5) {
    comments.push('резкий рост');
  } else if (signal.indicators.priceChange1h < -5) {
    comments.push('резкое падение');
  }
  
  if (signal.trendMomentum === 'STRONG_UP') {
    comments.push('мощный аптренд');
  } else if (signal.trendMomentum === 'STRONG_DOWN') {
    comments.push('мощный даунтренд');
  }
  
  return comments.join(', ') + `. Отличная возможность на ${signal.exchange}!`;
}

// ==================== ОСНОВНАЯ ЛОГИКА ====================
async function generateSignals() {
  console.log('🔍 Мультибиржевое сканирование хайп пар...');
  
  const allPairs = [];
  
  if (CONFIG.exchanges.binance) {
    const binancePairs = await getBinanceHypePairs();
    allPairs.push(...binancePairs);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (CONFIG.exchanges.bybit) {
    const bybitPairs = await getBybitHypePairs();
    allPairs.push(...bybitPairs);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  if (CONFIG.exchanges.mexc) {
    const mexcPairs = await getMexcHypePairs();
    allPairs.push(...mexcPairs);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // DEX пары обрабатываются отдельно (без технического анализа)
  if (CONFIG.exchanges.dex) {
    const dexPairs = await getDexHypePairs();
    // Отправляем топ DEX пары как информационные сигналы
    for (const pair of dexPairs.slice(0, 2)) {
      if (pair.hypeScore > 70) {
        await sendDexAlert(pair);
      }
    }
  }
  
  allPairs.sort((a, b) => b.hypeScore - a.hypeScore);
  
  const signals = [];
  
  for (const pair of allPairs) {
    try {
      if (pair.exchange.startsWith('DEX')) continue;
      
      console.log(`📊 Анализ ${pair.symbol} на ${pair.exchange}...`);
      
      const multiTFData = await analyzeMultiTimeframe(pair.symbol, pair.exchange);
      if (!multiTFData || Object.keys(multiTFData).length === 0) continue;
      
      const signal = generateHypeSignal(pair.symbol, multiTFData, pair.hypeScore, pair.exchange);
      if (signal) {
        signals.push(signal);
        console.log(`✅ Сигнал для ${pair.symbol} на ${pair.exchange}: ${signal.signal} (${signal.confidence}%)`);
        
        if (signals.length >= CONFIG.maxSignalsPerRun) break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 400));
    } catch (error) {
      console.error(`❌ Ошибка анализа ${pair.symbol} на ${pair.exchange}:`, error.message);
    }
  }
  
  console.log(`✅ Найдено ${signals.length} хайп сигналов`);
  return signals.sort((a, b) => b.confidence - a.confidence);
}

async function sendDexAlert(pair) {
  if (!CHAT_ID) return;
  
  try {
    const message = `
🟣 <b>DEX HYPE ALERT</b> 🟣

🔗 <b>${pair.symbol}</b> | ${pair.exchange}
⭐ <b>Hype Score:</b> ${pair.hypeScore}/100

📊 <b>24h Change:</b> ${pair.priceChange.toFixed(2)}%
💰 <b>Volume 24h:</b> $${pair.volume.toLocaleString()}
💧 <b>Liquidity:</b> $${pair.dexInfo ? 'N/A' : 'N/A'}

⚠️ <i>DEX пары высокорискованны! DYOR!</i>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ [DEX] Алерт ${pair.symbol} отправлен!`);
  } catch (error) {
    console.error('❌ Ошибка отправки DEX алерта:', error.message);
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n🔄 === MULTI-EXCHANGE HYPE SCANNER ===');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️ Хайп сигналов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} сигналов...`);
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Сканирование завершено\n');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот @${botInfo.username} запущен`);
    
    bot.launch();
    console.log('✅ Long polling активирован');
    
    // Сканирование каждые 10 минут
    cron.schedule('*/10 * * * *', runSignalsTask);
    console.log('✅ CRON настроен (каждые 10 минут)');
    
    // Первый запуск через 20 секунд
    console.log('⏳ Первое сканирование через 20 секунд...\n');
    setTimeout(runSignalsTask, 20000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ЗАПУСК
start();
