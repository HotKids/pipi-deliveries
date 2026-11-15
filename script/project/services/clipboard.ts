export type CopyTextResult = "copied" | "failed";

export async function copyText(text: string): Promise<CopyTextResult> {
  const value = text.trim();
  if (!value) return "failed";

  try {
    await Pasteboard.setString(value);
    return "copied";
  } catch {
    // Some host versions expose setString but only accept the general item API.
  }

  try {
    // One pasteboard item carries only the supplied representations.
    await Pasteboard.setItems([{ "public.plain-text": value } as Pasteboard.Item]);
    return "copied";
  } catch {
    // Fall through to the deprecated API for older Scripting builds.
  }

  try {
    await Promise.resolve(Clipboard.copyText(value));
    return "copied";
  } catch {
    return "failed";
  }
}
