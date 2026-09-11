export interface RefundRecord {
  refId: string;
  orderId: string;
  txnId: string;
  amount: string;
  status: "PENDING" | "SUBMITTED" | "CONFIRMED" | "FAILED" | "UNKNOWN";
}

export interface RefundIdempotencyStore {
  get(refId: string): Promise<RefundRecord | undefined>;
  put(record: RefundRecord): Promise<void>;
  /** Atomically claims a refund refId. Only one concurrent caller may win. */
  claim(record: RefundRecord): Promise<boolean>;
}

/** In-memory implementation for tests/local development only. */
export class MemoryRefundIdempotencyStore implements RefundIdempotencyStore {
  private readonly records = new Map<string, RefundRecord>();

  async get(refId: string) { return this.records.get(refId); }

  async claim(record: RefundRecord): Promise<boolean> {
    const existing = this.records.get(record.refId);
    if (existing) {
      assertSameRefund(existing, record);
      return false;
    }
    this.records.set(record.refId, record);
    return true;
  }

  async put(record: RefundRecord) {
    const existing = this.records.get(record.refId);
    if (existing) assertSameRefund(existing, record);
    this.records.set(record.refId, record);
  }
}

function assertSameRefund(left: RefundRecord, right: RefundRecord): void {
  if (left.orderId !== right.orderId || left.txnId !== right.txnId || left.amount !== right.amount) {
    throw new Error("refId is already bound to a different refund");
  }
}
