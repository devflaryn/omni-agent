/** Protecting this device's secrets at rest: DPAPI on Windows, the Keychain on macOS, else file permissions with a warning. */
import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { basename, join } from "node:path";

const SECOND = 1000;

export function runCommand(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { windowsHide: true, timeout: 30 * SECOND, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      // The message is ours: stderr or the arguments could hold anything.
      if (error) reject(new Error(`${basename(cmd)} failed`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

export const system32 = (exe) => join(process.env.SystemRoot || "C:\\Windows", "System32", exe);

/** DPAPI through PowerShell, for this user. The data goes over stdin, never in an argument. */
export function windowsProtector({ run = runCommand } = {}) {
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const call = async (method, bytes) => {
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${method}($b,$null,'CurrentUser'))`;
    const out = await run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], Buffer.from(bytes).toString("base64"));
    const result = Buffer.from(out.trim(), "base64");
    if (!result.length) throw new Error(`DPAPI ${method} returned nothing`);
    return result;
  };
  return { name: "dpapi", warning: null, protect: (bytes) => call("Protect", bytes), unprotect: (bytes) => call("Unprotect", bytes) };
}

/**
 * A random wrapping key kept in the login Keychain through `security`, and AES-256-GCM with it. The key goes in through
 * `security -i` on stdin, since an argument could be seen by any process.
 */
export function keychainProtector({ service, run = runCommand } = {}) {
  const security = "/usr/bin/security";
  const ACCOUNT = "omni-agent";
  let cached = null;
  const wrappingKey = async ({ create }) => {
    if (cached) return cached;
    try {
      const hex = (await run(security, ["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"])).trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return (cached = Buffer.from(hex, "hex"));
    } catch { /* no such item yet */ }
    if (!create) throw new Error("no key in the Keychain");
    const key = randomBytes(32);
    await run(security, ["-i"], `add-generic-password -a ${ACCOUNT} -s ${service} -U -w ${key.toString("hex")}\n`);
    return (cached = key);
  };
  return {
    name: "keychain",
    warning: null,
    async protect(bytes) {
      const key = await wrappingKey({ create: true });
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const sealed = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
    },
    async unprotect(blob) {
      const key = await wrappingKey({ create: false });
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
    },
  };
}

export const PLAIN_WARNING = "This computer's keys, and any recovery code you have not saved yet, are protected by file permissions alone: any program running as you can read them.";
export function plainProtector() {
  return { name: "none", warning: PLAIN_WARNING, protect: async (bytes) => Buffer.from(bytes), unprotect: async (bytes) => Buffer.from(bytes) };
}

export function defaultProtector(dir) {
  if (process.platform === "win32") return windowsProtector();
  if (process.platform === "darwin") return keychainProtector({ service: `omni-agent-${createHash("sha256").update(dir).digest("hex").slice(0, 16)}` });
  return plainProtector();
}
