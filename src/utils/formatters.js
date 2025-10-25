// === Helpers ===
export const fmt = (n, d=4) => (n===null||n===undefined? '—' : (+n).toLocaleString('ru-RU', {maximumFractionDigits:d}));
export const nowStr = () => new Date().toLocaleTimeString('ru-RU');

export function setClass(el, cls){
  el.classList.remove('n-red','n-green','n-blue');
  if(cls) el.classList.add(cls);
}

export function trendColor(curr, prev){
  if(prev==null) return '';
  if(curr>prev) return 'n-green';
  if(curr<prev) return 'n-red';
  return '';
}

// previous values for trend coloring
export const prevVals = {
  rsi:null, ema50:null, ema200:null, macd:null, atr:null,
  oi:null, oiDelta:null, funding:null, takerBuy:null, takerSell:null
};
