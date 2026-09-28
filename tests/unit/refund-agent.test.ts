import { describe, expect, it, vi } from "vitest";
import { RefundAgent } from "../../src/agent/refund-agent.js";
import type { GovernedPaytmRefundService } from "../../src/governed-refund.js";

const input = {
  orderId: "ORDER-1",
  txnId: "TXN-1",
  amount: "15000",
  signals: { refundEligible: true, managerApproved: false, fraudCheckPassed: true, maximumRefundAmount: 100000 },
};

function agent() {
  const governed = { refund: vi.fn().mockResolvedValue({ decision: "DENIED" }) };
  return { governed, agent: new RefundAgent(governed as unknown as GovernedPaytmRefundService) };
}

describe("RefundAgent.proposeRefund", () => {
  it("passes a signed approval object through", async () => {
    const { governed, agent: refundAgent } = agent();
    const approvalArtifact = { payload: {}, signature: {} };

    await refundAgent.proposeRefund({ ...input, approvalArtifact });

    expect(governed.refund).toHaveBeenCalledWith(expect.objectContaining({ approvalArtifact }));
  });

  it("G-71: refuses a refId over 128 or a reason over 256 characters before asking Parmana", async () => {
    const { governed, agent: refundAgent } = agent();

    await expect(refundAgent.proposeRefund({ ...input, refId: "r".repeat(129) })).rejects.toThrow("refId must be at most 128");
    await expect(refundAgent.proposeRefund({ ...input, reason: "x".repeat(257) })).rejects.toThrow("reason must be at most 256");
    expect(governed.refund).not.toHaveBeenCalled();

    await refundAgent.proposeRefund({ ...input, refId: "r".repeat(128), reason: "x".repeat(256) });
    expect(governed.refund).toHaveBeenCalledTimes(1);
  });

  it.each([["a string", "signed"], ["an array", []], ["null", null]])("refuses an approvalArtifact that is %s", async (_label, approvalArtifact) => {
    const { governed, agent: refundAgent } = agent();

    await expect(
      refundAgent.proposeRefund({ ...input, approvalArtifact: approvalArtifact as unknown as Record<string, unknown> }),
    ).rejects.toThrow("approvalArtifact must be the signed approval object");
    expect(governed.refund).not.toHaveBeenCalled();
  });
});
