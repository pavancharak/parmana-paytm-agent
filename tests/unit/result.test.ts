import { describe, expect, it } from "vitest";

import { isConfirmedPaytmSuccess, readPaytmResult } from "../../src/paytm/result.js";

describe("readPaytmResult", () => {
  it("reads the nested resultInfo shape Paytm staging really returns", () => {
    // Captured from a real call to Paytm staging with an invalid merchant id.
    const result = readPaytmResult({
      resultInfo: { resultStatus: "TXN_FAILURE", resultCode: "335", resultMsg: "Invalid merchant Id." },
    });

    expect(result).toEqual({ status: "TXN_FAILURE", code: "335", message: "Invalid merchant Id." });
  });

  it("still reads the older flat shape", () => {
    expect(readPaytmResult({ resultStatus: "S", resultCode: "00" })).toEqual({ status: "S", code: "00", message: null });
  });

  it("prefers resultInfo over a top level status when both exist", () => {
    const result = readPaytmResult({ resultStatus: "S", resultInfo: { resultStatus: "TXN_FAILURE", resultCode: "335" } });

    expect(result.status).toBe("TXN_FAILURE");
  });

  it("normalizes case and whitespace", () => {
    expect(readPaytmResult({ resultInfo: { resultStatus: " txn_success " } }).status).toBe("TXN_SUCCESS");
  });

  it("reports UNKNOWN when there is no status at all", () => {
    expect(readPaytmResult({})).toEqual({ status: "UNKNOWN", code: null, message: null });
    expect(readPaytmResult({ resultInfo: {} }).status).toBe("UNKNOWN");
    expect(readPaytmResult({ resultInfo: "not an object" }).status).toBe("UNKNOWN");
  });
});

describe("isConfirmedPaytmSuccess", () => {
  it.each(["S", "SUCCESS", "TXN_SUCCESS"])("treats %s as a confirmed success", (status) => {
    expect(isConfirmedPaytmSuccess({ status, code: null, message: null })).toBe(true);
  });

  it.each(["PENDING", "TXN_FAILURE", "F", "UNKNOWN", ""])("does not treat %s as a confirmed success", (status) => {
    expect(isConfirmedPaytmSuccess({ status, code: null, message: null })).toBe(false);
  });
});
