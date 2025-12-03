const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск MEXC Futures Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('❌ Нет TELEGRAM_CHAT_ID!');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'MEXC Futures',
  apiUrl: 'https://contract.mexc.com',
  minVolume: 50000,      // 50K USDT для анализа
  scanInterval: '*/5 * * * *', // Каждые 5 минут
  minChangeForSignal: 1.5, // Минимальное изменение 1.5%
  minConfidence: 55,      // Минимальная уверенность 55%
  maxSignalsPerScan: 3,   // Максимум сигналов за сканирование
  topCoinsCount: 30,      // Топ 30 рост и топ 30 падение
  volumeMultiplier: 1.2   // Минимальный множитель объема
};

// Хранилище отправленных сигналов (чтобы не дублировать)
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 30 * 60 * 1000; // 30 минут

// ==================== MEXC FUTURES API ====================
async function getMexcFuturesTickers() {
  try {
    console.log('📡 Запрос к MEXC Futures API...');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/ticker_24hr`, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });
    
    console.log(`✅ Получено ${response.data.length} фьючерсных пар`);
    
    // Фильтруем USDT фьючерсы
    const futuresPairs = response.data
      .filter(ticker => ticker.symbol.includes('_USDT'))
      .map(ticker => {
        const change = parseFloat(ticker.fundRate) || 0;
        const volume = parseFloat(ticker.volume24) || 0;
        const price = parseFloat(ticker.lastPrice);
        
        return {
          symbol: ticker.symbol,
          price: price,
          change: change,
          volume: volume,
          high: parseFloat(ticker.high24Price),
          low: parseFloat(ticker.low24Price),
          volumeValue: volume,
          fundingRate: parseFloat(ticker.fundRate) || 0
        };
      })
      .filter(ticker => 
        ticker.volumeValue >= CONFIG.minVolume && 
        ticker.price > 0.000001
      );
    
    console.log(`✅ Отфильтровано ${futuresPairs.length} фьючерсов с объемом > $${(CONFIG.minVolume/1000).toFixed(0)}K`);
    return futuresPairs;
    
  } catch (error) {
    console.error('❌ Ошибка MEXC Futures API:', error.message);
    return [];
  }
}

// Получаем пары для сканирования (топ 30 рост и топ 30 падение)
async function getPairsForScanning() {
  try {
    const allPairs = await getMexcFuturesTickers();
    if (allPairs.length === 0) return [];
    
    // Сортируем по изменению (рост)
    const topGainers = [...allPairs]
      .sort((a, b) => b.change - a.change)
      .slice(0, CONFIG.topCoinsCount);
    
    // Сортируем по изменению (падение)
    const topLosers = [...allPairs]
      .sort((a, b) => a.change - b.change)
      .slice(0, CONFIG.topCoinsCount);
    
    // Объединяем и удаляем дубликаты
    const combinedPairs = [...topGainers, ...topLosers];
    const uniquePairs = combinedPairs.filter((pair, index, self) =>
      index === self.findIndex(p => p.symbol === pair.symbol)
    );
    
    console.log(`🔍 Для сканирования: ${uniquePairs.length} уникальных пар (${topGainers.length} топ рост + ${topLosers.length} топ падение)`);
    
    return uniquePairs;
  } catch (error) {
    console.error('❌ Ошибка получения пар для сканирования:', error.message);
    return [];
  }
}

// Получаем данные свечей для фьючерсов
async function getMexcFuturesKlines(symbol, interval = '15m', limit = 50) {
  try {
    // Преобразуем символ для API фьючерсов
    const futuresSymbol = symbol.replace('_USDT', '');
    
    const response = await axios.get(`${CONFIG.apiUrl}/api/v1/contract/kline/${futuresSymbol}`, {
      params: {
        interval: interval === '15m' ? 'Min15' : interval,
        limit: limit
      },
      timeout: 8000
    });
    
    return response.data.map(k => ({
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    
  } catch (error) {
    console.error(`❌ Ошибка свечей фьючерса ${symbol}:`, error.message);
    return [];
  }
}

// ==================== ИНДИКАТОРЫ ====================
function calculateRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const change = closes[closes.length - i] - closes[closes.length - i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateVolumeSpike(currentVolume, avgVolume) {
  if (avgVolume === 0) return 1;
  return currentVolume / avgVolume;
}

function calculateSupportResistance(highs, lows, currentPrice) {
  if (highs.length < 10 || lows.length < 10) return { nearSupport: false, nearResistance: false };
  
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  
  const resistance = Math.max(...recentHighs);
  const support = Math.min(...recentLows);
  
  const priceRange = resistance - support;
  if (priceRange === 0) return { nearSupport: false, nearResistance: false };
  
  const pricePosition = (currentPrice - support) / priceRange;
  
  return {
    nearSupport: pricePosition < 0.3,
    nearResistance: pricePosition > 0.7,
    support: support,
    resistance: resistance
  };
}

// ==================== АНАЛИЗ ПАРЫ ====================
async function analyzePairForSignal(pair) {
  try {
    // Проверяем кд для этой пары
    const now = Date.now();
    const lastSignalTime = sentSignals.get(pair.symbol);
    if (lastSignalTime && (now - lastSignalTime) < SIGNAL_COOLDOWN) {
      console.log(`⏳ Пропускаем ${pair.symbol} (в кд)`);
      return null;
    }
    
    // Получаем свечи для фьючерса
    const klines = await getMexcFuturesKlines(pair.symbol, '15m', 40);
    if (klines.length < 20) return null;
    
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);
    
    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];
    
    // Рассчитываем индикаторы
    const rsi = calculateRSI(closes);
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volumeSpike = calculateVolumeSpike(currentVolume, avgVolume);
    
    const sr = calculateSupportResistance(highs, lows, currentPrice);
    
    // Определяем потенциальный сигнал
    let potentialSignal = null;
    let confidence = 0;
    let reasons = [];
    
    // УСЛОВИЯ ДЛЯ LONG
    const longScore = 
      (rsi < 35 ? 25 : 0) +
      (volumeSpike > CONFIG.volumeMultiplier ? 20 : 0) +
      (sr.nearSupport ? 15 : 0) +
      (pair.change > 2 ? 15 : (pair.change > 0 ? 10 : 0)) +
      (pair.fundingRate < 0 ? 10 : 0) + // Отрицательное финансирование - плюс для лонга
      (currentPrice < pair.high * 0.95 ? 10 : 0);
    
    // УСЛОВИЯ ДЛЯ SHORT
    const shortScore = 
      (rsi > 65 ? 25 : 0) +
      (volumeSpike > CONFIG.volumeMultiplier ? 20 : 0) +
      (sr.nearResistance ? 15 : 0) +
      (pair.change < -2 ? 15 : (pair.change < 0 ? 10 : 0)) +
      (pair.fundingRate > 0 ? 10 : 0) + // Положительное финансирование - плюс для шорта
      (currentPrice > pair.low * 1.05 ? 10 : 0);
    
    // Выбираем сигнал с наибольшим счетом
    if (longScore >= 50 && longScore > shortScore) {
      potentialSignal = 'LONG';
      confidence = Math.min(longScore, 95);
      
      if (rsi < 35) reasons.push(`RSI ${Math.round(rsi)} (перепродан)`);
      if (volumeSpike > CONFIG.volumeMultiplier) reasons.push(`Объем x${volumeSpike.toFixed(1)}`);
      if (sr.nearSupport) reasons.push(`Возле поддержки`);
      if (pair.change > 0) reasons.push(`Рост ${pair.change.toFixed(1)}%`);
      if (pair.fundingRate < 0) reasons.push(`Фин. ставка: ${pair.fundingRate.toFixed(4)}%`);
      
    } else if (shortScore >= 50 && shortScore > longScore) {
      potentialSignal = 'SHORT';
      confidence = Math.min(shortScore, 95);
      
      if (rsi > 65) reasons.push(`RSI ${Math.round(rsi)} (перекуплен)`);
      if (volumeSpike > CONFIG.volumeMultiplier) reasons.push(`Объем x${volumeSpike.toFixed(1)}`);
      if (sr.nearResistance) reasons.push(`Возле сопротивления`);
      if (pair.change < 0) reasons.push(`Падение ${Math.abs(pair.change).toFixed(1)}%`);
      if (pair.fundingRate > 0) reasons.push(`Фин. ставка: ${pair.fundingRate.toFixed(4)}%`);
    }
    
    // Проверяем минимальную уверенность
    if (!potentialSignal || confidence < CONFIG.minConfidence || reasons.length < 2) {
      return null;
    }
    
    // Рассчитываем уровни для фьючерсов
    const entry = currentPrice;
    let tp, sl;
    
    if (potentialSignal === 'LONG') {
      sl = entry * 0.97; // -3%
      tp = entry * 1.06; // +6% (RR 1:2)
    } else {
      sl = entry * 1.03; // +3%
      tp = entry * 0.94; // -6% (RR 1:2)
    }
    
    const rrRatio = '1:2';
    const tier = confidence >= 75 ? '🔥 PREMIUM' : confidence >= 60 ? '💎 STANDARD' : '📊 BASIC';
    
    // Сохраняем время отправки
    sentSignals.set(pair.symbol, now);
    
    return {
      pair: pair.symbol.replace('_USDT', '/USDT'),
      symbol: pair.symbol,
      signal: potentialSignal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(confidence),
      rrRatio: rrRatio,
      tier: tier,
      change24h: pair.change.toFixed(2),
      volume24h: (pair.volume / 1000).toFixed(0) + 'K',
      fundingRate: pair.fundingRate.toFixed(4),
      rsi: Math.round(rsi),
      volumeSpike: volumeSpike.toFixed(1),
      reasons: reasons,
      timestamp: new Date()
    };
    
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ====================
async function performAutoScan() {
  console.log('\n' + '='.repeat(60));
  console.log('🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ФЬЮЧЕРСОВ ЗАПУЩЕНО');
  console.log('='.repeat(60));
  
  const scanStartTime = Date.now();
  let signalsFound = 0;
  
  try {
    // Получаем пары для сканирования (топ 30 рост и топ 30 падение)
    const pairsToScan = await getPairsForScanning();
    
    if (pairsToScan.length === 0) {
      console.log('❌ Нет фьючерсных пар для сканирования');
      await sendStatusToChat('❌ Не удалось получить данные с биржи фьючерсов');
      return;
    }
    
    console.log(`📊 Начинаю анализ ${pairsToScan.length} фьючерсных пар...`);
    
    const allSignals = [];
    
    // Анализируем каждую пару
    for (let i = 0; i < pairsToScan.length; i++) {
      const pair = pairsToScan[i];
      console.log(`🔍 [${i+1}/${pairsToScan.length}] Анализ ${pair.symbol} (${pair.change > 0 ? '+' : ''}${pair.change.toFixed(2)}%)`);
      
      const signal = await analyzePairForSignal(pair);
      
      if (signal) {
        allSignals.push(signal);
        console.log(`✅ Найден сигнал: ${signal.signal} ${signal.pair} (${signal.confidence}%)`);
        signalsFound++;
      }
      
      // Задержка между запросами
      if (i < pairsToScan.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    // Сортируем сигналы по уверенности
    allSignals.sort((a, b) => b.confidence - a.confidence);
    
    // Отправляем лучшие сигналы
    const signalsToSend = allSignals.slice(0, CONFIG.maxSignalsPerScan);
    
    if (signalsToSend.length > 0) {
      console.log(`📤 Отправляю ${signalsToSend.length} лучших сигналов...`);
      
      for (const signal of signalsToSend) {
        await sendSignalToChat(signal);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Задержка между отправками
      }
      
      await sendStatusToChat(`✅ Сканирование фьючерсов завершено! Найдено ${signalsFound} сигналов, отправлено ${signalsToSend.length}`);
      
    } else {
      console.log('ℹ️ Сигналов не найдено');
      await sendStatusToChat(`ℹ️ Сканирование фьючерсов завершено. Сигналов не найдено. Проанализировано ${pairsToScan.length} пар`);
    }
    
    const scanTime = ((Date.now() - scanStartTime) / 1000).toFixed(1);
    console.log(`⏱ Время сканирования: ${scanTime} сек`);
    console.log(`📊 Найдено сигналов: ${signalsFound}`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ Критическая ошибка сканирования фьючерсов:', error.message);
    await sendStatusToChat(`❌ Ошибка сканирования фьючерсов: ${error.message}`);
  }
}

// ==================== ОТПРАВКА В ЧАТ ====================
async function sendSignalToChat(signal) {
  try {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const signalEmoji = signal.signal === 'LONG' ? '📈' : '📉';
    
    const message = `
${signalEmoji} <b>${signal.tier} СИГНАЛ ФЬЮЧЕРС</b> ${emoji}

🏦 <b>Биржа:</b> MEXC Futures
📊 <b>Пара:</b> ${signal.pair}
🎯 <b>Тип:</b> ${signal.signal}

💰 <b>Текущая цена:</b> $${signal.entry}
📈 <b>Изменение 24ч:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💎 <b>Объем 24ч:</b> $${signal.volume24h}
💰 <b>Ставка финансирования:</b> ${signal.fundingRate}%

🎯 <b>Точка входа:</b> $${signal.entry}
✅ <b>Тейк-профит:</b> $${signal.tp}
🛑 <b>Стоп-лосс:</b> $${signal.sl}

📊 <b>Соотношение RR:</b> ${signal.rrRatio}
🔮 <b>Уверенность:</b> ${signal.confidence}%
📈 <b>RSI:</b> ${signal.rsi}

📋 <b>Причины сигнала:</b>
${signal.reasons.map(r => `• ${r}`).join('\n')}

⏰ <b>Время сигнала:</b> ${signal.timestamp.toLocaleTimeString('ru-RU')}
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log(`✅ Фьючерсный сигнал отправлен: ${signal.pair}`);
    
  } catch (error) {
    console.error(`❌ Ошибка отправки фьючерсного сигнала ${signal?.pair}:`, error.message);
  }
}

async function sendStatusToChat(message) {
  try {
    const statusMessage = `
🤖 <b>Статус сканирования фьючерсов</b>

${message}

⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}
📅 <b>Дата:</b> ${new Date().toLocaleDateString('ru-RU')}

<i>Следующее сканирование через 5 минут</i>
    `.trim();
    
    await bot.telegram.sendMessage(CHAT_ID, statusMessage, { parse_mode: 'HTML' });
  } catch (error) {
    console.error('❌ Ошибка отправки статуса:', error.message);
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  const welcome = `
🤖 <b>MEXC Futures Signals Auto-Bot</b>

✅ <b>Автоматическое сканирование фьючерсов работает!</b>

🏦 <b>Биржа:</b> ${CONFIG.exchange}
⏰ <b>Сканирование:</b> каждые 5 минут
📊 <b>Пар за сканирование:</b> топ ${CONFIG.topCoinsCount} рост + топ ${CONFIG.topCoinsCount} падение
🎯 <b>Минимальное изменение:</b> ${CONFIG.minChangeForSignal}%
💰 <b>Минимальный объем:</b> $${(CONFIG.minVolume/1000).toFixed(0)}K

<b>📈 Анализируем:</b>
• RSI (перекупленность/перепроданность)
• Объем торгов (спайки)
• Уровни поддержки/сопротивления
• Ценовые движения
• Ставки финансирования

<b>📱 Команды:</b>
/start - информация
/scan - запустить сканирование сейчас
/top - топ движений фьючерсов за 24ч
/status - текущий статус
/test - проверка API

✅ <b>Фьючерсные сигналы приходят автоматически в канал!</b>
  `.trim();
  
  ctx.reply(welcome, { parse_mode: 'HTML' });
});

bot.command('scan', async (ctx) => {
  try {
    await ctx.reply('🚀 Запускаю внеочередное сканирование фьючерсов...');
    console.log('🚀 Запуск ручного сканирования фьючерсов по команде...');
    
    // Запускаем сканирование
    await performAutoScan();
    
    await ctx.reply('✅ Сканирование фьючерсов завершено! Проверьте канал с сигналами.');
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  try {
    await ctx.reply('📊 Ищу топ движений фьючерсов...');
    
    const tickers = await getMexcFuturesTickers();
    if (tickers.length === 0) {
      await ctx.reply('❌ Нет данных от биржи фьючерсов');
      return;
    }
    
    // Топ рост (30)
    const topGainers = [...tickers]
      .sort((a, b) => b.change - a.change)
      .slice(0, 30);
    
    // Топ падение (30)
    const topLosers = [...tickers]
      .sort((a, b) => a.change - b.change)
      .slice(0, 30);
    
    let message = `📈 <b>ТОП 30 РОСТА ФЬЮЧЕРСОВ (24ч)</b>\n\n`;
    
    topGainers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol.replace('_USDT', '/USDT')}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change.toFixed(2)}%\n`;
      message += `   💸 Фин. ставка: ${t.fundingRate.toFixed(4)}%\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    message += `📉 <b>ТОП 30 ПАДЕНИЯ ФЬЮЧЕРСОВ (24ч)</b>\n\n`;
    
    topLosers.forEach((t, i) => {
      message += `${i+1}. <b>${t.symbol.replace('_USDT', '/USDT')}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${t.change.toFixed(2)}%\n`;
      message += `   💸 Фин. ставка: ${t.fundingRate.toFixed(4)}%\n`;
      message += `   🔄 $${(t.volume/1000).toFixed(0)}K\n\n`;
    });
    
    message += `\n📊 Всего фьючерсных пар с объемом > $${(CONFIG.minVolume/1000).toFixed(0)}K: ${tickers.length}`;
    
    await ctx.reply(message, { parse_mode: 'HTML' });
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('status', async (ctx) => {
  const now = new Date();
  const nextScanMinutes = 5 - (now.getMinutes() % 5);
  
  const statusMessage = `
📊 <b>СТАТУС БОТА ФЬЮЧЕРСОВ</b>

🟢 <b>Состояние:</b> Активен
🏦 <b>Биржа:</b> ${CONFIG.exchange}
⏰ <b>Следующее сканирование:</b> через ${nextScanMinutes} мин
📊 <b>Отправлено сигналов:</b> ${sentSignals.size}
🕒 <b>Время сервера:</b> ${now.toLocaleTimeString('ru-RU')}

<b>Настройки сканирования фьючерсов:</b>
• Интервал: 5 минут
• Пар за сканирование: топ ${CONFIG.topCoinsCount} рост + топ ${CONFIG.topCoinsCount} падение
• Мин. изменение: ${CONFIG.minChangeForSignal}%
• Мин. объем: $${(CONFIG.minVolume/1000).toFixed(0)}K
• Мин. уверенность: ${CONFIG.minConfidence}%

<b>Команды:</b>
/scan - сканировать фьючерсы сейчас
/top - топ движений фьючерсов
/test - проверить API
  `.trim();
  
  await ctx.reply(statusMessage, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  try {
    await ctx.reply('🔄 Проверяю подключение к MEXC Futures...');
    
    const tickers = await getMexcFuturesTickers();
    
    if (tickers.length > 0) {
      await ctx.reply(
        `✅ MEXC Futures API работает!\n\n` +
        `📊 Получено фьючерсных пар: ${tickers.length}\n` +
        `💰 Мин. объем: $${(CONFIG.minVolume/1000).toFixed(0)}K\n` +
        `📈 Пример: ${tickers[0].symbol.replace('_USDT', '/USDT')} $${tickers[0].price.toFixed(4)} (${tickers[0].change > 0 ? '+' : ''}${tickers[0].change.toFixed(2)}%)\n` +
        `💸 Фин. ставка: ${tickers[0].fundingRate.toFixed(4)}%`
      );
    } else {
      await ctx.reply('❌ Не удалось получить данные с MEXC Futures');
    }
    
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// ==================== ЗАПУСК И НАСТРОЙКА ====================
async function startBot() {
  try {
    console.log('🚀 Инициализация MEXC Futures Auto-Signals Bot...');
    
    // Проверяем API
    console.log('📡 Проверка подключения к MEXC Futures...');
    const testTickers = await getMexcFuturesTickers();
    
    if (testTickers.length === 0) {
      console.log('⚠️  Внимание: MEXC Futures API может быть недоступен');
    } else {
      console.log(`✅ MEXC Futures API доступен, получено ${testTickers.length} фьючерсных пар`);
    }
    
    // Запускаем бота
    await bot.launch({
      dropPendingUpdates: true,
      allowedUpdates: ['message']
    });
    
    console.log('✅ Telegram бот для фьючерсов запущен!');
    
    // Настраиваем крон для автоматического сканирования
    cron.schedule(CONFIG.scanInterval, () => {
      console.log(`\n⏰ Время автоматического сканирования фьючерсов!`);
      performAutoScan();
    });
    
    console.log(`⏰ Автосканирование фьючерсов настроено: каждые 5 минут`);
    console.log(`📊 Сканируемые пары: топ ${CONFIG.topCoinsCount} рост + топ ${CONFIG.topCoinsCount} падение`);
    console.log(`🎯 Минимальное изменение: ${CONFIG.minChangeForSignal}%`);
    
    // Отправляем стартовое сообщение в канал
    try {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🤖 <b>MEXC Futures Auto-Signals Bot запущен!</b>\n\n` +
        `✅ Автоматическое сканирование фьючерсов активировано\n` +
        `⏰ Сканирование: каждые 5 минут\n` +
        `📊 Сканируемые пары: топ ${CONFIG.topCoinsCount} рост + топ ${CONFIG.topCoinsCount} падение\n` +
        `🎯 Минимальное изменение: ${CONFIG.minChangeForSignal}%\n` +
        `💰 Мин. объем: $${(CONFIG.minVolume/1000).toFixed(0)}K\n\n` +
        `📈 <b>Фьючерсные сигналы будут приходить автоматически!</b>\n\n` +
        `🔄 Первое сканирование через 1 минуту...`,
        { parse_mode: 'HTML' }
      );
      console.log('✅ Стартовое сообщение отправлено в канал');
    } catch (error) {
      console.log('⚠️ Не удалось отправить стартовое сообщение');
    }
    
    // Первое сканирование через 1 минуту после запуска
    setTimeout(() => {
      console.log('\n🚀 ЗАПУСК ПЕРВОГО СКАНИРОВАНИЯ ФЬЮЧЕРСОВ');
      performAutoScan();
    }, 60000);
    
    console.log('\n' + '='.repeat(60));
    console.log('🤖 БОТ ДЛЯ ФЬЮЧЕРСОВ УСПЕШНО ЗАПУЩЕН И РАБОТАЕТ');
    console.log('='.repeat(60));
    console.log(`💬 Канал ID: ${CHAT_ID}`);
    console.log(`⏰ Сканирование: каждые 5 минут`);
    console.log(`📊 Сканируемые пары: топ ${CONFIG.topCoinsCount} рост + топ ${CONFIG.topCoinsCount} падение`);
    console.log(`🎯 Мин. изменение: ${CONFIG.minChangeForSignal}%`);
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('❌ Критическая ошибка запуска:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Обработчики завершения
process.once('SIGINT', () => {
  console.log('\n🛑 Остановка бота фьючерсов...');
  bot.stop('SIGINT');
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('\n🛑 Остановка бота фьючерсов...');
  bot.stop('SIGTERM');
  process.exit(0);
});

// Запуск бота
startBot();
