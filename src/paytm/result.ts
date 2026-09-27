/**
 * Reads the outcome of a Paytm refund call out of the response body.
 *
 * Paytm nests the outcome: `body.resultInfo.{resultStatus, resultCode, resultMsg}`.
 * This service used to read `body.resultStatus` directly, which does not exist in a real
 * Paytm response, so every outcome was recorded as UNKNOWN and none could be a success.
 * The flat shape is still read as a fallback so an older, flat shaped body keeps working.
 */
export interface PaytmResult {
  readonly status: string;
  readonly code: string | null;
  readonly message: string | null;
}

/**
 * Statuses treated as a confirmed success. Deliberately narrow: PENDING is not here.
 * A refund Paytm has accepted but not completed needs reconciliation, and reporting it as a
 * success could let something upstream treat an unconfirmed refund as done.
 */
const CONFIRMED_SUCCESS_STATUSES: ReadonlySet<string> = new Set(["S", "SUCCESS", "TXN_SUCCESS"]);

function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPaytmResult(body: Record<string, unknown>): PaytmResult {
  const source = isRecord(body["resultInfo"]) ? body["resultInfo"] : body;
  return {
    status: (text(source["resultStatus"]) ?? "UNKNOWN").toUpperCase(),
    code: text(source["resultCode"]),
    message: text(source["resultMsg"]),
  };
}

export function isConfirmedPaytmSuccess(result: PaytmResult): boolean {
  return CONFIRMED_SUCCESS_STATUSES.has(result.status);
}
