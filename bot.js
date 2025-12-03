import os
import logging
import time
import json
from datetime import datetime, timedelta
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass, asdict

import requests
from telegram import Update
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    ContextTypes,
    JobQueue,
)
from telegram.constants import ParseMode

# =======================
# КОНФИГУРАЦИЯ
# =======================

@dataclass
class Config:
    TELEGRAM_TOKEN: str = os.environ.get("TELEGRAM_TOKEN", "")
    CHANNEL_ID: str = os.environ.get("CHANNEL_ID", "-100xxxxxx")
    TOP_LIMIT: int = int(os.environ.get("TOP_LIMIT", "12"))
    RR_MIN: float = float(os.environ.get("RR_MIN", "3.5"))
    AUTO_INTERVAL_SECONDS: int = int(os.environ.get("AUTO_INTERVAL", "300"))
    KLINE_INTERVAL: str = os.environ.get("KLINE_INTERVAL", "15m")
    KLINE_LIMIT: int = int(os.environ.get("KLINE_LIMIT", "150"))
    
    # Новые настройки
    MIN_QUOTE_VOLUME: float = float(os.environ.get("MIN_QUOTE_VOLUME", "10000000"))
    MAX_FUNDING_RATE: float = float(os.environ.get("MAX_FUNDING_RATE", "0.001"))
    ENABLE_AUTO_SIGNALS: bool = os.environ.get("ENABLE_AUTO_SIGNALS", "true").lower() == "true"

config = Config()
BINANCE_FAPI_URL = "https://fapi.binance.com"

# =======================
# ТЕМАТИЧЕСКИЕ ЭМОДЗИ ДЛЯ ОФОРМЛЕНИЯ
# =======================

class EmojiTheme:
    # Основные блоки
    HEADER = "🎯"  # Заголовок сигнала
    SEPARATOR = "─" * 30
    
    # Направления
    LONG = "🟢📈🚀"  # LONG сигнал
    SHORT = "🔴📉⬇️"   # SHORT сигнал
    
    # Параметры
    ENTRY = "🎯"      # Точка входа
    STOP_LOSS = "🛑"   # Стоп-лосс
    TAKE_PROFIT = "✅" # Тейк-профит
    RISK_REWARD = "⚖️"  # Риск-профит
    
    # Индикаторы
    TREND = "📊"      # Тренд
    VOLUME = "📈"     # Объем
    RSI = "📉"        # RSI
    ATR = "📏"        # ATR/Волатильность
    FUNDING = "💰"    # Фандинг
    OI = "📊"         # Open Interest
    
    # Статусы
    SUCCESS = "✅"
    WARNING = "⚠️"
    ERROR = "❌"
    INFO = "ℹ️"
    
    # Дополнительные
    FIRE = "🔥"
    ROCKET = "🚀"
    CHART = "📊"
    MONEY = "💸"
    CLOCK = "⏰"
    BELL = "🔔"
    TARGET = "🎯"
    SHIELD = "🛡️"
    
    # Разделители
    SECTION_START = "┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    SECTION_MID = "┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    SECTION_END = "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# =======================
# ЛОГИРОВАНИЕ
# =======================

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
    handlers=[
        logging.FileHandler('crypto_bot.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# =======================
# КЛАСС ДЛЯ УПРАВЛЕНИЯ СОСТОЯНИЕМ
# =======================

class BotState:
    """Хранение состояния бота и статистики"""
    
    def __init__(self):
        self.start_time = datetime.now()
        self.signals_sent = 0
        self.last_update = None
        self.successful_scans = 0
        self.failed_scans = 0
        
    def add_signal(self):
        self.signals_sent += 1
        
    def add_scan(self, success=True):
        if success:
            self.successful_scans += 1
        else:
            self.failed_scans += 1
        self.last_update = datetime.now()

bot_state = BotState()

# =======================
# УТИЛИТЫ ДЛЯ ДАННЫХ (BINANCE FUTURES)
# =======================

def fetch_futures_24h_tickers() -> List[Dict]:
    """Получение 24h тикеров по фьючам USDT-M"""
    url = f"{BINANCE_FAPI_URL}/fapi/v1/ticker/24hr"
    try:
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        # Фильтруем только USDT-пары без даты
        return [
            item for item in data 
            if item.get("symbol", "").endswith("USDT") 
            and "_" not in item.get("symbol", "")
        ]
    except Exception as e:
        logger.error(f"Ошибка при получении тикеров: {e}")
        return []

def get_top_movers(limit: int = 15) -> Tuple[List[Dict], List[Dict]]:
    """Топ рост и падение по фьючерсам за 24ч"""
    tickers = fetch_futures_24h_tickers()
    
    for t in tickers:
        try:
            t["change_percent"] = float(t.get("priceChangePercent", 0.0))
            t["volume"] = float(t.get("volume", 0.0))
            t["quoteVolume"] = float(t.get("quoteVolume", 0.0))
            t["lastPrice"] = float(t.get("lastPrice", 0.0))
        except (ValueError, TypeError):
            t["change_percent"] = 0.0
            t["volume"] = 0.0
            t["quoteVolume"] = 0.0
            t["lastPrice"] = 0.0
    
    # Сортируем по проценту изменения
    sorted_by_change = sorted(tickers, key=lambda x: x["change_percent"], reverse=True)
    top_gainers = sorted_by_change[:limit]
    
    sorted_by_change_asc = sorted(tickers, key=lambda x: x["change_percent"])
    top_losers = sorted_by_change_asc[:limit]
    
    return top_gainers, top_losers

def fetch_klines(symbol: str, interval: str = config.KLINE_INTERVAL, limit: int = config.KLINE_LIMIT) -> List[List]:
    """Получение свечей для анализа"""
    url = f"{BINANCE_FAPI_URL}/fapi/v1/klines"
    params = {"symbol": symbol, "interval": interval, "limit": limit}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.error(f"Ошибка при получении свечей {symbol}: {e}")
        return []

def fetch_open_interest(symbol: str) -> float:
    """Open Interest по фьючерсам"""
    url = f"{BINANCE_FAPI_URL}/fapi/v1/openInterest"
    params = {"symbol": symbol}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return float(data.get("openInterest", 0.0))
    except Exception as e:
        logger.warning(f"Ошибка при получении OI {symbol}: {e}")
        return 0.0

def fetch_funding_info(symbol: str) -> Dict:
    """Funding rate и mark price"""
    url = f"{BINANCE_FAPI_URL}/fapi/v1/premiumIndex"
    params = {"symbol": symbol}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        return {
            "funding_rate": float(data.get("lastFundingRate", 0.0)),
            "mark_price": float(data.get("markPrice", 0.0)),
            "next_funding_time": data.get("nextFundingTime", 0)
        }
    except Exception as e:
        logger.warning(f"Ошибка при получении funding {symbol}: {e}")
        return {"funding_rate": 0.0, "mark_price": 0.0, "next_funding_time": 0}

def fetch_single_ticker(symbol: str) -> Dict:
    """Тикер для одного символа"""
    url = f"{BINANCE_FAPI_URL}/fapi/v1/ticker/24hr"
    params = {"symbol": symbol}
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        
        # Нормализация полей
        try:
            data["change_percent"] = float(data.get("priceChangePercent", 0.0))
            data["volume"] = float(data.get("volume", 0.0))
            data["quoteVolume"] = float(data.get("quoteVolume", 0.0))
            data["lastPrice"] = float(data.get("lastPrice", 0.0))
            data["highPrice"] = float(data.get("highPrice", 0.0))
            data["lowPrice"] = float(data.get("lowPrice", 0.0))
        except (ValueError, TypeError):
            data.update({
                "change_percent": 0.0,
                "volume": 0.0,
                "quoteVolume": 0.0,
                "lastPrice": 0.0,
                "highPrice": 0.0,
                "lowPrice": 0.0
            })
        return data
    except Exception as e:
        logger.error(f"Ошибка при получении тикера {symbol}: {e}")
        raise

# =======================
# ИНДИКАТОРЫ
# =======================

def ema(values: List[float], period: int) -> List[float]:
    """Экспоненциальное скользящее среднее"""
    if not values or len(values) < period:
        return values[:]
    
    k = 2 / (period + 1)
    result = [values[0]]
    
    for price in values[1:]:
        prev = result[-1]
        result.append(price * k + prev * (1 - k))
    
    return result

def rsi(values: List[float], period: int = 14) -> List[float]:
    """Индекс относительной силы"""
    if len(values) < period + 1:
        return [50.0] * len(values)
    
    deltas = [values[i] - values[i - 1] for i in range(1, len(values))]
    gains = [max(d, 0) for d in deltas]
    losses = [max(-d, 0) for d in deltas]
    
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period if sum(losses[:period]) != 0 else 1e-9
    
    rsis = [50.0] * period
    rs = avg_gain / avg_loss
    rsis.append(100 - (100 / (1 + rs)))
    
    for i in range(period, len(deltas)):
        gain = gains[i]
        loss = losses[i]
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period if avg_loss != 0 else 1e-9
        rs = avg_gain / avg_loss
        rsis.append(100 - (100 / (1 + rs)))
    
    while len(rsis) < len(values):
        rsis.insert(0, 50.0)
    
    return rsis[-len(values):]

def atr(highs: List[float], lows: List[float], closes: List[float], period: int = 14) -> List[float]:
    """Average True Range"""
    if len(closes) < period + 1:
        return [0.0] * len(closes)
    
    trs = []
    for i in range(len(closes)):
        if i == 0:
            trs.append(highs[i] - lows[i])
        else:
            tr = max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
            trs.append(tr)
    
    atr_vals = []
    for i in range(len(trs)):
        if i < period:
            atr_vals.append(0.0)
        else:
            window = trs[i - period + 1: i + 1]
            atr_vals.append(sum(window) / period)
    
    return atr_vals

def calculate_support_resistance(highs: List[float], lows: List[float], closes: List[float], lookback: int = 20):
    """Определение уровней поддержки и сопротивления"""
    if len(closes) < lookback:
        return None, None
    
    recent_highs = highs[-lookback:]
    recent_lows = lows[-lookback:]
    
    resistance = max(recent_highs) if recent_highs else None
    support = min(recent_lows) if recent_lows else None
    
    return support, resistance

# =======================
# ГЕНЕРАЦИЯ СИГНАЛА
# =======================

def generate_signal(symbol: str, side_from_movers: str, ticker_info: Dict) -> Optional[Dict]:
    """Генерация торгового сигнала"""
    
    # Фильтр по минимальному объему
    if ticker_info.get("quoteVolume", 0) < config.MIN_QUOTE_VOLUME:
        return None
    
    try:
        klines = fetch_klines(symbol)
        if len(klines) < 50:
            return None
    except Exception as e:
        logger.warning(f"Не удалось получить свечи для {symbol}: {e}")
        return None
    
    # Извлечение данных
    closes = [float(k[4]) for k in klines]
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    volumes = [float(k[5]) for k in klines]
    
    # Расчет индикаторов
    ema_fast = ema(closes, 21)
    ema_slow = ema(closes, 55)
    rsi_vals = rsi(closes, 14)
    atr_vals = atr(highs, lows, closes, 14)
    support, resistance = calculate_support_resistance(highs, lows, closes)
    
    # Текущие значения
    last_close = closes[-1]
    last_ema_fast = ema_fast[-1]
    last_ema_slow = ema_slow[-1]
    last_rsi = rsi_vals[-1]
    last_atr = atr_vals[-1]
    avg_volume = sum(volumes[-50:]) / min(len(volumes), 50) if volumes else 0
    last_volume = volumes[-1] if volumes else 0
    
    # Дополнительные данные
    change_24h = ticker_info.get("change_percent", 0.0)
    quote_volume = ticker_info.get("quoteVolume", 0.0)
    high_24h = ticker_info.get("highPrice", 0.0)
    low_24h = ticker_info.get("lowPrice", 0.0)
    
    # Получение данных с биржи
    try:
        oi = fetch_open_interest(symbol)
        funding_info = fetch_funding_info(symbol)
        funding_rate = funding_info.get("funding_rate", 0.0)
        mark_price = funding_info.get("mark_price", last_close)
    except Exception as e:
        logger.warning(f"Ошибка при получении данных для {symbol}: {e}")
        oi = 0.0
        funding_rate = 0.0
        mark_price = last_close
    
    # Определение направления
    direction = "LONG" if side_from_movers == "LONG" else "SHORT"
    
    # Фильтры
    # 1. Тренд
    trend_long = last_close > last_ema_slow and last_ema_fast > last_ema_slow
    trend_short = last_close < last_ema_slow and last_ema_fast < last_ema_slow
    
    if direction == "LONG" and not trend_long:
        return None
    if direction == "SHORT" and not trend_short:
        return None
    
    # 2. RSI фильтр
    if direction == "LONG" and last_rsi > 75:
        return None
    if direction == "SHORT" and last_rsi < 25:
        return None
    
    # 3. Funding rate фильтр
    if direction == "LONG" and funding_rate > config.MAX_FUNDING_RATE:
        return None
    if direction == "SHORT" and funding_rate < -config.MAX_FUNDING_RATE:
        return None
    
    # 4. Volume spike
    volume_spike = last_volume > avg_volume * 1.3 if avg_volume > 0 else False
    
    # Расчет уровней
    if last_atr <= 0:
        last_atr = last_close * 0.003
    
    risk_distance = last_atr * 1.5
    
    if direction == "LONG":
        entry = last_close
        sl = entry - risk_distance
        tp = entry + (risk_distance * config.RR_MIN)
        
        # Корректировка по поддержке
        if support and support > sl and support < entry:
            sl = support * 0.995
        
        # Корректировка по сопротивлению
        if resistance and resistance > entry:
            tp = min(tp, resistance * 0.995)
    else:
        entry = last_close
        sl = entry + risk_distance
        tp = entry - (risk_distance * config.RR_MIN)
        
        # Корректировка по сопротивлению
        if resistance and resistance < sl and resistance > entry:
            sl = resistance * 1.005
        
        # Корректировка по поддержке
        if support and support < entry:
            tp = max(tp, support * 1.005)
    
    # Расчет RR
    if direction == "LONG":
        rr_ratio = (tp - entry) / (entry - sl) if (entry - sl) > 0 else 0
    else:
        rr_ratio = (entry - tp) / (sl - entry) if (sl - entry) > 0 else 0
    
    if rr_ratio < config.RR_MIN * 0.95:
        return None
    
    # Формирование сигнала
    signal = {
        "symbol": symbol,
        "direction": direction,
        "entry": round(entry, 6),
        "sl": round(sl, 6),
        "tp": round(tp, 6),
        "rr": round(rr_ratio, 2),
        "interval": config.KLINE_INTERVAL,
        "current_price": round(mark_price, 6),
        "change_24h": round(change_24h, 2),
        "volume_24h": quote_volume,
        "rsi": round(last_rsi, 2),
        "atr": round(last_atr, 6),
        "atr_percent": round((last_atr / last_close) * 100, 2),
        "funding_rate": round(funding_rate * 100, 4),
        "oi": oi,
        "volume_spike": volume_spike,
        "support": round(support, 6) if support else None,
        "resistance": round(resistance, 6) if resistance else None,
        "high_24h": high_24h,
        "low_24h": low_24h,
        "timestamp": datetime.now().isoformat()
    }
    
    return signal

# =======================
# КРАСИВОЕ ОФОРМЛЕНИЕ УВЕДОМЛЕНИЙ
# =======================

def format_price_change(change: float) -> str:
    """Форматирование изменения цены с эмодзи"""
    if change > 5:
        return f"🚀 +{change:.2f}%"
    elif change > 2:
        return f"📈 +{change:.2f}%"
    elif change > 0:
        return f"↗️ +{change:.2f}%"
    elif change < -5:
        return f"💥 {change:.2f}%"
    elif change < -2:
        return f"📉 {change:.2f}%"
    else:
        return f"↘️ {change:.2f}%"

def format_volume(volume: float) -> str:
    """Форматирование объема"""
    if volume >= 1_000_000_000:
        return f"{volume/1_000_000_000:.1f}B"
    elif volume >= 1_000_000:
        return f"{volume/1_000_000:.1f}M"
    elif volume >= 1_000:
        return f"{volume/1_000:.1f}K"
    return f"{volume:.0f}"

def format_funding_rate(rate: float) -> str:
    """Форматирование funding rate"""
    rate_percent = rate * 100
    if rate_percent > 0.03:
        return f"🔥 +{rate_percent:.4f}%"
    elif rate_percent > 0.01:
        return f"📈 +{rate_percent:.4f}%"
    elif rate_percent < -0.03:
        return f"❄️ {rate_percent:.4f}%"
    elif rate_percent < -0.01:
        return f"📉 {rate_percent:.4f}%"
    return f"⚖️ {rate_percent:.4f}%"

def format_rsi(rsi_value: float) -> str:
    """Форматирование RSI с эмодзи"""
    if rsi_value > 80:
        return f"🔴 {rsi_value:.1f} (Перекупленность)"
    elif rsi_value > 70:
        return f"🟡 {rsi_value:.1f} (Близко к перекупленности)"
    elif rsi_value < 20:
        return f"🟢 {rsi_value:.1f} (Перепроданность)"
    elif rsi_value < 30:
        return f"🟡 {rsi_value:.1f} (Близко к перепроданности)"
    return f"⚪️ {rsi_value:.1f} (Нейтрально)"

def create_signal_message(signal: Dict, is_auto: bool = False) -> str:
    """Создание красивого сообщения со сигналом"""
    
    direction_emoji = EmojiTheme.LONG if signal["direction"] == "LONG" else EmojiTheme.SHORT
    direction_text = "ЛОНГ" if signal["direction"] == "LONG" else "ШОРТ"
    
    # Заголовок
    if is_auto:
        header = f"{EmojiTheme.BELL} *АВТО-СИГНАЛ* {EmojiTheme.CLOCK}\n"
    else:
        header = f"{EmojiTheme.HEADER} *ТОРГОВЫЙ СИГНАЛ* {EmojiTheme.ROCKET}\n"
    
    header += f"{direction_emoji} *{direction_text}* | *{signal['symbol']}* | `{signal['interval']}`\n"
    header += EmojiTheme.SEPARATOR
    
    # Основные уровни
    levels = f"\n{EmojiTheme.SECTION_START}\n"
    levels += f"{EmojiTheme.ENTRY} *Вход:* `{signal['entry']}`\n"
    levels += f"{EmojiTheme.STOP_LOSS} *Стоп-лосс:* `{signal['sl']}` (-{abs((signal['sl']-signal['entry'])/signal['entry']*100):.2f}%)\n"
    levels += f"{EmojiTheme.TAKE_PROFIT} *Тейк-профит:* `{signal['tp']}` (+{abs((signal['tp']-signal['entry'])/signal['entry']*100):.2f}%)\n"
    
    # Риск-профит
    rr_color = "🟢" if signal["rr"] >= 3 else "🟡" if signal["rr"] >= 2 else "🔴"
    levels += f"{EmojiTheme.RISK_REWARD} *Риск-Профит:* {rr_color} `1:{signal['rr']}`\n"
    
    # Индикаторы
    indicators = f"\n{EmojiTheme.SECTION_MID}\n"
    indicators += f"{EmojiTheme.RSI} *RSI:* {format_rsi(signal['rsi'])}\n"
    indicators += f"{EmojiTheme.ATR} *Волатильность (ATR):* `{signal['atr_percent']:.2f}%`\n"
    indicators += f"{EmojiTheme.TREND} *Цена 24ч:* `{signal['low_24h']:.2f}` - `{signal['high_24h']:.2f}`\n"
    
    # Рыночные данные
    market = f"\n{EmojiTheme.SECTION_MID}\n"
    market += f"{EmojiTheme.CHART} *Изменение 24ч:* {format_price_change(signal['change_24h'])}\n"
    market += f"{EmojiTheme.VOLUME} *Объем 24ч:* `{format_volume(signal['volume_24h'])} USDT`\n"
    
    if signal['volume_spike']:
        market += f"{EmojiTheme.FIRE} *Объем выше среднего!*\n"
    
    market += f"{EmojiTheme.FUNDING} *Funding Rate:* {format_funding_rate(signal['funding_rate']/100)}\n"
    market += f"{EmojiTheme.OI} *Open Interest:* `{format_volume(signal['oi'])}`\n"
    
    # Уровни поддержки/сопротивления
    if signal.get('support') and signal.get('resistance'):
        levels_sr = f"\n{EmojiTheme.SECTION_MID}\n"
        levels_sr += f"🛡️ *Поддержка:* `{signal['support']}`\n"
        levels_sr += f"🎯 *Сопротивление:* `{signal['resistance']}`\n"
    else:
        levels_sr = ""
    
    # Таймстамп
    footer = f"\n{EmojiTheme.SECTION_END}\n"
    footer += f"{EmojiTheme.CLOCK} *Время сигнала:* {datetime.now().strftime('%H:%M:%S')}\n"
    footer += f"⚡️ *Текущая цена:* `{signal['current_price']}`\n"
    
    # Предупреждение
    warning = "\n\n⚠️ *ВНИМАНИЕ:* Торговля на бирже связана с рисками. Это не финансовый совет."
    
    return header + levels + indicators + market + levels_sr + footer + warning

def create_top_movers_message(gainers: List[Dict], losers: List[Dict]) -> str:
    """Создание сообщения с топом движущихся пар"""
    
    message = f"{EmojiTheme.CHART} *ТОП ДВИЖУЩИЕСЯ ФЬЮЧЕРСЫ* {EmojiTheme.ROCKET}\n"
    message += EmojiTheme.SEPARATOR + "\n\n"
    
    # Топ роста
    message += f"{EmojiTheme.LONG} *ТОП РОСТА (24ч):*\n"
    for i, item in enumerate(gainers[:5], 1):
        change = item.get('change_percent', 0)
        emoji = "🥇" if i == 1 else "🥈" if i == 2 else "🥉" if i == 3 else "🔸"
        message += f"{emoji} *{item['symbol']}*: {format_price_change(change)}\n"
    
    message += f"\n{EmojiTheme.SHORT} *ТОП ПАДЕНИЯ (24ч):*\n"
    for i, item in enumerate(losers[:5], 1):
        change = item.get('change_percent', 0)
        emoji = "🏴" if i == 1 else "🏳️" if i == 2 else "🎌" if i == 3 else "🔹"
        message += f"{emoji} *{item['symbol']}*: {format_price_change(change)}\n"
    
    message += f"\n{EmojiTheme.CLOCK} *Обновлено:* {datetime.now().strftime('%H:%M:%S')}"
    return message

def create_status_message() -> str:
    """Создание сообщения со статусом бота"""
    
    uptime = datetime.now() - bot_state.start_time
    hours, remainder = divmod(int(uptime.total_seconds()), 3600)
    minutes, seconds = divmod(remainder, 60)
    
    status = f"{EmojiTheme.INFO} *СТАТУС БОТА* {EmojiTheme.SHIELD}\n"
    status += EmojiTheme.SEPARATOR + "\n\n"
    
    status += f"🤖 *Бот работает:* {hours:02d}:{minutes:02d}:{seconds:02d}\n"
    status += f"📊 *Сигналов отправлено:* `{bot_state.signals_sent}`\n"
    status += f"✅ *Успешных сканирований:* `{bot_state.successful_scans}`\n"
    status += f"❌ *Неудачных сканирований:* `{bot_state.failed_scans}`\n"
    
    if bot_state.last_update:
        last_update_str = bot_state.last_update.strftime('%H:%M:%S')
        status += f"⏰ *Последнее обновление:* `{last_update_str}`\n"
    
    status += f"\n{EmojiTheme.TARGET} *Настройки:*\n"
    status += f"• Топ лимит: `{config.TOP_LIMIT}`\n"
    status += f"• Минимальный RR: `1:{config.RR_MIN}`\n"
    status += f"• Интервал авто: `{config.AUTO_INTERVAL_SECONDS//60} мин`\n"
    status += f"• Таймфрейм: `{config.KLINE_INTERVAL}`\n"
    
    status += f"\n{EmojiTheme.BELL} *Авто-сигналы:* {'ВКЛ' if config.ENABLE_AUTO_SIGNALS else 'ВЫКЛ'}"
    
    return status

# =======================
# TELEGRAM ХЕНДЛЕРЫ
# =======================

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /start"""
    
    welcome = f"""
{EmojiTheme.ROCKET} *ФЬЮЧЕРСНЫЙ ТРЕЙДИНГ БОТ* {EmojiTheme.MONEY}

Привет! Я бот для анализа фьючерсного рынка Binance.

{EmojiTheme.LONG} *Доступные команды:*
/start - Это меню
/top - Топ движущихся пар с сигналами
/signal [SYMBOL] - Сигнал по конкретной паре
/status - Статус бота и статистика
/scan - Быстрое сканирование рынка
/help - Помощь по командам

{EmojiTheme.CLOCK} *Автоматически каждые {config.AUTO_INTERVAL_SECONDS//60} минут:*
• Анализ топ-пар
• Отправка сигналов в канал

⚠️ *ВАЖНО:* Это инструмент для анализа, не финансовый совет.
Используйте на свой риск!
    """
    
    await update.message.reply_text(welcome, parse_mode=ParseMode.MARKDOWN)

async def top_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /top"""
    
    await update.message.reply_text(
        f"{EmojiTheme.CLOCK} Сканирую топ фьючерсов...", 
        parse_mode=ParseMode.MARKDOWN
    )
    
    try:
        top_gainers, top_losers = get_top_movers(limit=config.TOP_LIMIT)
        bot_state.add_scan(success=True)
        
        # Отправляем топ движущихся
        top_message = create_top_movers_message(top_gainers, top_losers)
        await update.message.reply_text(top_message, parse_mode=ParseMode.MARKDOWN)
        
        # Ищем сигналы
        signals_long = []
        for item in top_gainers[:8]:  # Только первые 8 для скорости
            symbol = item["symbol"]
            signal = generate_signal(symbol, "LONG", item)
            if signal:
                signals_long.append(signal)
        
        signals_short = []
        for item in top_losers[:8]:
            symbol = item["symbol"]
            signal = generate_signal(symbol, "SHORT", item)
            if signal:
                signals_short.append(signal)
        
        # Сортируем по объему
        signals_long.sort(key=lambda x: x["volume_24h"], reverse=True)
        signals_short.sort(key=lambda x: x["volume_24h"], reverse=True)
        
        # Отправляем сигналы
        if signals_long:
            await update.message.reply_text(
                f"{EmojiTheme.LONG} *НАЙДЕНО {len(signals_long)} LONG СИГНАЛОВ:*",
                parse_mode=ParseMode.MARKDOWN
            )
            for signal in signals_long[:3]:  # Максимум 3 сигнала
                message = create_signal_message(signal)
                await update.message.reply_text(message, parse_mode=ParseMode.MARKDOWN)
                bot_state.add_signal()
        
        if signals_short:
            await update.message.reply_text(
                f"{EmojiTheme.SHORT} *НАЙДЕНО {len(signals_short)} SHORT СИГНАЛОВ:*",
                parse_mode=ParseMode.MARKDOWN
            )
            for signal in signals_short[:3]:
                message = create_signal_message(signal)
                await update.message.reply_text(message, parse_mode=ParseMode.MARKDOWN)
                bot_state.add_signal()
        
        if not signals_long and not signals_short:
            await update.message.reply_text(
                f"{EmojiTheme.INFO} *Сигналов не найдено*\n"
                "Попробуйте позже или измените настройки фильтров.",
                parse_mode=ParseMode.MARKDOWN
            )
            
    except Exception as e:
        logger.error(f"Ошибка в команде /top: {e}")
        bot_state.add_scan(success=False)
        await update.message.reply_text(
            f"{EmojiTheme.ERROR} *Ошибка при сканировании*\n"
            f"Детали: {str(e)[:100]}...",
            parse_mode=ParseMode.MARKDOWN
        )

async def signal_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /signal"""
    
    if not context.args:
        await update.message.reply_text(
            f"{EmojiTheme.ERROR} Укажите символ!\n"
            f"Пример: `/signal BTCUSDT` или `/signal ETH`",
            parse_mode=ParseMode.MARKDOWN
        )
        return
    
    raw_symbol = context.args[0].upper().strip()
    if not raw_symbol.endswith("USDT"):
        raw_symbol += "USDT"
    
    await update.message.reply_text(
        f"{EmojiTheme.CLOCK} Анализирую {raw_symbol}...",
        parse_mode=ParseMode.MARKDOWN
    )
    
    try:
        ticker = fetch_single_ticker(raw_symbol)
        change = ticker.get("change_percent", 0.0)
        side = "LONG" if change >= 0 else "SHORT"
        
        signal = generate_signal(raw_symbol, side, ticker)
        
        if signal:
            message = create_signal_message(signal)
            await update.message.reply_text(message, parse_mode=ParseMode.MARKDOWN)
            bot_state.add_signal()
        else:
            await update.message.reply_text(
                f"{EmojiTheme.INFO} *Сигнал не найден для {raw_symbol}*\n"
                "Возможные причины:\n"
                "• Слишком низкий объем\n"
                "• Не проходит фильтры (RSI, funding, тренд)\n"
                "• Слишком низкий риск-профит",
                parse_mode=ParseMode.MARKDOWN
            )
            
    except Exception as e:
        logger.error(f"Ошибка в команде /signal {raw_symbol}: {e}")
        await update.message.reply_text(
            f"{EmojiTheme.ERROR} *Ошибка анализа {raw_symbol}*\n"
            "Проверьте правильность символа.",
            parse_mode=ParseMode.MARKDOWN
        )

async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /status"""
    message = create_status_message()
    await update.message.reply_text(message, parse_mode=ParseMode.MARKDOWN)

async def scan_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /scan - быстрая проверка"""
    
    await update.message.reply_text(
        f"{EmojiTheme.CLOCK} Быстрое сканирование рынка...",
        parse_mode=ParseMode.MARKDOWN
    )
    
    try:
        top_gainers, top_losers = get_top_movers(limit=8)
        
        # Проверяем только самые сильные движения
        strong_gainers = [g for g in top_gainers[:3] if abs(g.get('change_percent', 0)) > 3]
        strong_losers = [l for l in top_losers[:3] if abs(l.get('change_percent', 0)) > 3]
        
        if not strong_gainers and not strong_losers:
            await update.message.reply_text(
                f"{EmojiTheme.INFO} *Нет сильных движений на рынке*\n"
                "Все изменения в пределах ±3%",
                parse_mode=ParseMode.MARKDOWN
            )
            return
        
        message = f"{EmojiTheme.BELL} *СКАНИРОВАНИЕ ЗАВЕРШЕНО*\n\n"
        
        if strong_gainers:
            message += f"{EmojiTheme.LONG} *Сильный рост:*\n"
            for g in strong_gainers:
                message += f"• {g['symbol']}: {format_price_change(g['change_percent'])}\n"
        
        if strong_losers:
            message += f"\n{EmojiTheme.SHORT} *Сильное падение:*\n"
            for l in strong_losers:
                message += f"• {l['symbol']}: {format_price_change(l['change_percent'])}\n"
        
        message += f"\n{EmojiTheme.CLOCK} *Рекомендация:* "
        if len(strong_gainers) > len(strong_losers):
            message += "Преобладает бычий настрой"
        elif len(strong_losers) > len(strong_gainers):
            message += "Преобладает медвежий настрой"
        else:
            message += "Рынок в балансе"
        
        await update.message.reply_text(message, parse_mode=ParseMode.MARKDOWN)
        
    except Exception as e:
        logger.error(f"Ошибка в команде /scan: {e}")
        await update.message.reply_text(
            f"{EmojiTheme.ERROR} Ошибка сканирования",
            parse_mode=ParseMode.MARKDOWN
        )

async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик команды /help"""
    
    help_text = f"""
{EmojiTheme.INFO} *ПОМОЩЬ ПО КОМАНДАМ* {EmojiTheme.SHIELD}

{EmojiTheme.TARGET} *Основные команды:*
/start - Запуск бота и меню
/top - Топ пар с автоматическим поиском сигналов
/signal [SYMBOL] - Полный анализ конкретной пары
/status - Статистика и настройки бота
/scan - Быстрая проверка сильных движений
/help - Эта справка

{EmojiTheme.CHART} *Примеры использования:*
• `/top` - найти лучшие сигналы
• `/signal BTCUSDT` - анализ Bitcoin
• `/signal ETH` - анализ Ethereum (USDT добавится автоматически)

{EmojiTheme.CLOCK} *Автоматический режим:*
Бот каждые {config.AUTO_INTERVAL_SECONDS//60} минут сканирует рынок и отправляет сигналы в канал.

{EmojiTheme.WARNING} *Фильтры сигналов:*
• Минимальный RR: 1:{config.RR_MIN}
• Проверка тренда (EMA 21/55)
• Фильтр RSI (исключает перекупленность/перепроданность)
• Проверка funding rate
• Минимальный объем: {config.MIN_QUOTE_VOLUME:,.0f} USDT

⚠️ *ПРЕДУПРЕЖДЕНИЕ:*
Это инструмент технического анализа. Все торговые решения принимайте самостоятельно.
    """
    
    await update.message.reply_text(help_text, parse_mode=ParseMode.MARKDOWN)

# =======================
# ФОНОВЫЙ МОНИТОРИНГ
# =======================

async def background_monitoring(context: ContextTypes.DEFAULT_TYPE):
    """Автоматический мониторинг рынка"""
    
    if not config.ENABLE_AUTO_SIGNALS:
        return
    
    bot = context.application.bot
    
    try:
        logger.info("Запуск автоматического сканирования...")
        top_gainers, top_losers = get_top_movers(limit=config.TOP_LIMIT)
        
        # Поиск сигналов
        all_signals = []
        
        # Проверяем топ роста для LONG
        for item in top_gainers[:6]:
            signal = generate_signal(item["symbol"], "LONG", item)
            if signal:
                all_signals.append(signal)
        
        # Проверяем топ падения для SHORT
        for item in top_losers[:6]:
            signal = generate_signal(item["symbol"], "SHORT", item)
            if signal:
                all_signals.append(signal)
        
        # Сортируем по объему и отправляем
        all_signals.sort(key=lambda x: x["volume_24h"], reverse=True)
        
        if all_signals:
            # Отправляем максимум 3 лучших сигнала
            for signal in all_signals[:3]:
                message = create_signal_message(signal, is_auto=True)
                try:
                    await bot.send_message(
                        chat_id=config.CHANNEL_ID,
                        text=message,
                        parse_mode=ParseMode.MARKDOWN
                    )
                    bot_state.add_signal()
                    logger.info(f"Авто-сигнал отправлен: {signal['symbol']}")
                    # Пауза между сообщениями
                    await asyncio.sleep(1)
                except Exception as e:
                    logger.error(f"Ошибка отправки авто-сигнала: {e}")
        
        bot_state.add_scan(success=True)
        logger.info(f"Авто-сканирование завершено. Найдено сигналов: {len(all_signals)}")
        
    except Exception as e:
        logger.error(f"Ошибка в фоновом мониторинге: {e}")
        bot_state.add_scan(success=False)

# =======================
# ЗАПУСК БОТА
# =======================

def main():
    """Основная функция запуска бота"""
    
    if not config.TELEGRAM_TOKEN:
        raise RuntimeError("Не задан TELEGRAM_TOKEN в переменных окружения")
    
    # Создаем приложение
    application = ApplicationBuilder().token(config.TELEGRAM_TOKEN).build()
    
    # Регистрируем обработчики команд
    command_handlers = [
        CommandHandler("start", start),
        CommandHandler("top", top_command),
        CommandHandler("signal", signal_command),
        CommandHandler("status", status_command),
        CommandHandler("scan", scan_command),
        CommandHandler("help", help_command),
    ]
    
    for handler in command_handlers:
        application.add_handler(handler)
    
    # Настраиваем планировщик
    if config.ENABLE_AUTO_SIGNALS:
        job_queue = application.job_queue
        if job_queue:
            job_queue.run_repeating(
                background_monitoring,
                interval=config.AUTO_INTERVAL_SECONDS,
                first=10
            )
            logger.info(f"Авто-мониторинг включен с интервалом {config.AUTO_INTERVAL_SECONDS} сек")
        else:
            logger.warning("Job queue недоступен. Авто-мониторинг отключен.")
    
    # Запускаем бота
    logger.info("🤖 Бот запущен!")
    logger.info(f"📊 Топ лимит: {config.TOP_LIMIT}")
    logger.info(f"⚖️ Минимальный RR: 1:{config.RR_MIN}")
    logger.info(f"⏰ Интервал авто: {config.AUTO_INTERVAL_SECONDS//60} мин")
    logger.info(f"💎 Канал: {config.CHANNEL_ID}")
    
    application.run_polling()

if __name__ == "__main__":
    import asyncio
    main()
