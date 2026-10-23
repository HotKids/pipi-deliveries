package me.pipi.deliveries.background;

import java.util.Locale;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.data.ExpressRepository;
import me.pipi.deliveries.feature.express.ExpressOrderTextIdentity;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.network.ExpressAccountSource;
import me.pipi.deliveries.network.ExpressLog;
import me.pipi.deliveries.network.ExpressQueryCancellation;

/**
 * Client-side carrier recognition for account (sync) rows — EXPRESS_OWNERSHIP_PLAN §3.1 残留 #1
 * 裁决改为 A（用户定，2026-09-03）: the free Kuaidi100 recognizer is called directly by the client
 * for every waybill whose raw carrier misses the built-in table; the Worker only maps built-in raw
 * codes. Results are display-only carrier normalization; raw fields never change. Account orders
 * store recognition against their projected waybill, never the original order tuple.
 *
 * <p>承运商先对上再推送（T23，用户 2026-09-26，其余裁决 28）：一有运单号，同一轮先把识别跑完（内置表 → 快递100 免费
 * → 付费快递鸟）再落库、上列表、推送；订单这一轮对不上就不投影、保持原样，之后各轮继续补识别。手动件同样补识别。
 * 快递100 认得出、内置表没有的承运商按它给的名字只作显示（其余裁决 29）。</p>
 */
public final class AccountCarrierRecognition {
    @FunctionalInterface
    public interface Recognizer {
        CarrierNormalization recognize(String waybill) throws Exception;
    }

    /**
     * 用户 2026-09-27 第二轮清单：识别总时长三端对齐 30 秒（与 Pipi ExpressAutomaticCarrierRecognizer 同一语义）。
     * 一次同步轮里所有落库前 / 补识别的调用共用一份，只计等识别的时间，不算账号列表请求本身。用光后剩下的运单这一轮
     * 不再发请求，照 T23 压着（订单行保持原样、通知挂着），不计失败、不进终态，下一轮再识别；到点时正在等的那一次被
     * 取消，识别记录什么都不写。用户只定了时长，不设每轮张数上限。不属于同步轮的用户操作（一次详情刷新）每次各一份
     * 30 秒：用户 2026-09-27 识别 30 秒细则答「这样做」（Lite 详情刷新里的识别从最多 60 秒降到 30 秒）。
     */
    public static final long ROUND_BUDGET_MILLIS = 30_000L;
    /** Test seam: a shorter budget for a round or an operation; 0 uses {@link #ROUND_BUDGET_MILLIS}. */
    static volatile long budgetMillisOverride;

    /** What is left of one round's (or one operation's) recognition wait. */
    public static final class Budget {
        private long remainingNanos;

        /** A fresh budget of {@link AccountCarrierRecognition#ROUND_BUDGET_MILLIS}. */
        public Budget() {
            this(budgetMillisOverride > 0L ? budgetMillisOverride : ROUND_BUDGET_MILLIS);
        }

        public Budget(long millis) {
            remainingNanos = TimeUnit.MILLISECONDS.toNanos(Math.max(0L, millis));
        }

        public synchronized boolean spent() {
            return remainingNanos <= 0L;
        }

        synchronized long remainingNanos() {
            return remainingNanos;
        }

        synchronized void spend(long nanos) {
            remainingNanos -= Math.max(0L, nanos);
        }

        synchronized void exhaust() {
            remainingNanos = 0L;
        }
    }

    /** The budget ran out: nothing was asked, or the request in flight was cancelled; nothing was recorded. */
    public static final class BudgetSpentException extends Exception {
        /** Whether a request in flight was cancelled at the budget's end; false when nothing was asked. */
        public final boolean cut;

        BudgetSpentException(boolean cut) {
            super("carrier recognition budget spent");
            this.cut = cut;
        }
    }

    /** Runs each bounded recognition so the caller can stop waiting at the budget's end. */
    private static final ExecutorService BOUNDED_WAITS = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "express-carrier-wait");
        thread.setDaemon(true);
        return thread;
    });

    /**
     * {@code recognizer}, waiting no longer than what is left of {@code budget}. A spent budget sends
     * nothing and throws {@link BudgetSpentException}, which every caller here treats as no answer this
     * round (the row stays held). At the budget's end the wait is cancelled, and with it the request unless
     * another caller still waits for the same waybill: the recognition coordinator treats it like any caller
     * that leaves, disconnects the request and records no failure and no terminal verdict for it. Then
     * {@link BudgetSpentException} is thrown; the caller's thread is not interrupted. An interrupt of the
     * caller, or the end of the operation's own cancellation, still arrives as {@link InterruptedException}.
     */
    public static Recognizer bounded(Budget budget, Recognizer recognizer) {
        return waybill -> {
            if (budget.spent()) throw new BudgetSpentException(false);
            long started = System.nanoTime();
            Future<CarrierNormalization> call = BOUNDED_WAITS.submit(
                    ExpressLog.withCurrentScope(() -> recognizer.recognize(waybill)));
            try {
                return call.get(budget.remainingNanos(), TimeUnit.NANOSECONDS);
            } catch (TimeoutException timeout) {
                call.cancel(true);
                budget.exhaust();
                throw new BudgetSpentException(true);
            } catch (InterruptedException interrupted) {
                call.cancel(true);
                Thread.currentThread().interrupt();
                throw interrupted;
            } catch (ExecutionException failure) {
                Throwable cause = failure.getCause();
                if (cause instanceof InterruptedException) {
                    // The operation's own cancellation ended it, reported as ExpressApi reports it.
                    Thread.currentThread().interrupt();
                    throw (InterruptedException) cause;
                }
                if (cause instanceof Exception) throw (Exception) cause;
                if (cause instanceof Error) throw (Error) cause;
                throw new IllegalStateException(cause);
            } finally {
                budget.spend(System.nanoTime() - started);
            }
        };
    }

    private AccountCarrierRecognition() {}

    /**
     * 优化 5：the row's reuse anchor for the paid classify request ({@code parcelAnchorAtMs}) — 优化 5 续（用户 2026-10-03
     * 「第一次识别时记下锚点，之后不变」）the one recorded at the row's first recognition ({@link ExpressRepository#parcelAnchor});
     * 0 when it has no valid time, and then nothing is sent.
     */
    public static long parcelAnchor(ExpressRepository repository, ExpressItem row) {
        return repository == null
                ? me.pipi.deliveries.data.WaybillReusePolicy.parcelAnchorAt(row, System.currentTimeMillis())
                : repository.parcelAnchor(row);
    }

    /** R-20: a JD-platform row names the platform in its raw code; on a non-JD waybill that is no evidence. */
    static boolean platformLabelOnly(ExpressItem item) {
        if (item == null || !(item.isAccountOrder() || item.isJingDongSource())) return false;
        String waybill = normalize(item.displayWaybill());
        return !waybill.isEmpty() && !waybill.startsWith("JD");
    }

    /**
     * Whether recognition for {@code waybill} on this row must skip 京东 (R-20, T23 gap ②): a JD-platform
     * row (account order or JD business source) whose waybill does not start with JD.
     */
    public static boolean excludesJd(ExpressItem item, String waybill) {
        if (item == null || !(item.isAccountOrder() || item.isJingDongSource())) return false;
        String normalized = normalize(waybill);
        return !normalized.isEmpty() && !normalized.startsWith("JD");
    }

    public static boolean needsRecognition(ExpressItem item) {
        if (item == null) return false;
        if (item.isAccountOrder() && normalize(item.projectedWaybill).isEmpty()) return false;
        if (normalize(item.displayWaybill()).isEmpty() || item.resolvedCarrier() != null) return false;
        // T23 entry G: a manual row recognises its carrier too, but only while none is shown (an exhausted
        // verdict, 其余裁决 32, still retries once the coordinator's terminal window lapses).
        return !item.manuallyAdded || item.carrierPending() || item.carrierRecognitionExhausted();
    }

    public static boolean recognize(
            ExpressRepository repository, ExpressItem item, Recognizer recognizer)
            throws InterruptedException {
        if (repository == null || recognizer == null || !needsRecognition(item)) return false;
        CarrierNormalization recognized;
        try {
            recognized = recognizer.recognize(item.displayWaybill());
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception failure) {
            // The recognition coordinator owns retries (15-minute cooldown, three failures).
            return false;
        }
        if (recognized == null) return false;
        if (recognized.recognitionExhausted()) {
            // 其余裁决 32、33：识别终态、快递100 没给名字——记下结论，这一行随即放行，显示来源传回的 cpCode（没有就空着）。
            if (!item.carrierPending()) return false;
            return item.isAccountOrder()
                    ? repository.saveOrderProjectionExhausted(item, bindingSource(item),
                            item.projectedWaybill)
                    : repository.saveRecognizedCarrier(item, recognized);
        }
        if (!recognized.recognized()) {
            // 其余裁决 29: an off-table carrier is shown by the name Kuaidi100 gives, display only.
            String offTable = recognized.offTableName();
            if (offTable.isEmpty()) return false;
            if (item.isAccountOrder()) {
                return repository.saveOrderProjectionOffTableCarrier(item, bindingSource(item),
                        item.projectedWaybill, offTable);
            }
            return repository.saveRecognizedCarrier(item, recognized);
        }
        if (platformLabelOnly(item) && "JD".equals(recognized.standardCode)) return false;
        if (item.isAccountOrder()) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(recognized.standardCode);
            if (carrier == null) return false;
            // Audit C6 (user 2026-09-25; note: 汇通 is shown as 极兔): stored by its standard code, so
            // HTKY keeps its own identity and Kuaidi100 code instead of reading back as JTSD by name.
            return repository.saveOrderProjectionCarrier(item, bindingSource(item),
                    item.projectedWaybill, carrier.standardCode);
        }
        return repository.saveRecognizedCarrier(item, recognized);
    }

    /**
     * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」，其余裁决 28）：an account record about to add a new row, read as
     * the row it would become under {@code owner} (INTERFACE5 / INTERFACE6), so the same {@link #needsRecognition} and
     * R-20 rules decide it before anything is stored.
     */
    static ExpressItem publicationCandidate(ExpressQueryResult record, String owner) {
        return new ExpressItem(0L, record.phone, record.waybill, record.courierCode, record.companyName,
                record.semantic, record.statusDescription, record.latestDetail, record.latestTime,
                record.tracksJson, "", owner, record.detailUrl, record.statusEventTime, 0L, owner, "", "", "",
                false, "", "", "[]", record.sourceProvider, false, "", 0L, record.semantic,
                record.carrierNormalization);
    }

    /**
     * 代码 5（用户 2026-10-03「照 Pipi / iOS 的做法改」，其余裁决 28、37、42）：the carrier a new account row is stored with,
     * recognised before the row is saved and listed (built-in table → free Kuaidi100 → paid classify, as
     * {@link #recognize} does after the save): the recognised built-in carrier, Kuaidi100's off-table name (其余裁决 29) or
     * the terminal verdict (其余裁决 32). Null when the record needs no recognition or none matched this round — no
     * answer yet, a failure, a cooldown, the round's budget spent or cut off: the row is then stored as it came and
     * listed as before (raw code or nothing), its notification held while its carrier is pending, and a later round
     * recognises it again, as Pipi lists a new row whose recognition did not settle and iOS stores the parcel with
     * its direct carrier presentation.
     */
    public static CarrierNormalization beforePublication(ExpressQueryResult record, String owner,
            Recognizer recognizer) throws InterruptedException {
        if (record == null || recognizer == null) return null;
        ExpressItem candidate = publicationCandidate(record, owner);
        if (!needsRecognition(candidate)) return null;
        CarrierNormalization recognized;
        try {
            recognized = recognizer.recognize(candidate.displayWaybill());
        } catch (InterruptedException interrupted) {
            throw interrupted;
        } catch (Exception failure) {
            // The recognition coordinator owns retries; the budget's end is no answer this round.
            return null;
        }
        if (recognized == null) return null;
        if (recognized.recognitionExhausted()) return candidate.carrierPending() ? recognized : null;
        if (!recognized.recognized()) return recognized.offTableName().isEmpty() ? null : recognized;
        if (platformLabelOnly(candidate) && "JD".equals(recognized.standardCode)) return null;
        return recognized;
    }

    /**
     * T23: the carrier an unprojected order takes together with {@code waybill}, or null when none is
     * matched this round (the order then stays as it was). A table carrier the page gave is used as
     * before; otherwise the waybill is recognised (built-in table → free Kuaidi100 → paid classify,
     * 京东 skipped on a non-JD waybill); a real name the page gave comes next, then Kuaidi100's
     * off-table name. The returned value is what the projection stores: the page's name, a standard
     * code, or a display-only name. When recognition reached its terminal verdict without a name
     * (其余裁决 32, 33) the order is no longer held: the exhausted marker is returned and the row
     * shows the cpCode its source returned, as it is, or nothing when none was returned.
     */
    public static String projectionCarrier(ExpressItem order, String waybill, String offeredName,
            Recognizer recognizer) throws InterruptedException {
        String normalized = normalize(waybill);
        if (order == null || normalized.isEmpty()) return null;
        String offered = clean(offeredName);
        CarrierRegistry.Carrier table = CarrierRegistry.resolveProjected(offered);
        boolean platformOnly = table != null && "JD".equals(table.standardCode)
                && !normalized.startsWith("JD");
        if (table != null && !platformOnly) return offered;
        CarrierNormalization recognized = CarrierNormalization.NONE;
        if (recognizer != null) {
            try {
                CarrierNormalization answer = recognizer.recognize(waybill);
                if (answer != null) recognized = answer;
            } catch (InterruptedException interrupted) {
                throw interrupted;
            } catch (Exception failure) {
                // The recognition coordinator owns retries; this round keeps the order as it was.
            }
        }
        if (recognized.recognized()) {
            CarrierRegistry.Carrier carrier = CarrierRegistry.resolve(recognized.standardCode);
            if (carrier != null && !("JD".equals(carrier.standardCode)
                    && !normalized.startsWith("JD"))) {
                return carrier.standardCode;
            }
        }
        String realName = ExpressRepository.offTableCarrierName(offered);
        if (!realName.isEmpty()) return realName;
        String offTable = recognized.offTableName();
        if (!offTable.isEmpty()) return offTable;
        return recognized.recognitionExhausted() ? CarrierNormalization.PROJECTION_EXHAUSTED : null;
    }

    /**
     * T23: projects an unprojected Interface-5 order onto the waybill it already knows once its carrier
     * matched; returns whether it was projected. Every source notifies its landing round under the
     * ordinary rules (其余裁决 32: the query reply and the union page too), behind the carrier gate.
     */
    public static boolean projectPending(ExpressRepository repository, ExpressItem order,
            ExpressRepository.PendingProjection pending, Recognizer recognizer,
            ExpressQueryCancellation cancellation) throws InterruptedException {
        if (repository == null || order == null || pending == null) return false;
        String carrier = projectionCarrier(order, pending.waybill, pending.offeredName, recognizer);
        if (carrier == null) {
            ExpressLog.write("order.projection.skipped", "waybillTail", ExpressLog.tail(order.waybill),
                    "skipReason", "carrier_pending",
                    "projectionSource", pending.source.name().toLowerCase(Locale.ROOT));
            return false;
        }
        switch (pending.source) {
            case HELD_PAGE:
                return repository.releaseHeldOrderProjection(order, carrier, cancellation);
            case QUERY_TEXT:
                return repository.saveQueryTextProjection(order, pending.waybill, carrier, cancellation);
            case FEED_TEXT:
            default:
                return cancellation == null
                        ? repository.saveOrderProjection(order, bindingSource(order), pending.waybill, carrier)
                        : repository.saveOrderProjection(order, bindingSource(order), pending.waybill,
                                carrier, cancellation);
        }
    }

    /**
     * T23 entry E: the carrier a fresh v5_query reply may project this unprojected order with — null
     * when its order text names no waybill or the carrier did not match (the reply is then saved
     * without projecting, and later rounds retry recognition from the stored text).
     */
    public static String queryTextCarrier(ExpressItem owner, ExpressQueryResult query,
            Recognizer recognizer) throws InterruptedException {
        if (owner == null || query == null || !owner.isAccountOrder() || !owner.isJingDongSource()
                || !owner.projectedWaybill.isEmpty()) return null;
        ExpressOrderTextIdentity.Identity identity =
                ExpressOrderTextIdentity.fromTracksJson(query.tracksJson, owner.waybill);
        return identity == null ? null
                : projectionCarrier(owner, identity.waybill, "", recognizer);
    }

    /**
     * T23 entry F: saves a union page capture. For an unprojected order the carrier is matched first
     * (the page's table name or real name, else recognition); when it does not match — or the commit
     * was cut off by the capture's own budget — the waybill and page package are held instead of
     * lost, the order row stays as it was and no further page is opened for it. Any other row keeps
     * the ordinary save. Returns whether the page result was committed or held.
     */
    public static boolean savePageCapture(ExpressRepository repository, ExpressItem owner,
            ExpressRepository.ManualQueryOwnerClaim claim, ExpressQueryResult page, boolean complete,
            Recognizer recognizer, ExpressQueryCancellation cancellation) {
        if (repository == null || owner == null || page == null) return false;
        // Only a JD order takes its waybill from a page (AGENTS §9「谁需要自己取运单号」); anything else takes
        // the ordinary save, which never projects it.
        if (!owner.isAccountOrder() || !owner.isJingDongSource() || !owner.projectedWaybill.isEmpty()) {
            return repository.saveAutomaticDetailTimeline(owner, claim, page, complete, cancellation);
        }
        String carrier = null;
        boolean interrupted = false;
        try {
            carrier = projectionCarrier(owner, page.waybill, page.companyName, recognizer);
        } catch (InterruptedException cutOff) {
            interrupted = true;
        }
        try {
            if (carrier != null && repository.saveAutomaticDetailTimeline(
                    owner, claim, page, complete, cancellation, carrier)) return true;
            if (carrier != null && !interrupted
                    && (cancellation == null || !cancellation.isCancelled())) return false;
            return repository.holdOrderProjection(owner, claim, page, complete);
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    private static String bindingSource(ExpressItem item) {
        return ExpressAccountSource.bindingSourceForOwner(
                item.stateOwner.isEmpty() ? item.source : item.stateOwner);
    }

    private static String normalize(String value) {
        return clean(value).toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]", "");
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
