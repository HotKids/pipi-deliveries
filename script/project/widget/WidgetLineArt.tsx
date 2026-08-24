import { Image, Script } from "scripting";

export function WidgetLineArt(props: { family: "small" | "medium" }) {
  return (
    <Image
      filePath={{
        light: `${Script.directory}/assets/widget/empty-${props.family}-light.png`,
        dark: `${Script.directory}/assets/widget/empty-${props.family}-dark.png`,
      }}
      resizable={true}
      scaleToFill={true}
      opacity={0.22}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
    />
  );
}
