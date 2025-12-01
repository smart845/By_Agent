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

// ==================== НАСТРОЙКИ ТОРГОВЛИ (УЖЕСТОЧЕННЫЕ) ====================
const CONFIG = {
  // CoinGecko API
  apiUrl: 'https://api.coingecko.com/api/v3',
  topCoins: 250,
  
  // DEX Screener настройки
  dexMinLiquidity: 100000,          // Минимальная ликвидность $100K
  dexMaxAgeHours: 2,                // Максимальный возраст монеты (2 часа)
  dexMinVolume24h: 50000,           // Минимальный объем 24ч $50K
  
  // Фильтры CEX
  minVolume: 50000000,
  minMarketCap: 500000000,
  minConfidence: 65,
  minQualityScore: 7,
  minRRRatio: 3.5,
  minConfirmations: 3,
  
  // Критерии уровней
  godTier: {
    qualityScore: 9,
    confidence: 85,
    rrRatio: 4.5
  },
  premium: {
    qualityScore: 7,
    confidence: 65,
    rrRatio: 3.5
  }
};

// ==================== ИСКЛЮЧЕНИЯ ====================
const STABLECOINS = ['usdt', 'usdc', 'usdc.e','dai', 'busd', 'tusd', 'usdp', 'frax', 'ustc', 'eurs'];
const DEX_BLACKLIST_PAIRS = ['weth', 'wbnb', 'wmatic', 'wavax']; // Пропускаем пары с нативными токенами

// ==================== КЭШ ДЛЯ УЖЕ ОТПРАВЛЕННЫХ DEX МОНЕТ ====================
let sentDexTokens = new Set(); // Храним уже отправленные токены

// ==================== TELEGRAM BOT ====================
const bot = new Telegraf(BOT_TOKEN);

// Команда /start
bot.start((ctx) => {
  const chatId = ctx.chat.id;
  const username = ctx.chat.username ? `@${ctx.chat.username}` : 'Нет username';
  const firstName = ctx.chat.first_name || 'Пользователь';
  
  console.log(`💬 /start от chat ID: ${chatId}, User: ${firstName} ${username}`);
  
  ctx.reply(
    `🤖 Добро пожаловать в Crypto Signals Bot 2.0!\n\n` +
    `📊 Ваш Chat ID: <code>${chatId}</code>\n` +
    `👤 Пользователь: ${firstName} ${username}\n\n` +
    `🔄 Функции бота:\n` +
    `• 📈 Сигналы CEX каждые 10 минут\n` +
    `• 🔥 Новые DEX монеты каждые 5 минут\n` +
    `• 🎯 Тех анализ + фильтр качества\n\n` +
    `💡 Используйте этот Chat ID в переменных окружения:\n` +
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
    `Установите его в переменные окружения на Render:\n` +
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
      ema100: 44000
    },
    confirmations: ['RSI_OVERSOLD', 'MACD_BULLISH', 'BB_OVERSOLD', 'EMA_BULLISH_ALIGNMENT', 'HIGH_VOLUME'],
    liquidityZoneUsed: true,
    timestamp: new Date()
  };
  
  await sendSignalToTelegram(testSignal);
  ctx.reply('✅ Тестовый сигнал отправлен!');
});

// НОВАЯ КОМАНДА: /dex - проверить новые DEX монеты вручную
bot.command('dex', async (ctx) => {
  console.log('🔍 Ручной запуск DEX скринера...');
  ctx.reply('🔍 Ищу новые DEX монеты...');
  
  const newTokens = await scanNewDEXTokens();
  
  if (newTokens.length === 0) {
    ctx.reply('ℹ️ Новых DEX монет не найдено');
  } else {
    ctx.reply(`✅ Найдено ${newTokens.length} новых DEX монет. Отправляю в чат...`);
    
    for (const token of newTokens) {
      await sendDEXTokenToTelegram(token);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Задержка 1 сек
    }
  }
});

// ==================== DEX SCREENER ФУНКЦИИ ====================

// Получить новые токены с DEX
async function scanNewDEXTokens() {
  try {
    console.log('🔍 Сканирую новые DEX монеты...');
    
    // Ищем новые пары на популярных DEX
    const chains = [
      'ethereum',
      'bsc',
      'polygon',
      'arbitrum',
      'optimism',
      'base',
      'solana'
    ];
    
    const allTokens = [];
    
    // Проверяем несколько популярных DEX на каждой цепи
    for (const chain of chains) {
      try {
        const response = await axios.get(`${DEXSCREENER_API_URL}/tokens/${chain}/new`, {
          timeout: 10000
        });
        
        if (response.data && response.data.pairs) {
          const filteredTokens = response.data.pairs.filter(pair => {
            // Фильтры для DEX пар
            const now = Date.now();
            const pairCreatedAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).getTime() : now;
            const ageHours = (now - pairCreatedAt) / (1000 * 60 * 60);
            
            // Пропускаем слишком старые
            if (ageHours > CONFIG.dexMaxAgeHours) return false;
            
            // Пропускаем пары с низкой ликвидностью
            if (pair.liquidity && pair.liquidity.usd < CONFIG.dexMinLiquidity) return false;
            
            // Пропускаем пары с низким объемом
            if (pair.volume && pair.volume.h24 < CONFIG.dexMinVolume24h) return false;
            
            // Пропускаем пары с нативными токенами
            const baseTokenSymbol = pair.baseToken ? pair.baseToken.symbol.toLowerCase() : '';
            const quoteTokenSymbol = pair.quoteToken ? pair.quoteToken.symbol.toLowerCase() : '';
            
            if (DEX_BLACKLIST_PAIRS.some(token => 
              baseTokenSymbol.includes(token) || quoteTokenSymbol.includes(token))) {
              return false;
            }
            
            // Пропускаем стейблкоины
            if (STABLECOINS.includes(baseTokenSymbol) || STABLECOINS.includes(quoteTokenSymbol)) {
              return false;
            }
            
            // Пропускаем уже отправленные токены
            const tokenKey = `${pair.baseToken.address}-${pair.chainId}`;
            if (sentDexTokens.has(tokenKey)) return false;
            
            return true;
          });
          
          allTokens.push(...filteredTokens.slice(0, 5)); // Берем максимум 5 с каждой цепи
        }
        
        await new Promise(resolve => setTimeout(resolve, 500)); // Задержка между запросами
        
      } catch (error) {
        console.log(`⚠️ Ошибка при сканировании цепи ${chain}:`, error.message);
      }
    }
    
    console.log(`✅ Найдено ${allTokens.length} новых DEX монет`);
    return allTokens;
    
  } catch (error) {
    console.error('❌ Ошибка DEX скринера:', error.message);
    return [];
  }
}

// Отправить информацию о DEX токене в Telegram
async function sendDEXTokenToTelegram(token) {
  if (!CHAT_ID) {
    console.log('⚠️ CHAT_ID не установлен. DEX токен не отправлен.');
    return false;
  }
  
  try {
    // Добавляем в кэш отправленных токенов
    const tokenKey = `${token.baseToken.address}-${token.chainId}`;
    sentDexTokens.add(tokenKey);
    
    // Ограничиваем размер кэша (храним последние 1000)
    if (sentDexTokens.size > 1000) {
      const array = Array.from(sentDexTokens);
      sentDexTokens = new Set(array.slice(-1000));
    }
    
    // Определяем эмодзи для цепи
    const chainEmoji = getChainEmoji(token.chainId);
    
    // Форматируем время создания
    const createdTime = token.pairCreatedAt ? 
      new Date(token.pairCreatedAt).toLocaleString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit'
      }) : 'Неизвестно';
    
    // Форматируем цены
    const price = token.priceUsd ? parseFloat(token.priceUsd).toFixed(8) : 'N/A';
    const liquidity = token.liquidity ? `$${(token.liquidity.usd / 1000).toFixed(1)}K` : 'N/A';
    const volume24h = token.volume ? `$${(token.volume.h24 / 1000).toFixed(1)}K` : 'N/A';
    
    // Ссылка на DEXScreener
    const dexscreenerUrl = token.url ? token.url : `https://dexscreener.com/${token.chainId}/${token.pairAddress}`;
    
    // Ссылка на покупку (DEX)
    const buyLinks = generateBuyLinks(token);
    
    const message = `
<b>🔥 НОВАЯ DEX МОНЕТА 🔥</b>

${chainEmoji} <b>${token.baseToken?.name || 'Unknown'} (${token.baseToken?.symbol || '?'})</b>
📊 <b>Цепь:</b> ${getChainName(token.chainId)}

💰 <b>Цена:</b> $${price}
💧 <b>Ликвидность:</b> ${liquidity}
📈 <b>Объем 24ч:</b> ${volume24h}

🕐 <b>Создана:</b> ${createdTime}
👨‍💼 <b>Создатель:</b> ${token.txns ? token.txns.m5.buys || 0 : 0} покупок / ${token.txns ? token.txns.m5.sells || 0 : 0} продаж (5м)

🔗 <b>Ссылки:</b>
• <a href="${dexscreenerUrl}">DEXScreener</a>
${buyLinks}

⚠️ <i>ВНИМАНИЕ: DEX монеты - высокорисковые активы. Делайте свои исследования (DYOR).</i>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { 
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    
    console.log(`✅ DEX токен ${token.baseToken?.symbol || 'Unknown'} отправлен в Telegram`);
    return true;
    
  } catch (error) {
    console.error('❌ Ошибка отправки DEX токена:', error.message);
    return false;
  }
}

// Получить название цепи по chainId
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
    'fantom': 'Fantom'
  };
  
  return chains[chainId] || chainId || 'Unknown';
}

// Получить эмодзи для цепи
function getChainEmoji(chainId) {
  const emojis = {
    'ethereum': '🔷',
    'bsc': '💛',
    'polygon': '🟣',
    'arbitrum': '🔵',
    'optimism': '🔴',
    'base': '🔵',
    'solana': '🟣',
    'avalanche': '🔺',
    'fantom': '👻'
  };
  
  return emojis[chainId] || '🔗';
}

// Генерация ссылок для покупки
function generateBuyLinks(token) {
  const links = [];
  const chain = token.chainId;
  const contract = token.baseToken?.address;
  
  if (!contract) return '• Не доступно';
  
  // Uniswap для Ethereum
  if (chain === 'ethereum') {
    links.push(`• <a href="https://app.uniswap.org/#/swap?chain=mainnet&outputCurrency=${contract}">Uniswap</a>`);
  }
  
  // PancakeSwap для BSC
  if (chain === 'bsc') {
    links.push(`• <a href="https://pancakeswap.finance/swap?outputCurrency=${contract}">PancakeSwap</a>`);
  }
  
  // Quickswap для Polygon
  if (chain === 'polygon') {
    links.push(`• <a href="https://quickswap.exchange/#/swap?outputCurrency=${contract}">QuickSwap</a>`);
  }
  
  // Raydium для Solana (нужен другой формат)
  if (chain === 'solana') {
    links.push(`• <a href="https://raydium.io/swap/?inputCurrency=sol&outputCurrency=${contract}">Raydium</a>`);
  }
  
  // Добавляем ссылку на дедуст если есть
  if (token.baseToken?.socials?.twitter) {
    links.push(`• <a href="https://twitter.com/${token.baseToken.socials.twitter}">Twitter</a>`);
  }
  
  if (token.baseToken?.socials?.website) {
    links.push(`• <a href="${token.baseToken.socials.website}">Website</a>`);
  }
  
  return links.join('\n') || '• Не доступно';
}

// ==================== ФУНКЦИИ СИГНАЛОВ (СУЩЕСТВУЮЩИЕ - БЕЗ ИЗМЕНЕНИЙ) ====================

// [ВСЕ СУЩЕСТВУЮЩИЕ ФУНКЦИИ ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ]
// calculateSMA, calculateEMA, calculateRSI, calculateMACD, calculateBollingerBands,
// calculateVolatility, calculateStochastic, calculateATR, calculateADX,
// findLiquidityZones, findNearestLiquidityZone, generateTraderComment,
// analyzeSignal, fetchMarketData, generateSignals, sendSignalToTelegram
// ... (все существующие функции остаются без изменений)

// ==================== CRON ЗАДАЧИ ====================

// Существующая задача для CEX сигналов
async function runCEXSignalsTask() {
  console.log('\n🔄 === ЗАПУСК CEX ЗАДАЧИ ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const signals = await generateSignals();
    
    if (signals.length === 0) {
      console.log('ℹ️  CEX сигналов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${signals.length} CEX сигналов...`);
    
    for (const signal of signals) {
      await sendSignalToTelegram(signal);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('✅ CEX задача завершена\n');
  } catch (error) {
    console.error('❌ Ошибка в CEX задаче:', error.message);
  }
}

// НОВАЯ задача для DEX скрининга
async function runDEXScannerTask() {
  console.log('\n🔍 === ЗАПУСК DEX СКАНЕРА ===');
  console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
  
  try {
    const newTokens = await scanNewDEXTokens();
    
    if (newTokens.length === 0) {
      console.log('ℹ️  Новых DEX токенов не найдено');
      return;
    }
    
    console.log(`📤 Отправка ${newTokens.length} новых DEX токенов...`);
    
    // Отправляем максимум 3 токена за раз, чтобы не спамить
    const tokensToSend = newTokens.slice(0, 3);
    
    for (const token of tokensToSend) {
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
    // Удаляем webhook и запускаем long polling
    await bot.telegram.deleteWebhook();
    console.log('✅ Webhook удален');
    
    // Получаем информацию о боте
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Бот подключен: @${botInfo.username}`);
    
    // Запускаем бота
    bot.launch();
    console.log('✅ Бот запущен (long polling)');
    
    // Планируем CRON задачи:
    
    // 1. CEX сигналы каждые 10 минут
    cron.schedule('*/10 * * * *', runCEXSignalsTask);
    console.log('✅ CRON задача CEX запланирована (каждые 10 минут)');
    
    // 2. DEX сканер каждые 5 минут
    cron.schedule('*/5 * * * *', runDEXScannerTask);
    console.log('✅ CRON задача DEX запланирована (каждые 5 минут)');
    
    // Первый запуск через 15 секунд
    console.log('⏳ Первый запуск через 15 секунд...\n');
    
    setTimeout(() => {
      runCEXSignalsTask();
      setTimeout(runDEXScannerTask, 5000); // DEX через 5 секунд после CEX
    }, 15000);
    
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
