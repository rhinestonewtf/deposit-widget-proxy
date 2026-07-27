/**
 * Live verification for the self-service refund chain.
 *
 * Read-only by default: it proves the two assumptions the design rests on
 * without moving any money. Pass --execute to actually run a refund through a
 * locally-spawned proxy, which is the only step that spends funds.
 *
 *   RHINESTONE_API_KEY=... bun scripts/verify-refund.ts
 *   RHINESTONE_API_KEY=... bun scripts/verify-refund.ts --execute --destination 0x...
 *
 * Optional: --processor <url> (defaults to dev), --deposit <txHash> to target a
 * specific deposit instead of the first refundable one discovered.
 */
import { sign } from "hono/jwt";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const EXECUTE = args.includes("--execute");
const PROCESSOR = (
  flag("processor") ?? "https://dev.v1.orchestrator.rhinestone.dev/deposit-processor"
).replace(/\/$/, "");
const TARGET_TX = flag("deposit");
const DESTINATION = flag("destination");

const API_KEY = process.env.RHINESTONE_API_KEY?.trim();
if (!API_KEY) {
  console.error("RHINESTONE_API_KEY is not set");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", "x-api-key": API_KEY };

interface DepositRow {
  id?: string;
  chain?: string;
  txHash?: string;
  token?: string;
  depositAddress?: string;
  recipient?: string;
  sender?: string;
  amount?: string;
  status?: string;
  isSpam?: boolean;
}

let failures = 0;
function report(ok: boolean, label: string, detail?: unknown) {
  if (ok) {
    console.log(`  ✔ ${label}`);
  } else {
    failures++;
    console.log(`  ✘ ${label}`, detail === undefined ? "" : detail);
  }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${PROCESSOR}${path}`, { headers });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// --- 1. The key works and we can read deposits ----------------------------
console.log("\n[1] API key + GET /deposits");
const probe = await get("/deposits?limit=1&includeSpam=true");
report(probe.status === 200, `GET /deposits -> ${probe.status}`, probe.body);
if (probe.status !== 200) {
  console.error("\nCannot continue without a working key.");
  process.exit(1);
}

// --- 2. Find a refundable deposit on a managed account --------------------
// `refundDeposit` only accepts failed/rejected. includeSpam matters: it
// defaults to false and spam-flagged rejected rows are the common case.
console.log("\n[2] Discover a refundable deposit");
const candidates: DepositRow[] = [];
for (const status of ["failed", "rejected"]) {
  const { status: code, body } = await get(
    `/deposits?status=${status}&limit=25&includeSpam=true`,
  );
  if (code === 200 && Array.isArray(body?.deposits)) {
    candidates.push(...body.deposits);
  }
  console.log(
    `  status=${status}: ${code === 200 ? (body.deposits?.length ?? 0) : `HTTP ${code}`}`,
  );
}

const evmCandidates = candidates.filter(
  (d) =>
    d.chain?.startsWith("eip155:") &&
    d.txHash &&
    d.depositAddress &&
    d.token &&
    d.recipient,
);
const target = TARGET_TX
  ? evmCandidates.find((d) => d.txHash === TARGET_TX)
  : evmCandidates[0];

report(
  evmCandidates.length > 0,
  `found ${evmCandidates.length} refundable EVM deposit(s)`,
);
if (!target) {
  console.log(
    "\nNo refundable EVM deposit on this project. To create one, register a\n" +
      "managed account and send it dust below the bridge minimum (it lands as\n" +
      "`rejected`). Re-run afterwards.",
  );
  process.exit(failures === 0 ? 0 : 1);
}

console.log("  target:", {
  chain: target.chain,
  txHash: target.txHash,
  account: target.depositAddress,
  token: target.token,
  recipient: target.recipient,
  status: target.status,
  isSpam: target.isSpam,
});

// --- 3. The ownership check the proxy/helper depend on --------------------
// Both filter by recipient + chain + txHash and then match account+token.
console.log("\n[3] Ownership lookup by recipient");
const query = new URLSearchParams({
  recipient: target.recipient!,
  chain: target.chain!,
  txHash: target.txHash!,
  includeSpam: "true",
});
const lookup = await get(`/deposits?${query}`);
report(lookup.status === 200, `filtered lookup -> ${lookup.status}`);
const rows: DepositRow[] = lookup.body?.deposits ?? [];
report(
  rows.length > 0,
  `recipient filter returned ${rows.length} row(s) — aggregation works`,
);
const matched = rows.find(
  (d) =>
    d.depositAddress?.toLowerCase() === target.depositAddress?.toLowerCase() &&
    d.token?.toLowerCase() === target.token?.toLowerCase(),
);
report(
  Boolean(matched),
  "account+token match — the ownership check would pass",
  rows.map((d) => ({ depositAddress: d.depositAddress, token: d.token })),
);

// Casing matters: the proxy compares case-insensitively for 0x-hex only.
if (matched) {
  console.log("  casing:", {
    depositAddress: matched.depositAddress,
    depositAddressIsLowercase: matched.depositAddress === matched.depositAddress?.toLowerCase(),
    token: matched.token,
    tokenIsLowercase: matched.token === matched.token?.toLowerCase(),
  });
}

// A wrong recipient must return nothing, or the check is worthless.
const negative = await get(
  `/deposits?recipient=0x000000000000000000000000000000000000dEaD` +
    `&chain=${target.chain}&txHash=${target.txHash}&includeSpam=true`,
);
report(
  (negative.body?.deposits ?? []).length === 0,
  "unrelated recipient returns no rows",
  negative.body?.deposits,
);

// --- 4. The refund itself (spends funds) ----------------------------------
if (!EXECUTE) {
  console.log(
    "\n[4] Refund execution SKIPPED (read-only).\n" +
      "    Re-run with --execute --destination 0x... to move funds.",
  );
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

if (!DESTINATION) {
  console.error("\n--execute requires --destination 0x...");
  process.exit(1);
}

console.log("\n[4] Refund through a locally-spawned proxy");
const SECRET = "verify-refund-secret";
const PORT = 4733;
const proxy = Bun.spawn(["bun", "src/index.ts"], {
  cwd: import.meta.dir.replace(/\/scripts$/, ""),
  env: {
    ...process.env,
    RHINESTONE_API_KEY: API_KEY,
    DEPOSIT_SERVICE_URL: PROCESSOR,
    REFUND_TOKEN_SECRET: SECRET,
    PORT: String(PORT),
  },
  stdout: "inherit",
  stderr: "inherit",
});

for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch(`http://localhost:${PORT}/health`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const userToken = await sign(
  {
    recipient: target.recipient!,
    destination: DESTINATION,
    chain: target.chain!,
    txHash: target.txHash!,
    account: target.depositAddress!,
    token: target.token!,
    exp: Math.floor(Date.now() / 1000) + 120,
  },
  SECRET,
  "HS256",
);

// A token for someone else's recipient must be rejected before any money moves.
const forbidden = await fetch(`http://localhost:${PORT}/deposits/refund`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-user-token": await sign(
      {
        recipient: "0x000000000000000000000000000000000000dEaD",
        destination: DESTINATION,
        chain: target.chain!,
        txHash: target.txHash!,
        account: target.depositAddress!,
        token: target.token!,
        exp: Math.floor(Date.now() / 1000) + 120,
      },
      SECRET,
      "HS256",
    ),
  },
  body: "{}",
});
report(forbidden.status === 403, `wrong recipient -> ${forbidden.status} (want 403)`);

const refund = await fetch(`http://localhost:${PORT}/deposits/refund`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-user-token": userToken },
  body: "{}",
});
const refundBody = await refund.text();
report(refund.status === 200, `refund -> ${refund.status}`, refundBody);
console.log("  response:", refundBody);

// The atomic claim should have moved it out of failed/rejected.
await Bun.sleep(2000);
const after = await get(
  `/deposits?chain=${target.chain}&txHash=${target.txHash}&includeSpam=true`,
);
const afterRow = (after.body?.deposits ?? []).find(
  (d: DepositRow) => d.depositAddress?.toLowerCase() === target.depositAddress?.toLowerCase(),
);
console.log("  status after refund:", afterRow?.status);
report(
  afterRow?.status !== target.status,
  `status moved on from "${target.status}" (now "${afterRow?.status}")`,
);

proxy.kill();
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
