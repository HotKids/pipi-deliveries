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
import type { PickupEmptyArtwork } from "./components/EmptyDeliveryVehicle";
import { expireDueParcelHandoffs, loadAppState, peekStateRevision, refreshStoredWatchShipments, toggleParcelArtwork, visibleShipments } from "./services/storage";
import { performPickupAction, platformObservationSignature, refreshPlatformParcels } from "./services/platform-parcel-sync";
import { SCRIPT_VERSION } from "./services/build-track";
import {
  beginDiagnosticOperation,
  changedSinceLastLogged,
  diagnosticErrorDetails,
  diagnosticState,
  drainAppDiagnostics,
  noteDiagnosticAppliedRevision,
  startAppDiagnosticWrites,
  writeDiagnostic,
  writeRuntimeCapabilities,
} from "./services/logger";
import { preferNewerState } from "./services/ui-state";
import { refreshAllShipments, refreshCloudPddParcels, subscribeRefreshState } from "./services/sync";
import { enrichPendingCloudShipments } from "./services/sync";
import {
  reloadAndRefreshOnResume,
  resumeShipmentId,
} from "./services/app-resume";
import { activeMealCards, toggleMealCup } from "./services/meal/cards";
import { completeMeal } from "./services/meal/records";
import { mealCredentialScope } from "./services/meal/rules";
import { synchronizeMeals } from "./services/meal/cloud";
import { synchronizeParcelCloudRecords } from "./services/parcel-cloud-sync";
import { ensureMealRules, loadCarrierAuthorityCache, refreshCarrierAuthorityIfNeeded } from "./services/carrier-authority";
import { startForegroundOrderProjection } from "./services/foreground-order-projection";
import { startForegroundRefresh } from "./services/foreground-return-refresh";
import { startStatusAlignment } from "./services/status-alignment";
import {
  MEAL_SHORTCUT_RECORD_PARAMETER,
  PARCEL_SHORTCUT_RECORD_PARAMETER,
  discardShortcutDraft,
  nextShortcutLookup,
  preferShortcutLookup,
  takeScreenShortcutLookup,
} from "./services/parcel-shortcut";
import {
  hasRegisteredParcelPreview, onParcelActivityChanged, parcelActivityPreviewing, parcelActivitySceneChanged, parcelActivityTarget,
  reconcileParcelActivity,
} from "./services/parcel-live-activity";
import { nativePickupTabCloseId } from "./services/parcel-activity-action";
import { PICKUP_TAB_TITLE, activePickupCards, independentPickupContent, type ParcelActivityContent } from "./services/parcel-pickup";
import { nextParcelHandoffDeadline } from "./services/parcel-handoff-expiry";
import { reconcileFengchaoReminders } from "./services/fengchao-reminders";
import { transientToast, type WatchPullOutcome } from "./services/ui-feedback";
import { activeWatchScope } from "./services/international-records";
import { EXPRESS_TOAST_COPY, MEAL_TOAST_COPY } from "./services/express-toast-copy";
import { ShipmentLifecycleChangedError } from "./services/shipment-lifecycle";

type StartupState = {
  state: AppState | null;
};

const LAUNCH_INTERACTION_GRACE_MS = 250;

function shortcutPickupRecordId(state: AppState | null, parameters: Readonly<Record<string, unknown>>): string {
  const id = parameters[PARCEL_SHORTCUT_RECORD_PARAMETER];
  const record = typeof id === "string" && state?.pickupCodeRecords?.find((item) => item.id === id);
  return record && independentPickupContent(record) ? record.id : "";
}

function pickupNavigation(state: AppState | null, parameters: Readonly<Record<string, unknown>>,
  meals: readonly ParcelActivityContent[]) {
  const activity = state ? parcelActivityTarget(state, parameters.parcelActivity) : undefined;
  const mealId = parameters[MEAL_SHORTCUT_RECORD_PARAMETER];
  const card = typeof mealId === "string" ? meals.find(({ target }) => target &&
    "mealId" in target && target.mealId === mealId) : undefined;
  const meal = card?.target;
  const noticeMeal = meal && "mealId" in meal ? meal : undefined;
  return {
    activityShipmentId: activity && "shipmentId" in activity ? activity.shipmentId : "",
    pickupRecordId: activity && "mealId" in activity ? activity.mealId :
      activity && "recordId" in activity ? activity.recordId :
      noticeMeal?.mealId || shortcutPickupRecordId(state, parameters),
    activityMealQRCode: activity?.mealQRCode ?? (card?.hasMealQR && noticeMeal
      ? { id: noticeMeal.mealId, scope: noticeMeal.mealScope } : undefined),
  };
}

async function readStartupState(): Promise<StartupState> {
  // D100: the startup read ends with one line and its duration; a read that never returns is reported by the next
  // launch (D4). A failure stays an ERROR, since the page then waits for the user; it replaces app.startup.failed.
  // D150/D171: the startup line names the script version, since seven days of log can span an update.
  const finish = beginDiagnosticOperation("app.startup", { stage: "state", scriptVersion: SCRIPT_VERSION });
  try {
    const state = await loadAppState();
    finish("succeeded", diagnosticState(state));
    return { state };
  } catch (error) {
    finish("failed", diagnosticErrorDetails(error), "error");
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
  try {
    const cards = activeMealCards();
    // D127: a change in how many meal cards are shown is recorded; an unchanged reload is not.
    if (changedSinceLastLogged("meal.cards.loaded", String(cards.length))) {
      writeDiagnostic("meal.cards.loaded", { records: cards.length, result: cards.length ? "shown" : "empty" });
    }
    return cards;
  } catch (error) {
    writeDiagnostic("meal.cards.unavailable", diagnosticErrorDetails(error), "warning");
    return [];
  }
}

function usePickupTabState(cards: readonly ParcelActivityContent[], previewing: boolean, activityEndId?: string) {
  const hasCards = cards.length > 0 || previewing;
  const [keepVisible, setKeepVisible] = useState(hasCards);
  const hadCards = useRef(false);
  const previousActivity = useRef<string | undefined>(undefined);
  const lastCard = useRef<PickupEmptyArtwork | "preview" | undefined>(undefined);
  const emptyArtwork = useRef<PickupEmptyArtwork>("meal");
  const nextPreviewArtwork = useRef<PickupEmptyArtwork>("meal");
  const latestCard = cards.at(-1);
  if (latestCard) {
    lastCard.current = latestCard.kind === "meal" ? "meal" : "parcel";
  } else if (previewing) {
    lastCard.current = "preview";
  } else if (lastCard.current === "preview") {
    emptyArtwork.current = nextPreviewArtwork.current;
    nextPreviewArtwork.current = nextPreviewArtwork.current === "meal" ? "parcel" : "meal";
  } else if (lastCard.current) {
    emptyArtwork.current = lastCard.current;
  }
  if (!hasCards) lastCard.current = undefined;

  useEffect(() => {
    if (hasCards) {
      if (!hadCards.current) previousActivity.current = nativePickupTabCloseId();
      hadCards.current = true;
      if (!keepVisible) {
        setKeepVisible(true);
        writeDiagnostic("pickup.tab.changed", { result: "shown", records: cards.length });
      }
      return;
    }
    hadCards.current = false;
    if (!keepVisible) return;
    const nativeClose = nativePickupTabCloseId();
    if (nativeClose && nativeClose !== previousActivity.current) {
      setKeepVisible(false);
      writeDiagnostic("pickup.tab.changed", { result: "closed_from_activity" });
      return;
    }
    const timer = setTimeout(() => {
      setKeepVisible(false);
      writeDiagnostic("pickup.tab.changed", { result: "closed_after_grace" });
    }, 60_000);
    return () => clearTimeout(timer);
  }, [hasCards, keepVisible, activityEndId]);
  return { visible: hasCards || keepVisible, emptyArtwork: emptyArtwork.current };
}

function App({ initialStartup, initialPickupPreview }: { initialStartup: StartupState; initialPickupPreview: boolean }) {
  // One app-owned viewport stays mounted across Home/detail navigation.
  const [projectionView, setProjectionView] = useState<ProjectionViewportView | null>(null);
  const [startup, setStartup] = useState(initialStartup);
  const [platformNotice, setPlatformNotice] = useState<{ text: string } | undefined>(undefined);
  const [pickupNotice, setPickupNotice] = useState("");
  const [mealCards, setMealCards] = useState(readMealCards);
  const [watchAccessRevision, setWatchAccessRevision] = useState(0);
  // A Home Access Key notice brings Settings back to its root, where the key is entered.
  const [settingsRootRequest, setSettingsRootRequest] = useState(0);
  const [navigationRequest, setNavigationRequest] = useState(() => {
    const parameters = Script.queryParameters || {};
    const { activityShipmentId, pickupRecordId, activityMealQRCode } = pickupNavigation(startup.state, parameters, mealCards);
    return {
      shipmentId: activityShipmentId || resumeShipmentId({
        queryParameters: parameters,
        notificationInfo: Notification.current,
      }),
      pickupRecordId,
      activityMealQRCode,
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
  const shipments = useMemo(() => state ? visibleShipments(state) : [], [state, watchAccessRevision]);
  const platformObservationKey = useMemo(
    () => state ? platformObservationSignature(shipments, state.pickupCodeRecords) : "",
    [hasState, shipments, state?.pickupCodeRecords],
  );
  const pickupCards = useMemo(() => [...mealCards, ...activePickupCards(shipments, state?.pickupCodeRecords, state?.pickupArtworkChoices)],
    [shipments, state?.pickupCodeRecords, state?.pickupArtworkChoices, mealCards]);
  const latestPickupView = useRef({ state, pickupCards });
  latestPickupView.current = { state, pickupCards };
  const [pickupPreview, setPickupPreview] = useState(initialPickupPreview);
  const [activityEndId, setActivityEndId] = useState<string | undefined>(undefined);
  const { visible: hasPickupTab, emptyArtwork } = usePickupTabState(pickupCards, pickupPreview, activityEndId);
  const launchWorkStarted = useRef(false);
  const internationalRequest = useRef({ generation: 0, startedAt: 0 });
  const platformObservation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mealObservation = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
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
      // D161: the applied revision reaches the next refresh's end line instead of a line per applied state.
      noteDiagnosticAppliedRevision(selected.revision);
      return { state: selected };
    });
  }

  function refreshPlatformList(mode: "observe" | "pull") {
    return refreshPlatformParcels(applyState, mode).then((result) => {
      if (result.added) setPlatformNotice({ text: `已新增 ${result.added} 件快递` });
      if (result.added || result.succeeded) void refreshParcelCloud();
    }).catch(() => {
      writeDiagnostic("platform.sync.unavailable", {}, "warning");
    });
  }

  // The app's one Watch page owner. Its result tells a list pull what the read did (G-HIGH-10); every other caller
  // ignores it.
  function refreshInternational(force = false): Promise<WatchPullOutcome> {
    const current = internationalRequest.current;
    const now = Date.now();
    if (!force && now - current.startedAt < 120_000) {
      // D105: the two-minute throttle is recorded once per change, not on every return to the foreground.
      if (changedSinceLastLogged("cloud.international.throttle", "throttled")) {
        writeDiagnostic("cloud.sync.skipped", { domain: "international", stage: "watch_page", result: "throttled",
          skipReason: "throttled" });
      }
      return Promise.resolve("skipped");
    }
    current.startedAt = now;
    const generation = ++current.generation;
    return refreshStoredWatchShipments().then((next): WatchPullOutcome => {
      // The widget reads the shared state on its own timeline; a reload here would start a second
      // runtime refreshing beside this foreground pass.
      if (current.generation !== generation) return "skipped";
      // No result: no authorized Watch scope (nothing to read), or a read that failed and logged its own line.
      if (!next) return activeWatchScope() ? "failed" : "skipped";
      if (next.revision <= revision.current) return "unchanged";
      applyState(next);
      return "refreshed";
    }).catch((error): WatchPullOutcome => {
      writeDiagnostic("cloud.sync.failed", { domain: "international", stage: "watch_page",
        ...diagnosticErrorDetails(error) }, "warning");
      return "failed";
    });
  }

  function reloadMeals() {
    const cards = readMealCards();
    setMealCards(previous => previous.length === cards.length && JSON.stringify(previous) === JSON.stringify(cards)
      ? previous : cards);
    return cards;
  }

  /** `explicit`: 立即同步 or an Access Key change, which the automatic retry backoff for meal rules does not delay. */
  async function refreshMeals(explicit = false) {
    try {
      reloadMeals();
      if (await ensureMealRules("meal_sync", { explicit })) await synchronizeMeals();
      reloadMeals();
    } catch (error) {
      writeDiagnostic("meal.cards.refresh.failed", diagnosticErrorDetails(error), "warning");
    }
  }

  async function refreshParcelCloud() {
    if (typeof synchronizeParcelCloudRecords !== "function") return;
    try {
      await synchronizeParcelCloudRecords();
      if (typeof loadAppState === "function") {
        const next = await loadAppState();
        applyState(next);
      }
      if (typeof enrichPendingCloudShipments === "function") {
        await enrichPendingCloudShipments(applyState);
      }
    } catch {
      // synchronizeParcelCloudRecords logs its own diagnostic outcome.
    }
  }

  // The cloud record pull: the list pull, an Access Key change and 立即同步 on the account page share it.
  // Each owner skips without an authorized Access Key and records its own failure. The cloud PDD list is read
  // here for 立即同步 and a key change (owner 2026-11-21: 加上（推荐）); the list pull's own refresh already read
  // it in the same pass.
  // The list pull waits for the Watch read alone (G-HIGH-10); the meal and PDD pulls finish on their own.
  function startCloudRecords(trigger: "list_pull" | "access_key" | "sync_now") {
    const observed = latestPickupView.current.state;
    const meals = refreshMeals(trigger !== "list_pull");
    const parcels = refreshParcelCloud();
    const international = refreshInternational(true);
    const pdd = trigger !== "list_pull" && observed ? refreshCloudPddParcels(observed, applyState) : undefined;
    return { international, done: Promise.all([meals, parcels, international, pdd]).then(() => undefined) };
  }

  function refreshCloudRecords(trigger: "list_pull" | "access_key" | "sync_now"): Promise<void> {
    return startCloudRecords(trigger).done;
  }

  async function finishPickup(card: typeof pickupCards[number], openCabinet: boolean): Promise<void> {
    const target = card.target;
    if (target && "mealId" in target) {
      const finish = beginDiagnosticOperation("pickup.action", { stage: "commit", trigger: "meal" });
      let completed = false;
      try {
        completed = mealCredentialScope() === target.mealScope && completeMeal(target.mealScope, target.mealId);
        finish(completed ? "committed" : "stale");
      } catch (error) {
        finish("failed", diagnosticErrorDetails(error), "warning");
      }
      setPickupNotice(completed ? MEAL_TOAST_COPY.completed : MEAL_TOAST_COPY.completeFailed);
      try {
        if (completed) refreshMeals();
        else reloadMeals();
      } catch (error) {
        writeDiagnostic("pickup.meal.reload.failed", diagnosticErrorDetails(error), "warning");
      }
      return;
    }
    try {
      const notice = await performPickupAction(card, openCabinet, applyState);
      if (notice) setPickupNotice(notice);
      if (!openCabinet && typeof refreshParcelCloud === "function") void refreshParcelCloud();
    } catch (error) {
      if (error instanceof ShipmentLifecycleChangedError) {
        setPickupNotice(card.kind === "handoff" ? "未找到该寄件码"
          : target && "recordId" in target ? "未找到该取件码" : "该快递已失效");
      } else {
        writeDiagnostic("pickup.parcel.complete.failed", diagnosticErrorDetails(error), "warning");
        setPickupNotice(target && "recordId" in target
          ? EXPRESS_TOAST_COPY.pickupRecordActionFailed : EXPRESS_TOAST_COPY.signFailed);
      }
    }
  }

  function observePlatformList() {
    if (platformObservation.current !== undefined) return;
    platformObservation.current = setTimeout(() => {
      platformObservation.current = undefined;
      refreshPlatformList("observe");
    }, 0);
  }

  function observeMeals() {
    if (mealObservation.current !== undefined) return;
    mealObservation.current = setTimeout(() => {
      mealObservation.current = undefined;
      void refreshMeals();
      void refreshParcelCloud();
    }, 0);
  }

  function changePickupArtwork(card: typeof pickupCards[number]): boolean {
    try {
      if (card.kind === "meal") {
        const changed = toggleMealCup(card);
        reloadMeals();
        if (changed) {
          refreshMeals();
          return true;
        }
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
    const unsubscribe = onParcelActivityChanged(change => {
      if (change.kind === "preview") {
        reload();
        return;
      }
      if (change.kind === "pickup-tab-empty") {
        setActivityEndId(change.activityId);
      }
      reloadMeals();
      void loadAppState().then(next => {
        if (mounted) applyState(next);
      }).catch(() => writeDiagnostic("app.activity.resume.failed", {}, "warning"));
    });
    if (initialPickupPreview) reload();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = hasState ? subscribeRefreshState(applyState) : undefined;
    const start = async () => {
      if (!mounted) return;
      if (!hasState) {
        try { await refreshCarrierAuthorityIfNeeded(); }
        catch (error) { writeDiagnostic("app.startup.carriers.failed", diagnosticErrorDetails(error), "warning"); }
        return;
      }
      launchWorkStarted.current = true;
      await Promise.allSettled([
        (async () => {
          const summary = await refreshAllShipments();
          if (mounted) applyState(summary.state);
        })(),
        (async () => {
          try { await refreshCarrierAuthorityIfNeeded(); }
          catch (error) { writeDiagnostic("app.startup.carriers.failed", diagnosticErrorDetails(error), "warning"); }
          if (mounted) await refreshMeals();
        })(),
        refreshPlatformList("observe"),
        refreshInternational(),
        refreshParcelCloud(),
      ]);
    };
    const timer = setTimeout(() => void start(), LAUNCH_INTERACTION_GRACE_MS);
    return () => {
      mounted = false;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [hasState]);

  useEffect(() => {
    if (state && launchWorkStarted.current) observePlatformList();
  }, [platformObservationKey]);

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
      // D162: a phase change writes no line of its own; a return to the foreground ends in app.foreground.completed.
      // Refresh flows open the union page only while the app is active (user 2026-09-25).
      setProjectionSceneActive(phase === "active");
      parcelActivitySceneChanged(phase);
      orderProjection.scenePhaseChanged(phase);
      foregroundRefresh.scenePhaseChanged(phase);
      statusAlignment.scenePhaseChanged(phase);
      if (phase === "active") {
        if (launchWorkStarted.current) {
          observePlatformList();
          observeMeals();
          refreshInternational();
        }
        const foregroundStartedAt = Date.now();
        try {
          if (peekStateRevision() > revision.current) {
            void loadAppState().then(next => {
              if (mounted) applyState(next);
              // D101: the return to the foreground read a newer revision another runtime wrote.
              writeDiagnostic("app.foreground.completed", { result: "reloaded",
                durationMs: Date.now() - foregroundStartedAt, ...diagnosticState(next) });
            }).catch((error) => {
              if (mounted) writeDiagnostic("app.shortcut.resume.failed", diagnosticErrorDetails(error), "warning");
            });
          } else if (latestPickupView.current.state) {
            reconcileParcelActivity(latestPickupView.current.state, latestPickupView.current.pickupCards);
          }
          const lookup = nextShortcutLookup();
          // D101: a return that found the stored state current and reconciled the activities; written when its
          // outcome (a pending Shortcut lookup or none) changes.
          const outcome = lookup ? "shortcut_lookup" : "reconciled";
          if (peekStateRevision() <= revision.current && changedSinceLastLogged("app.foreground", outcome)) {
            writeDiagnostic("app.foreground.completed", { result: outcome,
              durationMs: Date.now() - foregroundStartedAt });
          }
          setNavigationRequest((current) => {
            const next = preferShortcutLookup(current.shortcutLookup, lookup);
            return next === current.shortcutLookup ? current : {
              ...current,
              shortcutLookup: next,
              generation: current.generation + 1,
            };
          });
        } catch (error) {
          writeDiagnostic("app.shortcut.resume.failed", diagnosticErrorDetails(error), "warning");
        }
      }
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      mounted = false;
      internationalRequest.current.generation++;
      AppEvents.scenePhase.removeListener(observe);
      if (platformObservation.current !== undefined) clearTimeout(platformObservation.current);
      if (mealObservation.current !== undefined) clearTimeout(mealObservation.current);
      orderProjection.stop();
      foregroundRefresh.stop();
      statusAlignment.stop();
    };
  }, []);

  useEffect(() => {
    if (state) {
      void reconcileFengchaoReminders(state, { shipments });
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
          // D101: the resume read the stored state; its refresh writes its own lines.
          writeDiagnostic("app.resume.completed", { result: "loaded", ...diagnosticState(persisted) });
          const meals = reloadMeals();
          const parameters = details.queryParameters || {};
          const presented = latestPickupView.current.state;
          const resumed = presented ? preferNewerState(persisted, presented) : persisted;
          const screenLookup = takeScreenShortcutLookup(parameters);
          const { activityShipmentId, pickupRecordId, activityMealQRCode } = pickupNavigation(resumed, parameters, meals);
          const pendingLookup = pickupRecordId ? undefined : nextShortcutLookup();
          setStartup(current => current.state && preferNewerState(resumed, current.state) === current.state
            ? current : { state: resumed });
          setNavigationRequest((current) => ({
            shipmentId: activityShipmentId || shipmentId,
            pickupRecordId,
            activityMealQRCode,
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
            emptyArtwork={emptyArtwork}
            focusedRecordId={navigationRequest.pickupRecordId}
            activityMealQRCode={navigationRequest.activityMealQRCode}
            onActivityMealQRCodeHandled={target => setNavigationRequest(current => current.activityMealQRCode === target
              ? { ...current, activityMealQRCode: undefined } : current)}
            onStateChange={applyState}
            showNotice={setPickupNotice}
            toast={transientToast(pickupNotice, setPickupNotice)}
            onAction={finishPickup}
            onArtworkChange={changePickupArtwork}
            onMealDeleted={() => refreshMeals()}
            onRefresh={async () => {
              await Promise.allSettled([
                refreshMeals(true),
                refreshParcelCloud(),
                refreshPlatformList("pull"),
                refreshAllShipments(undefined, { forceManualRefresh: true }).then((summary) => applyState(summary.state)),
              ]);
            }}
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
          onListPull={() => { refreshPlatformList("pull"); return startCloudRecords("list_pull").international; }}
          platformNotice={platformNotice}
          onOpenSettings={() => {
            setSettingsRootRequest(value => value + 1);
            selection.setValue("settings");
          }}
        />
      </Tab>
      <Tab key="settings" title="设置" systemImage="gearshape.fill" value="settings">
        <SettingsPage state={state} onStateChange={applyState} rootRequest={settingsRootRequest}
          onCloudRecordsRefresh={() => refreshCloudRecords("sync_now")}
          onAccessKeyChanged={() => {
            setWatchAccessRevision(value => value + 1);
            void refreshCloudRecords("access_key");
          }} />
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
    loadCarrierAuthorityCache();
    writeRuntimeCapabilities("app");
    const initialStartup = await readStartupState();
    let initialPickupPreview = false;
    try { initialPickupPreview = hasRegisteredParcelPreview(); }
    catch { writeDiagnostic("activity.parcel.preview.read.failed", { result: "failed" }, "warning"); }
    const presentedAt = Date.now();
    await Navigation.present({
      element: <App initialStartup={initialStartup} initialPickupPreview={initialPickupPreview} />,
      modalPresentationStyle: "fullScreen",
    });
    // D100: the session ended when the user closed the script; a session the system ends writes no line.
    writeDiagnostic("app.session.completed", { result: "closed", durationMs: Date.now() - presentedAt });
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
