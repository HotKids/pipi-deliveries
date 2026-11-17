/**
 * A hosted viewport for the JingDong union page (AGENTS §9, D-15 裁决 A′, 2026-09-04).
 *
 * A `WebViewController` created inside a service has no window: the loaded page reports
 * `innerWidth`/`innerHeight` of 0 and `document.visibilityState === "hidden"` (Fold7-paired
 * beta12 device log: `viewportAvailable=false visibilityState=hidden`). The union page mounts
 * its floors by viewport intersection, so the exact 「完整物流进度」 control is never rendered
 * and the post-click modal cannot appear. A multi-node response can still independently
 * establish completeness under §9.
 *
 * Scripting can embed a controller in a `<WebView>` view, so the app root lends the
 * projection a real viewport: the same controller is rendered behind the page
 * content, which mirrors Pipi's window-attached 0.01-alpha capture WebView. The page owns the
 * slot across Home/detail navigation; the serialized H5 service borrows it for one load.
 *
 * Nothing here changes what counts as `complete`: the causal gate and the modal-coverage check
 * in `account-order-projection.ts` are unchanged. Without a host, identity extraction returns
 * its first accepted package without waiting for expansion. Widget sync never opens WebViews.
 */

/** The page-side slot. `mount` resolves when its sized WebView appears in the host. */
export type ProjectionViewportHost = Readonly<{
  mount: (controller: WebViewController) => Promise<boolean>;
  unmount: () => void;
}>;

export type ProjectionViewportView = Readonly<{
  id: number;
  controller: WebViewController;
  appeared: () => void;
}>;

export function createProjectionViewportHost(show: (view: ProjectionViewportView | null) => void): ProjectionViewportHost {
  let id = 0;
  let pending: ((mounted: boolean) => void) | undefined;
  return {
    mount(controller) {
      pending?.(false);
      return new Promise<boolean>((resolve) => {
        const settle = (mounted: boolean) => {
          if (pending !== settle) return;
          pending = undefined;
          resolve(mounted);
        };
        pending = settle;
        show({ id: ++id, controller, appeared: () => settle(true) });
      });
    },
    unmount() {
      pending?.(false);
      show(null);
    },
  };
}

let host: ProjectionViewportHost | null = null;
// The app root mounts on screen and its first scene event may never come.
let sceneActive = true;

/**
 * The app root reports its scene phase (user 2026-09-25): a refresh flow opens the union page only
 * while the scene is active, because a page that is not on screen reports `visibilityState=hidden`
 * and times out.
 */
export function setProjectionSceneActive(active: boolean): void {
  sceneActive = active;
}

export function projectionSceneActive(): boolean {
  return sceneActive;
}

/** The app root registers while mounted; passing null unregisters. */
export function registerProjectionViewportHost(
  next: ProjectionViewportHost | null,
): void {
  host = next;
}

export function projectionViewportHostAvailable(): boolean {
  return host != null;
}

/**
 * Borrows the page's slot for this controller. Resolves false when no page is hosting, when
 * the page rejects, or when mounting fails — the caller then proceeds headless rather than
 * failing the projection.
 */
export async function acquireProjectionViewport(
  controller: WebViewController,
): Promise<boolean> {
  const current = host;
  if (!current || controller == null) return false;
  try {
    return (await current.mount(controller)) === true;
  } catch {
    return false;
  }
}

/** Always called in the projection's `finally`, even when the load was cancelled. */
export function releaseProjectionViewport(): void {
  try {
    host?.unmount();
  } catch {
    /* the page may already be gone; the controller is disposed by its owner */
  }
}
