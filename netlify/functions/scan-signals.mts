import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import nodemailer from "nodemailer";

const RSI_PERIOD = 14, RSI_OVERSOLD = 30, RSI_OVERBOUGHT = 70;
const TOP_N_COINS = 50;

function computeRSI(closes: number[]) {
  let gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  let avgGain = gains.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  let avgLoss = losses.slice(0, RSI_PERIOD).reduce((a, b) => a + b, 0) / RSI_PERIOD;
  const rsiArr: number[] = [];
  for (let i = RSI_PERIOD; i < gains.length; i++) {
    avgGain = (avgGain * (RSI_PERIOD - 1) + gains[i]) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + losses[i]) / RSI_PERIOD;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - 100 / (1 + rs));
  }
  return rsiArr;
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

async function fetchCloses(symbol: string): Promise<number[]> {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=1h&limit=120`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("http " + res.status);
  const raw = await res.json();
  return raw.map((c: any) => +c[4]);
}

function fmtPrice(p: number) {
  return "$" + p.toLocaleString(undefined, { maximumFractionDigits: p < 10 ? 4 : 2 });
}

async function sendEmail(
  hit: { symbol: string; signal: string; price: number; rsi: number },
  recipients: string[]
) {
  if (recipients.length === 0) return;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  const reason =
    hit.signal === "BUY"
      ? `RSI ${hit.rsi.toFixed(1)} is oversold (below ${RSI_OVERSOLD})`
      : `RSI ${hit.rsi.toFixed(1)} is overbought (above ${RSI_OVERBOUGHT})`;

  // Send one email per recipient (separate sends) so no one sees anyone
  // else's address.
  for (const to of recipients) {
    try {
      await transporter.sendMail({
        from: process.env.GMAIL_USER,
        to,
        subject: `${hit.signal} signal: ${hit.symbol.replace("USDT", "/USDT")}`,
        text: `${hit.symbol.replace("USDT", "/USDT")} — ${hit.signal}\nPrice: ${fmtPrice(hit.price)}\n${reason}\n\nCheck the chart before entering. Not financial advice.`,
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

  const results: { symbol: string; signal: string; price: number; rsi: number }[] = [];
  const BATCH = 10;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (sym) => {
        try {
          const closes = await fetchCloses(sym);
          const rsiArr = computeRSI(closes);
          const rsi = rsiArr[rsiArr.length - 1];
          const price = closes[closes.length - 1];
          let signal = "NONE";
          if (rsi < RSI_OVERSOLD) signal = "BUY";
          else if (rsi > RSI_OVERBOUGHT) signal = "SELL";
          return { symbol: sym, signal, price, rsi };
        } catch (e) {
          return null;
        }
      })
    );
    for (const r of batchResults) if (r) results.push(r);
  }

  const hits = results.filter((r) => r.signal !== "NONE");
  const currentKeys = new Set<string>();

  for (const hit of hits) {
    const key = hit.symbol + ":" + hit.signal;
    currentKeys.add(key);
    if (!notified.has(key)) {
      await sendEmail(hit, recipientList);
      console.log(`Emailed ${hit.signal} for ${hit.symbol} to ${recipientList.length} recipient(s)`);
    }
  }

  await store.setJSON("notified", [...currentKeys]);
  await store.setJSON("last-results", { at: new Date().toISOString(), hits });
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
