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
console.log('🔥 Источник данных: MEXC, Binance, Bybit, OKX, KuCoin');

// ==================== НАСТРОЙКИ ТОРГОВЛИ ====================
const CONFIG = {
  // Биржи
  exchanges: {
    mexc: {
      name: 'MEXC',
      spotApi: 'https://api.mexc.com/api/v3',
      futuresApi: 'https://contract.mexc.com/api/v1/contract',
      enabled: true
    },
    binance: {
      name: 'Binance',
      spotApi: 'https://api.binance.com/api/v3',
      futuresApi: 'https://fapi.binance.com/fapi/v1',
      enabled: true
    },
    bybit: {
      name: 'Bybit',
      spotApi: 'https://api.bybit.com/v5',
      enabled: true
    },
    okx: {
      name: 'OKX',
      spotApi: 'https://www.okx.com/api/v5',
      enabled: true
    },
    kucoin: {
      name: 'KuCoin',
      spotApi: 'https://api.kucoin.com/api/v1',
      enabled: true
    }
  },
  
  // Фильтры
  minVolatility: 5,           // Минимум 5% изменение за 24ч (было 10)
  minVolume: 50000,           // $50K минимальный объем (было 100K)
  minTrades: 50,              // Минимум 50 сделок за 24ч (было 100)
  topCoinsPerExchange: 100,   // Топ-100 с каждой биржи (было 50)
  
  // Критерии качества
  minQualityScore: 3,         // Минимум 3/10 (было 5)
  minConfidence: 55,          // Минимум 55% (было 65)
  minRRRatio: 2.5,            // Минимум 1:2.5 (было 3.0)
  
  // Уровни сигналов
  godTier: {
    qualityScore: 6,          // Было 7
    confidence: 75,           // Было 80
    rrRatio: 3.5,             // Было 4.0
    volatility: 10            // Было 15
  },
  premium: {
    qualityScore: 4,          // Было 5
    confidence: 60,           // Было 65
    rrRatio: 2.5,             // Было 3.0
    volatility: 5             // Было 10
  }
};

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply(
    `🤖 Crypto Signals Bot v3.1 - Multi-Exchange\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `🔥 Биржи:\n` +
    `  • MEXC\n  • Binance\n  • Bybit\n  • OKX\n  • KuCoin\n\n` +
    `📈 Анализ: Volatility, Funding, Open Interest, Volume\n` +
    `🎯 R:R соотношение: минимум 1:3\n\n` +
    `💡 Установите: <code>TELEGRAM_CHAT_ID=${chatId}</code>\n\n` +
    `📈 Сигналы каждые 5 минут.`,
    { parse_mode: 'HTML' }
  );
});

bot.command('chatid', (ctx) => {
  ctx.reply(
    `💬 Ваш Chat ID: <code>${ctx.chat.id}</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('test', async (ctx) => {
  const testSignal = {
    pair: 'BTC/USDT',
    signal: 'LONG',
    entry: 45000,
    tp: 48600,
    sl: 43650,
    confidence: 85,
    qualityScore: 8,
    rrRatio: 4.0,
    tier: 'GOD TIER',
    exchange: 'Binance',
    metrics: {
      volatility: 15.5,
      volume24h: 5000000000,
      trades24h: 150000,
      fundingRate: 0.01,
      openInterest: 1500000000
    },
    confirmations: ['HIGH_VOLATILITY', 'POSITIVE_FUNDING', 'HIGH_VOLUME', 'OVERSOLD']
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// ==================== ПОЛУЧЕНИЕ ДАННЫХ С БИРЖ ====================

// MEXC
async function fetchMEXCData() {
  try {
    const response = await axios.get(`${CONFIG.exchanges.mexc.spotApi}/ticker/24hr`, {
      timeout: 10000
    });
    
    const usdtPairs = response.data
      .filter(coin => coin.symbol.endsWith('USDT') && parseFloat(coin.quoteVolume) > CONFIG.minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, CONFIG.topCoinsPerExchange)
      .map(coin => ({
        exchange: 'MEXC',
        symbol: coin.symbol.replace('USDT', '/USDT'),
        price: parseFloat(coin.lastPrice),
        priceChange: parseFloat(coin.priceChangePercent),
        volume: parseFloat(coin.quoteVolume),
        trades: coin.count || 0
      }));
    
    console.log(`✅ MEXC: ${usdtPairs.length} пар`);
    return usdtPairs;
  } catch (error) {
    console.error('⚠️  MEXC error:', error.message);
    return [];
  }
}

// Binance
async function fetchBinanceData() {
  try {
    const response = await axios.get(`${CONFIG.exchanges.binance.spotApi}/ticker/24hr`, {
      timeout: 10000
    });
    
    const usdtPairs = response.data
      .filter(coin => coin.symbol.endsWith('USDT') && parseFloat(coin.quoteVolume) > CONFIG.minVolume)
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, CONFIG.topCoinsPerExchange)
      .map(coin => ({
        exchange: 'Binance',
        symbol: coin.symbol.replace('USDT', '/USDT'),
        price: parseFloat(coin.lastPrice),
        priceChange: parseFloat(coin.priceChangePercent),
        volume: parseFloat(coin.quoteVolume),
        trades: parseInt(coin.count) || 0
      }));
    
    console.log(`✅ Binance: ${usdtPairs.length} пар`);
    return usdtPairs;
  } catch (error) {
    console.error('⚠️  Binance error:', error.message);
    return [];
  }
}

// Bybit
async function fetchBybitData() {
  try {
    const response = await axios.get(`${CONFIG.exchanges.bybit.spotApi}/market/tickers`, {
      params: { category: 'spot' },
      timeout: 10000
    });
    
    if (!response.data?.result?.list) return [];
    
    const usdtPairs = response.data.result.list
      .filter(coin => coin.symbol.endsWith('USDT') && parseFloat(coin.turnover24h) > CONFIG.minVolume)
      .sort((a, b) => parseFloat(b.turnover24h) - parseFloat(a.turnover24h))
      .slice(0, CONFIG.topCoinsPerExchange)
      .map(coin => ({
        exchange: 'Bybit',
        symbol: coin.symbol.replace('USDT', '/USDT'),
        price: parseFloat(coin.lastPrice),
        priceChange: parseFloat(coin.price24hPcnt) * 100,
        volume: parseFloat(coin.turnover24h),
        trades: 0
      }));
    
    console.log(`✅ Bybit: ${usdtPairs.length} пар`);
    return usdtPairs;
  } catch (error) {
    console.error('⚠️  Bybit error:', error.message);
    return [];
  }
}

// OKX
async function fetchOKXData() {
  try {
    const response = await axios.get(`${CONFIG.exchanges.okx.spotApi}/market/tickers`, {
      params: { instType: 'SPOT' },
      timeout: 10000
    });
    
    if (!response.data?.data) return [];
    
    const usdtPairs = response.data.data
      .filter(coin => coin.instId.endsWith('-USDT') && parseFloat(coin.volCcy24h) > CONFIG.minVolume)
      .sort((a, b) => parseFloat(b.volCcy24h) - parseFloat(a.volCcy24h))
      .slice(0, CONFIG.topCoinsPerExchange)
      .map(coin => ({
        exchange: 'OKX',
        symbol: coin.instId.replace('-USDT', '/USDT'),
        price: parseFloat(coin.last),
        priceChange: ((parseFloat(coin.last) - parseFloat(coin.open24h)) / parseFloat(coin.open24h)) * 100,
        volume: parseFloat(coin.volCcy24h),
        trades: 0
      }));
    
    console.log(`✅ OKX: ${usdtPairs.length} пар`);
    return usdtPairs;
  } catch (error) {
    console.error('⚠️  OKX error:', error.message);
    return [];
  }
}

// KuCoin
async function fetchKuCoinData() {
  try {
    const response = await axios.get(`${CONFIG.exchanges.kucoin.spotApi}/market/allTickers`, {
      timeout: 10000
    });
    
    if (!response.data?.data?.ticker) return [];
    
    const usdtPairs = response.data.data.ticker
      .filter(coin => coin.symbol.endsWith('-USDT') && parseFloat(coin.volValue) > CONFIG.minVolume)
      .sort((a, b) => parseFloat(b.volValue) - parseFloat(a.volValue))
      .slice(0, CONFIG.topCoinsPerExchange)
      .map(coin => ({
        exchange: 'KuCoin',
        symbol: coin.symbol.replace('-USDT', '/USDT'),
        price: parseFloat(coin.last),
        priceChange: parseFloat(coin.changeRate) * 100,
        volume: parseFloat(coin.volValue),
        trades: 0
      }));
    
    console.log(`✅ KuCoin: ${usdtPairs.length} пар`);
    return usdtPairs;
  } catch (error) {
    console.error('⚠️  KuCoin error:', error.message);
    return [];
  }
}

// Получить funding rates (Binance + MEXC)
async function fetchFundingRates() {
  const fundingMap = {};
  
  // Binance funding
  try {
    const response = await axios.get(`${CONFIG.exchanges.binance.futuresApi}/premiumIndex`, {
      timeout: 10000
    });
    response.data.forEach(item => {
      const symbol = item.symbol.replace('USDT', '/USDT');
      fundingMap[`Binance_${symbol}`] = parseFloat(item.lastFundingRate || 0);
    });
  } catch (error) {
    console.error('⚠️  Binance funding error');
  }
  
  // MEXC funding
  try {
    const response = await axios.get(`${CONFIG.exchanges.mexc.futuresApi}/funding_rate/list`, {
      timeout: 10000
    });
    if (response.data?.data) {
      response.data.data.forEach(item => {
        const symbol = item.symbol.replace('_USDT', '/USDT');
        fundingMap[`MEXC_${symbol}`] = parseFloat(item.fundingRate || 0);
      });
    }
  } catch (error) {
    console.error('⚠️  MEXC funding error');
  }
  
  console.log(`✅ Получено ${Object.keys(fundingMap).length} funding rates`);
  return fundingMap;
}

// ==================== АНАЛИЗ СИГНАЛА ====================
function analyzeSignal(coin, fundingRate = 0) {
  const absChange = Math.abs(coin.priceChange);
  if (absChange < CONFIG.minVolatility) return null;
  
  let signal = null;
  let confidence = 0;
  let qualityScore = 0;
  const confirmations = [];
  
  // Волатильность
  if (absChange >= 10) {
    qualityScore += 2;
    confirmations.push('HIGH_VOLATILITY');
  } else if (absChange >= 7) {
    qualityScore += 1.5;
    confirmations.push('MEDIUM_VOLATILITY');
  } else if (absChange >= 5) {
    qualityScore += 1;
    confirmations.push('GOOD_VOLATILITY');
  }
  
  // Funding rate
  if (fundingRate > 0.01) {
    qualityScore += 2;
    confirmations.push('POSITIVE_FUNDING');
  } else if (fundingRate < -0.01) {
    qualityScore += 2;
    confirmations.push('NEGATIVE_FUNDING');
  }
  
  // Объем
  if (coin.volume > CONFIG.minVolume * 10) {
    qualityScore += 2;
    confirmations.push('HIGH_VOLUME');
  } else if (coin.volume > CONFIG.minVolume * 5) {
    qualityScore += 1;
    confirmations.push('GOOD_VOLUME');
  }
  
  // Сделки
  if (coin.trades > 1000) {
    qualityScore += 1;
    confirmations.push('HIGH_ACTIVITY');
  }
  
  // Определение сигнала
  if (coin.priceChange > CONFIG.minVolatility) {
    signal = 'SHORT';
    confidence = Math.min(60 + absChange * 1.5 + qualityScore * 3, 95);
    confirmations.push('OVERBOUGHT');
  } else if (coin.priceChange < -CONFIG.minVolatility) {
    signal = 'LONG';
    confidence = Math.min(60 + absChange * 1.5 + qualityScore * 3, 95);
    confirmations.push('OVERSOLD');
  }
  
  if (!signal) return null;
  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confidence < CONFIG.minConfidence) return null;
  if (confirmations.length < 1) return null;  // Было 2, теперь 1
  
  // Расчет SL/TP
  const slPercent = 3 + (absChange / 10);
  const tpPercent = slPercent * CONFIG.minRRRatio;
  
  let entry, sl, tp, rrRatio;
  
  if (signal === 'LONG') {
    entry = coin.price;
    sl = coin.price * (1 - slPercent / 100);
    tp = coin.price * (1 + tpPercent / 100);
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    entry = coin.price;
    sl = coin.price * (1 + slPercent / 100);
    tp = coin.price * (1 - tpPercent / 100);
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  if (rrRatio < CONFIG.minRRRatio) return null;
  
  const isGodTier = 
    qualityScore >= CONFIG.godTier.qualityScore &&
    confidence >= CONFIG.godTier.confidence &&
    rrRatio >= CONFIG.godTier.rrRatio &&
    absChange >= CONFIG.godTier.volatility;
  
  const isPremium = !isGodTier &&
    qualityScore >= CONFIG.premium.qualityScore &&
    confidence >= CONFIG.premium.confidence &&
    rrRatio >= CONFIG.premium.rrRatio &&
    absChange >= CONFIG.premium.volatility;
  
  if (!isGodTier && !isPremium) return null;
  
  return {
    pair: coin.symbol,
    signal,
    entry: parseFloat(entry.toFixed(8)),
    tp: parseFloat(tp.toFixed(8)),
    sl: parseFloat(sl.toFixed(8)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: isGodTier ? 'GOD TIER' : 'PREMIUM',
    exchange: coin.exchange,
    metrics: {
      volatility: parseFloat(absChange.toFixed(2)),
      volume24h: parseFloat(coin.volume.toFixed(0)),
      trades24h: coin.trades,
      fundingRate: parseFloat((fundingRate * 100).toFixed(4)),
      priceChange24h: parseFloat(coin.priceChange.toFixed(2))
    },
    confirmations,
    timestamp: new Date()
  };
}

// ==================== ГЕНЕРАЦИЯ СИГНАЛОВ ====================
async function generateSignals() {
  console.log('🔍 Генерация сигналов со всех бирж...');
  
  try {
    // Параллельный сбор данных со всех бирж
    const [mexcData, binanceData, bybitData, okxData, kucoinData, fundingRates] = await Promise.all([
      CONFIG.exchanges.mexc.enabled ? fetchMEXCData() : Promise.resolve([]),
      CONFIG.exchanges.binance.enabled ? fetchBinanceData() : Promise.resolve([]),
      CONFIG.exchanges.bybit.enabled ? fetchBybitData() : Promise.resolve([]),
      CONFIG.exchanges.okx.enabled ? fetchOKXData() : Promise.resolve([]),
      CONFIG.exchanges.kucoin.enabled ? fetchKuCoinData() : Promise.resolve([]),
      fetchFundingRates()
    ]);
    
    // Объединяем все данные
    const allCoins = [...mexcData, ...binanceData, ...bybitData, ...okxData, ...kucoinData];
    console.log(`📊 Всего монет со всех бирж: ${allCoins.length}`);
    
    if (allCoins.length === 0) {
      console.log('⚠️  Нет данных ни с одной биржи');
      return [];
    }
    
    const signals = [];
    
    for (const coin of allCoins) {
      const fundingKey = `${coin.exchange}_${coin.symbol}`;
      const fundingRate = fundingRates[fundingKey] || 0;
      
      const signal = analyzeSignal(coin, fundingRate);
      if (signal) {
        signals.push(signal);
      }
    }
    
    // Сортировка
    signals.sort((a, b) => {
      if (a.tier === 'GOD TIER' && b.tier !== 'GOD TIER') return -1;
      if (a.tier !== 'GOD TIER' && b.tier === 'GOD TIER') return 1;
      return b.qualityScore - a.qualityScore;
    });
    
    console.log(`✅ Найдено ${signals.length} сигналов`);
    
    if (signals.length > 0) {
      signals.forEach((s, i) => {
        console.log(`  ${i+1}. [${s.exchange}] ${s.pair} ${s.signal} | ${s.tier} | Q=${s.qualityScore} C=${s.confidence}% RR=1:${s.rrRatio} V=${s.metrics.volatility}%`);
      });
    }
    
    return signals;
  } catch (error) {
    console.error('❌ Ошибка генерации:', error.message);
    return [];
  }
}

// ==================== ОТПРАВКА В TELEGRAM ====================
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️  CHAT_ID не установлен');
    return false;
  }
  
  try {
    const direction = signal.signal === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const tierEmoji = signal.tier === 'GOD TIER' ? '🔥' : '⭐';
    
    const message = `
${tierEmoji} <b>${signal.tier} SIGNAL</b>
${direction} <b>${signal.pair}</b>

💵 Entry: $${signal.entry}
🎯 Take Profit: $${signal.tp} (+${((Math.abs(signal.tp - signal.entry) / signal.entry) * 100).toFixed(2)}%)
🛑 Stop Loss: $${signal.sl} (-${((Math.abs(signal.entry - signal.sl) / signal.entry) * 100).toFixed(2)}%)

📊 R:R Ratio: 1:${signal.rrRatio}
🎲 Confidence: ${signal.confidence}%
🏆 Quality: ${signal.qualityScore}/10

📈 Metrics:
  • Volatility: ${signal.metrics.volatility}%
  • Volume 24h: $${(signal.metrics.volume24h / 1000000).toFixed(2)}M
  • Trades 24h: ${signal.metrics.trades24h || 'N/A'}
  • Funding Rate: ${signal.metrics.fundingRate}%

🔍 Confirmations:
${signal.confirmations.map(c => `  • ${c}`).join('\n')}

🏦 Exchange: <b>${signal.exchange}</b>
⏰ ${signal.timestamp.toLocaleString('ru-RU')}
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ [${signal.exchange}] ${signal.pair} отправлен`);
    return true;
  } catch (error) {
    console.error('❌ Telegram error:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧА ====================
async function runSignalsTask() {
  console.log('\n🔄 === ЗАПУСК ЗАДАЧИ ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  Сигналов не найдено');
      return;
    }
    
    const signalsToSend = signals.slice(0, 5);
    console.log(`📤 Отправка ${signalsToSend.length} сигналов...`);
    
    for (const signal of signalsToSend) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ Задача завершена\n');
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    await bot.telegram.deleteWebhook();
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    bot.launch();
    console.log('✅ Бот запущен');
    
    cron.schedule('*/5 * * * *', runSignalsTask);
    console.log('✅ CRON: каждые 5 минут');
    
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
