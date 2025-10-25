# ByAgent Terminal (Vercel-ready)

Статическое веб‑приложение с живыми данными Bybit Futures:
- TradingView чарт
- Индикаторы (RSI/EMA/MACD/ATR)
- Open Interest, Funding, Taker volume
- Вебсокет‑обновления цены (tickers, kline)
- Алерты с локальным сохранением (и webhook на /api/notify)
- Модули: Wallet, Копитрейдинг, DeFi, Сигналы 10x, Избранное и т.д.

## Деплой на Vercel
1. Создай новый проект и загрузить ZIP архива этой папки.
2. Проект статический — сборка не требуется.
3. (Опционально) подключи серверлесс‑функцию `/api/notify` к своему Telegram‑боту.

## Настройка Telegram уведомлений
- Запрос POST на `/api/notify` с телом `{ sym, price, dir, now }` — здесь можешь реализовать отправку сообщения в Telegram.
