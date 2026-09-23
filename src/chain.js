/**
 * Live, read-only Solana data for the website: token facts, top holders,
 * and "does this wallet hold $VICINITY?". Everything comes from the public
 * blockchain. Nothing is written, and no wallet address is ever stored.
 *
 * RPC: set the secret SOLANA_RPC_URL (e.g. a free Helius key) in Cloudflare.
 * Without it we fall back to the public endpoint, which can't list holders.
 */
import { OFFICIAL } from "./official.js";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const PROGRAM_LABELS = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun bonding curve",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap liquidity pool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium liquidity pool",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium liquidity pool",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora liquidity pool",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG": "Meteora liquidity pool",
};

export async function rpc(env, method, params, fetchImpl = fetch) {
  const url = (env && env.SOLANA_RPC_URL) || PUBLIC_RPC;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc_http_${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`rpc_${data.error.code || "error"}`);
  return data.result;
}

const uiAmount = (raw, decimals) => Number(BigInt(raw)) / 10 ** decimals;

/** Mint facts that prove (or disprove) the token can't be rugged by minting/freezing. */
export async function getTokenFacts(env, mint, fetchImpl) {
  const info = await rpc(env, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchImpl);
  const parsed = info?.value?.data?.parsed?.info;
  if (!parsed) throw new Error("not_a_mint");
  const decimals = parsed.decimals;
  return {
    mint,
    program: info.value.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL Token",
    decimals,
    supply: uiAmount(parsed.supply, decimals),
    mintAuthority: parsed.mintAuthority || null,
    freezeAuthority: parsed.freezeAuthority || null,
    mintingDisabled: !parsed.mintAuthority,
    freezingDisabled: !parsed.freezeAuthority,
  };
}

/** Top holders (up to 20), with owner wallets and labels for pools/curves/team. */
export async function getTopHolders(env, mint, fetchImpl) {
  const facts = await getTokenFacts(env, mint, fetchImpl);
  const largest = await rpc(env, "getTokenLargestAccounts", [mint], fetchImpl);
  const accounts = (largest?.value || []).filter((a) => a.amount !== "0");
  if (!accounts.length) return { facts, holders: [] };

  const tokenAccs = await rpc(env, "getMultipleAccounts", [accounts.map((a) => a.address), { encoding: "jsonParsed" }], fetchImpl);
  const owners = tokenAccs.value.map((acc) => acc?.data?.parsed?.info?.owner || null);
  const uniqueOwners = [...new Set(owners.filter(Boolean))];
  const ownerAccs = uniqueOwners.length
    ? await rpc(env, "getMultipleAccounts", [uniqueOwners, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }], fetchImpl)
    : { value: [] };
  const ownerProgram = Object.fromEntries(uniqueOwners.map((o, i) => [o, ownerAccs.value[i]?.owner || null]));

  const byOwner = new Map();
  accounts.forEach((a, i) => {
    const owner = owners[i] || a.address;
    const amt = uiAmount(a.amount, a.decimals ?? facts.decimals);
    byOwner.set(owner, (byOwner.get(owner) || 0) + amt);
  });

  const team = new Set(OFFICIAL.teamWallets || []);
  const holders = [...byOwner.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([owner, amount], i) => ({
      rank: i + 1,
      owner,
      amount,
      percent: facts.supply ? (amount / facts.supply) * 100 : 0,
      label: team.has(owner) ? "Team wallet (public)" : PROGRAM_LABELS[ownerProgram[owner]] || null,
    }));
  return { facts, holders };
}

/** How much $VICINITY does this wallet hold? (read-only, not stored) */
export async function getHolding(env, owner, mint, fetchImpl) {
  const res = await rpc(env, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed" }], fetchImpl);
  let amount = 0;
  for (const acc of res?.value || []) amount += Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
  return amount;
}
