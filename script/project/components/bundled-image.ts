import { Script } from "scripting";

const MAX_BUNDLED_IMAGES = 48;
const images = new Map<string, UIImage>();
const inflight = new Map<string, Promise<UIImage | undefined>>();

function rememberBundled(path: string, image: UIImage): UIImage {
  images.delete(path);
  images.set(path, image);
  if (images.size > MAX_BUNDLED_IMAGES) {
    images.delete(images.keys().next().value!);
  }
  return image;
}

export function bundledImage(path: string | undefined): UIImage | undefined {
  if (!path) return undefined;
  const cached = images.get(path);
  if (cached) {
    return rememberBundled(path, cached);
  }
  const image = UIImage.fromFile(`${Script.directory}/assets/${path}`) ?? undefined;
  return image ? rememberBundled(path, image) : undefined;
}

export function prewarmBundledImages(paths: readonly (string | undefined)[]): Promise<void> {
  const unique = [...new Set(paths.filter((item): item is string => Boolean(item)))];
  return Promise.all(unique.map((path) => {
    if (images.has(path)) return Promise.resolve(images.get(path));
    const pending = inflight.get(path);
    if (pending) return pending;
    const task = (typeof FileManager?.readAsData === "function"
      ? FileManager.readAsData(`${Script.directory}/assets/${path}`)
        .then((data) => UIImage.fromData(data) ?? undefined)
        .catch(() => undefined)
      : Promise.resolve(undefined)
    ).then((decoded) => {
      inflight.delete(path);
      return decoded ? rememberBundled(path, decoded) : undefined;
    });
    inflight.set(path, task);
    return task;
  })).then(() => undefined);
}
