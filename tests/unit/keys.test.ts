import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchParmanaPublicKey } from "../../src/parmana/keys.js";

const { publicKey } = generateKeyPairSync("ed25519");
const PEM = publicKey.export({ format: "pem", type: "spki" }).toString();

describe("fetchParmanaPublicKey", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("fetches GET /keys/:keyId and parses the returned PEM into a usable public key, with no Authorization header", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keyId: "default", algorithm: "ed25519", use: "sig", pem: PEM }), {
        status: 200,
      }),
    );

    const keyObject = await fetchParmanaPublicKey("https://parmana.example.com", "default", 5_000);

    expect(keyObject.asymmetricKeyType).toBe("ed25519");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://parmana.example.com/keys/default");
    expect((init as RequestInit | undefined)?.headers).toBeUndefined();
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ pem: PEM }), { status: 200 }),
    );

    await fetchParmanaPublicKey("https://parmana.example.com/", "default", 5_000);

    expect(fetchMock.mock.calls[0]![0]).toBe("https://parmana.example.com/keys/default");
  });

  it("URL-encodes the keyId", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ pem: PEM }), { status: 200 }),
    );

    await fetchParmanaPublicKey("https://parmana.example.com", "tenant.some/weird id", 5_000);

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://parmana.example.com/keys/tenant.some%2Fweird%20id",
    );
  });

  it("throws on a non-2xx response", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response("not found", { status: 404 }));

    await expect(
      fetchParmanaPublicKey("https://parmana.example.com", "missing-key", 5_000),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws on a response with no pem field", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ keyId: "default" }), { status: 200 }),
    );

    await expect(
      fetchParmanaPublicKey("https://parmana.example.com", "default", 5_000),
    ).rejects.toThrow(/invalid response/);
  });
});
