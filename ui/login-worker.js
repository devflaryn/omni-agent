// The slow key, off the page's main thread: scrypt is JavaScript and runs for seconds, longer on a phone.
import { loginKeyFrom } from "./account-core.js";

self.onmessage = async ({ data: { password, salt } }) => {
  try {
    self.postMessage({ key: await loginKeyFrom(password, salt) });
  } catch {
    self.postMessage({ failed: true });
  }
};
