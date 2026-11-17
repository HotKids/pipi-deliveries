// ISO/IEC 15417 symbol widths, from the first bar to the last space or stop bar.
const SYMBOLS = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 " +
  "112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 " +
  "311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 " +
  "112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 " +
  "313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 " +
  "314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 " +
  "122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 " +
  "124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 " +
  "114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112"
).split(" ");

export function code128Widths(value: string): number[] {
  if (!/^[ -~]{1,80}$/.test(value)) return [];
  const initialDigits = /^\d+/.exec(value)?.[0].length ?? 0;
  let numeric = initialDigits >= 4 && initialDigits % 2 === 0 || initialDigits === value.length && initialDigits === 2;
  const symbols = [numeric ? 105 : 104];
  let offset = 0;
  while (offset < value.length) {
    const next = value.slice(offset);
    const count = /^\d+/.exec(next)?.[0].length ?? 0;
    if (numeric && count >= 2) {
      symbols.push(Number(next.slice(0, 2)));
      offset += 2;
      continue;
    }
    if (numeric) {
      symbols.push(100);
      numeric = false;
    } else if (count >= 4 && count % 2 === 0) {
      symbols.push(99);
      numeric = true;
      continue;
    }
    symbols.push(value.charCodeAt(offset) - 32);
    offset++;
  }
  const checksum = symbols.reduce((sum, symbol, index) => sum + symbol * Math.max(1, index), 0);
  symbols.push(checksum % 103, 106);
  return symbols.flatMap((symbol) => Array.from(SYMBOLS[symbol], Number));
}
