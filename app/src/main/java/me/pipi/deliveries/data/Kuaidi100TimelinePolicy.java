package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.WorkerStatusProjection;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.regex.Pattern;

/** Refresh lifetime and same-provider incremental-cache policy for local timelines. */
public final class Kuaidi100TimelinePolicy {
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");
    private Kuaidi100TimelinePolicy() {}

    /** A manual item becomes visible only after a provider supplies a genuine timeline node. */
    public static boolean hasRealTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        return ExpressTimeline.latestMeaningful(result.tracksJson, result.semantic) != null
                || hasTimedTracking(result);
    }

    /** 一条节点是否可用：时间能解析、文案不是来源报错（K100 页抓取那一级按条过滤时用）。 */
    public static boolean isValidTrack(String time, String detail) {
        return ExpressSourcePolicy.parseEventTime(time) > 0L
                && !ExpressStatusNormalizer.isProviderErrorDetail(detail);
    }

    /** A successful cache write requires a real event paired with a parseable provider time. */
    public static boolean hasTimedTracking(ExpressQueryResult result) {
        if (result == null || ExpressStatusNormalizer.isProviderErrorDetail(
                result.latestDetail)) return false;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (track.epochMillis > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A current query chain is complete enough once one provider package contains the order or
     * pickup boundary. Numeric codes are interpreted with the package's own provider contract so
     * account state 102 (shipped) is never confused with Online/K100 state 102 (ordered).
     */
    public static boolean hasTimelineStart(ExpressQueryResult result) {
        return hasStartSemantic(result, true);
    }

    /**
     * 揽收证据：<strong>只认已揽收，不认已下单</strong>（用户定 2026-09-04）。已下单的件根本还
     * 没有承运商历史可缺，拿它退掉后面几级会把包裹晾在那里。详情完整判据用的是这一条。
     */
    public static boolean hasPickupEvidence(ExpressQueryResult result) {
        return hasStartSemantic(result, false);
    }

    /**
     * Only node evidence counts (audit D10, user 2026-09-25, as on iOS and Pipi): a pickup or order
     * node, by its own structured node status, or by its text when it has none (user 2026-10-02
     * 「三端统一改成结构化优先」). The package's status alone — which the ranking may have borrowed
     * from another package — is no start evidence without such a node.
     */
    private static boolean hasStartSemantic(
            ExpressQueryResult result, boolean orderedCounts) {
        if (!hasTimedTracking(result)) return false;
        String provider = normalizeProvider(result.timelineProvider);
        try {
            Object root = new JSONTokener(result.tracksJson).nextValue();
            return containsTimelineStart(root, provider, orderedCounts);
        } catch (Throwable ignored) {
            return false;
        }
    }

    /** 该包最新一条**有效**节点的事件时间；没有有效时间节点时返回 0。 */
    public static long latestTimedEventMillis(ExpressQueryResult result) {
        if (result == null) return 0L;
        long latest = 0L;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) continue;
            long time = track.epochMillis;
            if (time > latest) latest = time;
        }
        return latest;
    }

    /** 有效（带时间、非报错）节点数。 */
    public static int timedTrackCount(ExpressQueryResult result) {
        if (result == null) return 0;
        int count = 0;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "")) {
            if (ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) continue;
            if (track.epochMillis > 0L) count++;
        }
        return count;
    }

    public static boolean hasTimelineStart(ExpressItem item) {
        if (item == null) return false;
        String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
        String provider = owner.toLowerCase(java.util.Locale.ROOT).contains("interface5")
                || "i5-jd".equalsIgnoreCase(owner) ? TimelineSlot.V5_QUERY
                : owner.toLowerCase(java.util.Locale.ROOT).contains("interface6")
                || "i6-jd".equalsIgnoreCase(owner) ? TimelineSlot.V6_LIST
                : item.manualTimelineProvider;
        return hasTimelineStart(new ExpressQueryResult(
                item.displayWaybill(), item.courierCode, item.companyName,
                item.semantic, item.statusEventTime, item.latestTime,
                item.latestDetail, item.tracksJson, "", item.phone,
                provider, "", "", item.sourceProvider));
    }

    public static boolean containsTimelineStart(
            Object node, String provider, boolean orderedCounts) {
        return containsTimelineStart(node, provider, orderedCounts, true);
    }

    /** R-29 needs an order or pickup event; query completion alone proves no origin. */
    public static boolean containsTimelineOrigin(Object node, String provider) {
        return containsTimelineStart(node, provider, true, false);
    }

    private static boolean containsTimelineStart(
            Object node, String provider, boolean orderedCounts, boolean completionCounts) {
        if (node instanceof JSONArray) {
            JSONArray values = (JSONArray) node;
            for (int index = 0; index < values.length(); index++) {
                if (containsTimelineStart(
                        values.opt(index), provider, orderedCounts, completionCounts)) return true;
            }
            return false;
        }
        if (!(node instanceof JSONObject)) return false;
        JSONObject value = (JSONObject) node;
        String detail = first(value,
                "context", "desc", "description", "logisticDetail",
                "lastLogisticDetail", "message");
        boolean providerError = ExpressStatusNormalizer.isProviderErrorDetail(detail);
        String compactDetail = WHITESPACE.matcher(detail).replaceAll("");
        String source = normalizeProvider(first(value, "_pipiStatusSource"));
        if (source.isEmpty()) source = provider;
        // 用户定 2026-10-02「三端统一改成结构化优先」（Pipi ExpressDetailTimelinePolicy.hasStartSemantic 同一顺序）：
        // 节点有真实结构化状态时由状态定；下面的揽收、终点、下单文案只认没有结构化状态的节点。占位投影
        // （structured=false、code 为空）不算结构化状态。词表本身不变。
        StatusSemantic semantic = StatusSemantic.UNKNOWN;
        if (!providerError) {
            String code = first(value,
                    "logisticsStatus", "statusCode", "status", "state", "action");
            String description = first(value, "logisticsStatusDesc", "stateName");
            WorkerStatusProjection projected = WorkerStatusProjection.nodeEvidence(value);
            semantic = projected != null ? projected.semantic : isAccountProvider(source)
                    ? StatusSemantic.fromAccountState(code, description)
                    : StatusSemantic.fromKuaidi100EventCode(code);
            if (semantic == StatusSemantic.UNKNOWN && projected == null) {
                semantic = StatusSemantic.fromStored(code, description);
            }
            if (semantic == StatusSemantic.PICKED
                    || (orderedCounts && semantic == StatusSemantic.ORDERED)) {
                return true;
            }
        }
        if (!providerError && ExpressTimeline.hasJtStatusLabel(value)) semantic = StatusSemantic.fromJtLabel(value.optString("jtStatusLabel"));
        if (!providerError && (semantic == StatusSemantic.PICKED || orderedCounts && semantic == StatusSemantic.ORDERED)) return true;
        boolean proseDecides = !providerError && semantic == StatusSemantic.UNKNOWN && !ExpressTimeline.hasJtStatusLabel(value);
        // 三端同一组词（2026-09-05 对齐）：揽收类与下单类；EMS 的「已收寄」「商品已经下单」也算。
        if (proseDecides && (compactDetail.contains("已揽件")
                || compactDetail.contains("已揽收")
                || compactDetail.contains("揽收完成")
                || compactDetail.contains("揽件成功")
                || compactDetail.contains("揽收成功")
                || compactDetail.contains("已收寄")
                // 顺丰揽收节点写「顺丰速运 已收取快件」(2026-09-05 三端同补)。
                || compactDetail.contains("收取快件"))) return true;
        // 终点文案（2026-09-08 从下单词表挪出来）：京东原文是「订单已完成配送，感谢您选择京东购物」，
        // 说的是送完了，不是刚下单。闸门跟下单类同一档（只在 orderedCounts 时生效）——这一票已经
        // 走完，没有更早的历史值得再抓；展示上它是 COMPLETED，见 ExpressStatusNormalizer。
        if (proseDecides && orderedCounts && completionCounts
                && (compactDetail.contains("订单已完成")
                || compactDetail.contains("配送完成"))) return true;
        // 下单类整表（2026-09-07 三端对齐到 iOS semanticFromText）：这几个词 Lite 的展示表
        // ExpressStatusNormalizer 早就认成「已下单」，起点闸门却看不见，同一行自相矛盾。
        if (proseDecides && orderedCounts && (compactDetail.contains("已下单")
                || compactDetail.contains("已经下单")
                || compactDetail.contains("订单已提交")
                || compactDetail.contains("订单已创建")
                || compactDetail.contains("提交了订单")
                || compactDetail.contains("等待出库")
                || compactDetail.contains("正在打包")
                || compactDetail.contains("拣货"))) return true;
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            Object child = value.opt(keys.next());
            if ((child instanceof JSONArray || child instanceof JSONObject)
                    && containsTimelineStart(child, source, orderedCounts, completionCounts)) return true;
        }
        return false;
    }

    private static boolean isAccountProvider(String provider) {
        return "account".equals(provider) || TimelineSlot.isAccount(provider);
    }

    private static String first(JSONObject value, String... keys) {
        if (value == null) return "";
        for (String key : keys) {
            Object raw = value.opt(key);
            if (!(raw instanceof String) && !(raw instanceof Number)) continue;
            String candidate = String.valueOf(raw).trim();
            if (!candidate.isEmpty() && !"null".equalsIgnoreCase(candidate)) {
                return candidate;
            }
        }
        return "";
    }

    private static String normalizeProvider(String value) {
        return value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
    }

    /** Uses only adapter contracts that explicitly return a self-contained timeline package. */
    public static boolean isTimelineIncomplete(ExpressQueryResult result) {
        if (result == null) return true;
        String provider = result.timelineProvider == null
                ? "" : result.timelineProvider.trim().toLowerCase(java.util.Locale.ROOT);
        // Completeness is an adapter contract. Moto/OPPO and account feeds can be partial even
        // when they contain several nodes or a terminal label. A collapsed KDNiao terminal
        // headline remains partial until its package contains another timed history node.
        boolean declaredComplete = TimelineSlot.K100_H5.equals(TimelineSlot.normalize(provider))
                || TimelineSlot.JT_H5.equals(TimelineSlot.normalize(provider))
                || TimelineSlot.KDNIAO.equals(TimelineSlot.normalize(provider));
        return !ManualTimelineAuthorityPolicy.isEffectivelyComplete(
                provider, result, declaredComplete);
    }

    public static boolean isTimelineIncomplete(ExpressItem item) {
        if (item == null) return true;
        String provider = item.manualTimelineProvider.toLowerCase(java.util.Locale.ROOT);
        if (provider.isEmpty()) {
            String owner = item.stateOwner.isEmpty() ? item.source : item.stateOwner;
            if ("V4".equalsIgnoreCase(owner) || "KD-100".equalsIgnoreCase(owner)
                    || "I5-K100".equalsIgnoreCase(owner)
                    || "I6-K100".equalsIgnoreCase(owner)) {
                provider = "v4".equalsIgnoreCase(owner)
                        ? TimelineSlot.V4_QUERY : TimelineSlot.K100_H5;
            }
        }
        return isTimelineIncomplete(new ExpressQueryResult(
                item.displayWaybill(), item.courierCode, item.companyName,
                item.semantic, item.statusEventTime, item.latestTime, item.latestDetail,
                item.tracksJson, "", item.phone, provider, "", "", item.sourceProvider));
    }

    /** A trusted signature freezes automatic refresh, including rows whose history is missing. */
    public static boolean shouldRefresh(
            ExpressItem item, ExpressQueryResult cached, long now) {
        boolean completed = item != null && item.semantic == StatusSemantic.COMPLETED;
        if (cached != null && cached.semantic == StatusSemantic.COMPLETED) {
            completed = true;
        }
        if (!completed) return true;
        return ExpressLifecycleTimes.signedEvidenceAt(item, cached, now) <= 0L;
    }

    /** Keeps historical nodes and applies this refresh's additions or node revisions. */
    public static ExpressQueryResult merge(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        return merge(cached, refreshed, false);
    }

    static ExpressQueryResult mergeManualProvider(
            ExpressQueryResult cached, ExpressQueryResult refreshed) {
        return merge(cached, refreshed, true);
    }

    private static ExpressQueryResult merge(
            ExpressQueryResult cached, ExpressQueryResult refreshed,
            boolean requireStructuredTerminal) {
        if (cached == null) return refreshed;
        if (refreshed == null) return cached;
        boolean frozenCompletedPresentation = frozenCompletedHeadline(cached, requireStructuredTerminal);
        ExpressQueryResult presentation = frozenCompletedPresentation
                ? cached : selectedSameProviderPresentation(
                        cached, refreshed, requireStructuredTerminal);
        ExpressQueryResult headline = requireStructuredTerminal && !hasTimedTracking(presentation)
                ? hasTimedTracking(refreshed) ? refreshed : cached : presentation;
        me.pipi.deliveries.model.CarrierNormalization normalization =
                refreshed.carrierNormalization.present()
                        ? refreshed.carrierNormalization : cached.carrierNormalization;
        ExpressQueryResult merged = new ExpressQueryResult(
                prefer(presentation.waybill,
                        prefer(refreshed.waybill, cached.waybill)),
                prefer(presentation.courierCode,
                        prefer(refreshed.courierCode, cached.courierCode)),
                prefer(presentation.companyName,
                        prefer(refreshed.companyName, cached.companyName)),
                presentation.semantic, requireStructuredTerminal
                        ? presentation.statusEventTime : effectiveStatusEventTime(presentation),
                headline.latestTime,
                headline.latestDetail,
                WorkerStatusProjection.attach(ExpressTimeline.mergeJson(
                        cached.tracksJson, refreshed.tracksJson), presentation.workerStatus),
                prefer(refreshed.detailUrl, cached.detailUrl),
                prefer(refreshed.phone, cached.phone),
                prefer(refreshed.timelineProvider, cached.timelineProvider),
                prefer(refreshed.routeInterface, cached.routeInterface),
                prefer(refreshed.routeCredential, cached.routeCredential),
                prefer(refreshed.sourceProvider, cached.sourceProvider), normalization)
                .withManualStatusEvidence(
                        presentation.statusDescription,
                        presentation.structuredStatusEvidence);
        return withMergedHeadline(merged);
    }

    /**
     * 头条 = 最新的有效时间节点（用户定 2026-09-04）。合并装进两包轨迹的并集，表头却整份照搬选中那一包；
     * 网页包都不带状态，两边 UNKNOWN 时选的是旧包，轨迹已有新节点、表头还停在第一次抓取（Fold7 2026-09-24，
     * 1906 的京粉页包）。与 iOS status.ts withMergedHeadline 同一条规则（用户 2026-09-24 采纳对齐）：合并后
     * 的轨迹里有比存着的表头严格更新的有效节点就换过去，时间相同不换；存着的表头时间解析不了时不动（这条只防
     * 新节点被挡住，不修没有时间的表头）。状态、状态时间、结构化证据、轨迹都不动。已签收的包也走这里（用户
     * 2026-09-25 定，审计 D6「换成最新」）：签收之后又来的节点照样当表头，与 iOS、Pipi 同一条规则。
     */
    static ExpressQueryResult withMergedHeadline(ExpressQueryResult merged) {
        ExpressTimeline.Track latest = latestTimedTrack(merged);
        if (latest == null) return merged;
        long retainedAt = ExpressSourcePolicy.parseEventTime(merged.latestTime);
        if (retainedAt <= 0L) return merged;
        return ExpressSourcePolicy.parseEventTime(latest.time) > retainedAt
                ? merged.withHeadline(latest.time, latest.detail) : merged;
    }

    /**
     * 读时的表头（用户 2026-09-24 采纳第 2 条 2a）：旁表和 v5 查询表里的包都按 {@link #mergeManualProvider} 存，
     * 读时套同一条表头规则，改之前存下的旧表头不用等同一来源下次抓取（已签收、详情已完整的行可能再也不抓）。
     * 与 Pipi 读时从轨迹现算同口径；已签收的包也不例外（用户 2026-09-25 定，D6）。
     */
    static ExpressQueryResult storedManualHeadline(ExpressQueryResult stored) {
        return stored == null ? null : withMergedHeadline(stored);
    }

    /**
     * 已签收冻结：状态、状态时间与结构化证据停在签收那一包，之后的节点只并进轨迹；手动来源的包还要有结构化
     * 证据。表头不冻结，照常取最新的有效节点（用户 2026-09-25 定，D6）。
     */
    static boolean frozenCompletedHeadline(ExpressQueryResult result, boolean requireStructuredTerminal) {
        return isCompletedTimedPackage(result)
                && (!requireStructuredTerminal || result.structuredStatusEvidence);
    }

    /** 最新的有效（带时间、非报错）节点；解析出来的轨迹按时间倒序，第一条就是。 */
    static ExpressTimeline.Track latestTimedTrack(ExpressQueryResult result) {
        if (result == null) return null;
        for (ExpressTimeline.Track track : ExpressTimeline.parse(result.tracksJson, "", "", result.timelineProvider)) {
            if (track.epochMillis > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) return track;
        }
        return null;
    }

    static boolean isCompletedTimedPackage(ExpressQueryResult result) {
        return result != null
                && result.semantic == StatusSemantic.COMPLETED
                && (result.workerStatus == null || result.structuredStatusEvidence
                && result.statusEventTime > 0L && result.statusEventTime <= System.currentTimeMillis())
                && hasTimedTracking(result);
    }

    /** Selects one provider response as the whole visible header while tracks merge separately. */
    private static ExpressQueryResult selectedSameProviderPresentation(
            ExpressQueryResult cached, ExpressQueryResult refreshed,
            boolean requireStructuredTerminal) {
        boolean cachedTerminal = cached.semantic.terminal()
                && (!requireStructuredTerminal || cached.structuredStatusEvidence);
        boolean refreshedTerminal = refreshed.semantic.terminal()
                && (!requireStructuredTerminal || refreshed.structuredStatusEvidence);
        if (cachedTerminal && !refreshedTerminal) return cached;
        if (refreshedTerminal && !cachedTerminal) return refreshed;
        if (cached.semantic == refreshed.semantic
                && WorkerStatusProjection.priority(cached) != WorkerStatusProjection.priority(refreshed)) {
            return WorkerStatusProjection.priority(cached) > WorkerStatusProjection.priority(refreshed)
                    ? cached : refreshed;
        }
        if (refreshed.semantic == StatusSemantic.UNKNOWN) return cached;
        if (cached.semantic == StatusSemantic.UNKNOWN) return refreshed;
        long cachedEvent = effectiveStatusEventTime(cached);
        long refreshedEvent = effectiveStatusEventTime(refreshed);
        if (refreshedEvent <= 0L) return cachedEvent <= 0L ? refreshed : cached;
        if (cachedEvent <= 0L) return refreshed;
        return refreshedEvent >= cachedEvent ? refreshed : cached;
    }

    private static long effectiveStatusEventTime(ExpressQueryResult result) {
        if (result == null) return 0L;
        if (result.workerStatus != null || result.statusEventTime > 0L) return result.statusEventTime;
        return ExpressSourcePolicy.parseEventTime(result.latestTime);
    }

    private static String prefer(String primary, String fallback) {
        return primary == null || primary.trim().isEmpty() ? fallback : primary;
    }
}
