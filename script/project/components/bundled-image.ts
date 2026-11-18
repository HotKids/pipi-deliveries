import { Script } from "scripting";

const images = new Map<string, UIImage>();

export function bundledImage(path: string): UIImage | undefined {
  let image = images.get(path);
  if (!image) {
    image = UIImage.fromFile(`${Script.directory}/assets/${path}`) ?? undefined;
    if (image) images.set(path, image);
  }
  return image;
}
