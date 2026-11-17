export const Path = {
  join(...parts) {
    return globalThis.Path.join(...parts);
  },
  basename(path) {
    return globalThis.Path.basename(path);
  },
};

export function fetch(...args) {
  return globalThis.fetch(...args);
}

export const AbortController = globalThis.AbortController;
export const AbortSignal = globalThis.AbortSignal;

export const Notification = {
  schedule(...args) {
    return globalThis.Notification.schedule(...args);
  },
  getAllPendingsOfCurrentScript(...args) {
    return globalThis.Notification.getAllPendingsOfCurrentScript(...args);
  },
  removePendings(...args) {
    return globalThis.Notification.removePendings(...args);
  },
};

export const Widget = {
  reloadAll(...args) {
    return globalThis.Widget.reloadAll(...args);
  },
};

export function useMemo(factory) {
  return factory();
}

export const Script = {
  get directory() {
    return globalThis.Script.directory;
  },
  get name() {
    return globalThis.Script.name;
  },
  createRunSingleURLScheme(...args) {
    return globalThis.Script.createRunSingleURLScheme(...args);
  },
  requestAccess(...args) {
    return globalThis.Script.requestAccess(...args);
  },
};
