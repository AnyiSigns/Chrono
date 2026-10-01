// ui-kit/src/store.ts
function createStore(initial) {
  let snapshot = initial;
  const listeners = /* @__PURE__ */ new Set();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit(next) {
      snapshot = next;
      for (const listener of [...listeners]) listener(snapshot);
    }
  };
}
export {
  createStore
};
