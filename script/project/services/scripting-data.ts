export function utf8Data(value: string): Data {
  if (!value.length) return Data.fromIntArray([]);
  const data = Data.fromRawString(value, "utf-8");
  if (!data) throw new Error("Unable to encode UTF-8 data");
  return data;
}
