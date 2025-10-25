import { fmt } from './formatters.js';

// Function to handle the "Найти" (Find) button logic and "Создать алерт" in the Alerts modal
export function setupAlertsModal(drawer) {
  const alertFindBtn = drawer.querySelector('#alertFind');
  const alertSymInput = drawer.querySelector('#alertSym');
  const liveDisplay = drawer.querySelector('#liveTickerDisplay');
  const liveSymbol = drawer.querySelector('#liveTickerSymbol');
  const livePrice = drawer.querySelector('#liveTickerPrice');
  const alertPriceInput = drawer.querySelector('#alertPrice');
  const alertCreateBtn = drawer.querySelector('#alertCreate');
  const alertsList = drawer.querySelector('#activeAlertsList');
  
  let currentLiveSymbol = alertSymInput.value.trim().toUpperCase();

  // Helper to format price (simple simulation)
  function formatPrice(price) {
    return fmt(price, 2);
  }

  // 1. "Найти" (Find) button logic
  if (alertFindBtn && alertSymInput) {
    alertFindBtn.addEventListener('click', () => {
      let sym = alertSymInput.value.trim().toUpperCase();
      if (sym && !sym.endsWith('USDT')) {
        sym += 'USDT';
      }
      alertSymInput.value = sym;
      currentLiveSymbol = sym;
      
      // Simulate fetching live price
      const simulatedPrice = (Math.random() * 10000 + 20000); // e.g., 20000 to 30000
      
      liveSymbol.textContent = sym;
      livePrice.textContent = formatPrice(simulatedPrice);
      liveDisplay.style.display = 'flex'; // Show the live display
      
      console.log('Searching for ticker:', sym);
    });
  }

  // 2. "Создать алерт" (Create Alert) button logic
  if (alertCreateBtn && alertPriceInput && alertsList) {
    alertCreateBtn.addEventListener('click', () => {
      const targetPrice = alertPriceInput.value.trim();
      if (!currentLiveSymbol || !targetPrice) {
        alert('Пожалуйста, сначала найдите тикер и введите целевую цену.');
        return;
      }

      const priceNum = parseFloat(targetPrice.replace(/\s/g, ''));
      if (isNaN(priceNum) || priceNum <= 0) {
        alert('Введите корректную целевую цену.');
        return;
      }

      const now = new Date();
      const timeStr = now.toLocaleTimeString('ru-RU');
      
      // Create the alert element
      const alertElement = document.createElement('div');
      alertElement.className = 'row';
      alertElement.style.cssText = 'margin-bottom: 6px; padding: 4px 0; border-bottom: 1px dashed rgba(64,64,64,.5);';
      alertElement.innerHTML = `
        <span class="mono n-blue" style="flex:1 1 80px;">${currentLiveSymbol}</span>
        <span class="mono n-green" style="flex:1 1 80px;">> ${formatPrice(priceNum)}</span>
        <span class="mini mono" style="flex:0 1 100px;">${timeStr}</span>
        <span class="mini mono" style="flex:0 1 40px;">🟢</span>
        <button class="btn delete-alert-btn" style="flex:0 1 auto; padding: 4px 8px; font-size: 12px; background: var(--red); border: none;">Удалить</button>
      `;

      // Remove the "Список алертов пуст" message if it exists
      const emptyMessage = alertsList.querySelector('.mini.mono');
      if (emptyMessage && emptyMessage.textContent.includes('пуст')) {
        alertsList.innerHTML = '';
      }

      // Add the new alert
      alertsList.prepend(alertElement); // Add to the top

      // Add delete functionality
      alertElement.querySelector('.delete-alert-btn').addEventListener('click', (e) => {
        e.target.closest('.row').remove();
        // Re-add the "empty" message if the list is now empty
        if (alertsList.children.length === 0) {
          alertsList.innerHTML = '<div class="mini mono" style="color:var(--muted)">Список алертов пуст.</div>';
        }
      });

      // Clear the price input
      alertPriceInput.value = '';
    });
  }
}

// Function that generates the content of the modal window based on the title
export function generateDrawerContent(title) {
  let content = '';
  let apiPath = '';

  switch (title) {
    case 'Копитрейдинг':
      apiPath = '/api/leaderboard';
      content = `
        <div>Копитрейдинг ByAgent Alpha</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'Спреды':
      apiPath = '/api/spreads';
      content = `
        <div>Спреды • BTCUSDT</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'DeFi':
      apiPath = '/api/defi';
      content = `
        <div>DeFi доходности • BTC</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'Сигналы 10x':
      content = `
        <div>Сигналы 10x</div>
        <div class="mini mono" style="margin-top:4px;">Модуль в разработке.</div>
      `;
      break;
    case '⭐ Избранное':
      content = `
        <div style="display:flex; align-items:center; gap:8px;"><span style="font-size:20px;">⭐</span> Избранное</div>
        <div class="row" style="margin-top:10px;">
          <input class="input" placeholder="Добавить тикер (напр. BTC)" style="flex:1 1 200px;"/>
          <button class="btn">Добавить</button>
        </div>
        <div class="mini" style="margin-top:10px;">Список пуст. Добавь тикер выше, он сохранится локально.</div>
      `;
      break;
    case 'Wallet':
      content = `
        <div style="display:flex; align-items:center; justify-content:space-between;">
          <span>Wallet / Подписка (TON)</span>
          <span class="mini mono n-red">Не активна</span>
        </div>
        <h3 style="margin:16px 0 8px 0; color:var(--text);">Wallet / Подписка</h3>
        <div class="row">
          <button class="btn" style="flex:0 1 auto;">Подключить TON Wallet</button>
          <div class="pill"><span class="k mono">Адрес:</span><span class="mono">—</span></div>
          <div class="pill"><span class="k mono">Баланс:</span><span class="mono">—</span></div>
        </div>
        <h3 style="margin:16px 0 8px 0; color:var(--text);">Подписка ByAgent — доступ на 30 дней</h3>
        <div class="mini mono" style="margin-bottom:12px;">Стоимость: 2 TON (демо-оплата)</div>
        <div class="row" style="align-items:center; gap:16px;">
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" style="width:16px; height:16px;"> Я принимаю условия использования
          </label>
          <label style="display:flex; align-items:center; gap:8px;">
            <input type="checkbox" style="width:16px; height:16px;"> Согласен с политикой конфиденциальности
          </label>
        </div>
        <button class="btn" style="margin-top:20px; flex:0 1 auto;">Продлить подписку за 2 TON</button>
        <div class="mini mono" style="margin-top:8px; color:var(--muted)">Подключите кошелёк и отметьте оба чекбокса</div>
      `;
      break;
    case 'Алерты':
      content = `
        <div>Алерты</div>
        <div class="row" style="margin-top:10px; align-items:center;">
          <span style="font-size:20px;">⚠️</span>
          <div class="mini mono" style="flex:1 1 auto;">Чтобы получать уведомления, запусти бота <a href="https://t.me/By_agent_bot" target="_blank" style="color:var(--silver);">@By_agent_bot</a> и нажми Start.</div>
          <button class="btn" style="flex:0 1 auto;">Открыть бота</button>
        </div>
        <h3 style="margin:20px 0 8px 0; color:var(--text); display:flex; justify-content:space-between; align-items:center;">
          <span>Ценовые алерты</span>
          <span class="mini mono">Уведомления в Telegram</span>
        </h3>
        <!-- Live Ticker and Price Display -->
        <div id="liveTickerDisplay" class="card" style="margin-bottom: 10px; padding: 10px; display: none; align-items: center; justify-content: space-between;">
          <span id="liveTickerSymbol" class="mono sym n-blue" style="font-size: 1.2em;">—</span>
          <span id="liveTickerPrice" class="mono n-green" style="font-size: 1.2em;">—</span>
        </div>
        <!-- Ticker Search Row -->
        <div class="row" style="gap:8px; margin-bottom: 8px;">
          <input id="alertSym" class="input" value="BTCUSDT" placeholder="Тикер (напр. BTC)" style="flex:1 1 180px;"/>
          <button id="alertFind" class="btn" style="flex:0 1 auto; padding: 11px 16px;">Найти</button>
        </div>
        <!-- Alert Creation Row -->
        <div class="row" style="gap:8px;">
          <input id="alertPrice" class="input" placeholder="Целевая цена" style="flex:1 1 180px;"/>
          <button id="alertCreate" class="btn" style="flex:0 1 auto; padding: 11px 16px;">Создать алерт</button>
        </div>
        <div class="mini mono" style="margin-top:8px; color:var(--muted)">Подключите бота, чтобы получать уведомления.</div>

        <h3 style="margin:20px 0 8px 0; color:var(--text);">Активные алерты</h3>
        <div id="activeAlertsList" style="border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: rgba(0,0,0,.15); max-height: 200px; overflow-y: auto;">
          <div class="mini mono" style="color:var(--muted)">Список алертов пуст.</div>
        </div>
      `;
      break;
    case 'Сетапы':
      apiPath = '/api/setups';
      content = `
        <div>Сетапы (топ-10)</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'Аномалии':
      apiPath = '/api/anomalies';
      content = `
        <div>Аномалии</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'Топ рост/падение':
      apiPath = '/api/movers';
      content = `
        <div>Топ рост/падение</div>
        <div class="seg" style="margin-top:10px;">
          <button class="active" style="flex:0 1 auto;"><span style="font-size:16px;">🚀</span> Топ растущие</button>
          <button style="flex:0 1 auto;"><span style="font-size:16px;">🪂</span> Топ падающие</button>
        </div>
        <div class="mini mono" style="margin-top:10px;">Нет данных (демо). Подключим ${apiPath} на бэкенде.</div>
      `;
      break;
    case 'Листинги':
      apiPath = '/api/listings';
      content = `
        <div>Листинги (новые / предстоящие)</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    case 'Доходность App':
      apiPath = '/api/stats';
      content = `
        <div>Доходность приложения</div>
        <div class="mini mono" style="margin-top:4px;">${apiPath} подключим на бэкенде (демо).</div>
      `;
      break;
    default:
      content = `<p class="mini">Модуль «${title}» в разработке.</p>`;
      break;
  }

  return content;
}
