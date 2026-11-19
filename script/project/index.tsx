import {
  AppEvents,
  Button,
  GeometryReader,
  List,
  Navigation,
  NavigationStack,
  Notification,
  Script,
  Section,
  Tab,
  TabView,
  Text,
  WebView,
  ZStack,
  useEffect,
  useMemo,
  useObservable,
  useRef,
  useState,
} from "scripting";
import {
  createProjectionViewportHost,
  registerProjectionViewportHost,
  setProjectionSceneActive,
  type ProjectionViewportView,
} from "./services/projection-viewport";
import type { AppState } from "./models";
import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";
import { PickupPage } from "./pages/PickupPage";
import { expireDueParcelHandoffs, loadAppState, peekStateRevision, toggleParcelArtwork, visibleShipments } from "./services/storage";
import { performPickupAction, refreshPlatformParcels } from "./services/platform-parcel-sync";
import {
  diagnosticErrorDetails,
  diagnosticState,
  drainAppDiagnostics,
  startAppDiagnosticWrites,
  writeDiagnostic,
  writeRuntimeCapabilities,
} from "./services/logger";
import { preferNewerState } from "./services/ui-state";
import { refreshAllShipments, subscribeRefreshState } from "./services/sync";
import {
  reloadAndRefreshOnResume,
  resumeShipmentId,
} from "./services/app-resume";
import { activeMealCards, toggleMealCup } from "./services/meal/cards";
import { completeMeal } from "./services/meal/records";
import { mealCredentialScope } from "./services/meal/rules";
import { synchronizeMeals } from "./services/meal/cloud";
import { ensureMealRules, initializeCarrierAuthority } from "./services/carrier-authority";
import { startForegroundOrderProjection } from "./services/foreground-order-projection";
import { startForegroundRefresh } from "./services/foreground-return-refresh";
import { startStatusAlignment } from "./services/status-alignment";
import {
  PARCEL_SHORTCUT_RECORD_PARAMETER,
  discardShortcutDraft,
  nextShortcutLookup,
  preferShortcutLookup,
  takeScreenShortcutLookup,
} from "./services/parcel-shortcut";
import {
  onParcelActivityPreviewChanged, parcelActivityPreviewing, parcelActivitySceneChanged, parcelActivityTarget,
  reconcileParcelActivity,
} from "./services/parcel-live-activity";
import { PICKUP_TAB_TITLE, activePickupCards, independentPickupContent } from "./services/parcel-pickup";
import { nextParcelHandoffDeadline } from "./services/parcel-handoff-expiry";
import { reconcileFengchaoReminders } from "./services/fengchao-reminders";
import { transientToast } from "./services/ui-feedback";

type StartupState = {
  state: AppState | null;
};

function shortcutPickupRecordId(state: AppState | null, parameters: Readonly<Record<string, unknown>>): string {
  const id = parameters[PARCEL_SHORTCUT_RECORD_PARAMETER];
  const record = typeof id === "string" && state?.pickupCodeRecords?.find((item) => item.id === id);
  return record && independentPickupContent(record) ? record.id : "";
}

async function readStartupState(): Promise<StartupState> {
  try {
    return { state: await loadAppState() };
  } catch (error) {
    writeDiagnostic(
      "app.startup.failed",
      diagnosticErrorDetails(error),
      "error",
    );
    return { state: null };
  }
}

async function readPickupPreview(): Promise<boolean | undefined> {
  try {
    return await parcelActivityPreviewing();
  } catch {
    writeDiagnostic("activity.parcel.preview.read.failed", { result: "failed" }, "warning");
    return undefined;
  }
}

function readMealCards() {
  try { return activeMealCards(); }
  catch {
    writeDiagnostic("meal.cards.unavailable", {}, "warning");
    return [];
  }
}

function App({ initialStartup, initialPickupPreview }: { initialStartup: StartupState; initialPickupPreview: boolean }) {
  // One app-owned viewport stays mounted across Home/detail navigation.
  const [projectionView, setProjectionView] = useState<ProjectionViewportView | null>(null);
  const [startup, setStartup] = useState(initialStartup);
  const [platformNotice, setPlatformNotice] = useState<{ text: string } | undefined>(undefined);
  const [pickupNotice, setPickupNotice] = useState("");
  const [mealCards, setMealCards] = useState(readMealCards);
  const [navigationRequest, setNavigationRequest] = useState(() => {
    const parameters = Script.queryParameters || {};
    const activity = startup.state ? parcelActivityTarget(startup.state, parameters.parcelActivity) : undefined;
    const pickupRecordId = activity && "mealId" in activity ? activity.mealId :
      activity && "recordId" in activity ? activity.recordId :
      shortcutPickupRecordId(startup.state, parameters);
    return {
      shipmentId: activity && "shipmentId" in activity ? activity.shipmentId : resumeShipmentId({
        queryParameters: parameters,
        notificationInfo: Notification.current,
      }),
      pickupRecordId,
      shortcutLookup: takeScreenShortcutLookup(parameters) || (pickupRecordId ? undefined : nextShortcutLookup()),
      generation: 0,
    };
  });
  const selection = useObservable<string>(
    navigationRequest.pickupRecordId ? "pickup" : "deliveries",
  );
  const state = startup.state;
  const hasState = state !== null;
  const revision = useRef(state?.revision ?? -1);
  revision.current = state?.revision ?? -1;
  const resumeGeneration = useRef(0);
  const shipments = useMemo(() => state ? visibleShipments(state) : [], [state]);
  const pickupCards = useMemo(() => [...activePickupCards(shipments, state?.pickupCodeRecords, state?.pickupArtworkChoices), ...mealCards],
    [shipments, state?.pickupCodeRecords, state?.pickupArtworkChoices, mealCards]);
  const latestPickupView = useRef({ state, pickupCards });
  latestPickupView.current = { state, pickupCards };
  const [pickupPreview, setPickupPreview] = useState(initialPickupPreview);
  const hasPickupTab = pickupCards.length > 0 || pickupPreview;
  const platformObservation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handoffDeadline = useMemo(() => nextParcelHandoffDeadline(state?.pickupCodeRecords),
    [state?.pickupCodeRecords]);
  const query = Script.queryParameters || {};
  const focusSearch = String(query.focus || "") === "search";

  function applyState(next: AppState) {
    setStartup((current) => {
      const selected = current.state
        ? preferNewerState(current.state, next)
        : next;
      if (selected === current.state) return current;
      writeDiagnostic("app.state.applied", diagnosticState(selected));
      return { state: selected };
    });
  }

  function refreshPlatformList(mode: "observe" | "pull") {
    void refreshPlatformParcels(applyState, mode).then((result) => {
      if (result.added) setPlatformNotice({ text: `已新增 ${result.added} 件快递` });
    }).catch(() => {
      writeDiagnostic("platform.sync.unavailable", {}, "warning");
    });
  }

  function reloadMeals() {
    const cards = readMealCards();
    setMealCards(previous => previous.length || cards.length ? cards : previous);
  }

  function refreshMeals() {
    reloadMeals();
    void ensureMealRules().then(rules => {
      if (rules) return synchronizeMeals();
    }).then(reloadMeals).catch(() => {
      writeDiagnostic("meal.cards.refresh.failed", {}, "warning");
    });
  }

  async function finishPickup(card: typeof pickupCards[number], openCabinet: boolean): Promise<string> {
    const target = card.target;
    if (!target || !("mealId" in target)) return performPickupAction(card, openCabinet, applyState);
    if (mealCredentialScope() !== target.mealScope || !completeMeal(target.mealScope, target.mealId)) {
      reloadMeals();
      return "这张取餐码已不可用。";
    }
    refreshMeals();
    return "已完成取餐";
  }

  function observePlatformList() {
    if (platformObservation.current !== undefined) return;
    platformObservation.current = setTimeout(() => {
      platformObservation.current = undefined;
      refreshPlatformList("observe");
    }, 0);
  }

  function changePickupArtwork(card: typeof pickupCards[number]): boolean {
    try {
      if (card.kind === "meal") {
        const changed = toggleMealCup(card);
        reloadMeals();
        if (changed) return true;
      } else {
        applyState(toggleParcelArtwork(card));
        return true;
      }
    } catch (error) {
      writeDiagnostic("pickup.artwork.change.failed", diagnosticErrorDetails(error), "warning");
    }
    setPickupNotice(card.kind === "meal" ? "冷热切换失败，请稍后重试" :
      card.kind === "handoff" ? "寄件渠道切换失败，请稍后重试" : "取件站点切换失败，请稍后重试");
    return false;
  }

  useEffect(() => {
    let mounted = true;
    const reload = () => {
      void readPickupPreview().then((previewing) => {
        if (mounted && previewing !== undefined) setPickupPreview(previewing);
      });
    };
    const unsubscribe = onParcelActivityPreviewChanged(reload);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!hasState) return;
    let mounted = true;
    const unsubscribe = subscribeRefreshState(applyState);
    const timer = setTimeout(() => {
      refreshMeals();
      void refreshAllShipments().then((summary) => {
        if (mounted) applyState(summary.state);
      }).catch(() => { /* The refresh records its failure and leaves the cached list available. */ });
    }, 0);
    return () => {
      mounted = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [hasState]);

  useEffect(() => {
    if (state) observePlatformList();
  }, [state?.revision]);

  useEffect(() => {
    let mounted = true;
    // While the app is on screen it captures JD order waybills by itself (Lite parity, 2026-09-24).
    const orderProjection = startForegroundOrderProjection({ applyState });
    // Returning to the foreground refreshes the list, debounced 2 minutes (user 2026-10-02「改成 2 分钟（三端一起）」;
    // 30 s before, user default #11, audit R4).
    const foregroundRefresh = startForegroundRefresh({ applyState });
    // A visible row whose status, headline and detail times are out of step is refreshed once, forced (user 2026-10-02).
    const statusAlignment = startStatusAlignment({ applyState });
    const observe = (phase: "active" | "inactive" | "background") => {
      writeDiagnostic("app.scene.changed", { result: phase });
      // Refresh flows open the union page only while the app is active (user 2026-09-25).
      setProjectionSceneActive(phase === "active");
      parcelActivitySceneChanged(phase);
      orderProjection.scenePhaseChanged(phase);
      foregroundRefresh.scenePhaseChanged(phase);
      statusAlignment.scenePhaseChanged(phase);
      if (phase === "active") {
        observePlatformList();
        refreshMeals();
        try {
          if (peekStateRevision() > revision.current) {
            void loadAppState().then(next => {
              if (mounted) applyState(next);
            }).catch(() => {
              if (mounted) writeDiagnostic("app.shortcut.resume.failed", {}, "warning");
            });
          } else if (latestPickupView.current.state) {
            reconcileParcelActivity(latestPickupView.current.state, latestPickupView.current.pickupCards);
          }
          const lookup = nextShortcutLookup();
          setNavigationRequest((current) => {
            const next = preferShortcutLookup(current.shortcutLookup, lookup);
            return next === current.shortcutLookup ? current : {
              ...current,
              shortcutLookup: next,
              generation: current.generation + 1,
            };
          });
        } catch {
          writeDiagnostic("app.shortcut.resume.failed", {}, "warning");
        }
      }
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      mounted = false;
      AppEvents.scenePhase.removeListener(observe);
      if (platformObservation.current !== undefined) clearTimeout(platformObservation.current);
      orderProjection.stop();
      foregroundRefresh.stop();
      statusAlignment.stop();
    };
  }, []);

  useEffect(() => {
    if (state) {
      void reconcileFengchaoReminders(state, undefined, shipments);
    }
  }, [state]);

  useEffect(() => {
    if (state) reconcileParcelActivity(state, pickupCards);
  }, [state, pickupCards]);

  useEffect(() => {
    if (!mealCards.length) return;
    const deadline = Math.min(...mealCards.map(card => card.expiresAtMs ?? Infinity));
    if (!Number.isFinite(deadline)) return;
    const timer = setTimeout(reloadMeals, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    return () => clearTimeout(timer);
  }, [mealCards]);

  useEffect(() => {
    if (handoffDeadline === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let committed = false;
    function cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
    function schedule(deadline: number) {
      cancel();
      if (committed) return;
      timer = setTimeout(() => {
        timer = undefined;
        const now = Date.now();
        if (now < deadline) {
          schedule(deadline);
          return;
        }
        try {
          const next = expireDueParcelHandoffs(now);
          committed = true;
          applyState(next);
        } catch {
          writeDiagnostic("activity.parcel.expiry.failed", {}, "warning");
        }
      }, Math.min(2_147_483_647, Math.max(0, deadline - Date.now())));
    }
    const observe = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") schedule(handoffDeadline);
      else cancel();
    };
    AppEvents.scenePhase.addListener(observe);
    schedule(handoffDeadline);
    return () => {
      cancel();
      AppEvents.scenePhase.removeListener(observe);
    };
  }, [handoffDeadline, state?.revision]);

  useEffect(() => {
    if (!hasPickupTab && selection.value === "pickup") selection.setValue("deliveries");
  }, [hasPickupTab]);

  useEffect(() => {
    const unsubscribe = Script.onResume((details) => {
      const request = ++resumeGeneration.current;
      void reloadAndRefreshOnResume(details, {
        load: loadAppState,
        onLoadFailed: (error) => {
          if (request !== resumeGeneration.current) return;
          writeDiagnostic("app.resume.failed", diagnosticErrorDetails(error), "error");
          setStartup({ state: null });
        },
        applyPersisted: (persisted, shipmentId) => {
          if (request !== resumeGeneration.current) return;
          reloadMeals();
          const parameters = details.queryParameters || {};
          const presented = latestPickupView.current.state;
          const resumed = presented ? preferNewerState(persisted, presented) : persisted;
          const screenLookup = takeScreenShortcutLookup(parameters);
          const activity = parcelActivityTarget(resumed, parameters.parcelActivity);
          const activityShipmentId = activity && "shipmentId" in activity ? activity.shipmentId : "";
          const pickupRecordId = activity && "mealId" in activity ? activity.mealId :
            activity && "recordId" in activity ? activity.recordId : shortcutPickupRecordId(resumed, parameters);
          const pendingLookup = pickupRecordId ? undefined : nextShortcutLookup();
          setStartup(current => current.state && preferNewerState(resumed, current.state) === current.state
            ? current : { state: resumed });
          setNavigationRequest((current) => ({
            shipmentId: activityShipmentId || shipmentId,
            pickupRecordId,
            shortcutLookup: screenLookup || preferShortcutLookup(current.shortcutLookup, pendingLookup),
            generation: current.generation + 1,
          }));
          if (pickupRecordId) selection.setValue("pickup");
          else if (screenLookup || activityShipmentId) selection.setValue("deliveries");
        },
        refresh: () => refreshAllShipments(),
        applyRefreshed: (next) => {
          if (request === resumeGeneration.current) applyState(next);
        },
      });
    });
    return () => { resumeGeneration.current++; unsubscribe(); };
  }, []);

  useEffect(() => {
    let mounted = true;
    const viewportHost = createProjectionViewportHost((view) => {
      if (mounted) setProjectionView(view);
    });
    registerProjectionViewportHost(viewportHost);
    return () => {
      mounted = false;
      registerProjectionViewportHost(null);
      viewportHost.unmount();
    };
  }, []);

  if (!state) {
    return (
      <NavigationStack>
        <List
          navigationTitle="派派助手"
          navigationBarTitleDisplayMode="large"
        >
          <Section header={<Text>本地数据暂不可用</Text>}>
            <Text>
              脚本没有覆盖现有数据。请稍后重试读取本地快递信息。
            </Text>
            <Button title="重试" action={() => void readStartupState().then(setStartup)} />
          </Section>
        </List>
      </NavigationStack>
    );
  }

  return (
    <TabView
      selection={selection}
      toast={transientToast(pickupNotice, setPickupNotice)}
      background={
        projectionView
          ? {
              alignment: "topLeading",
              // Match Pipi's renderable capture surface while keeping it behind the app.
              content: (
                <GeometryReader>
                  {({ size }) => (
                    <ZStack>
                      {size.width > 0 && size.height > 0 ? (
                        <WebView key={projectionView.id}
                          controller={projectionView.controller}
                          frame={{ width: size.width, height: size.height }}
                          opacity={0.01}
                          allowsHitTesting={false}
                          disabled={true}
                          onAppear={projectionView.appeared}
                        />
                      ) : null}
                    </ZStack>
                  )}
                </GeometryReader>
              ),
            }
          : undefined
      }
    >
      {hasPickupTab ? (
        <Tab key="pickup" title={PICKUP_TAB_TITLE} systemImage="archivebox.fill" value="pickup">
          <PickupPage
            state={state}
            shipments={shipments}
            cards={pickupCards}
            previewing={pickupPreview}
            focusedRecordId={navigationRequest.pickupRecordId}
            onStateChange={applyState}
            showNotice={setPickupNotice}
            onAction={finishPickup}
            onArtworkChange={changePickupArtwork}
          />
        </Tab>
      ) : null}
      <Tab key="deliveries" title="快递" systemImage="shippingbox.fill" value="deliveries">
        <HomePage
          state={state}
          shipments={shipments}
          autoFocusSearch={focusSearch || Boolean(navigationRequest.shortcutLookup && !navigationRequest.shortcutLookup.openOnTap)}
          initialShipmentId={navigationRequest.shipmentId}
          navigationRequestGeneration={navigationRequest.generation}
          shortcutLookup={navigationRequest.shortcutLookup}
          onShortcutHandled={(generation) => {
            if (generation !== navigationRequest.generation) return;
            const draftToken = navigationRequest.shortcutLookup?.draftToken;
            if (draftToken) discardShortcutDraft(draftToken);
            setNavigationRequest((current) =>
              current.generation === generation ? { ...current, shortcutLookup: undefined } : current);
          }}
          onStateChange={applyState}
          onListPull={() => { refreshPlatformList("pull"); refreshMeals(); }}
          platformNotice={platformNotice}
        />
      </Tab>
      <Tab key="settings" title="设置" systemImage="gearshape.fill" value="settings">
        <SettingsPage state={state} onStateChange={applyState} onAccessKeyChanged={refreshMeals} />
      </Tab>
    </TabView>
  );
}

async function run() {
  // Without this the whole session ends on any throw with nothing recorded: `void run()` turns a
  // rejection into an unhandled one, the presented view is torn down, and the user sees the script
  // quit back to the app with an empty diagnostic log.
  startAppDiagnosticWrites();
  try {
    initializeCarrierAuthority();
    writeRuntimeCapabilities("app");
    const [initialStartup, initialPickupPreview] = await Promise.all([readStartupState(), readPickupPreview()]);
    await Navigation.present({
      element: <App initialStartup={initialStartup} initialPickupPreview={initialPickupPreview ?? false} />,
      modalPresentationStyle: "fullScreen",
    });
  } catch (error) {
    writeDiagnostic(
      "app.session.failed",
      diagnosticErrorDetails(error),
      "error",
    );
  } finally {
    await drainAppDiagnostics();
    Script.exit();
  }
}

void run();
