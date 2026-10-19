/** Local integration builds have their own output and can reach only a loopback backend. */
export function browserBuildTarget(localOrigin: string | undefined) {
  if (localOrigin === undefined) {
    return {
      origin: "https://obrigado.dev",
      permission: "https://obrigado.dev/*",
      outDir: ".output",
    };
  }
  const url = new URL(localOrigin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "OBRIGADO_BROWSER_E2E_ORIGIN must be an HTTP loopback origin without credentials, a path or a query",
    );
  }
  return { origin: url.origin, permission: `http://${url.hostname}/*`, outDir: ".output/e2e" };
}
