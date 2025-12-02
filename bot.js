import { Telegraf } from 'telegraf';
import axios from 'axios';
import cron from 'node-cron';
import { HttpsProxyAgent } from 'https-proxy-agent';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🔍 Проверка переменных окружения:');
console.log('TELEGRAM_BOT_TOKEN:', BOT_TOKEN ? '✅ Установлен' : '❌ НЕ установлен');
console.log('TELEGRAM_CHAT_ID:', CHAT_ID ? `✅ Установлен (${CHAT_ID})` : '❌ НЕ установлен');

if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN не установлен!');
  process.exit(1);
}

// ==================== КОНФИГУРАЦИЯ ====================
const CONFIG = {
  // Ваш прокси только для Bybit запросов
  BYBIT_PROXY: 'http://14db7c2b55cdd:4693eb6dd0@141.226.244.38:12323',
  
  // Альтернативные API эндпоинты
  apiEndpoints: [
    'https://api.bytick.com',  // Основной - альтернативный домен
    'https://api.bybit.com'    // Запасной
  ],
  currentEndpointIndex: 0,
  
  // Настройки сканирования
  category: 'spot',
  timeframe: '15',
  topGainers: 20,
  topLosers: 20,
  min24hVolume: 50000,      // 50K USDT (уменьшено)
  stopLossPercent: 2.0,
  takeProfitPercent: 4.0,
  minRRRatio: 2.0,          // 1:2
  minConfidence: 50,        // 50%
  minConfirmations: 2,
  
  // Настройки запросов
  retryAttempts: 2,
  retryDelay: 3000
};

// Создаем прокси агент только для Bybit запросов
let bybitProxyAgent = null;
try {
  bybitProxyAgent = new HttpsProxyAgent(CONFIG.BYBIT_PROXY);
  console.log('✅ Прокси агент для Bybit создан');
} catch (error) {
  console.error('❌ Ошибка создания прокси агента:', error.message);
  console.log('⚠️  Будет использоваться прямое подключение к Bybit');
}

// ==================== УТИЛИТЫ ====================
function getCurrentEndpoint() {
  return CONFIG.apiEndpoints[CONFIG.currentEndpointIndex];
}

function rotateEndpoint() {
  CONFIG.currentEndpointIndex = (CONFIG.currentEndpointIndex + 1) % CONFIG.apiEndpoints.length;
  console.log(`🔄 Смена API endpoint на: ${getCurrentEndpoint()}`);
  return getCurrentEndpoint();
}

// Функция для запросов к Bybit (через прокси)
async function makeBybitRequest(url, params = {}) {
  const endpointsToTry = [...CONFIG.apiEndpoints];
  
  for (let endpoint of endpointsToTry) {
    try {
      const fullUrl = `${endpoint}${url}`;
      console.log(`📡 Запрос к Bybit: ${fullUrl}`);
      
      const config = {
        params,
        timeout: 15000,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      };
      
      // Пробуем с прокси, если он доступен
      if (bybitProxyAgent) {
        config.httpsAgent = bybitProxyAgent;
        config.httpAgent = bybitProxyAgent;
        console.log('🌐 Используется прокси для Bybit');
      } else {
        console.log('🌐 Прямое подключение к Bybit');
      }
      
      const response = await axios.get(fullUrl, config);
      
      if (response.data?.retCode === 0) {
        console.log(`✅ Успешный запрос к ${endpoint}`);
        return response.data;
      } else {
        console.log(`⚠️ Endpoint ${endpoint} вернул ошибку: ${response.data?.retMsg}`);
      }
      
    } catch (error) {
      console.error(`❌ Ошибка запроса к ${endpoint}:`, error.message);
      // Пробуем следующий endpoint
    }
    
    // Задержка перед следующей попыткой
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error('Не удалось подключиться к Bybit через все endpoints');
}

// ==================== ТЕЛЕГРАМ БОТ ====================
const bot = new Telegraf(BOT_TOKEN, {
  telegram: {
    // Явно отключаем прокси для Telegram
    agent: null,
    webhookReply: false
  }
});

// Включаем подробное логирование для отладки
bot.use(async (ctx, next) => {
  const start = Date.now();
  console.log(`📱 Получено обновление:`, ctx.updateType);
  
  if (ctx.message) {
    console.log(`   От: ${ctx.from?.id} (${ctx.from?.username || 'нет username'})`);
    console.log(`   Команда: ${ctx.message.text}`);
  }
  
  await next();
  
  const responseTime = Date.now() - start;
  console.log(`   ⏱️  Время обработки: ${responseTime}ms`);
});

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  console.log('✅ Обработка команды /start');
  const welcomeMessage = `🤖 <b>Bybit Scalper Bot</b>

✅ <b>Бот активен и готов к работе!</b>

📊 <b>Параметры сканирования:</b>
• Топ 20 растущих/падающих пар
• Минимальный объем: ${(CONFIG.min24hVolume / 1000).toFixed(0)}K USDT
• R:R соотношение: 1:${CONFIG.minRRRatio}
• Минимум подтверждений: ${CONFIG.minConfirmations}

🌐 <b>Статус подключения:</b>
• Bybit API: ${bybitProxyAgent ? 'через прокси' : 'прямое'}
• Telegram: прямое подключение

⏰ <b>Расписание:</b>
Автоматическое сканирование каждые 30 минут

📱 <b>Доступные команды:</b>
/start - это сообщение
/test - проверить подключение
/scan - ручное сканирование
/status - статус бота
/proxy - информация о прокси`;

  ctx.reply(welcomeMessage, { parse_mode: 'HTML' })
    .then(() => console.log('✅ Сообщение /start отправлено'))
    .catch(err => console.error('❌ Ошибка отправки:', err.message));
});

bot.command('test', async (ctx) => {
  console.log('✅ Обработка команды /test');
  try {
    await ctx.reply('🧪 Тестирую подключения...');
    
    // Проверяем Telegram
    await ctx.reply('✅ Telegram API: OK');
    
    // Проверяем Bybit
    try {
      const testData = await makeBybitRequest('/v5/market/tickers', {
        category: 'spot',
        limit: 2
      });
      
      if (testData.retCode === 0) {
        const pairs = testData.result?.list?.length || 0;
        await ctx.reply(`✅ Bybit API: OK (${pairs} пар получено)`);
        
        if (testData.result.list && testData.result.list.length > 0) {
          const pair = testData.result.list[0];
          await ctx.reply(
            `📊 Пример пары:\n` +
            `${pair.symbol}: $${pair.lastPrice}\n` +
            `Изменение: ${(pair.price24hPcnt * 100).toFixed(2)}%`
          );
        }
      } else {
        await ctx.reply(`⚠️ Bybit API: ${testData.retMsg}`);
      }
    } catch (error) {
      await ctx.reply(`❌ Bybit API: ${error.message}`);
    }
    
    await ctx.reply('✅ Тестирование завершено!');
    
  } catch (error) {
    console.error('❌ Ошибка команды /test:', error);
    ctx.reply(`❌ Ошибка: ${error.message}`)
      .catch(err => console.error('Не удалось отправить сообщение об ошибке:', err));
  }
});

bot.command('status', (ctx) => {
  console.log('✅ Обработка команды /status');
  const now = new Date();
  const nextScan = 30 - (now.getMinutes() % 30);
  
  ctx.reply(
    `📊 <b>Статус бота</b>\n\n` +
    `🟢 <b>Состояние:</b> Активен\n` +
    `📡 <b>Bybit подключение:</b> ${bybitProxyAgent ? 'через прокси' : 'прямое'}\n` +
    `🎯 <b>Следующее сканирование:</b> через ${nextScan} мин\n` +
    `⏰ <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}\n\n` +
    `📈 <b>Параметры:</b>\n` +
    `• Объем > ${(CONFIG.min24hVolume/1000).toFixed(0)}K USDT\n` +
    `• Min R:R: 1:${CONFIG.minRRRatio}\n` +
    `• Min Confidence: ${CONFIG.minConfidence}%`,
    { parse_mode: 'HTML' }
  ).catch(err => console.error('Ошибка отправки статуса:', err));
});

bot.command('proxy', (ctx) => {
  console.log('✅ Обработка команды /proxy');
  
  const proxyStatus = bybitProxyAgent ? 
    `✅ <b>Прокси активен для Bybit</b>\n` +
    `IP: 141.226.244.38\n` +
    `Порт: 12323\n` +
    `Telegram: прямое подключение` :
    `⚠️ <b>Прокси не используется</b>\n` +
    `Все подключения прямые`;
  
  ctx.reply(
    `🌐 <b>Сетевые настройки</b>\n\n` +
    proxyStatus + `\n\n` +
    `📡 <b>Bybit Endpoints:</b>\n` +
    CONFIG.apiEndpoints.map(e => `• ${e}`).join('\n') + `\n\n` +
    `🔄 <b>Текущий:</b> ${getCurrentEndpoint()}`,
    { parse_mode: 'HTML' }
  ).catch(err => console.error('Ошибка отправки информации о прокси:', err));
});

bot.command('scan', async (ctx) => {
  console.log('✅ Обработка команды /scan');
  try {
    await ctx.reply('🔍 Запускаю ручное сканирование...');
    runSignalsTask(true, ctx);
  } catch (error) {
    console.error('❌ Ошибка команды /scan:', error);
    ctx.reply(`❌ Ошибка: ${error.message}`)
      .catch(err => console.error('Не удалось отправить ошибку:', err));
  }
});

// Команда для отладки - проверяет что бот получает сообщения
bot.on('text', (ctx) => {
  const text = ctx.message.text;
  if (!text.startsWith('/')) {
    console.log(`📱 Получен текст: "${text}"`);
    ctx.reply(`Получено: "${text}"\nИспользуйте /start для списка команд`)
      .catch(err => console.error('Ошибка ответа:', err));
  }
});

// ==================== ИНДИКАТОРЫ (упрощенные) ====================
function calculateRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[prices.length - i] - prices[prices.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
  if (!prices || prices.length < 26) return { histogram: 0 };
  // Упрощенный расчет MACD
  const shortEMA = prices.slice(-12).reduce((a, b) => a + b, 0) / 12;
  const longEMA = prices.slice(-26).reduce((a, b) => a + b, 0) / 26;
  const macdLine = shortEMA - longEMA;
  const signal = prices.slice(-9).reduce((a, b) => a + b, 0) / 9;
  return { histogram: macdLine - signal };
}

function calculateStochastic(highs, lows, closes) {
  if (!highs || highs.length < 14) return { k: 50 };
  const period = 14;
  const recentHigh = Math.max(...highs.slice(-period));
  const recentLow = Math.min(...lows.slice(-period));
  const currentClose = closes[closes.length - 1];
  if (recentHigh === recentLow) return { k: 50 };
  const k = ((currentClose - recentLow) / (recentHigh - recentLow)) * 100;
  return { k };
}

// ==================== АНАЛИЗ СИГНАЛА ====================
async function analyzeSignal(pair) {
  try {
    console.log(`🔍 Анализ: ${pair.symbol}`);
    
    // Простой анализ без сложных индикаторов
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const candleResponse = await makeBybitRequest('/v5/market/kline', {
      category: CONFIG.category,
      symbol: pair.symbol,
      interval: CONFIG.timeframe,
      limit: 50
    });
    
    if (!candleResponse.result?.list || candleResponse.result.list.length < 20) {
      return null;
    }
    
    const candles = candleResponse.result.list;
    const closes = candles.map(c => parseFloat(c[4])).reverse();
    const highs = candles.map(c => parseFloat(c[2])).reverse();
    const lows = candles.map(c => parseFloat(c[3])).reverse();
    
    const currentPrice = closes[closes.length - 1];
    const rsi = calculateRSI(closes);
    const macd = calculateMACD(closes);
    const stoch = calculateStochastic(highs, lows, closes);
    
    // Простая логика
    const confirmations = [];
    if (rsi < 35) confirmations.push('RSI_OVERSOLD');
    if (rsi > 65) confirmations.push('RSI_OVERBOUGHT');
    if (macd.histogram > 0) confirmations.push('MACD_BULLISH');
    if (macd.histogram < 0) confirmations.push('MACD_BEARISH');
    if (stoch.k < 25) confirmations.push('STOCH_OVERSOLD');
    if (stoch.k > 75) confirmations.push('STOCH_OVERBOUGHT');
    
    if (confirmations.length < 2) return null;
    
    let signal = null;
    let confidence = 50;
    
    const bullishCount = confirmations.filter(c => 
      c.includes('OVERSOLD') || c.includes('BULLISH')
    ).length;
    
    const bearishCount = confirmations.filter(c => 
      c.includes('OVERBOUGHT') || c.includes('BEARISH')
    ).length;
    
    if (bullishCount >= 2 && pair.change > -10) {
      signal = 'LONG';
      confidence = 60 + bullishCount * 5;
    } else if (bearishCount >= 2 && pair.change < 10) {
      signal = 'SHORT';
      confidence = 60 + bearishCount * 5;
    }
    
    if (!signal || confidence < CONFIG.minConfidence) return null;
    
    // Уровни
    const entry = currentPrice;
    let sl, tp;
    
    if (signal === 'LONG') {
      sl = entry * 0.98; // -2%
      tp = entry * 1.04; // +4%
    } else {
      sl = entry * 1.02; // +2%
      tp = entry * 0.96; // -4%
    }
    
    const rrRatio = signal === 'LONG' ? 
      (tp - entry) / (entry - sl) : 
      (entry - tp) / (sl - entry);
    
    if (rrRatio < CONFIG.minRRRatio) return null;
    
    console.log(`✅ СИГНАЛ: ${signal} ${pair.symbol} (${confidence}%)`);
    
    return {
      pair: pair.symbol.replace('USDT', '/USDT'),
      signal,
      entry: entry.toFixed(6),
      tp: tp.toFixed(6),
      sl: sl.toFixed(6),
      confidence,
      rrRatio: rrRatio.toFixed(1),
      tier: confidence >= 70 ? 'GOD TIER' : 'PREMIUM',
      change24h: pair.change.toFixed(2),
      volume24h: pair.volume,
      indicators: { rsi: Math.round(rsi), stoch_k: stoch.k.toFixed(0) },
      confirmations,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== ПОЛУЧЕНИЕ ДАННЫХ ====================
async function getTopMovers() {
  try {
    console.log('📡 Получение данных с Bybit...');
    
    const response = await makeBybitRequest('/v5/market/tickers', {
      category: CONFIG.category
    });
    
    if (!response.result?.list) {
      console.log('❌ Нет данных от Bybit');
      return [];
    }
    
    const usdtPairs = response.result.list
      .filter(pair => pair.symbol.endsWith('USDT'))
      .filter(pair => !pair.symbol.includes('UP') && !pair.symbol.includes('DOWN'))
      .filter(pair => parseFloat(pair.turnover24h) >= CONFIG.min24hVolume)
      .map(pair => ({
        symbol: pair.symbol,
        change: (parseFloat(pair.price24hPcnt) || 0) * 100,
        volume: parseFloat(pair.turnover24h) || 0,
        price: parseFloat(pair.lastPrice) || 0
      }));
    
    console.log(`✅ Получено ${usdtPairs.length} пар`);
    
    const sorted = usdtPairs.sort((a, b) => b.change - a.change);
    return [
      ...sorted.slice(0, CONFIG.topGainers),
      ...sorted.slice(-CONFIG.topLosers).reverse()
    ];
    
  } catch (error) {
    console.error('❌ Ошибка получения данных:', error.message);
    return [];
  }
}

// ==================== ОСНОВНАЯ ЗАДАЧА ====================
async function runSignalsTask(isManual = false, ctx = null) {
  console.log('\n🎯 ' + (isManual ? 'РУЧНОЕ' : 'АВТО') + ' СКАНИРОВАНИЕ');
  console.log('='.repeat(50));
  
  try {
    const pairs = await getTopMovers();
    
    if (pairs.length === 0) {
      console.log('ℹ️  Нет пар для анализа');
      if (isManual && ctx) {
        ctx.reply('ℹ️  Нет данных от Bybit для анализа')
          .catch(err => console.error('Ошибка отправки:', err));
      }
      return;
    }
    
    console.log(`📊 Анализ ${pairs.length} пар...`);
    
    const signals = [];
    for (let i = 0; i < Math.min(pairs.length, 10); i++) {
      const signal = await analyzeSignal(pairs[i]);
      if (signal) signals.push(signal);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    console.log(`📊 Найдено ${signals.length} сигналов`);
    
    if (signals.length === 0) {
      if (isManual && ctx) {
        ctx.reply('ℹ️  Сигналов не найдено в этом сканировании')
          .catch(err => console.error('Ошибка отправки:', err));
      }
      return;
    }
    
    // Отправляем сигналы
    for (const signal of signals) {
      const message = `
${signal.tier === 'GOD TIER' ? '👑' : '💎'} <b>${signal.tier}</b>
${signal.signal === 'LONG' ? '🟢' : '🔴'} <b>${signal.signal} ${signal.pair}</b>

📈 Изменение: ${signal.change24h}%
💰 Объем: $${(signal.volume24h / 1000).toFixed(0)}K

🎯 Вход: ${signal.entry}
✅ Тейк: ${signal.tp}
🛑 Стоп: ${signal.sl}

📊 R:R: 1:${signal.rrRatio}
🔮 Уверенность: ${signal.confidence}%

⏰ ${signal.timestamp.toLocaleTimeString('ru-RU', {hour: '2-digit', minute:'2-digit'})}
      `.trim();
      
      if (CHAT_ID) {
        await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' })
          .catch(err => console.error('Ошибка отправки сигнала:', err));
      }
      
      if (isManual && ctx && signal.tier === 'GOD TIER') {
        ctx.reply(message, { parse_mode: 'HTML' })
          .catch(err => console.error('Ошибка отправки:', err));
      }
      
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    if (isManual && ctx) {
      ctx.reply(`✅ Сканирование завершено. Найдено ${signals.length} сигналов`)
        .catch(err => console.error('Ошибка отправки:', err));
    }
    
  } catch (error) {
    console.error('❌ Ошибка сканирования:', error);
    if (isManual && ctx) {
      ctx.reply(`❌ Ошибка: ${error.message}`)
        .catch(err => console.error('Ошибка отправки ошибки:', err));
    }
  }
}

// ==================== ЗАПУСК БОТА ====================
async function start() {
  try {
    console.log('\n🚀 ЗАПУСК BYBIT SCALPER BOT');
    console.log('='.repeat(40));
    console.log('📱 Telegram бот инициализируется...');
    
    // Запускаем бота с обработкой ошибок
    bot.catch((err, ctx) => {
      console.error('❌ Ошибка в боте:', err);
      console.error('Контекст:', ctx?.updateType);
    });
    
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот запущен!');
    console.log('📡 Подключение к Bybit...');
    
    // Тестируем подключение к Bybit
    try {
      await makeBybitRequest('/v5/market/tickers', { category: 'spot', limit: 1 });
      console.log('✅ Bybit API доступен');
    } catch (error) {
      console.log('⚠️  Bybit API временно недоступен, но бот продолжает работу');
    }
    
    console.log('='.repeat(40));
    console.log('🤖 БОТ ГОТОВ К РАБОТЕ');
    console.log('');
    console.log('📱 Доступные команды в Telegram:');
    console.log('   /start - информация о боте');
    console.log('   /test  - проверить подключения');
    console.log('   /scan  - ручное сканирование');
    console.log('   /status - статус бота');
    console.log('   /proxy - информация о подключении');
    console.log('');
    console.log('⏰ Автосканирование каждые 30 минут');
    console.log('='.repeat(40));
    
    if (CHAT_ID) {
      try {
        await bot.telegram.sendMessage(
          CHAT_ID,
          `🤖 <b>Bybit Scalper Bot запущен!</b>\n\n` +
          `✅ Telegram: подключено\n` +
          `✅ Bybit API: ${bybitProxyAgent ? 'через прокси' : 'прямое'}\n\n` +
          `📱 Используйте команды:\n` +
          `/start /test /scan /status /proxy\n\n` +
          `⏰ Первое сканирование через 2 минуты`,
          { parse_mode: 'HTML' }
        );
        console.log('✅ Стартовое сообщение отправлено');
      } catch (error) {
        console.error('⚠️  Не удалось отправить стартовое сообщение');
      }
    }
    
    // Настраиваем планировщик
    cron.schedule('*/30 * * * *', () => {
      const now = new Date();
      console.log(`\n⏰ АВТОСКАНИРОВАНИЕ: ${now.toLocaleTimeString('ru-RU')}`);
      runSignalsTask(false);
    });
    
    console.log('⏳ Первое сканирование через 2 минуты...');
    
    // Первое сканирование
    setTimeout(() => {
      console.log(`\n🎯 ПЕРВОЕ СКАНИРОВАНИЕ`);
      runSignalsTask(false);
    }, 120000);
    
  } catch (error) {
    console.error('❌ КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Обработчики завершения
process.once('SIGINT', () => {
  console.log('\n🛑 Получен SIGINT, останавливаю бота...');
  bot.stop('SIGINT');
  setTimeout(() => process.exit(0), 1000);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Получен SIGTERM, останавливаю бота...');
  bot.stop('SIGTERM');
  setTimeout(() => process.exit(0), 1000);
});

// Запускаем бота
start();
