import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';

// ==================== КОНФИГУРАЦИЯ ====================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const DEXSCREENER_API_URL = 'https://api.dexscreener.com/latest/dex';

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

console.log('✅ Bot token найден');
console.log('📱 Chat ID:', CHAT_ID || 'НЕ УСТАНОВЛЕН (получите через /chatid)');
console.log('🔑 CoinGecko API Key:', COINGECKO_API_KEY ? 'УСТАНОВЛЕН' : 'НЕ УСТАНОВЛЕН (работает без ключа, но с лимитами)');

// ==================== НАСТРОЙКИ ТОРГОВЛИ ====================
const CONFIG = {
  // CoinGecko API
  apiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 100,  // Уменьшено для стабильности
  
  // DEX Screener настройки (УПРОЩЕНО)
  dexMinLiquidity: 50000,           // Минимальная ликвидность $50K (уменьшено)
  dexMaxAgeHours: 24,               // Максимальный возраст монеты (24 часа)
  dexMinVolume24h: 10000,           // Минимальный объем 24ч $10K (уменьшено)
  
  // Фильтры CEX
  minVolume: 10000000,              // Уменьшено для получения сигналов
  minMarketCap: 100000000,          // Уменьшено
  minConfidence: 60,                // Уменьшено
  minQualityScore: 5,               // Уменьшено
  minRRRatio: 2.5,                  // Уменьшено
  minConfirmations: 2,              // Уменьшено
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'dai', 'busd', 'tusd'];

// ==================== КЭШ ДЛЯ DEX МОНЕТ ====================
let sentDexTokens = new Set();

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команда /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';
  
  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);
  
  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot!\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n` +
    `👤 Пользователь: ${firstName} ${username}\n\n` +
    `🔄 Функции:\n` +
    `• 📈 Сигналы CEX каждые 10 минут\n` +
    `• 🔥 Новые DEX монеты каждые 30 минут\n\n` +
    `💡 Используйте этот Chat ID:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// Команда /chatid
bot.command('chatid', (ctx) => {
  const chatId = ctx.chat.id;
  console.log(`💬 /chatid от chat ID: ${chatId}`);
  ctx.reply(
    `💬 Ваш Chat ID: <code>${chatId}</code>\n\n` +
    `Установите его в переменные окружения:\n` +
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    { parse_mode: 'HTML' }
  );
});

// Команда /test - тестовый сигнал
bot.command('test', async (ctx) => {
  console.log('🧪 Отправка тестового сигнала...');
  
  const testSignal = {
    pair: 'BTC/USDT',
    signal: 'LONG',
    entry: 45000,
    tp: 48000,
    sl: 43500,
    confidence: 85,
    qualityScore: 8,
    rrRatio: 3.5,
    tier: 'TEST',
    exchange: 'BINANCE',
    indicators: {
      rsi: 28,
      volatility: 5.2,
      stochK: 25,
      adx: 35,
      atr: 0.015,
    },
    confirmations: ['RSI_OVERSOLD', 'MACD_BULLISH'],
    liquidityZoneUsed: true,
    timestamp: new Date()
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// Команда /dex - тест DEX
bot.command('dex', async (ctx) => {
  console.log('🔍 Ручной запуск DEX скринера...');
  ctx.reply('🔍 Ищу новые DEX монеты...');
  
  try {
    const newTokens = await scanNewDEXTokens();
    
    if (newTokens.length === 0) {
      ctx.reply('ℹ️ Новых DEX монет не найдено');
    } else {
      ctx.reply(`✅ Найдено ${newTokens.length} новых DEX монет. Отправляю...`);
      
      for (const token of newTokens.slice(0, 3)) { // Максимум 3
        await sendDEXTokenToTelegram(token);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    console.error('Ошибка DEX команды:', error);
    ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// ==================== УПРОЩЕННЫЙ DEX SCREENER ====================
async function scanNewDEXTokens() {
  try {
    console.log('🔍 Сканирую новые DEX монеты...');
    
    // ПРОСТОЙ запрос к DEXScreener - популярные новые пары
    const response = await axios.get(`${DEXSCREENER_API_URL}/pairs`, {
      params: {
        sort: 'createdAt',  // Сортировка по дате создания
        order: 'desc',      // Новые сначала
        limit: 50           // 50 пар
      },
      timeout: 10000
    });
    
    if (!response.data || !response.data.pairs) {
      console.log('⚠️ Нет данных от DEXScreener');
      return [];
    }
    
    console.log(`📊 Получено ${response.data.pairs.length} пар от DEXScreener`);
    
    // Фильтруем результаты
    const filteredTokens = response.data.pairs.filter(pair => {
      // Базовые проверки
      if (!pair.baseToken || !pair.quoteToken) return false;
      
      // Пропускаем стейблкоины
      const baseSymbol = pair.baseToken.symbol.toLowerCase();
      const quoteSymbol = pair.quoteToken.symbol.toLowerCase();
      
      if (STABLECOINS.includes(baseSymbol) || STABLECOINS.includes(quoteSymbol)) {
        return false;
      }
      
      // Проверяем ликвидность
      if (pair.liquidity && pair.liquidity.usd < CONFIG.dexMinLiquidity) {
        return false;
      }
      
      // Проверяем возраст (если есть дата создания)
      if (pair.pairCreatedAt) {
        const createdTime = new Date(pair.pairCreatedAt).getTime();
        const ageHours = (Date.now() - createdTime) / (1000 * 60 * 60);
        
        if (ageHours > CONFIG.dexMaxAgeHours) return false;
      }
      
      // Проверяем объем
      if (pair.volume && pair.volume.h24 < CONFIG.dexMinVolume24h) {
        return false;
      }
      
      // Проверяем, не отправляли ли уже
      const tokenKey = `${pair.baseToken.address}-${pair.chainId || 'unknown'}`;
      if (sentDexTokens.has(tokenKey)) return false;
      
      return true;
    });
    
    console.log(`✅ Отфильтровано ${filteredTokens.length} новых DEX монет`);
    return filteredTokens.slice(0, 5); // Берем только 5 лучших
    
  } catch (error) {
    console.error('❌ Ошибка DEX скринера:', error.message);
    return [];
  }
}

async function sendDEXTokenToTelegram(token) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен');
    return false;
  }
  
  try {
    // Добавляем в кэш
    const tokenKey = `${token.baseToken.address}-${token.chainId || 'unknown'}`;
    sentDexTokens.add(tokenKey);
    
    // Ограничиваем кэш
    if (sentDexTokens.size > 500) {
      const array = Array.from(sentDexTokens);
      sentDexTokens = new Set(array.slice(-500));
    }
    
    // Форматируем данные
    const chainName = getChainName(token.chainId);
    const chainEmoji = getChainEmoji(token.chainId);
    
    const price = token.priceUsd ? `$${parseFloat(token.priceUsd).toFixed(8)}` : 'N/A';
    const liquidity = token.liquidity?.usd ? `$${(token.liquidity.usd / 1000).toFixed(1)}K` : 'N/A';
    const volume24h = token.volume?.h24 ? `$${(token.volume.h24 / 1000).toFixed(1)}K` : 'N/A';
    
    const createdTime = token.pairCreatedAt ? 
      new Date(token.pairCreatedAt).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }) : 'Неизвестно';
    
    // Ссылка на DEXScreener
    const dexUrl = `https://dexscreener.com/${token.chainId || 'ethereum'}/${token.pairAddress}`;
    
    const message = `
<b>🔥 НОВАЯ DEX МОНЕТА 🔥</b>

${chainEmoji} <b>${token.baseToken?.name || 'Unknown'}</b>
(<code>${token.baseToken?.symbol || '?'}</code>)

📊 <b>Цепь:</b> ${chainName}
💰 <b>Цена:</b> ${price}
💧 <b>Ликвидность:</b> ${liquidity}
📈 <b>Объем 24ч:</b> ${volume24h}

🕐 <b>Создана:</b> ${createdTime}
🔗 <b>DEXScreener:</b> <a href="${dexUrl}">Открыть</a>

⚠️ <i>ВНИМАНИЕ: Высокий риск! DYOR.</i>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { 
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    
    console.log(`✅ DEX токен ${token.baseToken?.symbol} отправлен`);
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка отправки DEX токена:', error.message);
    return false;
  }
}

function getChainName(chainId) {
  const chains = {
    'ethereum': 'Ethereum',
    'bsc': 'BNB Chain',
    'polygon': 'Polygon',
    'arbitrum': 'Arbitrum',
    'optimism': 'Optimism',
    'base': 'Base',
    'solana': 'Solana',
    'avalanche': 'Avalanche',
    'fantom': 'Fantom',
    'cronos': 'Cronos',
    '1': 'Ethereum',
    '56': 'BNB Chain',
    '137': 'Polygon',
    '42161': 'Arbitrum',
    '10': 'Optimism',
    '8453': 'Base'
  };
  
  return chains[chainId] || chainId || 'Unknown';
}

function getChainEmoji(chainId) {
  const emojis = {
    'ethereum': '🔷', '1': '🔷',
    'bsc': '💛', '56': '💛',
    'polygon': '🟣', '137': '🟣',
    'arbitrum': '🔵', '42161': '🔵',
    'optimism': '🔴', '10': '🔴',
    'base': '🔵', '8453': '🔵',
    'solana': '🟣',
    'avalanche': '🔺',
    'fantom': '👻'
  };
  
  return emojis[chainId] || '🔗';
}

// ==================== СУЩЕСТВУЮЩИЕ ФУНКЦИИ (УПРОЩЕННЫЕ) ====================

// Упрощенный расчет индикаторов
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = prices[prices.length - i] - prices[prices.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(prices) {
  // Упрощенный MACD
  if (prices.length < 26) return { histogram: 0 };
  
  const shortPrices = prices.slice(-12);
  const longPrices = prices.slice(-26);
  
  const shortEMA = shortPrices.reduce((a, b) => a + b, 0) / shortPrices.length;
  const longEMA = longPrices.reduce((a, b) => a + b, 0) / longPrices.length;
  
  return { histogram: shortEMA - longEMA };
}

function calculateBollingerBands(prices, period = 20) {
  if (prices.length < period) return { upper: null, middle: null, lower: null };
  
  const recent = prices.slice(-period);
  const sma = recent.reduce((a, b) => a + b, 0) / period;
  
  const variance = recent.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  
  return {
    upper: sma + stdDev * 2,
    middle: sma,
    lower: sma - stdDev * 2
  };
}

// Анализ сигнала (упрощенный)
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
  if (priceHistory.length < 50) return null;
  
  // Индикаторы
  const rsi = calculateRSI(priceHistory);
  const macd = calculateMACD(priceHistory);
  const bb = calculateBollingerBands(priceHistory);
  
  // Подсчет подтверждений
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
  if (macd.histogram > 0) {
    qualityScore += 1;
    confirmations.push('MACD_BULLISH');
  } else if (macd.histogram < 0) {
    qualityScore += 1;
    confirmations.push('MACD_BEARISH');
  }
  
  // Bollinger Bands
  if (price < bb.lower) {
    qualityScore += 2;
    confirmations.push('BB_OVERSOLD');
  } else if (price > bb.upper) {
    qualityScore += 2;
    confirmations.push('BB_OVERBOUGHT');
  }
  
  // Минимальные требования
  if (qualityScore < CONFIG.minQualityScore) return null;
  if (confirmations.length < CONFIG.minConfirmations) return null;
  
  // Определение сигнала
  let signal = null;
  let confidence = 50;
  
  if (rsi < 35 && macd.histogram > 0) {
    signal = 'LONG';
    confidence = Math.min(60 + (35 - rsi) * 2 + confirmations.length * 5, 90);
  } else if (rsi > 65 && macd.histogram < 0) {
    signal = 'SHORT';
    confidence = Math.min(60 + (rsi - 65) * 2 + confirmations.length * 5, 90);
  }
  
  if (!signal || confidence < CONFIG.minConfidence) return null;
  
  // Расчет цен
  const entry = price;
  const priceChange = price * 0.02; // 2% для стопа
  
  let sl, tp, rrRatio;
  
  if (signal === 'LONG') {
    sl = entry - priceChange;
    tp = entry + priceChange * CONFIG.minRRRatio;
    rrRatio = (tp - entry) / (entry - sl);
  } else {
    sl = entry + priceChange;
    tp = entry - priceChange * CONFIG.minRRRatio;
    rrRatio = (entry - tp) / (sl - entry);
  }
  
  if (rrRatio < CONFIG.minRRRatio) return null;
  
  return {
    pair: `${coin.symbol.toUpperCase()}/USDT`,
    signal,
    entry: parseFloat(entry.toFixed(6)),
    tp: parseFloat(tp.toFixed(6)),
    sl: parseFloat(sl.toFixed(6)),
    confidence: Math.round(confidence),
    qualityScore,
    rrRatio: parseFloat(rrRatio.toFixed(2)),
    tier: confidence > 75 ? 'PREMIUM' : 'STANDARD',
    exchange: 'BINANCE',
    indicators: {
      rsi: Math.round(rsi),
    },
    confirmations,
    timestamp: new Date()
  };
}

// Получение данных с CoinGecko
async function fetchMarketData() {
  try {
    const url = `${CONFIG.apiUrl}/coins/markets?vs_currency=usd&order=volume_desc&per_page=${CONFIG.topCoins}&page=1&sparkline=true`;
    
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    };
    
    if (COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = COINGECKO_API_KEY;
    }
    
    console.log('📡 Запрос к CoinGecko API...');
    const response = await axios.get(url, { headers, timeout: 15000 });
    
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
  console.log('🔍 Генерация сигналов...');
  
  const marketData = await fetchMarketData();
  
  if (!marketData || marketData.length === 0) {
    console.log('❌ Не удалось получить данные рынка.');
    return [];
  }
  
  const signals = marketData
    .filter(coin => !STABLECOINS.includes(coin.symbol.toLowerCase()))
    .map(coin => {
      const priceHistory = coin.sparkline_in_7d?.price;
      
      if (!priceHistory || priceHistory.length < 50) {
        return null;
      }
      
      return analyzeSignal(coin, priceHistory);
    })
    .filter(signal => signal !== null)
    .sort((a, b) => b.confidence - a.confidence);
    
  console.log(`✅ Сгенерировано ${signals.length} сигналов.`);
  return signals;
}

// Отправка сигнала в Telegram
async function sendSignalToTelegram(signal) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. Сигнал не отправлен.');
    return false;
  }
  
  try {
    const directionEmoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    
    const timestamp = signal.timestamp.toLocaleString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const message = `
<b>📈 ТОРГОВЫЙ СИГНАЛ</b>

${directionEmoji} <b>${signal.signal} ${signal.pair}</b>

💵 <b>Entry:</b> ${signal.entry.toFixed(4)}
🎯 <b>Take Profit:</b> ${signal.tp.toFixed(4)}
🛑 <b>Stop Loss:</b> ${signal.sl.toFixed(4)}

📊 <b>Confidence:</b> ${signal.confidence}%
🎲 <b>R:R Ratio:</b> 1:${signal.rrRatio.toFixed(1)}

📉 <b>RSI:</b> ${signal.indicators.rsi}
🔍 <b>Confirmations:</b> ${signal.confirmations.join(', ')}

🏦 <b>Exchange:</b> ${signal.exchange}
⏱ <b>${timestamp}</b>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Сигнал ${signal.pair} отправлен`);
    return true;
  } catch (error) {
    console.error('❌ Ошибка отправки сигнала:', error.message);
    return false;
  }
}

// ==================== CRON ЗАДАЧИ ====================

async function runCEXSignalsTask() {
  console.log('\n🔄 Запуск CEX задачи...');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️ Сигналов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${Math.min(signals.length, 3)} сигналов...`);
    
    // Отправляем максимум 3 сигнала
    for (const signal of signals.slice(0, 3)) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    console.log('✅ CEX задача завершена\n');
  } catch (error) {
    console.error('❌ Ошибка в CEX задаче:', error.message);
  }
}

async function runDEXScannerTask() {
  console.log('\n🔍 Запуск DEX сканера...');
  console.log(`⏰ ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const newTokens = await scanNewDEXTokens();
    
    if (newTokens.length === 0) {
      console.log('ℹ️ Новых DEX токенов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${Math.min(newTokens.length, 2)} DEX токенов...`);
    
    // Отправляем максимум 2 токена
    for (const token of newTokens.slice(0, 2)) {
      await sendDEXTokenToTelegram(token);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('✅ DEX сканер завершен\n');
  } catch (error) {
    console.error('❌ Ошибка в DEX сканере:', error.message);
  }
}

// ==================== ЗАПУСК ====================
async function start() {
  try {
    // Удаляем webhook
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    // Запускаем бота
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    // Планируем CRON задачи
    // CEX сигналы каждые 10 минут
    cron.schedule('*/10 * * * *', runCEXSignalsTask);
    console.log('✅ CEX задача запланирована (каждые 10 минут)');
    
    // DEX сканер каждые 30 минут
    cron.schedule('*/30 * * * *', runDEXScannerTask);
    console.log('✅ DEX задача запланирована (каждые 30 минут)');
    
    // Первый запуск
    console.log('⏳ Первый запуск через 10 секунд...\n');
    
    setTimeout(async () => {
      await runCEXSignalsTask();
      setTimeout(runDEXScannerTask, 5000);
    }, 10000);
    
  } catch (error) {
    console.error('❌ Ошибка запуска:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Запуск
start();
