import { describe, expect, it } from "vitest";
import { endpointUrl } from "./http.js";

/*
 * Connection diagnostics fetch an operator-supplied URL from the control plane,
 * which is a server-side request an admin gets to aim. The rule below is
 * narrow on purpose — see the comment in `http.ts` for why private and
 * loopback destinations stay allowed.
 */
describe("endpointUrl", () => {
  it("refuses link-local metadata addresses in either family", () => {
    expect(() => endpointUrl("http://169.254.169.254", "/health"))
      .toThrow(/link-local metadata address/);
    expect(() => endpointUrl("http://169.254.170.2", "/health"))
      .toThrow(/link-local metadata address/);
    expect(() => endpointUrl("http://[fe80::1]", "/health"))
      .toThrow(/link-local metadata address/);
  });

  it("allows the private and loopback destinations this product is normally pointed at", () => {
    // Blocking these would refuse the dashboard's own suggested endpoint and
    // every single-box install, so they must keep working.
    expect(endpointUrl("http://gpu-server.internal:8000", "/health").href).toBe("http://gpu-server.internal:8000/health");
    expect(endpointUrl("http://10.0.0.5:8000", "/health").href).toBe("http://10.0.0.5:8000/health");
    expect(endpointUrl("http://192.168.1.20:8000", "/health").href).toBe("http://192.168.1.20:8000/health");
    expect(endpointUrl("http://127.0.0.1:8000", "/health").href).toBe("http://127.0.0.1:8000/health");
    // A host that only begins with the link-local octets is a normal name.
    expect(endpointUrl("http://169.254.169.254.example.com", "/health").hostname)
      .toBe("169.254.169.254.example.com");
  });

  it("keeps the existing origin, scheme and credential rules", () => {
    expect(() => endpointUrl("ftp://server", "/health")).toThrow(/HTTP or HTTPS/);
    expect(() => endpointUrl("http://user:pass@server", "/health")).toThrow(/must not contain credentials/);
    expect(() => endpointUrl("http://server", "http://elsewhere/health")).toThrow(/remain on the service origin/);
    expect(() => endpointUrl(null, "/health")).toThrow(/is not configured/);
  });
});
