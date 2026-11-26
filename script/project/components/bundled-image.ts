import { Script } from "scripting";

const MAX_BUNDLED_IMAGES = 48;
const images = new Map<string, UIImage>();

export function bundledImage(path: string | undefined): UIImage | undefined {
  if (!path) return undefined;
  const cached = images.get(path);
  if (cached) {
    images.delete(path);
    images.set(path, cached);
    return cached;
  }
  const image = UIImage.fromFile(`${Script.directory}/assets/${path}`) ?? undefined;
  if (image) {
    images.set(path, image);
    if (images.size > MAX_BUNDLED_IMAGES) {
      images.delete(images.keys().next().value!);
    }
  }
  return image;
}
