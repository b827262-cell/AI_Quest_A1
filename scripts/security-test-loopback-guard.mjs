import net from "node:net";
import tls from "node:tls";

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(...args) {
  const port = args[0];
  if (typeof port !== "number") throw new Error("security test permits only ephemeral TCP listeners");
  if (typeof args[1] === "string") {
    if (args[1] !== "127.0.0.1" && args[1] !== "::1") {
      throw new Error("security test permits loopback listeners only");
    }
  } else {
    args.splice(1, 0, "127.0.0.1");
  }
  return originalListen.apply(this, args);
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const candidate = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof candidate === "object" && candidate !== null ? candidate : { port: args[0], host: args[1] };
  let host = options.host ?? options.hostname;
  if (options.path) throw new Error("security test network guard blocks Unix sockets");
  if (host === undefined && Number.isInteger(options.port)) {
    host = "127.0.0.1";
    if (Array.isArray(args[0])) args[0] = [{ ...options, host }, ...args[0].slice(1)];
    else if (typeof args[0] === "object") args[0] = { ...args[0], host };
    else args.splice(1, 0, host);
  }
  // Undici can call connect() without arguments after configuring a socket
  // through its own connector. It cannot select a destination at this point.
  if (host === undefined && options.port === undefined && args.length === 0) {
    return originalConnect.apply(this, args);
  }
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("security test network guard permits loopback TCP only");
  }
  return originalConnect.apply(this, args);
};

tls.connect = function blockedTlsConnect() {
  throw new Error("security test network guard blocks TLS and external network access");
};

const originalFetch = globalThis.fetch;
if (typeof originalFetch === "function") {
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]")) {
      return Promise.reject(new Error("security test network guard permits loopback HTTP only"));
    }
    return originalFetch(input, init);
  };
}
