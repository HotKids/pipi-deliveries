package me.pipi.deliveries.network;

import android.util.Log;

/**
 * 快递日志的统一用词（用户定 2026-09-05，三端同一套）：每行固定 interface / level / source / event，
 * 附 tail、nodes 等。不用品牌词，不用能力档词。
 *
 * <p>level：v1_list…v6_list、v5_list、v5_query、v6_picker、v4_query、v2_query、jd_h5、cn_h5、
 * k100_h5、kdniao、k100_autoCom。event：started / succeeded / failed / skipped / selected。</p>
 */
public final class ExpressLog {
    public static final String TAG = "PipiExpress";

    private ExpressLog() {}

    /** 只打尾号 4 位；单号、手机号永不落日志。 */
    public static String tail(String value) {
        String clean = value == null ? "" : value.trim();
        return clean.length() <= 4 ? clean : clean.substring(clean.length() - 4);
    }

    public static void line(String iface, String level, String source, String event,
                            Object... keyValues) {
        StringBuilder builder = new StringBuilder(96);
        if (iface != null && !iface.isEmpty()) builder.append("interface=").append(iface).append(' ');
        builder.append("level=").append(level).append(' ');
        if (source != null && !source.isEmpty()) builder.append("source=").append(source).append(' ');
        builder.append("event=").append(event);
        for (int index = 0; index + 1 < keyValues.length; index += 2) {
            builder.append(' ').append(keyValues[index]).append('=').append(keyValues[index + 1]);
        }
        emit(builder.toString());
    }

    /** 日志永远不能改变业务行为：纯 JVM 单测里 android.util.Log 没有实现，吞掉即可。 */
    private static void emit(String message) {
        try {
            Log.i(TAG, message);
        } catch (RuntimeException ignored) {
            // Unit tests without the Android runtime.
        }
    }

    /** 通知被规则压掉：reason 说明是哪条规则（first_seen_in_batch = 这轮才出现的件）。 */
    public static void notificationSkipped(
            me.pipi.deliveries.model.ExpressItem current, String reason) {
        if (current == null) return;
        emit("notification event=skipped reason=" + reason
                + " tail=" + tail(current.displayWaybill())
                + " source=" + source(current.sourceProvider, current.manuallyAdded)
                + " current=" + current.semantic + '@'
                + me.pipi.deliveries.notification.ExpressNotifications.eventTime(current));
    }

    /** 自动件首次入库被留存规则拒绝：上游还列着、本地早已过了留存窗口的老件。 */
    public static void retentionRejected(
            me.pipi.deliveries.model.ExpressQueryResult result, String reason) {
        if (result == null) return;
        emit("retention event=rejected reason=" + reason
                + " tail=" + tail(result.waybill)
                + " source=" + source(result.sourceProvider, false)
                + " semantic=" + result.semantic
                + " eventTime=" + result.statusEventTime
                + " latestTime=" + result.latestTime);
    }

    /** 通知判定：previous/current 各自的状态与事件时间，看批量通知到底是哪一边翻了。 */
    public static void notificationDecided(
            me.pipi.deliveries.model.ExpressItem previous,
            me.pipi.deliveries.model.ExpressItem current, boolean deferred) {
        if (previous == null || current == null) return;
        emit("notification event=decided tail=" + tail(current.displayWaybill())
                + " source=" + source(current.sourceProvider, current.manuallyAdded)
                + " previous=" + previous.semantic + '@'
                + me.pipi.deliveries.notification.ExpressNotifications.eventTime(previous)
                + " current=" + current.semantic + '@'
                + me.pipi.deliveries.notification.ExpressNotifications.eventTime(current)
                + " previousStatusEventTime=" + previous.statusEventTime
                + " currentStatusEventTime=" + current.statusEventTime
                + " previousTitle=" + previous.displayStatus()
                + " currentTitle=" + current.displayStatus()
                + " detailChanged=" + !String.valueOf(previous.latestDetail).equals(
                        String.valueOf(current.latestDetail))
                + " deferred=" + deferred);
    }

    /** 手动查件落库被哪道门拦下：只打尾号和原因。 */
    public static void manualCommitSkipped(String reason, String waybill, int writes) {
        emit("manual commit event=skipped tail=" + tail(waybill)
                + " reason=" + reason + " writes=" + writes);
    }

    /** 业务来源：jingdong / cainiao / shunfeng / douyin / manual。 */
    public static String source(String sourceProvider, boolean manuallyAdded) {
        if (manuallyAdded) return "manual";
        String value = sourceProvider == null ? "" : sourceProvider.trim().toLowerCase(java.util.Locale.ROOT);
        return value.isEmpty() ? "" : value;
    }
}
