/** A USDC amount in base units (six decimals) as dollars: "5000" is "$0.005", "10000" is "$0.01". Read by the server and the operator page. */
export function usdOf(baseUnits: string | number): string {
  const padded = String(baseUnits).padStart(7, "0");
  return `$${padded.slice(0, -6)}.${padded.slice(-6).replace(/0+$/, "").padEnd(2, "0")}`;
}
