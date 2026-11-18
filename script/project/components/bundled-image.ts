import { Script, useEffect, useState } from "scripting";

const images = new Map<string, UIImage>();
const pending = new Map<string, Promise<UIImage | undefined>>();

export function bundledImage(path: string): UIImage | undefined {
  let image = images.get(path);
  if (!image) {
    image = UIImage.fromFile(`${Script.directory}/assets/${path}`) ?? undefined;
    if (image) images.set(path, image);
  }
  return image;
}

/** Visible app views load file bytes without blocking their render. */
export function useBundledImage(path: string | undefined): UIImage | undefined {
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!path || images.has(path)) return;
    let active = true;
    let load = pending.get(path);
    if (!load) {
      load = FileManager.readAsData(`${Script.directory}/assets/${path}`).then(data => {
        const image = images.get(path) ?? UIImage.fromData(data) ?? undefined;
        if (image) images.set(path, image);
        return image;
      }).catch(() => undefined).finally(() => pending.delete(path));
      pending.set(path, load);
    }
    void load.then(image => { if (active && image) redraw(value => value + 1); });
    return () => { active = false; };
  }, [path]);
  return path ? images.get(path) : undefined;
}
