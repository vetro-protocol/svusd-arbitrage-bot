// redact: the boundary every console path goes through. A client error quotes the request that
// failed, so the endpoint URL (credential and all) arrives inside someone else's error string.
// Registered values are scrubbed exactly; the URL and hex patterns are the backstop for the rest.

import {describe, expect, it, vi} from "vitest";

/** Fresh module per case: registerSecrets is module state that would otherwise leak between tests. */
async function freshRedact() {
  vi.resetModules();
  return import("../../src/redact.js");
}

const INFURA = "https://mainnet.infura.io/v3/473f9873a58045c29284dae8f8c5f178";
const ALCHEMY = "https://eth-mainnet.g.alchemy.com/v2/AbC123_secretKey";
// QuickNode is the awkward one: the token is in the path, the endpoint id in the subdomain.
const QUICKNODE = "https://misty-cold-tree.quiknode.pro/9f8e7d6c5b4a32109f8e7d6c5b4a3210/";

describe("redactSecrets: URL shapes", () => {
  it("strips the credential-bearing path but keeps the host", async () => {
    const {redactSecrets} = await freshRedact();
    expect(redactSecrets(`URL: ${INFURA}`)).toBe("URL: https://mainnet.infura.io/<redacted>");
    expect(redactSecrets(ALCHEMY)).toBe("https://eth-mainnet.g.alchemy.com/<redacted>");
    expect(redactSecrets(QUICKNODE)).toBe("https://misty-cold-tree.quiknode.pro/<redacted>");
  });

  it("drops user:password@ credentials along with the path", async () => {
    const {redactSecrets} = await freshRedact();
    expect(redactSecrets("https://user:pa55w0rd@rpc.example.com/path?key=abc")).toBe(
      "https://rpc.example.com/<redacted>",
    );
  });

  it("leaves a bare host alone", async () => {
    const {redactSecrets} = await freshRedact();
    expect(redactSecrets("https://eth.llamarpc.com")).toBe("https://eth.llamarpc.com");
  });
});

describe("redactSecrets: registered values", () => {
  it("scrubs a registered URL entirely, subdomain included", async () => {
    const {redactSecrets, registerSecrets} = await freshRedact();
    registerSecrets(QUICKNODE);
    const out = redactSecrets(`URL: ${QUICKNODE}`);
    expect(out).toBe("URL: <redacted>");
    // The pattern pass alone would have kept this; only the value pass removes it.
    expect(out).not.toContain("misty-cold-tree");
  });

  it("scrubs a registered value even when it is not shaped like a URL", async () => {
    const {redactSecrets, registerSecrets} = await freshRedact();
    registerSecrets(INFURA);
    expect(redactSecrets(`{"endpoint":"${INFURA}"}`)).toBe('{"endpoint":"<redacted>"}');
  });

  it("ignores undefined and values too short to scrub safely", async () => {
    const {redactSecrets, registerSecrets} = await freshRedact();
    registerSecrets(undefined, "", "abc");
    expect(redactSecrets("abc is a common substring")).toBe("abc is a common substring");
  });
});

describe("redactSecrets: hex", () => {
  it("redacts a bare 32-hex project id", async () => {
    const {redactSecrets} = await freshRedact();
    expect(redactSecrets("key 473f9873a58045c29284dae8f8c5f178 here")).toBe("key <redacted> here");
  });

  it("keeps 0x-prefixed hashes and addresses readable", async () => {
    const {redactSecrets} = await freshRedact();
    const tx = "0xd07b9bc23bde0eace291409ad836816bd91ccaf492933059d287be7685e20b3c";
    const addr = "0x2B66E41fE0Be93c7f68B8fB2F2d9274f2Bc73aE6";
    expect(redactSecrets(`tx ${tx} at ${addr}`)).toBe(`tx ${tx} at ${addr}`);
  });
});

describe("errorText", () => {
  it("drops payload-dump lines rather than truncating them", async () => {
    const {errorText} = await freshRedact();
    const calldata = `0x${"ab".repeat(300)}`;
    const out = errorText(new Error(`reverted\n  data: ${calldata}\nDetails: out of gas`));
    expect(out).toBe("reverted | Details: out of gas");
    expect(out).not.toContain("abab");
  });

  it("joins the surviving lines and redacts them", async () => {
    const {errorText} = await freshRedact();
    expect(errorText(new Error(`failed\nURL: ${INFURA}\nDetails: out of gas`))).toBe(
      "failed | URL: https://mainnet.infura.io/<redacted> | Details: out of gas",
    );
  });

  it("caps total length", async () => {
    const {errorText} = await freshRedact();
    const out = errorText(new Error(Array.from({length: 40}, () => "x".repeat(100)).join("\n")));
    expect(out.length).toBeLessThanOrEqual(1_201);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles a non-Error throw", async () => {
    const {errorText} = await freshRedact();
    expect(errorText(INFURA)).toBe("https://mainnet.infura.io/<redacted>");
  });
});

describe("errorSummary", () => {
  it("keeps only the first line, redacted", async () => {
    const {errorSummary} = await freshRedact();
    expect(errorSummary(new Error(`revert: InsufficientProfit\nURL: ${INFURA}`))).toBe(
      "revert: InsufficientProfit",
    );
  });
});
