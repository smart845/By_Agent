import { AppState } from '../../config/constants.js';
import { by } from '../services/bybit-api.js';
import { fmt, nowStr, setClass, trendColor, prevVals } from '../utils/formatters.js';
import { setActiveSeg } from './agent-analytics.js';

const $ = (id) => document.getElementById(id);

let oiTimer = null;
const oiUpdatePeriodSec = 10; // Update every 10 seconds

export async function refreshOI(){
  try{
    // 1. Get Open Interest
    const oi = await by('/v5/market/open-interest', {category:'linear', symbol: AppState.currentSymbol, intervalTime: AppState.oiInterval, limit: 2});
    const list = (oi.list||[]).sort((a,b)=>+a.timestamp - +b.timestamp);
    const last = list[list.length-1];
    const prev = list[list.length-2] || last;
    const oiNow = +last.openInterest;
    const oiPrev = +prev.openInterest;
    const oiDeltaVal = oiNow - oiPrev;
    const oiDeltaPctVal = oiPrev !== 0 ? ((oiDeltaVal / oiPrev) * 100) : 0;
    
    $('oiNow').textContent = fmt(oiNow,0);
    $('oiDelta').textContent = fmt(oiDeltaVal,0);
    $('oiDeltaPct').textContent = fmt(oiDeltaPctVal,2) + '%';
    
    // Color indication for OI
    setClass($('oiNow'), trendColor(oiNow, prevVals.oi));
    setClass($('oiDelta'), oiDeltaVal >= 0 ? 'n-green' : 'n-red');
    setClass($('oiDeltaPct'), oiDeltaPctVal >= 0 ? 'n-green' : 'n-red');
    prevVals.oi = oiNow;

    // 2. Get Taker Volume
    try {
      const takerVol = await by('/v5/market/recent-trade', {category:'linear', symbol: AppState.currentSymbol, limit: 50});
      if(takerVol.list && takerVol.list.length > 0) {
        let buyVol = 0, sellVol = 0;
        takerVol.list.forEach(trade => {
          const vol = +trade.size * +trade.price;
          if(trade.side === 'Buy') buyVol += vol;
          else sellVol += vol;
        });
        $('takerBuy').textContent = fmt(buyVol,0);
        $('takerSell').textContent = fmt(sellVol,0);
        setClass($('takerBuy'), trendColor(buyVol, prevVals.takerBuy));
        setClass($('takerSell'), trendColor(sellVol, prevVals.takerSell));
        prevVals.takerBuy = buyVol; 
        prevVals.takerSell = sellVol;
      }
    } catch(e) {
      console.warn('Taker volume fallback:', e);
      $('takerBuy').textContent = '—';
      $('takerSell').textContent = '—';
    }

    // 3. Get Funding Rate
    const tick = await by('/v5/market/tickers', {category:'linear', symbol: AppState.currentSymbol});
    const fr = tick.list && tick.list[0] ? +tick.list[0].fundingRate : null;
    $('fundingNow').textContent = fr!=null ? (fr*100).toFixed(4) + '%' : '—';
    setClass($('fundingNow'), fr>0 ? 'n-green' : (fr<0 ? 'n-red' : ''));
    prevVals.funding = fr;

    $('oiHint').textContent = AppState.oiInterval + ' • ' + nowStr();
    $('oiUpdated').textContent = 'Обновлено: ' + nowStr();
  }catch(e){
    console.error('OI Error:', e);
    $('oiUpdated').textContent = 'Ошибка обновления: ' + e.message;
  }
}

// Function to start OI auto-update
export function spawnOI(){
  clearInterval(oiTimer);
  const run = async () => {
    await refreshOI();
  };
  run(); // first run immediately
  oiTimer = setInterval(run, oiUpdatePeriodSec * 1000); // auto-update every 10 seconds
}
