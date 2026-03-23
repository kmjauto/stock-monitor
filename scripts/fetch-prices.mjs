/**
 * 투자 모니터링 — 가격 수집 + 텔레그램 알림
 * GitHub Actions에서 15분마다 실행
 *
 * 가격 소스:
 *   - 주식/ETF: Yahoo Finance (비공식 무료 API, 15~20분 지연)
 *   - 크립토: CoinGecko (공식 무료 API)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.join(__dirname, '..');
const CONFIG      = path.join(ROOT, 'config/watchlist.json');
const PRICES_OUT  = path.join(ROOT, 'docs/data/prices.json');
const WL_OUT      = path.join(ROOT, 'docs/data/watchlist.json');
const ALERT_LOG   = path.join(ROOT, 'docs/data/alert_history.json');

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALERT_COOLDOWN_H = 4; // 동일 알림 재발송 대기 시간(시간)

// 크립토 티커 → CoinGecko ID 매핑
const CRYPTO_MAP = {
  'BTC-USD': 'bitcoin',
  'SOL-USD': 'solana',
  'XRP-USD': 'ripple'
};

// ── 데이터 로드 ─────────────────────────────────────────────────────────────
const watchlist = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const allStocks  = [...(watchlist.holdings || []), ...(watchlist.watchlist || [])];

let alertHistory = {};
if (fs.existsSync(ALERT_LOG)) {
  try { alertHistory = JSON.parse(fs.readFileSync(ALERT_LOG, 'utf8')); }
  catch { alertHistory = {}; }
}

// ── Yahoo Finance 개별 조회 (v7/quote — 애프터마켓 포함) ──────────────────
async function fetchYahooOne(ticker) {
  const fields = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketDayHigh,regularMarketDayLow,postMarketPrice,postMarketChange,postMarketChangePercent,preMarketPrice,preMarketChange,preMarketChangePercent,currency,marketState';
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}&fields=${fields}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!res.ok) { console.error(`Yahoo ${res.status}: ${ticker}`); return null; }
    const data = await res.json();
    const q = data?.quoteResponse?.result?.[0];
    if (!q) return null;

    return {
      price:            q.regularMarketPrice           ?? null,
      change:           q.regularMarketChange          ?? null,
      changePercent:    q.regularMarketChangePercent   ?? null,
      prevClose:        q.regularMarketPreviousClose   ?? null,
      high:             q.regularMarketDayHigh         ?? null,
      low:              q.regularMarketDayLow          ?? null,
      currency:         q.currency                     ?? null,
      marketState:      q.marketState                  ?? 'CLOSED',
      postMarketPrice:  q.postMarketPrice              ?? null,
      postMarketChange: q.postMarketChange             ?? null,
      postMarketChangePct: q.postMarketChangePercent   ?? null,
      preMarketPrice:   q.preMarketPrice               ?? null,
      preMarketChange:  q.preMarketChange              ?? null,
      preMarketChangePct: q.preMarketChangePercent     ?? null,
    };
  } catch (e) {
    console.error(`Yahoo fetch 오류 [${ticker}]:`, e.message);
    return null;
  }
}

async function fetchYahoo(tickers) {
  if (tickers.length === 0) return {};
  const results = {};
  // 병렬 조회 (최대 5개씩 동시)
  const BATCH = 5;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const fetched = await Promise.all(batch.map(t => fetchYahooOne(t)));
    batch.forEach((t, idx) => { if (fetched[idx]) results[t] = fetched[idx]; });
    if (i + BATCH < tickers.length) await sleep(400);
  }
  return results;
}

// ── CoinGecko 크립토 조회 ────────────────────────────────────────────────────
async function fetchCrypto(tickerList) {
  if (tickerList.length === 0) return {};
  const ids = tickerList.map(t => CRYPTO_MAP[t]).filter(Boolean).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const res  = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) { console.error(`CoinGecko ${res.status}`); return {}; }

    const data    = await res.json();
    const results = {};

    for (const [ticker, geckoId] of Object.entries(CRYPTO_MAP)) {
      if (!tickerList.includes(ticker)) continue;
      const d = data[geckoId];
      if (!d) continue;

      const price         = d.usd ?? null;
      const changePercent = d.usd_24h_change ?? null;
      const change        = (price && changePercent)
        ? price * changePercent / (100 + changePercent)
        : null;

      results[ticker] = {
        price, change, changePercent,
        prevClose:   price && change ? price - change : null,
        high:        null,
        low:         null,
        currency:    'USD',
        marketState: 'REGULAR', // 크립토는 24시간
      };
    }
    return results;
  } catch (e) {
    console.error('CoinGecko fetch 오류:', e.message);
    return {};
  }
}

// ── 텔레그램 메시지 전송 ──────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] 미설정 — 알림 생략');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    const r = await res.json();
    if (r.ok) console.log('[Telegram] 전송 완료');
    else      console.error('[Telegram] 오류:', r.description);
  } catch (e) {
    console.error('[Telegram] 전송 실패:', e.message);
  }
}

// ── 알림 쿨다운 확인 ──────────────────────────────────────────────────────────
function shouldAlert(key) {
  if (!alertHistory[key]) return true;
  const hoursSince = (Date.now() - new Date(alertHistory[key]).getTime()) / 3_600_000;
  return hoursSince >= ALERT_COOLDOWN_H;
}

// ── 알림 조건 체크 ────────────────────────────────────────────────────────────
async function checkAlerts(prices) {
  const msgs = [];
  const now  = new Date().toISOString();

  for (const stock of allStocks) {
    const d = prices[stock.ticker];
    if (!d?.price || !stock.alerts) continue;

    const p    = d.price;
    const name = stock.name;
    const pFmt = stock.currency === 'KRW'
      ? p.toLocaleString('ko-KR') + '원'
      : '$' + p.toFixed(2);

    const checks = [
      { key: `${stock.ticker}_buy2`,  cond: stock.alerts.buy2  !== undefined && p <= stock.alerts.buy2,  emoji: '🟢🟢', label: '강한 추매구간', ref: stock.alerts.buy2  },
      { key: `${stock.ticker}_buy1`,  cond: stock.alerts.buy1  !== undefined && p <= stock.alerts.buy1,  emoji: '🟢',   label: '1차 추매구간', ref: stock.alerts.buy1  },
      { key: `${stock.ticker}_sell2`, cond: stock.alerts.sell2 !== undefined && p >= stock.alerts.sell2, emoji: '🔴🔴', label: '강한 익절구간', ref: stock.alerts.sell2 },
      { key: `${stock.ticker}_sell1`, cond: stock.alerts.sell1 !== undefined && p >= stock.alerts.sell1, emoji: '🔴',   label: '익절 구간',    ref: stock.alerts.sell1 },
    ];

    for (const { key, cond, emoji, label, ref } of checks) {
      if (cond && shouldAlert(key)) {
        const refFmt = stock.currency === 'KRW'
          ? ref.toLocaleString('ko-KR') + '원'
          : '$' + ref;
        msgs.push(`${emoji} <b>[${label}]</b> ${name}\n현재가: ${pFmt} / 기준가: ${refFmt}`);
        alertHistory[key] = now;
        break; // 하나의 종목에서 가장 강한 조건 하나만
      }
    }
  }

  if (msgs.length > 0) {
    const kst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    await sendTelegram(`📊 <b>투자 알림</b>\n⏰ ${kst}\n\n${msgs.join('\n\n')}`);
  }
}

// ── 오전 9시 KST 일일 요약 ───────────────────────────────────────────────────
async function maybeMorningSummary(prices) {
  const kstNow   = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hour12: false });
  const kstDate  = new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  const summKey  = `morning_${kstDate}`;

  if (parseInt(kstNow) !== 9 || alertHistory[summKey]) return;

  const lines = ['☀️ <b>오늘의 시장 현황</b>', ''];

  for (const stock of watchlist.holdings ?? []) {
    const d = prices[stock.ticker];
    if (!d?.price) continue;
    const sign  = d.changePercent >= 0 ? '+' : '';
    const arrow = d.changePercent > 0 ? '▲' : d.changePercent < 0 ? '▼' : '─';
    const pFmt  = d.currency === 'KRW'
      ? d.price.toLocaleString('ko-KR') + '원'
      : '$' + d.price.toFixed(2);
    lines.push(`${arrow} ${stock.name}: ${pFmt} (${sign}${d.changePercent?.toFixed(2)}%)`);
  }

  await sendTelegram(lines.join('\n'));
  alertHistory[summKey] = new Date().toISOString();
}

// ── 유틸 ─────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 메인 실행 ────────────────────────────────────────────────────────────────
console.log(`\n[${new Date().toISOString()}] 가격 수집 시작`);

// 티커 분류
const cryptoTickers = allStocks.map(s => s.ticker).filter(t => CRYPTO_MAP[t]);
const stockTickers  = allStocks.map(s => s.ticker).filter(t => !CRYPTO_MAP[t]);

// 병렬 조회
const [stockPrices, cryptoPrices] = await Promise.all([
  fetchYahoo(stockTickers),
  fetchCrypto(cryptoTickers),
]);

const allPrices = { ...stockPrices, ...cryptoPrices };
console.log(`조회 완료: ${Object.keys(allPrices).length} / ${allStocks.length}개`);

// docs/data 디렉토리 보장
const outDir = path.join(ROOT, 'docs/data');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// prices.json 저장
fs.writeFileSync(PRICES_OUT, JSON.stringify({
  lastUpdated: new Date().toISOString(),
  stocks: allPrices,
}, null, 2));
console.log('prices.json 저장');

// watchlist.json 동기화 (대시보드용)
fs.copyFileSync(CONFIG, WL_OUT);
console.log('watchlist.json 동기화');

// 알림 체크
await checkAlerts(allPrices);
await maybeMorningSummary(allPrices);

// alert_history.json 저장
fs.writeFileSync(ALERT_LOG, JSON.stringify(alertHistory, null, 2));
console.log('alert_history.json 저장');

console.log('완료\n');
