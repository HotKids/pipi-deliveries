import assert from "node:assert/strict";
import test from "node:test";
import {
  asPlainObject,
  cleanScalarText,
  cleanString,
  cloneJsonRecord,
  cloneJsonValue,
  firstCleanScalarText,
  firstCleanString,
  isPlainObject,
  positiveFiniteTime,
} from "../services/value-guards";

test("value-guards plain object and text helpers preserve exact edge cases", () => {
  assert.equal(isPlainObject({ a: 1 }), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([1, 2]), false);
  assert.deepEqual(asPlainObject("nope"), {});

  assert.equal(cleanString("  hello "), "hello");
  assert.equal(cleanString(123), "");

  assert.equal(cleanScalarText(123), "123");
  assert.equal(cleanScalarText(Number.NaN, true), "");
  assert.equal(cleanScalarText(42, true), "42");

  assert.equal(firstCleanString({ a: " ", b: " sf ", c: "jd" }, "a", "b", "c"), "sf");
  assert.equal(firstCleanScalarText({ a: "", b: 201 }, "a", "b"), "201");
});

test("value-guards positiveFiniteTime and cloneJsonRecord avoid JSON round-trip", () => {
  assert.equal(positiveFiniteTime(1000, 2000), 1000);
  assert.equal(positiveFiniteTime(2500, 2000), 0);
  assert.equal(positiveFiniteTime(0), 0);
  assert.equal(positiveFiniteTime(-5), 0);
  assert.equal(positiveFiniteTime("1000"), 0);

  const source = {
    nested: { list: [1, undefined, { k: "v", drop: undefined }] },
    keep: false,
    omit: undefined,
  };
  const cloned = cloneJsonRecord(source);
  assert.deepEqual(cloned, {
    nested: { list: [1, null, { k: "v" }] },
    keep: false,
  });
  (cloned!.nested as { list: unknown[] }).list.push(99);
  assert.equal(source.nested.list.length, 3);
  assert.equal(cloneJsonValue("plain"), "plain");
  assert.equal(cloneJsonRecord(null), undefined);
});
