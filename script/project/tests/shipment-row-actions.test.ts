import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One operation, one implementation (user decision 2026-09-04). PhoneManagerPage already had a
// working swipe-to-delete: rows inside a Section, the swipe action calling a page handler, and the
// page confirming with Dialog.confirm. Every attempt to give the express list its own mechanism
// failed — a row-hosted confirmationDialog ended the script session, a page-hosted one anchored to
// the page, and the imperative Dialog APIs appeared to throw. The list's rows were loose children
// of the List, mixed with a Section and a trailing VStack, which breaks SwiftUI row identity.
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFile(resolve(projectDir, path), "utf8");
const rowSource = await read("components/ShipmentRow.tsx");
const homeSource = await read("pages/HomePage.tsx");
const detailSource = await read("pages/DetailPage.tsx");
const phoneSource = await read("pages/PhoneManagerPage.tsx");

// The row carries the swipe action and hands the request to the page — same as the phone row.
assert.match(
  rowSource,
  /trailingSwipeActions=\{\{[\s\S]*?allowsFullSwipe: false,[\s\S]*?title="删除"[\s\S]*?role="destructive"[\s\S]*?action=\{props\.onDelete\}/,
  "the express row uses the same swipe-action shape as PhoneManagerPage",
);
assert.match(
  phoneSource,
  /trailingSwipeActions=\{\{[\s\S]*?allowsFullSwipe: false,/,
  "the reference implementation still looks like this",
);
assert.doesNotMatch(rowSource, /confirmationDialog=/, "the row hosts no presentation");
assert.doesNotMatch(rowSource, /useState/, "the row owns no confirmation state");
assert.doesNotMatch(rowSource, /setTimeout/);

// 右滑签收（用户定 2026-09-06）走同一条路：行只声明手势，动作交回页面。已签收的行不给这个手势。
assert.match(
  rowSource,
  /leadingSwipeActions=\{[\s\S]*?presentationStatus\.semantic === "COMPLETED"[\s\S]*?allowsFullSwipe: false,[\s\S]*?title="签收"[\s\S]*?action=\{props\.onComplete\}/,
  "the sign gesture reuses the delete shape and is withheld from a signed row",
);

// Rows must sit inside a Section: loose rows mixed with a Section and a VStack break row identity.
assert.match(
  homeSource,
  /<Section>\s*\{shipments\.map\(\(shipment\) => \(/,
  "shipment rows must be wrapped in their own Section",
);

// The page confirms with the same imperative alert PhoneManagerPage uses.
assert.match(
  homeSource,
  /async function confirmDelete\(shipment: Shipment\)[\s\S]*?await Dialog\.confirm\(\{[\s\S]*?title: "要删除此快递吗？"[\s\S]*?cancelLabel: "取消",[\s\S]*?confirmLabel: "删除",/,
  "AGENTS §11: the delete copy is one string shared with Pipi's cards/express_list.dart",
);
assert.match(homeSource, /删除后，该快递及其本地物流轨迹将一并移除。/);
assert.match(
  homeSource,
  /if \(!confirmed\) return;\s*remove\(shipment\.identity\.id\);/,
  "a cancelled confirmation must mutate nothing",
);

// 签收的确认同样由页面托管，文案取自三端统一表，取消则什么都不改。
assert.match(
  homeSource,
  /async function confirmComplete\(shipment: Shipment\)[\s\S]*?await Dialog\.confirm\(\{[\s\S]*?title: "要标记为已签收吗？"[\s\S]*?cancelLabel: "取消",[\s\S]*?confirmLabel: "签收",/,
  "the sign confirmation is page-hosted, exactly like the delete one",
);
assert.match(
  homeSource,
  /if \(!confirmed\) return;\s*complete\(shipment\.identity\.id\);/,
  "a cancelled sign confirmation must mutate nothing",
);
assert.match(
  homeSource,
  /performShipmentCompletion\(id\)/,
  "signing goes through the shared mutation service, not a bespoke write",
);
assert.match(homeSource, /EXPRESS_TOAST_COPY\.signed/);
assert.match(homeSource, /EXPRESS_TOAST_COPY\.signFailed/);

// The detail page carries no delete of its own any more.
assert.doesNotMatch(detailSource, /systemName="trash"/);
assert.doesNotMatch(detailSource, /confirmingDelete/);

console.log("shipment-row-actions tests passed");
