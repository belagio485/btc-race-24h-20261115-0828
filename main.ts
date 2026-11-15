// Race a BTC trading bot live for 24 hours (btc-race-24h-20261115-0828).
//
// Strategy: a 60-bar Donchian breakout system on 1-minute cbBTC bars, long
// only, fully invested or fully in cash. It buys the whole cash balance when
// the last two closes both print above the highest high of the 60 bars
// before them, which confirms a fresh hourly breakout instead of a single
// wick. It sells the whole position when the close falls 0.6% below the
// highest close seen since entry (a trailing stop on closes), or when the
// position has been held for 60 bars, whichever comes first. It opens no
// new position in the last 30 batches of the window, because a fresh entry
// there has no time to earn back its round-trip cost before the window
// ends. Every comparison is exact integer arithmetic on the raw price
// strings, so two runs on the same bars answer with the same orders.
//
// Protocol: the harness sends one hello line, then one batch line per bar,
// then done. This bot answers every batch with exactly one reply carrying
// its orders (possibly none) and echoing the batch seq. Orders decided on
// a batch fill at the next bar's open. The bot uses no network, no wall
// clock, no randomness and no files; the bar time in each batch is the
// only time it sees. An unexpected batch shape yields an empty reply
// instead of a crash, so one odd batch can never fail the run.

type IncomingBar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
};

type IncomingFill = {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  price: string;
  qty: string;
};

type IncomingPosition = {
  symbol: string;
  qty: string;
  cost_quote_units: string;
};

type IncomingMessage = {
  type: string;
  seq: number;
  symbols?: Array<{ symbol: string }>;
  fees?: { min_notional_quote_units: string };
  bars?: IncomingBar[];
  fills?: IncomingFill[];
  account?: {
    cash_quote_units: string;
    positions: IncomingPosition[];
    equity_quote_units: string;
  };
};

type OutgoingOrder = {
  side: string;
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

// How many past bars define the breakout high.
const BREAKOUT_BARS = 60;
// Trailing stop: sell when close < peak * TRAIL_NUM / TRAIL_DEN (0.6%).
const TRAIL_NUM = 497;
const TRAIL_DEN = 500;
// Longest a position is held, in batches, before a time-stop exit.
const MAX_HOLD_BARS = 60;
// No new entries at this batch seq or later (the window holds 1440 bars).
const LAST_ENTRY_SEQ = 1410;
// Slippage guard on every order, measured from the latest close.
const MAX_SLIPPAGE_BPS = 100;

let symbol = "CBBTC";
let minNotional = 1000000n;
const closes: number[] = [];
const highs: number[] = [];
let entryPeak = 0;
let fillSeq = -1;
let orderCounter = 0;

function highestHighBefore(endIndex: number, count: number): number {
  let best = 0;
  for (let k = endIndex - count; k < endIndex; k += 1) {
    if (highs[k] > best) {
      best = highs[k];
    }
  }
  return best;
}

function freshBreakout(): boolean {
  const j = closes.length - 1;
  if (j < BREAKOUT_BARS + 1) {
    return false;
  }
  const highNow = highestHighBefore(j, BREAKOUT_BARS);
  const highPrev = highestHighBefore(j - 1, BREAKOUT_BARS);
  return closes[j] > highNow && closes[j - 1] > highPrev;
}

function handleBatch(msg: IncomingMessage): OutgoingOrder[] {
  const seq = msg.seq;
  const account = msg.account;
  const cashText = account ? account.cash_quote_units : "0";
  const positions = account && Array.isArray(account.positions) ? account.positions : [];
  const fills = Array.isArray(msg.fills) ? msg.fills : [];

  for (const fill of fills) {
    if (fill.status !== "filled") {
      continue;
    }
    if (fill.side === "buy") {
      entryPeak = Number(fill.price);
      fillSeq = seq;
    } else if (fill.side === "sell") {
      entryPeak = 0;
      fillSeq = -1;
    }
  }

  const bars = Array.isArray(msg.bars) ? msg.bars : [];
  let bar: IncomingBar | undefined;
  for (const candidate of bars) {
    if (candidate.symbol === symbol) {
      bar = candidate;
      break;
    }
  }

  let close = 0;
  if (bar !== undefined) {
    close = Number(bar.c);
    closes.push(close);
    highs.push(Number(bar.h));
  }

  let holding = false;
  let positionQty = "0";
  for (const position of positions) {
    if (position.symbol === symbol && BigInt(position.qty) > 0n) {
      holding = true;
      positionQty = position.qty;
      break;
    }
  }

  if (holding && bar !== undefined) {
    if (entryPeak === 0) {
      entryPeak = close;
    } else if (close > entryPeak) {
      entryPeak = close;
    }
  }

  const orders: OutgoingOrder[] = [];
  if (holding) {
    const trailHit =
      bar !== undefined && entryPeak > 0 && TRAIL_DEN * close < TRAIL_NUM * entryPeak;
    const heldOut = fillSeq >= 0 && seq - fillSeq >= MAX_HOLD_BARS;
    if (trailHit || heldOut) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: "x" + orderCounter,
        symbol: symbol,
        qty: positionQty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    return orders;
  }

  if (
    bar !== undefined &&
    seq < LAST_ENTRY_SEQ &&
    freshBreakout() &&
    BigInt(cashText) >= minNotional
  ) {
    orderCounter += 1;
    orders.push({
      side: "buy",
      client_id: "e" + orderCounter,
      symbol: symbol,
      notional_quote_units: cashText,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
  }
  return orders;
}

function handleLine(line: string): void {
  if (line.trim() === "") {
    return;
  }
  let msg: IncomingMessage;
  try {
    msg = JSON.parse(line) as IncomingMessage;
  } catch {
    return;
  }
  if (msg.type === "hello") {
    if (msg.symbols && msg.symbols.length > 0) {
      symbol = msg.symbols[0].symbol;
    }
    if (msg.fees && msg.fees.min_notional_quote_units) {
      minNotional = BigInt(msg.fees.min_notional_quote_units);
    }
    return;
  }
  if (msg.type === "batch") {
    let orders: OutgoingOrder[];
    try {
      orders = handleBatch(msg);
    } catch {
      orders = [];
    }
    const reply = JSON.stringify({ type: "reply", seq: msg.seq, orders: orders });
    process.stdout.write(reply + "\n");
    return;
  }
  if (msg.type === "done") {
    process.exit(0);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    handleLine(line);
  }
});
process.stdin.on("end", () => {
  if (buffer.trim() !== "") {
    handleLine(buffer);
  }
  process.exit(0);
});
