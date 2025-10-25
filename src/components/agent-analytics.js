import { AppState } from '../../config/constants.js';
import { fetchKlines } from '../services/bybit-api.js';
import { rsi, ema, macd, atr } from '../utils/indicators.js';
import { fmt, nowStr, setClass, trendColor, prevVals } from '../utils/formatters.js';

const $ = (id) => document.getElementById(id);

function applyAgentColors(ind){
  // price is always blue
  setClass($('lastV'), 'n-blue');
  // upward/downward metrics
  setClass($('rsiV'), trendColor(ind.rsi14, prevVals.rsi));
  setClass($('ema50V'), trendColor(ind.ema50, prevVals.ema50));
  setClass($('ema200V'), trendColor(ind.ema200, prevVals.ema200));
  setClass($('macdV'), trendColor(ind.macdLine, prevVals.macd));
  setClass($('atrV'), trendColor(ind.atr, prevVals.atr));
  // ticker color by signal
  if(ind.signal==='LONG'){ setClass($('agentSym'), 'n-green'); $('agentDot').style.background='var(--green)'; setClass($('agentStateTxt'), 'n-green'); }
  else if(ind.signal==='SHORT'){ setClass($('agentSym'), 'n-red'); $('agentDot').style.background='var(--red)'; setClass($('agentStateTxt'), 'n-red'); }
  else { setClass($('agentSym'), 'n-blue'); $('agentDot').style.background='var(--blue)'; setClass($('agentStateTxt'), 'n-blue'); }
  // persist previous
  prevVals.rsi = ind.rsi14; prevVals.ema50 = ind.ema50; prevVals.ema200 = ind.ema200;
  prevVals.macd = ind.macdLine; prevVals.atr = ind.atr;
}

async function computeIndicators(sym){
  // Fetch 15-minute klines
  const rows = await fetchKlines(sym, '15', 300);
  if(rows.length < 200) return {}; // Need enough data for 200 EMA
  
  const closes = rows.map(r=>r.c);
  
  // RSI 14 (needs 14+1 candles for first calculation)
  const rsi14 = rsi(closes.slice(-(14+60)));
  
  // EMA 50 (needs 50 candles)
  const ema50 = ema(closes.slice(-200), 50);
  
  // EMA 200 (needs 200 candles)
  const ema200 = ema(closes.slice(-300), 200);
  
  // MACD (needs 26+12 candles)
  const m = macd(closes.slice(-200));
  
  // ATR 14
  const ohlc = rows.map(r=>({h:r.h, l:r.l, c:r.c}));
  const a = atr(ohlc, 14);
  
  const last = closes[closes.length-1];
  
  // Simple Signal Logic (as per original code)
  const signal = last > ema50 && rsi14 > 55 ? 'LONG' : (last < ema50 && rsi14 < 45 ? 'SHORT' : 'FLAT');
  
  return {last, rsi14, ema50, ema200, macdLine:m.line, atr:a, signal};
}

let agentTimer = null;

export async function spawnAgent(){
  clearInterval(agentTimer);
  $('autoLbl').textContent = AppState.agentPeriodSec+'s';
  
  const run = async () => {
    try{
      const ind = await computeIndicators(AppState.currentSymbol);
      if(!ind.last){ 
        $('wsState').textContent = 'offline';
        return; 
      }
      
      $('lastV').textContent = fmt(ind.last);
      $('rsiV').textContent = fmt(ind.rsi14,2);
      $('ema50V').textContent = fmt(ind.ema50,2);
      $('ema200V').textContent = fmt(ind.ema200,2);
      $('macdV').textContent = fmt(ind.macdLine,4);
      $('atrV').textContent = fmt(ind.atr,4);
      $('sidePill').textContent = ind.signal;
      $('agentStateTxt').textContent = ind.signal==='LONG'?'LONG':(ind.signal==='SHORT'?'SHORT':'FLAT');
      
      // Entry/TP/SL (Risk/Reward 1.2/0.8)
      const rrRatio = 1.2 / 0.8;
      const tp = ind.signal==='LONG'? ind.last + ind.atr*1.2 : ind.signal==='SHORT' ? ind.last - ind.atr*1.2 : null;
      const sl = ind.signal==='LONG'? ind.last - ind.atr*0.8 : ind.signal==='SHORT' ? ind.last + ind.atr*0.8 : null;
      
      $('entryV').textContent = ind.signal==='FLAT' ? '—' : fmt(ind.last);
      $('tpV').textContent = ind.signal==='FLAT' ? '—' : fmt(tp,2);
      $('slV').textContent = ind.signal==='FLAT' ? '—' : fmt(sl,2);
      $('rrV').textContent = ind.signal==='FLAT' ? '—' : rrRatio.toFixed(2);
      
      // Confidence (simple calculation based on distance from 50)
      $('confV').textContent = ind.signal==='FLAT' ? '—' : (Math.min(99, Math.max(30, Math.abs(ind.rsi14-50)*2))).toFixed(0)+'%';
      
      $('wsState').textContent = 'online ' + nowStr();
      applyAgentColors(ind);
      
    }catch(e){
      console.error('Agent Error:', e);
      $('wsState').textContent = 'error';
    }
  };
  
  await run();
  agentTimer = setInterval(run, AppState.agentPeriodSec * 1000);
}

export function setActiveSeg(segEl, btn){
  segEl.querySelectorAll('button').forEach(b=>b.classList.toggle('active', b===btn));
}
