import {
  Button, HStack, Image, Navigation, NavigationStack, Text, VStack, WebView, useEffect, useRef, useState,
} from "scripting";
import { useBundledImage } from "../components/bundled-image";
import { iconTileShape } from "../components/icon-tile";
import {
  accountStatus, cookieValue, cookiesForURL, PLATFORM_NAMES, providerCookies, savePlatformLogin, WEB_PLATFORMS,
  trustedPlatformPage, type ExpressPlatform, type WebPlatform,
} from "../services/platform-accounts";
import { requestFengchaoCode, signInFengchao, type FengchaoChallenge } from "../services/fengchao-account";
import {
  checkCainiaoLogin, jdLoginProof, openProviderController, PlatformWireError, retainJdLoginView,
} from "../services/platform-wire";
import { asPlainObject, cleanString } from "../services/value-guards";
import { transientToast } from "../services/ui-feedback";
import { waitForRefresh } from "../services/deadline";
import { PhoneBindingPage } from "./PhoneBindingPage";

export function PlatformIcon({ platform, size = 36 }: {
  platform: ExpressPlatform | "samsung";
  size?: number;
}) {
  const artwork = useBundledImage(`platform-accounts/${platform}.png`);
  return artwork ? (
    <Image image={artwork}
      resizable antialiased interpolation="high" frame={{ width: size, height: size }}
      clipShape={iconTileShape(size)} />
  ) : <Image systemName="shippingbox.fill" frame={{ width: size, height: size }} />;
}

function decoded(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

// Only provider-owned account pages and the presence of their login cookies can finish the login.
async function verifiedLogin(platform: WebPlatform, controller: WebViewController, previousProof: string) {
  const page = asPlainObject(await controller.evaluateJavaScript<unknown>(
    "return {url: location.href, nickname: document.querySelector('.my_header_name, .userInfo .nickname, .nickname-wrapper .nickname')?.textContent || '', " +
    "pddMember: /我的订单|待收货|待发货|退出登录|个人中心|收货地址|我的拼单|待付款|我的优惠券/.test(document.body?.innerText?.slice(0, 6000) || '')}",
  ));
  const address = cleanString(page.url);
  if (!trustedPlatformPage(platform, address)) return null;
  const url = new URL(address);
  const cookies = providerCookies(platform, await controller.getAllCookies());
  if (platform === "cainiao") {
    const apiCookies = cookiesForURL(cookies, "https://h5api.m.taobao.com/h5/");
    const id = cookieValue(apiCookies, "unb") || cookieValue(apiCookies, "lgc") || cookieValue(apiCookies, "_nk_");
    const session = cookieValue(apiCookies, "cookie2") || cookieValue(apiCookies, "sgcookie");
    if (!id || !session || session === previousProof) return null;
    return { id: decoded(id), proof: session, cookies, nickname: "" };
  }
  if (platform === "pinduoduo") {
    if (!["mobile.yangkeduo.com", "mobile.pinduoduo.com", "m.pinduoduo.com"].includes(url.hostname) ||
      /login|passport|psnl_verification/.test(url.pathname) || page.pddMember !== true) return null;
    const appCookies = cookiesForURL(cookies, url.toString());
    const token = cookieValue(appCookies, "PDDAccessToken");
    const id = cookieValue(appCookies, "pdd_user_id");
    return token && id ? { id, proof: token, cookies, nickname: cleanString(page.nickname).replace(/^游客$/, "") } : null;
  }
  if (!["home.m.jd.com", "my.m.jd.com", "trade.m.jd.com"].includes(url.hostname)) return null;
  const account = jdLoginProof(cookies, url.toString());
  return account ? { ...account, cookies, nickname: cleanString(page.nickname).replace(/^京东用户$/, "") } : null;
}

function PlatformWebLogin({ platform, generation }: { platform: WebPlatform; generation: string }) {
  const dismiss = Navigation.useDismiss();
  const [controller, setController] = useState<WebViewController | null>(null);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const checking = useRef(false);
  const seenProof = useRef("");
  const detachJdView = useRef<(() => void) | null>(null);

  async function readLogin(web: WebViewController, retry = false) {
    if (!mounted.current || checking.current) return;
    checking.current = true;
    try {
      if (accountStatus(platform).generation !== generation) {
        dismiss(false);
        return;
      }
      const candidate = await waitForRefresh(
        verifiedLogin(platform, web, retry ? "" : seenProof.current), Date.now() + 5_000,
      ).catch(() => null);
      if (!candidate || !mounted.current) {
        if (retry && mounted.current) setNotice("请先在网页完成登录");
        return;
      }
      seenProof.current = candidate.proof;
      const cookies = platform === "cainiao" ? await checkCainiaoLogin(candidate.cookies) : candidate.cookies;
      if (!mounted.current) return;
      const saved = savePlatformLogin(platform, generation, { kind: "web", cookies }, candidate.id, candidate.nickname);
      if (saved && platform === "jingdong") {
        // The next reader must wait until this sheet releases the authenticated WebView.
        const detached = new Promise<void>((resolve) => { detachJdView.current = resolve; });
        retainJdLoginView(accountStatus(platform).generation, web, detached);
        mounted.current = false;
      }
      dismiss(saved);
    } catch {
      if (mounted.current) setNotice("登录状态未能确认，请重试");
    } finally {
      checking.current = false;
    }
  }

  useEffect(() => {
    let current: WebViewController | undefined;
    let timer: number | undefined;
    async function poll() {
      if (!mounted.current || !current) return;
      await readLogin(current);
      if (mounted.current) timer = setTimeout(() => void poll(), 1_250);
    }
    void openProviderController(platform, [], "login").then((web) => {
      if (!mounted.current) { web.dispose(); return; }
      current = web;
      setController(web);
      void web.loadURL(WEB_PLATFORMS[platform].login).catch(() => {
        if (mounted.current) setNotice("登录页面加载失败，请重试");
      });
      timer = setTimeout(() => void poll(), 1_250);
    }).catch(() => {
      if (mounted.current) setNotice("无法打开登录页面");
    });
    return () => {
      mounted.current = false;
      seenProof.current = "";
      if (timer !== undefined) clearTimeout(timer);
      if (detachJdView.current) detachJdView.current();
      else current?.dispose();
    };
  }, []);

  return (
    <NavigationStack>
      <VStack spacing={0} navigationBarTitleDisplayMode="inline"
        toast={transientToast(notice, setNotice)}
        toolbar={{
          topBarLeading: (
            <Button title="取消" systemImage="xmark" labelStyle="iconOnly" action={() => dismiss(false)} />
          ),
          principal: <HStack spacing={8}><PlatformIcon platform={platform} size={24} /><Text font={17}>{PLATFORM_NAMES[platform]}</Text></HStack>,
          topBarTrailing: (
            <Button title="完成" systemImage="checkmark" labelStyle="iconOnly"
              action={() => controller && void readLogin(controller, true)} disabled={!controller} />
          ),
        }}>
        {controller ? <WebView controller={controller} /> : null}
      </VStack>
    </NavigationStack>
  );
}

function FengchaoBinding({ generation }: { generation: string }) {
  const dismiss = Navigation.useDismiss();
  const challenge = useRef<FengchaoChallenge | null>(null);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; challenge.current = null; }, []);
  return (
    <NavigationStack>
      <PhoneBindingPage
        bindings={[]}
        purpose="fengchao"
        onCancel={() => dismiss(false)}
        onSendCode={async (mobile) => {
          challenge.current = null;
          try {
            const value = await requestFengchaoCode(mobile);
            if (active.current) challenge.current = value;
          } catch (error) {
            throw new Error(error instanceof PlatformWireError && error.reason === "verification"
              ? "请先在丰巢 App 完成安全验证，再获取验证码。" : "验证码发送失败，请稍后重试。");
          }
        }}
        onBind={async (mobile, code) => {
          if (challenge.current?.mobile !== mobile) throw new Error("请先获取该手机号的验证码");
          try {
            const credentials = await signInFengchao(challenge.current, code);
            if (active.current) dismiss(savePlatformLogin("fengchao", generation, credentials, mobile));
          } catch {
            throw new Error("丰巢登录失败，请检查验证码后重试。");
          }
        }}
      />
    </NavigationStack>
  );
}

export async function presentPlatformLogin(platform: ExpressPlatform): Promise<boolean> {
  const generation = accountStatus(platform).generation;
  const result = await Navigation.present<boolean>({
    element: platform === "fengchao" ? <FengchaoBinding generation={generation} /> :
      <PlatformWebLogin platform={platform} generation={generation} />,
    modalPresentationStyle: platform === "fengchao" ? "pageSheet" : "fullScreen",
  });
  return result === true;
}
