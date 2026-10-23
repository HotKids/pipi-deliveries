import assert from "node:assert/strict";
import { allowedProductImageURL, normalizedProductImageMetadataURL } from "../services/product-image-url";

for (const value of ["https://jd.com/a", "https://img.jd.com/a", "https://360buyimg.com/a", "https://img10.360buyimg.com/a",
  "https://JD.com:443/a", " https://img.jd.com/a "]) {
  assert.equal(allowedProductImageURL(value), new URL(value).href);
  assert.equal(normalizedProductImageMetadataURL(value), new URL(value).href);
}
for (const value of [null, 1, "http://jd.com/a", "https://jd.com:8443/a", "https://notjd.com/a", "https://jd.com.evil.test/a",
  "https://user@jd.com/a", "https://user:pass@jd.com/a", "https://@jd.com/a", " https://@jd.com/a",
  "https://jd.com\\evil/a", "https://img.jd.com/a\u0000", "\nhttps://img.jd.com/a"]) {
  assert.equal(allowedProductImageURL(value), null, "every download hop retains its raw-authority policy");
  if (value !== " https://@jd.com/a") assert.equal(normalizedProductImageMetadataURL(value), null);
}
for (const value of ["https:jd.com/a", "https:/jd.com/a", " https://@jd.com/a"]) {
  assert.equal(normalizedProductImageMetadataURL(value), "https://jd.com/a", "metadata retains normalization before fetch");
  assert.equal(allowedProductImageURL(value), null, "the same raw value is still rejected at the fetch boundary");
  assert.equal(allowedProductImageURL(normalizedProductImageMetadataURL(value)), "https://jd.com/a");
}
for (const value of ["https://jd.com?email=@", "https://jd.com#@", "https://@jd.com/a"]) {
  assert.equal(normalizedProductImageMetadataURL(value), null, "metadata retains its existing raw spelling rejection");
}
const padded = "\nhttps://img.jd.com/a\n";
assert.equal(normalizedProductImageMetadataURL(padded), null, "metadata still rejects raw controls");
assert.equal(allowedProductImageURL(padded.trim()), "https://img.jd.com/a", "the downloader retains its existing input trimming");
console.log("product image URL: shared origins, metadata normalization and distinct fetch-hop boundaries passed");
