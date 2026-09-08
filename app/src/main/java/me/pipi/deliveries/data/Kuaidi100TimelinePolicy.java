package me.pipi.deliveries.data;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Refresh lifetime and same-provider incremental-cache policy for local timelines. */
public final class Kuaidi100TimelinePolicy {
    static final long SIGNED_REFRESH_WINDOW_MS = 24L * 60L * 60L * 1000L;

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
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L
                    && !ExpressStatusNormalizer.isProviderErrorDetail(track.detail)) {
                return true;
            }
        }
        return false;
    }

    /**
     * A current query chain is complete enough once one provider package contains the order or
     * pickup boundary. Numeric codes are interpreted with the package's own provider contract so
     * account state 102 (shipped) is never confused with Picker/K100 state 102 (ordered).
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

    private static boolean hasStartSemantic(
            ExpressQueryResult result, boolean orderedCounts) {
        if (!hasTimedTracking(result)) return false;
        if (result.semantic == StatusSemantic.PICKED
                || (orderedCounts && result.semantic == StatusSemantic.ORDERED)) return true;
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
            long time = ExpressSourcePolicy.parseEventTime(track.time);
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
            if (ExpressSourcePolicy.parseEventTime(track.time) > 0L) count++;
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
        if (node instanceof JSONArray) {
            JSONArray values = (JSONArray) node;
            for (int index = 0; index < values.length(); index++) {
                if (containsTimelineStart(values.opt(index), provider, orderedCounts)) return true;
            }
            return false;
        }
        if (!(node instanceof JSONObject)) return false;
        JSONObject value = (JSONObject) node;
        String detail = first(value,
                "context", "desc", "description", "logisticDetail",
                "lastLogisticDetail", "message");
        boolean providerError = ExpressStatusNormalizer.isProviderErrorDetail(detail);
        String compactDetail = detail.replaceAll("\\s+", "");
        // 三端同一组词（2026-09-05 对齐）：揽收类与下单类；EMS 的「已收寄」「商品已经下单」也算。
        if (!providerError && (compactDetail.contains("已揽件")
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
        if (!providerError && orderedCounts && (compactDetail.contains("订单已完成")
                || compactDetail.contains("配送完成"))) return true;
        // 下单类整表（2026-09-07 三端对齐到 iOS semanticFromText）：这几个词 Lite 的展示表
        // ExpressStatusNormalizer 早就认成「已下单」，起点闸门却看不见，同一行自相矛盾。
        if (!providerError && orderedCounts && (compactDetail.contains("已下单")
                || compactDetail.contains("已经下单")
                || compactDetail.contains("订单已提交")
                || compactDetail.contains("订单已创建")
                || compactDetail.contains("等待出库")
                || compactDetail.contains("正在打包")
                || compactDetail.contains("拣货"))) return true;
        String source = normalizeProvider(first(value, "_pipiStatusSource"));
        if (source.isEmpty()) source = provider;
        if (!providerError) {
            String code = first(value,
                    "logisticsStatus", "statusCode", "status", "state", "action");
            String description = first(value, "logisticsStatusDesc", "stateName");
            StatusSemantic semantic = isAccountProvider(source)
                    ? StatusSemantic.fromAccountState(code, description)
                    : StatusSemantic.fromKuaidi100EventCode(code);
            if (semantic == StatusSemantic.UNKNOWN) {
                semantic = StatusSemantic.fromStored(code, description);
            }
            if (semantic == StatusSemantic.PICKED
                    || (orderedCounts && semantic == StatusSemantic.ORDERED)) {
                return true;
            }
        }
        java.util.Iterator<String> keys = value.keys();
        while (keys.hasNext()) {
            Object child = value.opt(keys.next());
            if ((child instanceof JSONArray || child instanceof JSONObject)
                    && containsTimelineStart(child, source, orderedCounts)) return true;
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

    /** Refresh on every open until an exact signed event is at least 24 hours old. */
    public static boolean shouldRefresh(
            ExpressItem item, ExpressQueryResult cached, long now) {
        boolean completed = item != null && item.semantic == StatusSemantic.COMPLETED;
        long signedAt = 0L;
        if (cached != null && cached.semantic == StatusSemantic.COMPLETED) {
            completed = true;
        }
        if (!completed) return true;
        signedAt = ExpressLifecycleTimes.signedAt(item, cached, now);
        if (signedAt <= 0L) return true;
        return now - signedAt < SIGNED_REFRESH_WINDOW_MS;
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
        boolean frozenCompletedPresentation = isCompletedTimedPackage(cached)
                && (!requireStructuredTerminal || cached.structuredStatusEvidence);
        ExpressQueryResult presentation = frozenCompletedPresentation
                ? cached : selectedSameProviderPresentation(
                        cached, refreshed, requireStructuredTerminal);
        me.pipi.deliveries.model.CarrierNormalization normalization =
                refreshed.carrierNormalization.present()
                        ? refreshed.carrierNormalization : cached.carrierNormalization;
        return new ExpressQueryResult(
                prefer(presentation.waybill,
                        prefer(refreshed.waybill, cached.waybill)),
                prefer(presentation.courierCode,
                        prefer(refreshed.courierCode, cached.courierCode)),
                prefer(presentation.companyName,
                        prefer(refreshed.companyName, cached.companyName)),
                presentation.semantic, effectiveStatusEventTime(presentation),
                presentation.latestTime,
                presentation.latestDetail,
                ExpressTimeline.mergeJson(cached.tracksJson, refreshed.tracksJson),
                prefer(refreshed.detailUrl, cached.detailUrl),
                prefer(refreshed.phone, cached.phone),
                prefer(refreshed.timelineProvider, cached.timelineProvider),
                prefer(refreshed.routeInterface, cached.routeInterface),
                prefer(refreshed.routeCredential, cached.routeCredential),
                prefer(refreshed.sourceProvider, cached.sourceProvider), normalization)
                .withManualStatusEvidence(
                        presentation.statusDescription,
                        presentation.structuredStatusEvidence);
    }

    static boolean isCompletedTimedPackage(ExpressQueryResult result) {
        return result != null
                && result.semantic == StatusSemantic.COMPLETED
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
        if (result.statusEventTime > 0L) return result.statusEventTime;
        return ExpressSourcePolicy.parseEventTime(result.latestTime);
    }

    private static String prefer(String primary, String fallback) {
        return primary == null || primary.trim().isEmpty() ? fallback : primary;
    }
}
