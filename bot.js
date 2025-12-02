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
  exchange: 'MEXC Futures (REAL)',
  apiUrl: 'https://contract.mexc.com',
  minVolume: 100000,               // минимальный объем в USDT
  scanInterval: '*/5 * * * *',     // каждые 5 минут
  minChangeForSignal: 2,           // минимальное изменение 2% (24h change)
  minConfidence: 60,               // минимальная "уверенность" сигнала
  maxSignalsPerScan: 3,            // максимум сигналов за одно сканирование
  topCoinsCount: 20,               // Топ 20 рост и топ 20 падение
  volumeMultiplier: 1.5            // множитель объёма относительно среднего
};

// Хранилище отправленных сигналов (для cooldown)
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 60 * 60 * 1000; // 1 час

// ==================== MEXC FUTURES API (ТОЛЬКО REAL) ====================
async function getMexcFuturesTickers() {
  try {
    console.log('📡 Запрос РЕАЛЬНЫХ данных MEXC Futures API...');

    const response = await axios.get(
      `${CONFIG.apiUrl}/api/v1/contract/ticker`,
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        }
      }
    );

    console.log('✅ API ответ получен');

    let tickersData = response.data;
    if (tickersData && tickersData.data) {
      tickersData = tickersData.data;
    }

    if (!Array.isArray(tickersData) || tickersData.length === 0) {
      console.log('❌ API вернул пустой массив');
      return [];
    }

    console.log(`✅ Получено ${tickersData.length} тикеров с MEXC`);

    const futuresPairs = [];

    for (const ticker of tickersData) {
      try {
        const symbol = ticker.symbol || '';

        // Берём только USDT фьючерсы
        if (!symbol.includes('_USDT')) continue;

        const price = parseFloat(ticker.lastPrice);
        const change = parseFloat(ticker.riseFallRate) * 100; // riseFallRate в долях
        const volume24 = parseFloat(ticker.volume24) || 0;
        const amount24 = parseFloat(ticker.amount24) || 0;

        // Пробуем привести к объему в USDT
        const volumeValue = price > 0 ? amount24 * price : volume24;

        if (
          !isFinite(price) || price <= 0 ||
          !isFinite(change) ||
          !isFinite(volumeValue) || volumeValue < CONFIG.minVolume
        ) {
          continue;
        }

        futuresPairs.push({
          symbol: symbol,
          price: price,
          change: change,               // 24h %
          volume: volume24,
          volumeValue: volumeValue,     // в USDT
          high: parseFloat(ticker.high24Price) || price,
          low: parseFloat(ticker.low24Price) || price,
          fundingRate: parseFloat(ticker.fundingRate) || 0,
          lastUpdate: Date.now(),
          isReal: true,
          source: 'MEXC'
        });
      } catch (err) {
        console.log(`⚠️ Ошибка парсинга тикера ${ticker.symbol}:`, err.message);
        continue;
      }
    }

    console.log(`✅ Отфильтровано ${futuresPairs.length} реальных фьючерсных пар с достаточным объемом`);

    return futuresPairs;
  } catch (error) {
    console.error('❌ Ошибка MEXC API:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Ответ:', JSON.stringify(error.response.data).slice(0, 300));
    }
    return [];
  }
}

// Получаем пары для сканирования: ТОП 20 рост и ТОП 20 падение
async function getPairsForScanning() {
  const allPairs = await getMexcFuturesTickers();

  if (allPairs.length === 0) {
    console.log('❌ Нет реальных данных с MEXC для сканирования');
    return [];
  }

  console.log(`📊 Использую ${allPairs.length} реальных пар для сканирования`);

  const topGainers = [...allPairs]
    .sort((a, b) => b.change - a.change)
    .slice(0, CONFIG.topCoinsCount);

  const topLosers = [...allPairs]
    .sort((a, b) => a.change - b.change)
    .slice(0, CONFIG.topCoinsCount);

  const combinedPairs = [...topGainers, ...topLosers];
  const uniquePairs = [];
  const seen = new Set();

  for (const pair of combinedPairs) {
    if (!seen.has(pair.symbol)) {
      seen.add(pair.symbol);
      uniquePairs.push(pair);
    }
  }

  console.log(`🔍 Для сканирования отобрано ${uniquePairs.length} уникальных пар (ТОП рост/падение)`);

  if (uniquePairs.length > 0) {
    const sample = uniquePairs[0];
    console.log(
      `📊 Пример: ${sample.symbol} $${sample.price} (${sample.change > 0 ? '+' : ''}${sample.change.toFixed(2)}%)`
    );
  }

  return uniquePairs;
}

// Получаем свечи с MEXC по символу
async function getMexcFuturesKlines(symbol, interval = '15m', limit = 50) {
  try {
    const futuresSymbol = symbol.replace('_USDT', '');

    const response = await axios.get(
      `${CONFIG.apiUrl}/api/v1/contract/kline/${futuresSymbol}`,
      {
        params: {
          interval: 'Min15', // 15 минут
          limit: limit
        },
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json'
        }
      }
    );

    let klinesData = response.data;
    if (klinesData && klinesData.data) {
      klinesData = klinesData.data;
    }

    if (!Array.isArray(klinesData) || klinesData.length === 0) {
      throw new Error('Пустые данные свечей MEXC');
    }

    const parsed = klinesData
      .map((k) => {
        // Часто формат: [timestamp, open, high, low, close, volume ...]
        if (Array.isArray(k)) {
          return {
            open: parseFloat(k[1]) || 0,
            high: parseFloat(k[2]) || 0,
            low: parseFloat(k[3]) || 0,
            close: parseFloat(k[4]) || 0,
            volume: parseFloat(k[5]) || 0
          };
        } else if (typeof k === 'object') {
          return {
            open: parseFloat(k.open) || 0,
            high: parseFloat(k.high) || 0,
            low: parseFloat(k.low) || 0,
            close: parseFloat(k.close) || 0,
            volume: parseFloat(k.volume) || 0
          };
        }
        return null;
      })
      .filter((c) =>
        c &&
        isFinite(c.open) &&
        isFinite(c.high) &&
        isFinite(c.low) &&
        isFinite(c.close) &&
        isFinite(c.volume)
      );

    if (parsed.length === 0) {
      throw new Error('Не удалось распарсить свечи MEXC');
    }

    return parsed;
  } catch (error) {
    console.error(`❌ Ошибка получения свечей для ${symbol}:`, error.message);
    // ВАЖНО: никаких тестовых свечей, просто возвращаем пустой массив
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

  if (losses === 0) return 100;
  if (gains === 0) return 0;

  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function calculateVolumeSpike(currentVolume, avgVolume) {
  if (avgVolume === 0) return 1;
  return currentVolume / avgVolume;
}

function calculateSupportResistance(highs, lows, currentPrice) {
  if (!highs || !lows || highs.length < 10 || lows.length < 10) {
    return { nearSupport: false, nearResistance: false };
  }

  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);

  const resistance = Math.max(...recentHighs);
  const support = Math.min(...recentLows);

  const priceRange = resistance - support;
  if (priceRange === 0) {
    return { nearSupport: false, nearResistance: false };
  }

  const pricePosition = (currentPrice - support) / priceRange;

  return {
    nearSupport: pricePosition < 0.3,
    nearResistance: pricePosition > 0.7,
    support,
    resistance
  };
}

// ==================== АНАЛИЗ ПАРЫ ====================
async function analyzePairForSignal(pair) {
  try {
    const now = Date.now();
    const lastSignalTime = sentSignals.get(pair.symbol);

    // cooldown
    if (lastSignalTime && now - lastSignalTime < SIGNAL_COOLDOWN) {
      return null;
    }

    const klines = await getMexcFuturesKlines(pair.symbol, '15m', 40);
    if (!klines || klines.length < 25) {
      console.log(`ℹ️ Мало свечей для анализа ${pair.symbol}`);
      return null;
    }

    const closes = klines.map((k) => k.close);
    const highs = klines.map((k) => k.high);
    const lows = klines.map((k) => k.low);
    const volumes = klines.map((k) => k.volume);

    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    if (!isFinite(currentPrice) || currentPrice <= 0) {
      return null;
    }

    const rsi = calculateRSI(closes);
    const recentVolumes = volumes.slice(-20);
    const avgVolume =
      recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeSpike = calculateVolumeSpike(currentVolume, avgVolume);
    const sr = calculateSupportResistance(highs, lows, currentPrice);

    let longScore = 0;
    let longReasons = [];
    let shortScore = 0;
    let shortReasons = [];

    // LONG условия
    if (rsi < 35) {
      longScore += 30;
      longReasons.push(`RSI ${Math.round(rsi)} (перепродан)`);
    }
    if (volumeSpike > CONFIG.volumeMultiplier) {
      longScore += 25;
      longReasons.push(`Объем x${volumeSpike.toFixed(1)} к среднему`);
    }
    if (sr.nearSupport && sr.support) {
      longScore += 20;
      longReasons.push(`Рядом с поддержкой ~ $${sr.support.toFixed(4)}`);
    }
    if (pair.change > CONFIG.minChangeForSignal) {
      longScore += 15;
      longReasons.push(`Рост за 24ч ${pair.change.toFixed(1)}%`);
    }
    if (pair.fundingRate < 0) {
      longScore += 10;
      longReasons.push(
        `Фин. ставка ${ (pair.fundingRate * 100).toFixed(4) }% (лонги получают)`
      );
    }

    // SHORT условия
    if (rsi > 65) {
      shortScore += 30;
      shortReasons.push(`RSI ${Math.round(rsi)} (перекуплен)`);
    }
    if (volumeSpike > CONFIG.volumeMultiplier) {
      shortScore += 25;
      shortReasons.push(`Объем x${volumeSpike.toFixed(1)} к среднему`);
    }
    if (sr.nearResistance && sr.resistance) {
      shortScore += 20;
      shortReasons.push(
        `Рядом с сопротивлением ~ $${sr.resistance.toFixed(4)}`
      );
    }
    if (pair.change < -CONFIG.minChangeForSignal) {
      shortScore += 15;
      shortReasons.push(
        `Падение за 24ч ${Math.abs(pair.change).toFixed(1)}%`
      );
    }
    if (pair.fundingRate > 0) {
      shortScore += 10;
      shortReasons.push(
        `Фин. ставка ${ (pair.fundingRate * 100).toFixed(4) }% (шорты получают)`
      );
    }

    let potentialSignal = null;
    let confidence = 0;
    let reasons = [];

    if (longScore >= CONFIG.minConfidence && longScore > shortScore) {
      potentialSignal = 'LONG';
      confidence = Math.min(longScore, 95);
      reasons = longReasons;
    } else if (shortScore >= CONFIG.minConfidence && shortScore > longScore) {
      potentialSignal = 'SHORT';
      confidence = Math.min(shortScore, 95);
      reasons = shortReasons;
    }

    if (!potentialSignal || confidence < CONFIG.minConfidence || reasons.length < 3) {
      return null;
    }

    const entry = currentPrice;
    let tp, sl;

    if (potentialSignal === 'LONG') {
      sl = entry * 0.98;
      tp = entry * 1.06;
    } else {
      sl = entry * 1.02;
      tp = entry * 0.94;
    }

    const rrRatio = '1:2';
    const tier =
      confidence >= 80 ? '🔥 PREMIUM' :
      confidence >= 70 ? '💎 STRONG' :
      '📊 STANDARD';

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
      volume24h: (pair.volumeValue / 1_000_000).toFixed(2) + 'M',
      fundingRate: (pair.fundingRate * 100).toFixed(4),
      rsi: Math.round(rsi),
      volumeSpike: volumeSpike.toFixed(1),
      reasons: reasons,
      timestamp: new Date(),
      isRealData: true,
      source: 'MEXC'
    };
  } catch (error) {
    console.error(`❌ Ошибка анализа пары ${pair.symbol}:`, error.message);
    return null;
  }
}

// ==================== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ====================
async function performAutoScan() {
  console.log('\n' + '='.repeat(60));
  console.log('🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ФЬЮЧЕРСОВ MEXC');
  console.log('='.repeat(60));

  const scanStartTime = Date.now();

  try {
    console.log('📡 Получение данных с MEXC...');
    const pairsToScan = await getPairsForScanning();

    if (pairsToScan.length === 0) {
      console.log('❌ Нет данных для сканирования');
      await sendStatusToChat(
        '❌ Нет данных с MEXC API. Сигналы не отправлялись. Попробую снова через 5 минут.'
      );
      return;
    }

    console.log(`📊 Анализ ${pairsToScan.length} пар...`);

    const allSignals = [];

    for (let i = 0; i < pairsToScan.length; i++) {
      const pair = pairsToScan[i];
      console.log(
        `🔍 [${i + 1}/${pairsToScan.length}] ${pair.symbol} $${pair.price} (${pair.change > 0 ? '+' : ''}${pair.change.toFixed(2)}%)`
      );

      const signal = await analyzePairForSignal(pair);

      if (signal) {
        allSignals.push(signal);
        console.log(
          `✅ Сигнал: ${signal.signal} ${signal.pair} (${signal.confidence}%)`
        );
      }

      if (i < pairsToScan.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    allSignals.sort((a, b) => b.confidence - a.confidence);
    const signalsToSend = allSignals.slice(0, CONFIG.maxSignalsPerScan);

    if (signalsToSend.length > 0) {
      console.log(`📤 Отправка ${signalsToSend.length} сигналов...`);

      await sendStatusToChat(
        `🔍 Найдено ${allSignals.length} сигналов, отправляю Топ ${signalsToSend.length}`
      );

      for (const signal of signalsToSend) {
        await sendSignalToChat(signal);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      console.log(`✅ Отправлено ${signalsToSend.length} сигналов`);
    } else {
      console.log('ℹ️ Сигналов не найдено по текущим условиям');
      await sendStatusToChat('ℹ️ Сигналов не найдено на текущем сканировании');
    }

    const scanTime = ((Date.now() - scanStartTime) / 1000).toFixed(1);
    console.log(`⏱ Время сканирования: ${scanTime} сек`);
    console.log(`📊 Найдено сигналов: ${allSignals.length}`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ Ошибка сканирования:', error.message);
    await sendStatusToChat(`❌ Ошибка сканирования: ${error.message}`);
  }
}

// ==================== ОТПРАВКА В ЧАТ ====================
async function sendSignalToChat(signal) {
  try {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const dataSource = '✅ РЕАЛЬНЫЕ ДАННЫЕ MEXC';

    const message = `
${emoji} <b>${signal.tier} СИГНАЛ ФЬЮЧЕРС MEXC</b>

${dataSource}
🏦 <b>Биржа:</b> ${CONFIG.exchange}
📊 <b>Пара:</b> <code>${signal.pair}</code>
🎯 <b>Тип:</b> <b>${signal.signal}</b>

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
📊 <b>Объем / средний:</b> x${signal.volumeSpike}

📋 <b>Причины сигнала:</b>
${signal.reasons.map((r) => `• ${r}`).join('\n')}

⏰ <b>Время:</b> ${signal.timestamp.toLocaleTimeString('ru-RU')}
📅 <b>Дата:</b> ${signal.timestamp.toLocaleDateString('ru-RU')}

⚠️ <i>Торговля на фьючерсах сопряжена с высоким риском</i>
    `.trim();

    await bot.telegram.sendMessage(CHAT_ID, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    console.log(`✅ Сигнал отправлен: ${signal.pair} (${signal.confidence}%)`);
  } catch (error) {
    console.error('❌ Ошибка отправки сигнала:', error.message);
  }
}

async function sendStatusToChat(message) {
  try {
    const statusMessage = `
🤖 <b>Статус сканирования</b>

${message}

⏰ <b>Время:</b> ${new Date().toLocaleTimeString('ru-RU')}
📅 <b>Дата:</b> ${new Date().toLocaleDateString('ru-RU')}

<i>Следующее сканирование через 5 минут</i>
    `.trim();

    await bot.telegram.sendMessage(CHAT_ID, statusMessage, {
      parse_mode: 'HTML',
      disable_notification: true
    });
  } catch (error) {
    console.error('❌ Ошибка отправки статуса:', error.message);
  }
}

// ==================== КОМАНДЫ БОТА ====================
bot.start((ctx) => {
  ctx.reply(
    `
🤖 <b>MEXC Futures Signals Bot</b>

✅ <b>Автосканирование каждые 5 минут</b>
🏦 Биржа: ${CONFIG.exchange}
📊 Пары для сканирования: ТОП ${CONFIG.topCoinsCount} роста + ТОП ${CONFIG.topCoinsCount} падения
⏰ Интервал: 5 минут

<b>Команды:</b>
/scan - сканировать сейчас
/top - топ движений (реальные данные MEXC)
/status - статус бота
/test - проверить API MEXC
/stats - статистика (кол-во уникальных пар с сигналами)
  `.trim(),
    { parse_mode: 'HTML' }
  );
});

bot.command('scan', async (ctx) => {
  try {
    await ctx.reply('🚀 Запускаю сканирование (REAL MEXC)...');
    console.log('🚀 Ручное сканирование по команде /scan...');
    performAutoScan();
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  try {
    await ctx.reply('📊 Получаю данные TOP с MEXC...');

    const tickers = await getMexcFuturesTickers();
    if (tickers.length === 0) {
      await ctx.reply('❌ Нет данных от MEXC API, попробуй позже');
      return;
    }

    const topGainers = [...tickers]
      .sort((a, b) => b.change - a.change)
      .slice(0, 10);

    const topLosers = [...tickers]
      .sort((a, b) => a.change - b.change)
      .slice(0, 10);

    let message = `📈 <b>ТОП 10 РОСТА (MEXC Futures)</b>\n\n`;

    topGainers.forEach((t, i) => {
      message += `${i + 1}. <b>${t.symbol.replace('_USDT', '/USDT')}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change.toFixed(2)}%\n`;
      message += `   💎 Объем: ~$${(t.volumeValue / 1_000_000).toFixed(2)}M\n\n`;
    });

    message += `📉 <b>ТОП 10 ПАДЕНИЯ (MEXC Futures)</b>\n\n`;

    topLosers.forEach((t, i) => {
      message += `${i + 1}. <b>${t.symbol.replace('_USDT', '/USDT')}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📉 ${t.change.toFixed(2)}%\n`;
      message += `   💎 Объем: ~$${(t.volumeValue / 1_000_000).toFixed(2)}M\n\n`;
    });

    await ctx.reply(message, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('status', async (ctx) => {
  const now = new Date();
  const nextScanMinutes = 5 - (now.getMinutes() % 5);

  const statusMessage = `
📊 <b>СТАТУС БОТА</b>

🟢 Состояние: Активен
🏦 Биржа: ${CONFIG.exchange}
⏰ Следующее сканирование: через ${nextScanMinutes} мин
📨 Уникальных пар с сигналами (за сессию): ${sentSignals.size}

🕒 Время: ${now.toLocaleTimeString('ru-RU')}
  `.trim();

  await ctx.reply(statusMessage, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  try {
    await ctx.reply('🔄 Проверяю MEXC API...');

    const tickers = await getMexcFuturesTickers();

    if (tickers.length > 0) {
      let message = `✅ <b>MEXC API работает!</b>\n\n`;
      message += `📊 Получено пар: ${tickers.length}\n\n`;
      message += `<b>Примеры реальных цен:</b>\n`;

      tickers.slice(0, 3).forEach((ticker, i) => {
        message += `${i + 1}. <b>${ticker.symbol.replace('_USDT', '/USDT')}</b>\n`;
        message += `   💰 $${ticker.price.toFixed(4)}\n`;
        message += `   📈 ${ticker.change > 0 ? '+' : ''}${ticker.change.toFixed(2)}%\n\n`;
      });

      await ctx.reply(message, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('❌ MEXC API не вернул данные, попробуй позже', {
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('stats', async (ctx) => {
  try {
    const statsMessage = `
📈 <b>СТАТИСТИКА СИГНАЛОВ (СЕССИЯ</b>)

Уникальных пар, по которым уже был сигнал (под cooldown): ${sentSignals.size}
  `.trim();

    await ctx.reply(statsMessage, { parse_mode: 'HTML' });
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

// ==================== ЗАПУСК ====================
async function startBot() {
  try {
    console.log('🚀 Запуск бота...');

    console.log('📡 Первичный тест MEXC API...');
    const testTickers = await getMexcFuturesTickers();

    if (testTickers.length > 0) {
      console.log(`✅ MEXC API доступен: ${testTickers.length} пар`);
      const sample = testTickers[0];
      console.log(
        `📊 Пример: ${sample.symbol} $${sample.price} (${sample.change > 0 ? '+' : ''}${sample.change.toFixed(2)}%)`
      );
    } else {
      console.log('⚠️ MEXC API сейчас не вернул данных. Бот запущен, будет пробовать на следующих сканированиях.');
    }

    await bot.launch();
    console.log('✅ Бот запущен!');

    console.log('⏰ Настройка автосканирования каждые 5 минут...');
    const cronJob = cron.schedule(
      CONFIG.scanInterval,
      () => {
        console.log('\n🔄 ========== АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ ==========');
        console.log(`⏰ Время: ${new Date().toLocaleTimeString('ru-RU')}`);
        performAutoScan();
      },
      {
        scheduled: true,
        timezone: 'Europe/Moscow'
      }
    );

    cronJob.start();
    console.log(`✅ Автосканирование настроено: ${CONFIG.scanInterval}`);
    console.log('📊 Будет сканировать каждые 5 минут (0,5,10,15... минут)');

    setTimeout(() => {
      console.log('\n🚀 Первое сканирование через 30 секунд...');
    }, 30000);

    setTimeout(() => {
      console.log('\n🚀 ЗАПУСК ПЕРВОГО СКАНИРОВАНИЯ');
      performAutoScan();
    }, 35000);

    console.log('\n' + '='.repeat(60));
    console.log('🤖 БОТ ЗАПУЩЕН И РАБОТАЕТ (ТОЛЬКО REAL MEXC)');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error);
    process.exit(1);
  }
}

startBot();
