const { Telegraf } = require('telegraf');
const axios = require('axios');
const cron = require('node-cron');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

console.log('🤖 Запуск Coinbase Perpetual Futures Signals Bot...');

if (!BOT_TOKEN) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN!');
  process.exit(1);
}

if (!CHAT_ID) {
  console.error('❌ Нет TELEGRAM_CHAT_ID!');
  console.error('👉 Укажи TELEGRAM_CHAT_ID в переменных окружения');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ==================== НАСТРОЙКИ ====================
const CONFIG = {
  exchange: 'Coinbase Perpetual Futures (Advanced Trade)',
  apiUrl: 'https://api.coinbase.com/api/v3/brokerage',
  minVolume: 100000,               // минимальный объём (в quote, типа USDC) для фильтра
  scanInterval: '*/5 * * * *',     // каждые 5 минут
  minChangeForSignal: 2,           // минимальное изменение 2% (24h change)
  minConfidence: 60,               // минимальная "уверенность" сигнала
  maxSignalsPerScan: 3,            // максимум сигналов за одно сканирование
  topCoinsCount: 20,               // Топ 20 рост и топ 20 падение
  volumeMultiplier: 1.5,           // множитель объёма относительно средних 15m свечей
  candlesGranularity: 900          // 900 секунд = 15m
};

// cooldown по инструменту
const sentSignals = new Map();
const SIGNAL_COOLDOWN = 60 * 60 * 1000; // 1 час

// ==================== COINBASE ADVANCED PUBLIC API ====================

// Список PERPETUAL FUTURES продуктов (public, без ключей)
async function getCoinbasePerpProducts() {
  try {
    console.log('📡 Запрос PERPETUAL FUTURES продуктов Coinbase Advanced...');

    const response = await axios.get(
      `${CONFIG.apiUrl}/market/products`,
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        },
        params: {
          product_type: 'FUTURE',
          contract_expiry_type: 'PERPETUAL',
          get_tradability_status: true,
          products_sort_order: 'PRODUCTS_SORT_ORDER_VOLUME_24H_DESCENDING',
          limit: 200
        }
      }
    );

    let data = response.data || {};
    const products = Array.isArray(data.products) ? data.products : [];

    if (!products.length) {
      console.log('❌ Coinbase вернул пустой список продуктов FUTURE/PERPETUAL');
      return [];
    }

    console.log(`✅ Получено ${products.length} фьючерсных PERP продуктов`);

    const futures = [];

    for (const p of products) {
      try {
        // названия полей могут немного отличаться, но по докам примерно так:
        const productId = p.product_id || p.productId;
        const productType = p.product_type || p.productType;
        const expiryType = p.contract_expiry_type || (p.future_product_details && p.future_product_details.contract_expiry_type);

        if (productType !== 'FUTURE') continue;
        if (expiryType && expiryType !== 'PERPETUAL') continue;

        const price = parseFloat(p.price || p.price_24h || p.current_price);
        const change24 = parseFloat(p.price_percentage_change_24h || p.price_change_24h || 0);
        const quoteVol = parseFloat(p.quote_volume_24h || p.volume_24h_quote || 0);
        const baseVol = parseFloat(p.volume_24h || p.volume_in_base_24h || 0);

        const volumeValue = Number.isFinite(quoteVol) && quoteVol > 0
          ? quoteVol
          : (Number.isFinite(price) && price > 0 ? baseVol * price : 0);

        if (!productId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(volumeValue) || volumeValue < CONFIG.minVolume) {
          continue;
        }

        futures.push({
          productId,
          symbol: productId,
          price,
          change: change24,
          volumeBase24: baseVol,
          volumeQuote24: quoteVol,
          volumeValue,
          lastUpdate: Date.now(),
          isReal: true,
          source: 'CoinbaseAdvanced'
        });
      } catch (err) {
        console.log('⚠️ Ошибка парсинга продукта Coinbase FUTURE:', err.message);
        continue;
      }
    }

    console.log(`✅ Отфильтровано ${futures.length} PERPETUAL FUTURES с достаточным объёмом`);

    return futures;
  } catch (error) {
    console.error('❌ Ошибка Coinbase /market/products:', error.message);
    if (error.response) {
      console.error('Статус:', error.response.status);
      console.error('Ответ:', JSON.stringify(error.response.data).slice(0, 300));
    }
    return [];
  }
}

// Получаем свечи по продукту (15m) с Advanced Trade public candles
async function getCoinbaseCandles(productId, granularitySec = CONFIG.candlesGranularity) {
  try {
    const response = await axios.get(
      `${CONFIG.apiUrl}/market/products/${encodeURIComponent(productId)}/candles`,
      {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache'
        },
        params: {
          granularity: granularitySec
        }
      }
    );

    let candles = response.data || [];

    if (!Array.isArray(candles) || !candles.length) {
      console.log(`ℹ️ Пустые свечи для ${productId}`);
      return [];
    }

    // Advanced Trade может вернуть либо массив массивов, либо объектов
    const parsed = candles.map(c => {
      if (Array.isArray(c)) {
        // формат, похожий на старый Coinbase Exchange:
        // [ time, low, high, open, close, volume ]
        const time = c[0];
        const low = parseFloat(c[1]);
        const high = parseFloat(c[2]);
        const open = parseFloat(c[3]);
        const close = parseFloat(c[4]);
        const volume = parseFloat(c[5]);

        if (
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close) ||
          !Number.isFinite(volume)
        ) return null;

        return { time, open, high, low, close, volume };
      } else if (typeof c === 'object' && c !== null) {
        // возможный объектный формат
        const open = parseFloat(c.open);
        const high = parseFloat(c.high);
        const low = parseFloat(c.low);
        const close = parseFloat(c.close);
        const volume = parseFloat(c.volume);
        const time = c.start_time || c.time;

        if (
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close) ||
          !Number.isFinite(volume)
        ) return null;

        return { time, open, high, low, close, volume };
      }

      return null;
    }).filter(Boolean);

    if (!parsed.length) {
      console.log(`ℹ️ Не удалось распарсить свечи ${productId}`);
      return [];
    }

    return parsed;
  } catch (error) {
    console.error(`❌ Ошибка свечей ${productId}:`, error.message);
    return [];
  }
}

// Получаем пары для сканирования: ТОП 20 рост и ТОП 20 падение по 24h change
async function getPairsForScanning() {
  const allFuts = await getCoinbasePerpProducts();

  if (!allFuts.length) {
    console.log('❌ Нет PERPETUAL FUTURES для сканирования');
    return [];
  }

  console.log(`📊 Использую ${allFuts.length} PERP фьючерсов для отбора TOP 20/20`);

  const topGainers = [...allFuts]
    .sort((a, b) => b.change - a.change)
    .slice(0, CONFIG.topCoinsCount);

  const topLosers = [...allFuts]
    .sort((a, b) => a.change - b.change)
    .slice(0, CONFIG.topCoinsCount);

  const combined = [...topGainers, ...topLosers];
  const seen = new Set();
  const unique = [];

  for (const p of combined) {
    if (!seen.has(p.productId)) {
      seen.add(p.productId);
      unique.push(p);
    }
  }

  console.log(`🔍 Для сканирования отобрано ${unique.length} уникальных PERP фьючерсов`);

  if (unique.length) {
    const s = unique[0];
    console.log(`📊 Пример: ${s.productId} $${s.price} (${s.change > 0 ? '+' : ''}${s.change.toFixed(2)}%)`);
  }

  return unique;
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
  if (!Number.isFinite(avgVolume) || avgVolume === 0) return 1;
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
  if (!Number.isFinite(priceRange) || priceRange === 0) {
    return { nearSupport: false, nearResistance: false };
  }

  const pos = (currentPrice - support) / priceRange;

  return {
    nearSupport: pos < 0.3,
    nearResistance: pos > 0.7,
    support,
    resistance
  };
}

// ==================== АНАЛИЗ ПАРЫ ====================
async function analyzePairForSignal(pair) {
  try {
    const now = Date.now();
    const lastSignalTime = sentSignals.get(pair.productId);

    if (lastSignalTime && now - lastSignalTime < SIGNAL_COOLDOWN) {
      return null;
    }

    const klines = await getCoinbaseCandles(pair.productId, CONFIG.candlesGranularity);
    if (!klines || klines.length < 25) {
      console.log(`ℹ️ Недостаточно свечей для ${pair.productId}`);
      return null;
    }

    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    const volumes = klines.map(k => k.volume);

    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

    const rsi = calculateRSI(closes);
    const recentVolumes = volumes.slice(-20);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeSpike = calculateVolumeSpike(currentVolume, avgVolume);
    const sr = calculateSupportResistance(highs, lows, currentPrice);

    let longScore = 0;
    let longReasons = [];
    let shortScore = 0;
    let shortReasons = [];

    // LONG
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

    // SHORT
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
      shortReasons.push(`Рядом с сопротивлением ~ $${sr.resistance.toFixed(4)}`);
    }
    if (pair.change < -CONFIG.minChangeForSignal) {
      shortScore += 15;
      shortReasons.push(`Падение за 24ч ${Math.abs(pair.change).toFixed(1)}%`);
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

    sentSignals.set(pair.productId, now);

    return {
      pair: pair.productId,
      symbol: pair.productId,
      signal: potentialSignal,
      entry: entry.toFixed(8),
      tp: tp.toFixed(8),
      sl: sl.toFixed(8),
      confidence: Math.round(confidence),
      rrRatio,
      tier,
      change24h: pair.change.toFixed(2),
      volume24h: (pair.volumeValue / 1_000_000).toFixed(2) + 'M',
      rsi: Math.round(rsi),
      volumeSpike: volumeSpike.toFixed(1),
      reasons,
      timestamp: new Date(),
      isRealData: true,
      source: 'CoinbaseAdvanced'
    };
  } catch (error) {
    console.error(`❌ Ошибка анализа ${pair.productId}:`, error.message);
    return null;
  }
}

// ==================== АВТОСКАН ====================
async function performAutoScan() {
  console.log('\n' + '='.repeat(60));
  console.log('🎯 АВТОМАТИЧЕСКОЕ СКАНИРОВАНИЕ COINBASE PERP FUTURES');
  console.log('='.repeat(60));

  const start = Date.now();

  try {
    console.log('📡 Получение PERP продуктов...');
    const pairsToScan = await getPairsForScanning();

    if (!pairsToScan.length) {
      console.log('❌ Нет данных для сканирования');
      await sendStatusToChat('❌ Нет данных PERP FUTURES от Coinbase. Сигналы не отправлялись.');
      return;
    }

    console.log(`📊 Анализ ${pairsToScan.length} перпетульных фьючерсов...`);

    const allSignals = [];

    for (let i = 0; i < pairsToScan.length; i++) {
      const p = pairsToScan[i];
      console.log(
        `🔍 [${i + 1}/${pairsToScan.length}] ${p.productId} $${p.price} (${p.change > 0 ? '+' : ''}${p.change.toFixed(2)}%)`
      );

      const signal = await analyzePairForSignal(p);
      if (signal) {
        allSignals.push(signal);
        console.log(`✅ Сигнал: ${signal.signal} ${signal.pair} (${signal.confidence}%)`);
      }

      if (i < pairsToScan.length - 1) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    allSignals.sort((a, b) => b.confidence - a.confidence);
    const signalsToSend = allSignals.slice(0, CONFIG.maxSignalsPerScan);

    if (signalsToSend.length) {
      console.log(`📤 Отправка ${signalsToSend.length} сигналов...`);

      await sendStatusToChat(
        `🔍 Найдено ${allSignals.length} потенциальных сигналов, отправляю топ ${signalsToSend.length}.`
      );

      for (const s of signalsToSend) {
        await sendSignalToChat(s);
        await new Promise(r => setTimeout(r, 1500));
      }

      console.log(`✅ Сигналы отправлены`);
    } else {
      console.log('ℹ️ Сигналы не найдены по текущим условиям');
      await sendStatusToChat('ℹ️ Сигналов не найдено на текущем сканировании');
    }

    const scanTime = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`⏱ Время сканирования: ${scanTime} сек`);
    console.log(`📊 Всего сигналов найдено: ${allSignals.length}`);
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ Ошибка автосканирования:', error.message);
    await sendStatusToChat(`❌ Ошибка сканирования: ${error.message}`);
  }
}

// ==================== ОТПРАВКА В ТЕЛЕГУ ====================
async function sendSignalToChat(signal) {
  try {
    const emoji = signal.signal === 'LONG' ? '🟢' : '🔴';
    const dataSource = '✅ РЕАЛЬНЫЕ ДАННЫЕ COINBASE ADVANCED (PUBLIC)';

    const message = `
${emoji} <b>${signal.tier} СИГНАЛ PERPETUAL FUTURES</b>

${dataSource}
🏦 <b>Биржа:</b> ${CONFIG.exchange}
📊 <b>Инструмент:</b> <code>${signal.pair}</code>
🎯 <b>Тип:</b> <b>${signal.signal}</b>

💰 <b>Текущая цена:</b> $${signal.entry}
📈 <b>Изменение 24ч:</b> ${signal.change24h > 0 ? '+' : ''}${signal.change24h}%
💎 <b>24h объём:</b> ~$${signal.volume24h}

🎯 <b>Вход:</b> $${signal.entry}
✅ <b>TP:</b> $${signal.tp}
🛑 <b>SL:</b> $${signal.sl}

📊 <b>RR:</b> ${signal.rrRatio}
🔮 <b>Уверенность:</b> ${signal.confidence}%
📈 <b>RSI:</b> ${signal.rsi}
📊 <b>Объём / средний:</b> x${signal.volumeSpike}

📋 <b>Причины:</b>
${signal.reasons.map(r => `• ${r}`).join('\n')}

⏰ <b>Время:</b> ${signal.timestamp.toLocaleTimeString('ru-RU')}
📅 <b>Дата:</b> ${signal.timestamp.toLocaleDateString('ru-RU')}

⚠️ <i>Фьючерсы с плечом = высокий риск. Не финансовый совет.</i>
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

<i>Следующее автосканирование через 5 минут</i>
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
🤖 <b>Coinbase Perpetual Futures Signals Bot</b>

✅ Перпетульные фьючерсы Coinbase Advanced
✅ Автоскан каждые 5 минут
📊 Пары: ТОП ${CONFIG.topCoinsCount} роста + ТОП ${CONFIG.topCoinsCount} падения по 24ч

<b>Команды:</b>
/scan - сканировать сейчас
/top  - показать TOP 10 роста/падения
/status - статус бота
/test - проверить доступность Coinbase API
/stats - статистика сигналов (по количеству инструментов)
  `.trim(),
    { parse_mode: 'HTML' }
  );
});

bot.command('scan', async (ctx) => {
  try {
    await ctx.reply('🚀 Запускаю сканирование Coinbase PERP...');
    console.log('🚀 Ручное сканирование /scan');
    performAutoScan();
  } catch (error) {
    await ctx.reply(`❌ Ошибка: ${error.message}`);
  }
});

bot.command('top', async (ctx) => {
  try {
    await ctx.reply('📊 Получаю TOP PERP FUTURES с Coinbase...');

    const products = await getCoinbasePerpProducts();
    if (!products.length) {
      await ctx.reply('❌ Нет данных PERP FUTURES от Coinbase');
      return;
    }

    const topGainers = [...products]
      .sort((a, b) => b.change - a.change)
      .slice(0, 10);

    const topLosers = [...products]
      .sort((a, b) => a.change - b.change)
      .slice(0, 10);

    let message = `📈 <b>ТОП 10 РОСТА (PERP FUTURES)</b>\n\n`;

    topGainers.forEach((t, i) => {
      message += `${i + 1}. <b>${t.productId}</b>\n`;
      message += `   💰 $${t.price.toFixed(4)}\n`;
      message += `   📈 +${t.change.toFixed(2)}%\n`;
      message += `   💎 Объем: ~$${(t.volumeValue / 1_000_000).toFixed(2)}M\n\n`;
    });

    message += `📉 <b>ТОП 10 ПАДЕНИЯ (PERP FUTURES)</b>\n\n`;

    topLosers.forEach((t, i) => {
      message += `${i + 1}. <b>${t.productId}</b>\n`;
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
⏰ Следующее автосканирование: через ${nextScanMinutes} мин
📨 Инструментов с cooldown (уже был сигнал): ${sentSignals.size}

🕒 Время: ${now.toLocaleTimeString('ru-RU')}
  `.trim();

  await ctx.reply(statusMessage, { parse_mode: 'HTML' });
});

bot.command('test', async (ctx) => {
  try {
    await ctx.reply('🔄 Проверяю публичный Coinbase Advanced API (FUTURE/PERPETUAL)...');

    const products = await getCoinbasePerpProducts();

    if (products.length > 0) {
      let msg = `✅ <b>Coinbase Advanced публичный API работает!</b>\n\n`;
      msg += `📊 PERP продуктов с объёмом: ${products.length}\n\n`;
      msg += `<b>Примеры:</b>\n`;

      products.slice(0, 3).forEach((p, i) => {
        msg += `${i + 1}. <b>${p.productId}</b>\n`;
        msg += `   💰 $${p.price.toFixed(4)}\n`;
        msg += `   📈 ${p.change > 0 ? '+' : ''}${p.change.toFixed(2)}%\n\n`;
      });

      await ctx.reply(msg, { parse_mode: 'HTML' });
    } else {
      await ctx.reply('❌ PERP продукты не найдены. Возможно, Coinbase сейчас не отдаёт данные или нет доступа к PERPETUAL FUTURES в твоём регионе.', {
        parse_mode: 'HTML'
      });
    }
  } catch (error) {
    await ctx.reply(`❌ Ошибка теста: ${error.message}`);
  }
});

bot.command('stats', async (ctx) => {
  const msg = `
📈 <b>СТАТИСТИКА СИГНАЛОВ (СЕССИЯ)</b>

Уникальных PERP инструментов, по которым уже был сигнал (под cooldown): ${sentSignals.size}
  `.trim();

  await ctx.reply(msg, { parse_mode: 'HTML' });
});

// ==================== ЗАПУСК ====================
async function startBot() {
  try {
    console.log('🚀 Старт бота Coinbase PERP...');

    console.log('📡 Тестовый запрос PERP продуктов...');
    const testProducts = await getCoinbasePerpProducts();

    if (testProducts.length) {
      console.log(`✅ Найдено PERP продуктов: ${testProducts.length}`);
      const s = testProducts[0];
      console.log(`📊 Пример: ${s.productId} $${s.price} (${s.change > 0 ? '+' : ''}${s.change.toFixed(2)}%)`);
    } else {
      console.log('⚠️ PERP продукты не найдены, но бот всё равно запустится и будет пробовать на следующих сканах.');
    }

    await bot.launch();
    console.log('✅ Telegram бот запущен');

    console.log('⏰ Настраиваю автосканирование каждые 5 минут...');
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
    console.log(`✅ Автосканирование активно: ${CONFIG.scanInterval}`);

    setTimeout(() => {
      console.log('\n🚀 Первое сканирование через 30 секунд...');
    }, 30000);

    setTimeout(() => {
      console.log('\n🚀 ЗАПУСК ПЕРВОГО СКАНИРОВАНИЯ');
      performAutoScan();
    }, 35000);

    console.log('\n' + '='.repeat(60));
    console.log('🤖 БОТ ЗАПУЩЕН И РАБОТАЕТ НА COINBASE PERPETUAL FUTURES (PUBLIC API, БЕЗ КЛЮЧЕЙ)');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('❌ Ошибка запуска бота:', error);
    process.exit(1);
  }
}

startBot();
