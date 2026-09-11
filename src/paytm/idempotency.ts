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
}

/** In-memory store for local/staging use. Production should supply a durable store. */
export class MemoryRefundIdempotencyStore implements RefundIdempotencyStore {
  private readonly records = new Map<string, RefundRecord>();

  async get(refId: string) {
    return this.records.get(refId);
  }

  async put(record: RefundRecord) {
    const existing = this.records.get(record.refId);
    if (existing && (existing.orderId !== record.orderId || existing.txnId !== record.txnId || existing.amount !== record.amount)) {
      throw new Error("refId is already bound to a different refund");
    }
    this.records.set(record.refId, record);
  }
}
