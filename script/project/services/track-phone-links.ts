const PHONE = /(?<![A-Za-z0-9])(?:\+86[- ]?)?(?:1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}|0[0-9]{2,3}[- ]?[0-9]{7,8}|(?:400|800)[- ]?[0-9]{3}[- ]?[0-9]{4}|95[0-9]{3,4})(?![A-Za-z0-9])/g;

/** Preserve every source character; only the matched phone span becomes interactive. */
export function trackPhoneText(detail: string, dial: (phone: string) => void) {
  const content: (string | { content: string; foregroundColor: string; onTapGesture: () => void })[] = [];
  let offset = 0;
  for (const match of detail.matchAll(PHONE)) {
    if (match.index > offset) content.push(detail.slice(offset, match.index));
    const phone = match[0].replace(/[- ]/g, "");
    content.push({ content: match[0], foregroundColor: "#1E85E5", onTapGesture: () => dial(phone) });
    offset = match.index + match[0].length;
  }
  if (offset < detail.length) content.push(detail.slice(offset));
  return { content };
}
