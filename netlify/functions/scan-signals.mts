import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

// ===================== Strategy constants =====================
const RSI_PERIOD = 14;
const TOUCH_LEVEL = 40;
const OVERBOUGHT = 70;
const OVERSOLD = 30;
const EXT_NEAR = 0.272; // 1.272 extension
const EXT_FAR = 0.618;  // 1.618 extension
const LOOKBACK_DAYS = 30;
const TOP_N_COINS = 50;
const DAY_MS = 86400000;

type Candle = { time: number; high: number; low: number; close: number; rsi: number | null };
type DayGroup = { dayKey: number; dateLabel: string; candles: Candle[] };
type Setup = {
  symbol: string;
  n1Price: number; n1Time: number;
  n2Price: number; n2Time: number;
  zoneLow: number; zoneHigh: number;
  formedTime: number;
};

function computeRSISeries(closes: number[]): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  let gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  if (gains.length < RSI_PERIOD) return out;
  let avgGain = gains.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  let avgLoss = losses.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  for (let i = RSI_PERIOD; i < gains.length; i++) {
    avgGain = (avgGain * (RSI_PERIOD - 1) + gains[i]) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + losses[i]) / RSI_PERIOD;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = 100 - 100 / (1 + rs);
    out[i + 1] = rsi; // +1 because gains[i] corresponds to closes[i+1]
  }
  return out;
}

function dateLabel(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function groupByDay(candles: Candle[]): DayGroup[] {
  const map = new Map<number, Candle[]>();
  for (const c of candles) {
    const key = Math.floor(c.time / DAY_MS) * DAY_MS;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(c);
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  const days = keys.map((k) => ({ dayKey: k, dateLabel: dateLabel(k), candles: map.get(k)! }));
  // Drop the last day — it's the current, still-open UTC day.
  if (days.length > 0) days.pop();
  return days;
}

function findSetups(symbol: string, candles: Candle[]): Setup[] {
  const days = groupByDay(candles);
  const cutoff = Date.now() - LOOKBACK_DAYS * DAY_MS;
  const setups: Setup[] = [];

  for (let k = 0; k + 2 < days.length; k++) {
    const dayA = days[k];       // earlier of the "12,13" pair
    const dayB = days[k + 1];   // shared middle day
    const dayC = days[k + 2];   // later of the "13,14" pair
    if (dayC.candles[dayC.candles.length - 1].time < cutoff) continue;

    const earlyWindow = [...dayA.candles, ...dayB.candles];
    const lateWindow = [...dayB.candles, ...dayC.candles];

    // --- late window: must show an overbought (>70) excursion ---
    const overboughtCandles = lateWindow.filter((c) => c.rsi !== null && c.rsi > OVERBOUGHT);
    if (overboughtCandles.length === 0) continue;
    let n1Candle = overboughtCandles[0];
    for (const c of overboughtCandles) if (c.high > n1Candle.high) n1Candle = c;

    // --- early window: no overbought, no oversold, must touch RSI 40 ---
    const hasInvalid = earlyWindow.some((c) => c.rsi !== null && (c.rsi > OVERBOUGHT || c.rsi < OVERSOLD));
    if (hasInvalid) continue;

    let touchCandle: Candle | null = null;
    for (let i = 1; i < earlyWindow.length; i++) {
      const prev = earlyWindow[i - 1], cur = earlyWindow[i];
      if (prev.rsi === null || cur.rsi === null) continue;
      if ((prev.rsi - TOUCH_LEVEL) * (cur.rsi - TOUCH_LEVEL) <= 0) {
        touchCandle = cur; // keep overwriting — we want the LAST touch chronologically
      }
    }
    if (!touchCandle) continue;

    const n1 = n1Candle.high, n2 = touchCandle.low;
    const diff = n1 - n2;
    if (diff <= 0) continue;

    const zoneHigh = n2 - EXT_NEAR * diff;
    const zoneLow = n2 - EXT_FAR * diff;
    const formedTime = dayC.candles[dayC.candles.length - 1].time;

    // Has price already traded into the zone since this setup formed?
    const alreadyHit = candles.some(
      (c) => c.time > formedTime && c.low <= zoneHigh && c.high >= zoneLow
    );
    if (alreadyHit) continue;

    setups.push({
      symbol,
      n1Price: n1, n1Time: n1Candle.time,
      n2Price: n2, n2Time: touchCandle.time,
      zoneLow, zoneHigh, formedTime,
    });
  }
  return setups;
}

async function getTopSymbols(): Promise<string[]> {
  const res = await fetch("https://data-api.binance.vision/api/v3/ticker/24hr");
  const all = await res.json();
  return all
    .filter((t: any) => t.symbol.endsWith("USDT") && !t.symbol.includes("UP") && !t.symbol.includes("DOWN") && !t.symbol.includes("BEAR") && !t.symbol.includes("BULL"))
    .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, TOP_N_COINS)
    .map((t: any) => t.symbol);
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("http " + res.status);
  const raw = await res.json();
  const closes = raw.map((c: any) => +c[4]);
  const rsiArr = computeRSISeries(closes);
  return raw.map((c: any, i: number) => ({
    time: +c[0], high: +c[2], low: +c[3], close: +c[4], rsi: rsiArr[i],
  }));
}

function fmtPrice(p: number) {
  return "$" + p.toLocaleString(undefined, { maximumFractionDigits: p < 10 ? 4 : 2 });
}

async function sendEmail(setup: Setup, recipients: string[]) {
  if (recipients.length === 0) return;
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  const label = setup.symbol.replace("USDT", "/USDT");
  const text =
    `${label} — SELL zone setup\n\n` +
    `Zone: ${fmtPrice(setup.zoneLow)} – ${fmtPrice(setup.zoneHigh)}\n` +
    `N1 (overbought peak): ${fmtPrice(setup.n1Price)} on ${dateLabel(setup.n1Time)}\n` +
    `N2 (RSI-40 touch low): ${fmtPrice(setup.n2Price)} on ${dateLabel(setup.n2Time)}\n\n` +
    `Price hasn't reached this zone yet — watch it manually for a reversal. Not financial advice.`;

  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: `Setup: ${label} — zone ${fmtPrice(setup.zoneLow)}–${fmtPrice(setup.zoneHigh)}`,
        text,
      });
    } catch (e) {
      console.error("Email failed for recipient " + to, e);
    }
  }
}

export default async () => {
  const store = getStore("signal-scanner");

  const notifiedRaw = (await store.get("notified", { type: "json" })) as string[] | null;
  let notified = new Set(notifiedRaw || []);

  const subscribersRaw = (await store.get("subscribers", { type: "json" })) as string[] | null;
  const recipients = new Set(subscribersRaw || []);
  if (process.env.NOTIFY_TO_EMAIL) recipients.add(process.env.NOTIFY_TO_EMAIL);
  const recipientList = [...recipients];

  const symbols = await getTopSymbols();

  const allSetups: Setup[] = [];
  const BATCH = 8;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (sym) => {
        try {
          const candles = await fetchCandles(sym);
          return findSetups(sym, candles);
        } catch (e) {
          return [];
        }
      })
    );
    for (const setups of batchResults) allSetups.push(...setups);
  }

  const currentKeys = new Set<string>();
  for (const setup of allSetups) {
    const key = `${setup.symbol}:${setup.n1Time}:${setup.n2Time}`;
    currentKeys.add(key);
    if (!notified.has(key)) {
      await sendEmail(setup, recipientList);
      console.log(`Emailed setup for ${setup.symbol} to ${recipientList.length} recipient(s)`);
    }
  }

  await store.setJSON("notified", [...currentKeys]);
  await store.setJSON("last-results", { at: new Date().toISOString(), setups: allSetups });
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
