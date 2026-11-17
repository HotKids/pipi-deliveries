import {
  clearPlatformLogin, currentPlatformSession, type CabinetCredentials, type PlatformSession,
} from "./platform-accounts";
import { encryptFengchaoChallenge } from "./fengchao-rsa";
import { jsonObject, PlatformWireError, providerRequest } from "./platform-wire";
import { utf8Data } from "./scripting-data";
import { asPlainObject, cleanScalarText, type JsonObject } from "./value-guards";

const FENGCHAO = "https://consumer.fcbox.com";
const OP_CODE = "30b2718363204beeae98b7d03a75c3a4";

export type FengchaoChallenge = Readonly<{
  mobile: string;
  key: string;
  timestamp: string;
  clientIp: string;
  requestCode: string;
}>;

export type CabinetParcel = Readonly<{
  cabinetCode: string;
  cabinetName: string;
  address: string;
  location: string;
  boxId: string;
  boxGlobalRow: string;
  code: string;
  expressId: string;
  postId: string;
  clientMobile: string;
  companyName: string;
  companyLogoUrl: string;
  staffMobile: string;
  expressType: number;
}>;

function deviceHeaders(ip: string): Record<string, string> {
  // The consumer endpoint versions its mobile wire format through this header.
  return {
    "User-Agent": "channel=xiaomi,ip=" + ip + ",os=15,deviceType=2211133C,platform=Android," +
      "resolution=1080*2296,versionCode=6007000,versionName=6.7.0,timestamp=" + Date.now(),
    FC_USER_FLAG: "",
    "pinpoint-spanid": "1",
    "pinpoint-sampled": "true",
    "pinpoint-pspanid": "-1",
  };
}

function signed(challenge: FengchaoChallenge, code = ""): string {
  const { mobile, key, timestamp, clientIp, requestCode } = challenge;
  const purpose = code ? code + "01" : "11";
  const digest = Crypto.md5(utf8Data("86" + mobile + purpose + timestamp + clientIp + requestCode + OP_CODE)).toHexString();
  return encodeURIComponent(encryptFengchaoChallenge("86" + mobile + digest, key));
}

function success(payload?: JsonObject): boolean {
  const code = cleanScalarText(payload?.code);
  return code === "0" || code === "150100000" || payload?.success === true;
}

export async function requestFengchaoCode(mobile: string): Promise<FengchaoChallenge> {
  if (!/^1[3-9]\d{9}$/.test(mobile)) throw new PlatformWireError("unavailable");
  const query = "mobile=" + mobile + "&type=11&opCode=" + OP_CODE + "&nationCode=86";
  const response = await providerRequest(FENGCHAO + "/v1/account/secureCheckMobile?" + query, deviceHeaders(""));
  if (!response.ok) throw new PlatformWireError("unavailable");
  const data = asPlainObject(jsonObject(await response.text())?.data);
  if (String(data.needSliderCode).toLowerCase() === "true") throw new PlatformWireError("verification");
  const keyOrder = cleanScalarText(data.keyOrder).split(",").slice(0, 5);
  const key = keyOrder.map((part) => cleanScalarText(data["key" + part.trim()])).join("");
  const challenge = {
    mobile, key,
    timestamp: cleanScalarText(data.timestamp),
    clientIp: cleanScalarText(data.clientIp),
    requestCode: cleanScalarText(data.requestCode),
  };
  if (keyOrder.length !== 5 || key.length < 100) throw new PlatformWireError("unavailable");
  const sent = await providerRequest(FENGCHAO + "/v1/account/secureSendCode?" + query +
    "&sliderTicket=&sliderRandstr=&sign=" + signed(challenge), deviceHeaders(challenge.clientIp), "");
  if (!sent.ok || !success(jsonObject(await sent.text()))) throw new PlatformWireError("unavailable");
  return challenge;
}

export async function signInFengchao(challenge: FengchaoChallenge, code: string): Promise<CabinetCredentials> {
  if (!/^\d{4,6}$/.test(code)) throw new PlatformWireError("unavailable");
  const response = await providerRequest(FENGCHAO + "/v1/account/secureLoginByPhone?mobile=" + challenge.mobile +
    "&verifyCode=" + code + "&channel=0&type=1&weiXinUser=&nationCode=86&opCode=" + OP_CODE +
    "&sign=" + signed(challenge, code), deviceHeaders(challenge.clientIp), "");
  const token = response.headers.get("Authorization");
  if (!response.ok || !token) throw new PlatformWireError("unavailable");
  return {
    kind: "cabinet",
    mobile: challenge.mobile,
    clientIp: challenge.clientIp,
    token,
    flag: response.headers.get("FC_USER_FLAG") || "",
    userAuth: response.headers.get("FC_USER_AUTH") || "",
  };
}

export function platformPickupCode(raw: unknown, ...identifiers: string[]): string {
  const code = cleanScalarText(raw).replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ").trim().replace(/^(?:取件码|提货码|取货码|自提码|寄件码|凭码)[:：\s]*/, "")
    .split(/[,，;；、]/)[0].trim().replace(/\s*[-－—]\s*/g, "-");
  const key = (value: string) => value.replace(/[\s_－—-]/g, "").toUpperCase();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{1,19}$/.test(code) &&
    !/^(?:need_?sms|need_?code|null|none|undefined|true|false|nan)$/i.test(code) &&
    !identifiers.some((id) => id && key(code) === key(id)) ? code : "";
}

function objects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asPlainObject).filter((item) => Object.keys(item).length) : [];
}

export function cabinetParcels(data: JsonObject, mobile: string): CabinetParcel[] {
  const result: CabinetParcel[] = [];
  for (const cabinet of objects(data.cabinets)) {
    const cabinetCode = cleanScalarText(cabinet.cabinetCode);
    const address = cleanScalarText(cabinet.address);
    const cabinetName = ["cabinetName", "name", "pointName", "siteName"].map((key) => cleanScalarText(cabinet[key]))
      .find((name) => name && name !== address) || (cabinetCode ? "丰巢柜 " + cabinetCode : "");
    for (const box of objects(cabinet.boxes)) {
      for (const pkg of objects(box.packages)) {
        const expressId = cleanScalarText(pkg.expressId);
        const code = platformPickupCode(pkg.code, expressId);
        if (!code) continue;
        result.push({
          cabinetCode, cabinetName, address, expressId, code,
          location: cleanScalarText(box.location),
          boxId: cleanScalarText(box.boxId),
          boxGlobalRow: cleanScalarText(pkg.boxGlobalRow),
          postId: cleanScalarText(pkg.postId),
          clientMobile: cleanScalarText(pkg.clientMobile) || mobile,
          companyName: cleanScalarText(pkg.companyName),
          companyLogoUrl: cleanScalarText(pkg.companyLogoUrl),
          staffMobile: cleanScalarText(pkg.staffMobile),
          expressType: Number(cleanScalarText(pkg.expressType) || 1),
        });
      }
    }
  }
  return result;
}

async function cabinetRequest(session: PlatformSession, path: string, body?: JsonObject) {
  const live = currentPlatformSession("fengchao", session.generation);
  if (live?.credentials.kind !== "cabinet") throw new PlatformWireError("changed");
  const { token, clientIp, flag, userAuth } = live.credentials;
  const headers = { ...deviceHeaders(clientIp), Authorization: token };
  const openHeaders: Record<string, string> = body ? {
    "pinpoint-traceid": "ConsumerA0fc2d4fc6bfea8b^" + Date.now() + "^993",
    FLAG: flag, FC_USER_FLAG: flag, FC_USER_AUTH: userAuth,
  } : {};
  const response = await providerRequest(FENGCHAO + path, { ...headers, ...openHeaders }, body);
  const payload = jsonObject(await response.text());
  if (!currentPlatformSession("fengchao", session.generation)) throw new PlatformWireError("changed");
  if (response.status === 401 || cleanScalarText(payload?.code) === "401") {
    clearPlatformLogin("fengchao", session.generation, true);
    throw new PlatformWireError("expired");
  }
  if (!response.ok || !payload) throw new PlatformWireError("unavailable");
  return payload;
}

export async function fetchFengchaoCabinets(session: PlatformSession): Promise<CabinetParcel[]> {
  if (session.credentials.kind !== "cabinet") throw new PlatformWireError("changed");
  const response = await cabinetRequest(session, "/post/mobilePick/queryWaitPick?channelCode=ANDROID_FC_APP");
  if (!success(response)) throw new PlatformWireError("unavailable");
  return cabinetParcels(asPlainObject(response.data), session.credentials.mobile);
}

export function supportsCabinetOpening(parcel: CabinetParcel): boolean {
  return Boolean(parcel.cabinetCode && parcel.boxId && parcel.postId && parcel.code);
}

export async function requestCabinetOpening(session: PlatformSession, parcel: CabinetParcel): Promise<void> {
  if (!supportsCabinetOpening(parcel)) throw new PlatformWireError("unavailable");
  const payload = await cabinetRequest(session, "/post/clientGet/openBox", {
    cabinetCode: parcel.cabinetCode, channel: "APP-ANDRIOD", clientMobile: parcel.clientMobile,
    code: parcel.code, expressId: parcel.expressId, localActivityId: "", localAddress: parcel.address,
    localAllBoxIdList: parcel.boxId, localBoxGlobalRow: parcel.boxGlobalRow, localCode: parcel.code,
    localCurrBoxId: parcel.boxId, localDigitizationStatus: 0, localFromSource: "2",
    localOneClickOpenCabinetValidTime: "", localOrderId: "", localPopupTimeout: 120,
    localRefusePackages: [{
      companyLogoUrl: parcel.companyLogoUrl, companyName: parcel.companyName, expressId: parcel.expressId,
      expressType: parcel.expressType, localSelected: true, postId: parcel.postId, staffMobile: parcel.staffMobile,
    }],
    localRefuseSessionTokenTime: 120, localScanFirst: true, localScanTotal: 0, localSource: "0",
    localSupportVisual: false, mobilePickType: "APP-ANDRIOD", pickType: "ANDROID_PICK_MOBILE_APP", postId: parcel.postId,
  });
  if (!success(payload) || payload.success === false) throw new PlatformWireError("unavailable");
}
