const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск Crypto Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'CRYPTO',     // Общее название
  topGainers: 30,         // Топ 30 роста
  topLosers: 30,          // Топ 30 падения
  minVolume: 100000,      // 100K USDT минимальный объем
  minChange: 1.0,         // Минимальное изменение 1%
  scanInterval: '*/15 * * * *', // Каждые 15 минут
  
  // Настройки сигналов
  minConfidence: 65,      // Минимальная уверенность 65%
  minConfirmations: 3,    // Минимум 3 подтверждения
  stopLossPercent: 2.0,   // Стоп-лосс 2%
  takeProfitPercent: 6.0, // Тейк-профит 6%
  minRRRatio: 2.5,        // Минимальное R:R 1:2.5
};

// ==================== АЛЬТЕРНАТИВНЫЕ API ====================
// Если один API не работает, пробуем другой
const API_ENDPOINTS = [
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3',
    getTickers: async () => {
      try {
        const response = await axios.get(`${API_ENDPOINTS[0].url}/coins/markets`, {
          params: {
            vs_currency: 'usd',
            order: 'volume_desc',
            per_page: 200,
            page: 1,
            sparkline: false
          },
          timeout: 10000
        });
        
        return response.data.map(coin => ({
          symbol: coin.symbol.toUpperCase() + 'USDT',
          price: coin.current_price,
          change: coin.price_change_percentage_24h,
          volume: coin.total_volume,
          high: coin.high_24h,
          low: coin.low_24h,
          name: coin.name
        }));
      } catch (error) {
        console.error('CoinGecko API error:', error.message);
        return [];
      }
    }
  },
  {
    name: 'CoinCap',
    url: 'https://api.coincap.io/v2',
    getTickers: async () => {
      try {
        const response = await axios.get(`${API_ENDPOINTS[1].url}/assets`, {
          params: { limit: 200 },
          timeout: 10000
        });
        
        return response.data.data
          .filter(asset => asset.symbol)
          .map(asset => ({
            symbol: asset.symbol.toUpperCase() + 'USDT',
            price: parseFloat(asset.priceUsd),
            change: parseFloat(asset.changePercent24Hr),
            volume: parseFloat(asset.volumeUsd24Hr),
            name: asset.name
          }));
      } catch (error) {
        console.error('CoinCap API error:', error.message);
        return [];
      }
    }
  },
  {
    name: 'Binance Alternative',
    url: 'https://api.binance.com',
    getTickers: async () => {
      try {
        // Используем прокси или альтернативный домен
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'application/json'
          }
        });
        
        return response.data
          .filter(ticker => ticker.symbol.endsWith('USDT'))
          .map(ticker => ({
            symbol: ticker.symbol,
            price: parseFloat(ticker.lastPrice),
            change: parseFloat(ticker.priceChangePercent),
            volume: parseFloat(ticker.quoteVolume),
            high: parseFloat(ticker.highPrice),
            low: parseFloat(ticker.lowPrice)
          }));
      } catch (error) {
        console.error('Binance API error:', error.message);
        return [];
      }
    }
  }
];

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getMarketData() {
  console.log('📡 Получение данных с бирж...');
  
  // Пробуем все API по очереди
  for (const api of API_ENDPOINTS) {
    try {
      console.log(`🔄 Пробуем ${api.name}...`);
      const tickers = await api.getTickers();
      
      if (tickers && tickers.length > 50) {
        console.log(`✅ ${api.name}: получено ${tickers.length} пар`);
        
        // Фильтруем по объему и нормальным изменениям
        const filtered = tickers.filter(ticker => {
          const volume = ticker.volume || 0;
          const change = ticker.change || 0;
          const price = ticker.price || 0;
          
          return volume >= CONFIG.minVolume && 
                 price > 0.000001 &&
                 Math.abs(change) !== 0 && // Исключаем 0%
                 !isNaN(change);          // Исключаем NaN
        });
        
        if (filtered.length > 20) {
          console.log(`✅ ${api.name}: ${filtered.length} пар после фильтрации`);
          return { source: api.name, tickers: filtered };
        }
      }
    } catch (error) {
      console.error(`❌ ${api.name} не доступен:`, error.message);
    }
  }
  
  console.error('❌ Все API недоступны');
  return { source: 'none', tickers: [] };
}

// ==================== ТЕХНИЧЕСКИЕ ИНДИКАТОРЫ ====================
function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const idx = prices.length - i;
    const change = prices[idx] - prices[idx - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  
  if (!ema12 || !ema26) return { histogram: 0, macd: 0, signal: 0 };
  
  const macdLine = ema12 - ema26;
  
  // Упрощенный сигнал
  const signal = calculateEMA(prices.slice(-9).map((_, i) => {
    const slice = prices.slice(0, prices.length - 9 + i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    return (e12 || 0) - (e26 || 0);
  }), 9) || macdLine;
  
  return {
    histogram: macdLine - signal,
    macd: macdLine,
    signal: signal
  };
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (!prices || prices.length < period) return null;
  
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, price) => sum + Math.pow(price - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  
  return {
    upper: mean + (std * stdDev),
    middle: mean,
    lower: mean - (std * stdDev)
  };
}

function calculateStochastic(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period) return { k: 50, d: 50 };
  
  const kValues = [];
  for (let i = period - 1; i < closes.length; i++) {
    const highSlice = highs.slice(i - period + 1, i + 1);
    const lowSlice = lows.slice(i - period + 1, i + 1);
    const highest = Math.max(...highSlice);
    const lowest = Math.min(...lowSlice);
    
    if (highest === lowest) {
      kValues.push(50);
    } else {
      kValues.push(((closes[i] - lowest) / (highest - lowest)) * 100);
    }
  }
  
  const k = kValues.length > 0 ? kValues[kValues.length - 1] : 50;
  const d = kValues.length >= 3 ? 
    kValues.slice(-3).reduce((a, b) => a + b, 0) / 3 : k;
  
  return { k, d };
}

// ==================== АНАЛИЗ ПАРЫ ====================
async function analyzePair(pair) {
  try {
    console.log(`🔍 Анализ ${pair.symbol}...`);
    
    // Для CoinGecko/CoinCap получаем свечи через альтернативный API
    let klines = [];
    let source = 'coingecko';
    
    try {
      // Используем Binance для свечей (если пара есть на Binance)
      const symbolForBinance = pair.symbol.replace('USDT', '');
      const response = await axios.get('https://api.binance.com/api/v3/klines', {
        params: {
          symbol: symbolForBinance + 'USDT',
          interval: '15m',
          limit: 100
        },
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      klines = response.data.map(k => ({
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5])
      }));
      source = 'binance';
      
    } catch (binanceError) {
      // Если Binance не работает, используем CoinGecko для истории
      try {
        const response = await axios.get(
          `https://api.coingecko.com/api/v3/coins/${pair.symbol.toLowerCase().replace('usdt', '')}/market_chart`,
          {
            params: {
              vs_currency: 'usd',
              days: '7',
              interval: 'daily'
            },
            timeout: 10000
          }
        );
        
        if (response.data.prices) {
          klines = response.data.prices.map(([time, price]) => ({
            time: new Date(time),
            close: price,
            high: price * 1.02, // Приблизительные значения
            low: price * 0.98,
            volume: pair.volume / 7 // Распределяем объем
          }));
        }
      } catch (cgError) {
        console.log(`⚠️ Нет свечных данных для ${pair.symbol}`);
      }
    }
    
    if (klines.length < 30) {
      console.log(`⚠️ Недостаточно данных для ${pair.symbol}`);
      return null;
    }
    
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume || 0);
    
    const currentPrice = closes[closes.length - 1];
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(closes);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const macd = calculateMACD(closes);
    const bb = calculateBollingerBands(closes);
    const stoch = calculateStochastic(highs, lows, closes);
    
    // Рассчитываем силу объема
    const avgVolume = volumes.length >= 20 ? 
      volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : 
      pair.volume / 24;
    const volumeRatio = pair.volume / avgVolume;
    
    // Собираем подтверждения
    const confirmations = [];
    let confidence = 0;
    
    // 1. RSI анализ
    if (rsi < 30) {
      confirmations.push('RSI_OVERSOLD');
      confidence += 15;
    } else if (rsi > 70) {
      confirmations.push('RSI_OVERBOUGHT');
      confidence += 15;
    }
    
    // 2. MACD анализ
    if (macd.histogram > 0) {
      confirmations.push('MACD_BULLISH');
      confidence += 10;
    } else if (macd.histogram < 0) {
      confirmations.push('MACD_BEARISH');
      confidence += 10;
    }
    
    // 3. Стохастик
    if (stoch.k < 20) {
      confirmations.push('STOCH_OVERSOLD');
      confidence += 10;
    } else if (stoch.k > 80) {
      confirmations.push('STOCH_OVERBOUGHT');
      confidence += 10;
    }
    
    // 4. Тренд EMA
    if (ema9 && ema21 && ema50) {
      if (currentPrice > ema9 && ema9 > ema21 && ema21 > ema50) {
        confirmations.push('STRONG_UPTREND');
        confidence += 15;
      } else if (currentPrice < ema9 && ema9 < ema21 && ema21 < ema50) {
        confirmations.push('STRONG_DOWNTREND');
        confidence += 15;
      } else if (ema9 > ema21) {
        confirmations.push('EMA_BULLISH');
        confidence += 8;
      } else if (ema9 < ema21) {
        confirmations.push('EMA_BEARISH');
        confidence += 8;
      }
    }
    
    // 5. Боллинджер
    if (bb) {
      const bbPosition = ((currentPrice - bb.lower) / (bb.upper - bb.lower)) * 100;
      if (bbPosition < 20) {
        confirmations.push('BB_OVERSOLD');
        confidence += 12;
      } else if (bbPosition > 80) {
        confirmations.push('BB_OVERBOUGHT');
        confidence += 12;
      }
    }
    
    // 6. Объем
    if (volumeRatio > 1.5) {
      confirmations.push('HIGH_VOLUME');
      confidence += 10;
    }
    
    // 7. Изменение цены
    if (Math.abs(pair.change) > 5) {
      confirmations.push('STRONG_MOVE');
      confidence += Math.min(Math.abs(pair.change), 15);
    }
    
    // Проверяем минимальные требования
    if (confirmations.length < CONFIG.minConfirmations || confidence < CONFIG.minConfidence) {
      return null;
    }
    
    // Определяем направление
    let signal = null;
    let finalConfidence = Math.min(confidence, 95);
    
    const bullishConfirmations = confirmations.filter(c => 
      c.includes('BULLISH') || c.includes('UPTREND') || c.includes('OVERSOLD')
    ).length;
    
    const bearishConfirmations = confirmations.filter(c => 
      c.includes('BEARISH') || c.includes('DOWNTREND') || c.includes('OVERBOUGHT')
    ).length;
    
    if (bullishConfirmations >= 3 && pair.change > -10) {
      signal = 'LONG';
      finalConfidence += 5;
    } else if (bearishConfirmations >= 3 && pair.change < 10) {
      signal = 'SHORT';
      finalConfidence += 5;
    }
    
    if (!signal) return null;
    
    // Рассчитываем уровни
    const entry = currentPrice;
    let sl, tp, rrRatio;
    
    if (signal === 'LONG') {
      sl = entry * (1 - CONFIG.stopLossPercent / 100);
      tp = entry * (1 + CONFIG.takeProfitPercent / 100);
      rrRatio = (tp - entry) / (entry - sl);
    } else {
      sl = entry * (1 + CONFIG.stopLossPercent / 100);
      tp = entry * (1 - CONFIG.takeProfitPercent / 100);
      rrRatio = (entry - tp) / (sl - entry);
    }
    
    if (rrRatio < CONFIG.minRRRatio) {
      return null;
    }
    
    // Определяем уровень сигнала
    const tier = finalConfidence >= 85 ? 'GOD TIER 👑' : 
                 finalConfidence >= 75 ? 'PREMIUM 💎' : 
                 finalConfidence >= 65 ? 'STANDARD 📊' : null;
    
    if (!tier || tier === 'STANDARD 📊') {
      return null;
    }
    
    console.log(`✅ СИГНАЛ: ${tier} ${signal} ${pair.symbol} (${finalConfidence.toFixed(0)}%)`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      symbol: pair.symbol,
      signal: signal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(finalConfidence),
      rrRatio: rrRatio.toFixed(2),
      tier: tier,
      change24h: parseFloat(pair.change.toFixed(2)),
      volume24h: pair.volume,
      indicators: {
        rsi: Math.round(rsi),
        macd_hist: macd.histogram.toFixed(6),
        stoch_k: stoch.k.toFixed(1),
        stoch_d: stoch.d.toFixed(1),
        ema9: ema9 ? ema9.toFixed(6) : null,
        ema21: ema21 ? ema21.toFixed(6) : null,
        volume_ratio: volumeRatio.toFixed(1)
      },
      confirmations: confirmations.slice(0, 6),
      source: source,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('✅ Команда /start от', ctx.from.id);
  
  const welcome = `
🤖 <b>Crypto Signals Bot Pro</b>

🎯 <b>Анализ:</b> Топ ${CONFIG.topGainers} роста + Топ ${CONFIG.topLosers} падения
💰 <b>Мин. объем:</b> ${(CONFIG.minVolume/1000).toFixed(0)}K USDT
📊 <b>Мин. изменение:</b> ${CONFIG.minChange}%
🎖️ <b>Мин. уверенность:</b> ${CONFIG.minConfidence}%

⚡ <b>Индикаторы:</b>
• RSI (перекупленность/перепроданность)
• MACD (импульс и тренд)
• EMA (9, 21, 50) - тренд
• Bollinger Bands - волатильность
• Stochastic - моментум
• Volume Analysis - объемы

⏰ <b>Сканирование:</b> каждые 15 минут
🏆 <b>Уровни сигналов:</b>
👑 GOD TIER - уверенность ≥85%
💎 PREMIUM - уверенность ≥75%
📊 STANDARD - уверенность ≥65%

📱 <b>Команды:</b>
/start - информация
/test - проверить API
/scan - ручное сканирование (до 10 сигналов)
/top - топ движений за 24h
/status - статус бота

✅ <b>Бот активен и ищет сигналы!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  console.log('🧪 Тест подключения...');
  
  try {
    await ctx.reply('🔄 Проверяю доступность API...');
    
    const data = await getMarketData();
    
    if (data.tickers.length > 0) {
      const sample = data.tickers.slice(0, 3);
      let message = `✅ <b>API работает!</b>\n\n`;
      message += `📡 Источник: ${data.source}\n`;
      message += `📊 Получено пар: ${data.tickers.length}\n\n`;
      message += `<b>Примеры:</b>\n`;
      
      sample.forEach(t => {
        const change = t.change || 0;
        const changeStr = change > 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
        message += `• <b>${t.symbol}</b>\n`;
        message += `  Цена: $${t.price.toFixed(4)}\n`;
        message += `  Изменение: ${changeStr}\n`;
        message += `  Объем: $${(t.volume/1000).toFixed(0)}K\n\n`;
      });
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('❌ Не удалось получить данные с API');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  console.log('📈 Топ движений...');
  
  try {
    await ctx.reply('📊 Получаю топ движений...');
    
    const data = await getMarketData();
    if (data.tickers.length === 0) {
      await ctx.reply('❌ Нет данных для анализа');
      return;
    }
    
    // Фильтруем по минимальному изменению
    const filtered = data.tickers.filter(t => Math.abs(t.change || 0) >= 1);
    
    if (filtered.length === 0) {
      await ctx.reply('ℹ️ Нет пар с изменением >1%');
      return;
    }
    
    // Топ роста
    const topGainers = [...filtered]
      .sort((a, b) => (b.change || 0) - (a.change || 0))
      .slice(0, 5);
    
    // Топ падения
    const topLosers = [...filtered]
      .sort((a, b) => (a.change || 0) - (b.change || 0))
      .slice(0, 5);
    
    let message = `📈 <b>ТОП 5 РОСТА (24h)</b>\n\n`;
    
    topGainers.forEach((t, i) => {
      const change = t.change || 0;
      const changeStr = change > 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 ${changeStr}\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    message += `📉 <b>ТОП 5 ПАДЕНИЯ (24h)</b>\n\n`;
    
    topLosers.forEach((t, i) => {
      const change = t.change || 0;
      const changeStr = `${change.toFixed(2)}%`; // Отрицательный знак уже в числе
      message += `${i+1}. <b>${t.symbol}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${changeStr}\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    message += `📡 Источник: ${data.source}`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('scan', async (ctx) => {
  console.log('🔍 Ручное сканирование...');
  
  try {
    await ctx.reply('🔍 Запускаю глубокое сканирование...');
    
    const data = await getMarketData();
    if (data.tickers.length === 0) {
      await ctx.reply('❌ Нет данных для анализа');
      return;
    }
    
    // Сортируем по абсолютному изменению и берем топ
    const sortedByChange = [...data.tickers]
      .sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0))
      .slice(0, 60); // Берем 60 самых волатильных
    
    await ctx.reply(`📊 Анализирую ${sortedByChange.length} пар...`);
    
    const signals = [];
    
    // Анализируем каждую пару
    for (let i = 0; i < Math.min(sortedByChange.length, 60); i++) {
      const pair = sortedByChange[i];
      
      // Пропускаем если изменение слишком маленькое
      if (Math.abs(pair.change || 0) < CONFIG.minChange) continue;
      
      const signal = await analyzePair(pair);
      
      if (signal) {
        signals.push(signal);
        console.log(`✅ Найден сигнал ${i+1}/${sortedByChange.length}: ${signal.pair}`);
      }
      
      // Задержка между запросами чтобы не перегружать API
      if (i % 10 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    if (signals.length > 0) {
      // Сортируем по уверенности
      signals.sort((a, b) => b.confidence - a.confidence);
      
      let message = `🎯 <b>НАЙДЕНО СИГНАЛОВ: ${signals.length}</b>\n\n`;
      
      // Показываем только лучшие 5
      signals.slice(0, 5).forEach((sig, i) => {
        const emoji = sig.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = sig.tier.includes('GOD') ? '👑' : sig.tier.includes('PREMIUM') ? '💎' : '📊';
        
        message += `${tierEmoji} <b>${sig.tier}</b>\n`;
        message += `${emoji} <b>${sig.signal} ${sig.pair}</b>\n`;
        message += `📈 Изменение: ${sig.change24h > 0 ? '+' : ''}${sig.change24h}%\n`;
        message += `💰 Объем: $${(sig.volume24h/1000000).toFixed(2)}M\n`;
        message += `🎯 Вход: $${sig.entry}\n`;
        message += `✅ Тейк: $${sig.tp}\n`;
        message += `🛑 Стоп: $${sig.sl}\n`;
        message += `📊 R:R: 1:${sig.rrRatio}\n`;
        message += `🔮 Уверенность: ${sig.confidence}%\n`;
        message += `📊 RSI: ${sig.indicators.rsi}\n`;
        message += `📈 MACD Hist: ${sig.indicators.macd_hist}\n`;
        message += `💎 Подтверждения: ${sig.confirmations.length}\n\n`;
      });
      
      message += `📡 Источник данных: ${data.source}`;
      
      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('ℹ️ Сигналов не найдено. Попробуйте позже или используйте /top для просмотра движений');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка сканирования: ${error.message}`);
  }
});

bot.command('status', (ctx) => {
  const now = new Date();
  const nextScan = 15 - (now.getMinutes() % 15);
  
  ctx.reply(
    `📊 <b>СТАТУС БОТА</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `🏦 <b>Источники:</b> CoinGecko, CoinCap, Binance\n` +
    `🎯 <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `⏰ <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `📈 <b>Параметры сканирования:</b>\n` +
    `• Топ роста: ${CONFIG.topGainers} пар\n` +
    `• Топ падения: ${CONFIG.topLosers} пар\n` +
    `• Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT\n` +
    `• Мин. изменение: ${CONFIG.minChange}%\n` +
    `• Мин. уверенность: ${CONFIG.minConfidence}%\n\n` +
    `⚡ <b>Индикаторы:</b> RSI, MACD, EMA, BB, Stochastic\n\n` +
    `💡 <b>Команды:</b> /scan /top /test`,
    { parse_mode: 'HTML' }
  );
});

// ==================== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ====================
async function autoScan() {
  console.log('\n🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ');
  console.log('='.repeat(50));
  
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен, пропускаю отправку');
    return;
  }
  
  try {
    const data = await getMarketData();
    if (data.tickers.length === 0) {
      console.log('❌ Нет данных от API');
      return;
    }
    
    console.log(`📊 Источник: ${data.source}, пар: ${data.tickers.length}`);
    
    // Берем самые волатильные пары (топ роста + топ падения)
    const sortedByChange = [...data.tickers]
      .sort((a, b) => Math.abs(b.change || 0) - Math.abs(a.change || 0));
    
    const topGainers = sortedByChange
      .filter(t => (t.change || 0) > 0)
      .slice(0, CONFIG.topGainers);
    
    const topLosers = sortedByChange
      .filter(t => (t.change || 0) < 0)
      .slice(0, CONFIG.topLosers);
    
    const pairsToAnalyze = [...topGainers, ...topLosers];
    
    console.log(`📈 Анализ ${pairsToAnalyze.length} пар (${topGainers.length} рост + ${topLosers.length} падение)...`);
    
    const signals = [];
    
    // Анализируем каждую пару (быстрый анализ для автосканирования)
    for (let i = 0; i < pairsToAnalyze.length; i++) {
      const pair = pairsToAnalyze[i];
      
      // Пропускаем если изменение слишком маленькое
      if (Math.abs(pair.change || 0) < 3) continue;
      
      try {
        const signal = await analyzePair(pair);
        if (signal) {
          signals.push(signal);
        }
      } catch (error) {
        // Пропускаем ошибки в отдельных парах
      }
      
      // Задержка
      if (i % 5 === 0 && i > 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    if (signals.length > 0) {
      // Сортируем и берем только лучшие
      signals.sort((a, b) => b.confidence - a.confidence);
      const bestSignals = signals.slice(0, 3); // Только 3 лучших
      
      console.log(`📊 Найдено ${signals.length} сигналов, отправляю ${bestSignals.length} лучших`);
      
      for (const signal of bestSignals) {
        const profitPercent = signal.signal === 'LONG' 
          ? ((signal.tp / signal.entry - 1) * 100).toFixed(2)
          : ((1 - signal.tp / signal.entry) * 100).toFixed(2);
        
        const lossPercent = signal.signal === 'LONG'
          ? ((1 - signal.sl / signal.entry) * 100).toFixed(2)
          : ((signal.sl / signal.entry - 1) * 100).toFixed(2);
        
        const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
        const tierEmoji = signal.tier.includes('GOD') ? '👑' : '💎';
        
        const message = `
${tierEmoji} <b>${signal.tier} СИГНАЛ</b>

${emoji} <b>${signal.signal} ${signal.pair}</b>

📈 <b>Изменение 24h:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💰 <b>Объем 24h:</b> $${(signal.volume24h / 1000000).toFixed(2)}M

🎯 <b>Вход:</b> $${signal.entry}
✅ <b>Тейк-профит:</b> $${signal.tp} (<b>+${profitPercent}%</b>)
🛑 <b>Стоп-лосс:</b> $${signal.sl} (<b>-${lossPercent}%</b>)

📊 <b>R:R Ratio:</b> 1:${signal.rrRatio}
🔮 <b>Confidence:</b> ${signal.confidence}%

<b>📉 ИНДИКАТОРЫ:</b>
• RSI: ${signal.indicators.rsi}
• MACD Hist: ${signal.indicators.macd_hist}
• Stoch K: ${signal.indicators.stoch_k}
• Volume: x${signal.indicators.volume_ratio}

<b>✅ ПОДТВЕРЖДЕНИЯ:</b>
${signal.confirmations.slice(0, 4).map(c => `• ${c.replace(/_/g, ' ')}`).join('\n')}

🏦 <b>Exchange: ${CONFIG.exchange.toUpperCase()}</b>
⏰ <b>Time:</b> ${signal.timestamp.toLocaleTimeString('ru-RU')}
        `.trim();
        
        try {
          await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
          console.log(`✅ Автосигнал отправлен: ${signal.pair}`);
          
          // Задержка между отправками
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (error) {
          console.error(`❌ Ошибка отправки:`, error.message);
        }
      }
    } else {
      console.log('ℹ️ Сигналов для автоотправки не найдено');
    }
    
  } catch (error) {
    console.error('❌ Ошибка автосканирования:', error.message);
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('🚀 Запуск Crypto Signals Bot Pro...');
    
    // Запускаем Telegram бота
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот запущен!');
    
    // Настройка планировщика
    cron.schedule(CONFIG.scanInterval, () => {
      const now = new Date();
      console.log(`\n⏰ АВТОСКАНИРОВАНИЕ: ${now.toLocaleTimeString('ru-RU')}`);
      autoScan();
    });
    
    console.log(`⏰ Автосканирование настроено: ${CONFIG.scanInterval}`);
    
    // Первое сканирование через 2 минуты
    setTimeout(() => {
      console.log('\n🎯 ПЕРВОЕ АВТОСКАНИРОВАНИЕ');
      autoScan();
    }, 120000);
    
    // Приветственное сообщение
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>Crypto Signals Bot Pro запущен!</b>\n\n` +
          `✅ Telegram: подключено\n` +
          `✅ API источники: CoinGecko, CoinCap, Binance\n` +
          `⏰ Автосканирование: каждые 15 минут\n\n` +
          `📊 <b>Параметры:</b>\n` +
          `• Топ ${CONFIG.topGainers} роста + ${CONFIG.topLosers} падения\n` +
          `• Объем > ${(CONFIG.minVolume/1000).toFixed(0)}K USDT\n` +
          `• Изменение > ${CONFIG.minChange}%\n\n` +
          `⚡ <b>Индикаторы:</b>\n` +
          `• RSI, MACD, EMA (9,21,50)\n` +
          `• Bollinger Bands, Stochastic\n` +
          `• Volume Analysis\n\n` +
          `📱 <b>Команды:</b>\n` +
          `/start - информация\n` +
          `/test - проверить API\n` +
          `/scan - глубокое сканирование\n` +
          `/top - топ движений\n` +
          `/status - статус бота\n\n` +
          `🔄 Первое сканирование через 2 минуты`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.log('⚠️ Не удалось отправить стартовое сообщение');
      }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log('🤖 CRYPTO SIGNALS BOT PRO ЗАПУЩЕН');
    console.log('='.repeat(50));
    console.log('📊 Конфигурация:');
    console.log(`   • Топ роста: ${CONFIG.topGainers} пар`);
    console.log(`   • Топ падения: ${CONFIG.topLosers} пар`);
    console.log(`   • Мин. объем: ${(CONFIG.minVolume/1000).toFixed(0)}K USDT`);
    console.log(`   • Мин. изменение: ${CONFIG.minChange}%`);
    console.log(`   • Мин. уверенность: ${CONFIG.minConfidence}%`);
    console.log('');
    console.log('⚡ Индикаторы:');
    console.log('   • RSI (14)');
    console.log('   • MACD (12,26,9)');
    console.log('   • EMA (9,21,50)');
    console.log('   • Bollinger Bands (20,2)');
    console.log('   • Stochastic (14,3,3)');
    console.log('');
    console.log('📱 Команды в Telegram:');
    console.log('   /start  - информация о боте');
    console.log('   /test   - проверка API');
    console.log('   /scan   - глубокое сканирование (до 60 пар)');
    console.log('   /top    - топ движений за 24h');
    console.log('   /status - статус бота');
    console.log('='.repeat(50));
    console.log(`⏰ Автосканирование: каждые 15 минут`);
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Обработчики завершения
process.once('SIGINT', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 1000);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Остановка бота...');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

// Запуск
start();
