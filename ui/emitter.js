// The little of Node's EventEmitter the shared account code uses. One file for Node, browsers and iOS WKWebView.
export class Emitter {
  #listeners = new Map();

  on(name, listener) {
    if (!this.#listeners.has(name)) this.#listeners.set(name, []);
    this.#listeners.get(name).push(listener);
    return this;
  }

  once(name, listener) {
    const wrapped = (...args) => { this.off(name, wrapped); listener(...args); };
    wrapped.listener = listener;
    return this.on(name, wrapped);
  }

  off(name, listener) {
    const list = this.#listeners.get(name);
    if (!list) return this;
    const at = list.findIndex((l) => l === listener || l.listener === listener);
    if (at >= 0) list.splice(at, 1);
    return this;
  }

  /** Unlike Node's, an "error" with no listener is not thrown: nothing here wants that. */
  emit(name, ...args) {
    const list = this.#listeners.get(name);
    if (!list?.length) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  setMaxListeners() { return this; }
}
