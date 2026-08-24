export const Path = {
  join(...parts) {
    return globalThis.Path.join(...parts);
  },
};

export function fetch(...args) {
  return globalThis.fetch(...args);
}

export const Notification = {
  schedule(...args) {
    return globalThis.Notification.schedule(...args);
  },
};

export const Widget = {
  reloadAll(...args) {
    return globalThis.Widget.reloadAll(...args);
  },
};

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
