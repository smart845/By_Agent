import { CONFIG, AppState } from '../../config/constants.js';
import { fmt } from '../utils/formatters.js';

const $ = (id) => document.getElementById(id);

// === API Helpers ===
export const by = async (path, params = {}) => {
  const url = new URL(CONFIG.BYBIT.API_BASE + path);
  url.search = new URLSearchParams(params).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error(await r.text());
  const j = await r.json();
  if (j.retCode !== 0 && j.retMsg && j.retMsg !== 'OK') throw new Error(j.retMsg || 'API error');
  return j.result;
};

// === Symbol Management ===
let SYMBOLS = []; // [{symbol:'BTCUSDT', quote:'USDT', base:'BTC'}]

export async function loadSymbols(){
  try{
    const res = await by(CONFIG.ENDPOINTS.INSTRUMENTS, {category:'linear'});
    const list = res.list || [];
    SYMBOLS = list
      .filter(s => s.quoteCoin === 'USDT')
      .map(s => ({symbol:s.symbol, base:s.baseCoin, quote:s.quoteCoin}));
    // fill datalist
    $('symList').innerHTML = SYMBOLS.slice(0,500).map(s => `<option value="${s.symbol}">${s.base}/${s.quote}</option>`).join('');
  }catch(e){ console.error('symbols', e); }
}

export function normalizeSymbol(raw){
  if(!raw) return null;
  let t = raw.toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!t) return null;
  if(!/USDT$/.test(t)) {
    const guess = t + 'USDT';
    if (SYMBOLS.find(s=>s.symbol===guess)) return guess;
  }
  if (SYMBOLS.find(s=>s.symbol===t)) return t;
  const c = SYMBOLS.find(s=>s.base===t || s.symbol.startsWith(t));
  return c ? c.symbol : t;
}

export async function fetchKlines(sym, interval='15', limit=300){
  const res = await by(CONFIG.ENDPOINTS.KLINE, {category:'linear', symbol:sym, interval, limit});
  let rows = (res.list || []).map(r=>({
    t: +r[0], o:+r[1], h:+r[2], l:+r[3], c:+r[4]
  })).sort((a,b)=>a.t-b.t);
  return rows;
}

// === TradingView chart ===
function tvSymbol(sym){ return `BYBIT:${sym}`; }

export function mountTV(sym){
  const containerId = 'tvchart';
  document.getElementById(containerId).innerHTML = ''; // reset
  
  new TradingView.widget({
    symbol: tvSymbol(sym),
    interval: '15',
    autosize: true,
    locale: 'ru',
    theme: 'dark',
    toolbar_bg: '#0b1020',
    hide_side_toolbar: false,
    withdateranges: true,
    allow_symbol_change: false,
    container_id: containerId,
    studies: [
      'RSI@tv-basicstudies',
      'MACD@tv-basicstudies',
      'MAExp@tv-basicstudies', // EMA 50
      'MAExp@tv-basicstudies'  // EMA 200
    ]
  });
}
