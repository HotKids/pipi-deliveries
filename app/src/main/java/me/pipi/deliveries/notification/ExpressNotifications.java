package me.pipi.deliveries.notification;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationChannelGroup;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.drawable.Icon;
import android.os.Build;

import me.pipi.deliveries.R;
import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.StatusSemantic;

import me.pipi.deliveries.feature.express.ExpressDetailActivity;

/** Status notification renderer using only local vector and courier resources. */
public final class ExpressNotifications {
    static final String LEGACY_CHANNEL = "express_status";
    static final String GROUP_IMPORTANT = "express_important";
    static final String GROUP_REGULAR = "express_regular";
    static final String CHANNEL_PICKED = "express_picked";
    static final String CHANNEL_DELIVERY = "express_delivery";
    static final String CHANNEL_WAITING_PICKUP = "express_waiting_pickup";
    static final String CHANNEL_DANGER = "express_danger";
    static final String CHANNEL_CANCELLED = "express_cancelled";
    static final String CHANNEL_ORDERED = "express_ordered";
    static final String CHANNEL_SHIPPED = "express_shipped";
    static final String CHANNEL_TRANSIT = "express_transit";
    static final String CHANNEL_COMPLETED = "express_completed";

    private ExpressNotifications() {}

    public static void ensureChannels(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannelGroup(new NotificationChannelGroup(
                GROUP_IMPORTANT, context.getString(R.string.notification_group_important)));
        manager.createNotificationChannelGroup(new NotificationChannelGroup(
                GROUP_REGULAR, context.getString(R.string.notification_group_regular)));
        createChannel(manager, context, CHANNEL_PICKED,
                R.string.notification_channel_picked, GROUP_IMPORTANT,
                NotificationManager.IMPORTANCE_HIGH);
        createChannel(manager, context, CHANNEL_DELIVERY,
                R.string.notification_channel_delivery, GROUP_IMPORTANT,
                NotificationManager.IMPORTANCE_HIGH);
        createChannel(manager, context, CHANNEL_WAITING_PICKUP,
                R.string.notification_channel_waiting_pickup, GROUP_IMPORTANT,
                NotificationManager.IMPORTANCE_HIGH);
        createChannel(manager, context, CHANNEL_DANGER,
                R.string.notification_channel_danger, GROUP_IMPORTANT,
                NotificationManager.IMPORTANCE_HIGH);
        createChannel(manager, context, CHANNEL_CANCELLED,
                R.string.notification_channel_cancelled, GROUP_IMPORTANT,
                NotificationManager.IMPORTANCE_HIGH);
        createChannel(manager, context, CHANNEL_ORDERED,
                R.string.notification_channel_ordered, GROUP_REGULAR,
                NotificationManager.IMPORTANCE_DEFAULT);
        createChannel(manager, context, CHANNEL_SHIPPED,
                R.string.notification_channel_shipped, GROUP_REGULAR,
                NotificationManager.IMPORTANCE_DEFAULT);
        createChannel(manager, context, CHANNEL_TRANSIT,
                R.string.notification_channel_transit, GROUP_REGULAR,
                NotificationManager.IMPORTANCE_DEFAULT);
        createChannel(manager, context, CHANNEL_COMPLETED,
                R.string.notification_channel_completed, GROUP_REGULAR,
                NotificationManager.IMPORTANCE_DEFAULT);
        manager.deleteNotificationChannel(LEGACY_CHANNEL);
    }

    public static void post(Context context, ExpressItem item) {
        if (item == null) return;
        String channelId = channelId(item.semantic);
        if (channelId == null) return;
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        ensureChannels(context);
        Intent open = new Intent(context, ExpressDetailActivity.class)
                .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, item.rowId);
        PendingIntent content = PendingIntent.getActivity(
                context, (int) (item.rowId & 0x7fffffff), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail = item.latestDetail;
        Notification.Builder builder = new Notification.Builder(context, channelId)
                .setSmallIcon(R.drawable.ic_local_shipping)
                .setColorized(false)
                .setContentTitle(notificationTitle(item))
                .setContentText(breakableText(detail))
                .setStyle(new Notification.BigTextStyle().bigText(breakableText(detail)))
                .setContentIntent(content)
                .setWhen(item.statusEventTime > 0L ? item.statusEventTime : item.updatedAt)
                .setAutoCancel(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_STATUS);
        int accent = statusColor(item.semantic);
        if (accent != 0) builder.setColor(accent);
        int logo = item.displayIconResource();
        if (logo != R.drawable.ic_card_express_cp_default) {
            builder.setLargeIcon(Icon.createWithResource(context, logo));
        }
        Notification notification = builder.build();
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) throw new IllegalStateException("Notification service unavailable");
        manager.notify((int) (item.rowId & 0x7fffffff), notification);
    }

    public static void cancel(Context context, long rowId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel((int) (rowId & 0x7fffffff));
    }

    /**
     * 与 Pipi 的 ExpressSourcePolicy.shouldNotifyTrackChange 同口径（三端统一）：只有**状态变了**，
     * 或者**出现了更新的事件**（事件时间更晚且标题/正文确实变了），才是一次新通知。
     *
     * <p>原来只比标题/正文文案：接口 5 按件详情把摘要换成全量轨迹的头条时，八票早已签收的件在
     * 同一分钟被重新通知一遍「已签收」（2026-09-05 Fold7 实测）。文案变了但事件没变，不是新事件。</p>
     */
    public static boolean shouldPostUpdate(ExpressItem previous, ExpressItem current) {
        if (previous == null || current == null) return false;
        if (isFrozenJingDong(previous)) return false;
        return shouldPostUpdate(
                previous.semantic, notificationTitle(previous), previous.latestDetail,
                eventTime(previous),
                current.semantic, notificationTitle(current), current.latestDetail,
                eventTime(current));
    }

    /**
     * iOS isFrozenJingDongShipment 同口径：京东来源、已投影出真实运单（或本来就不是账号订单）、
     * 且已签收的件就此冻结，之后任何改写都不再通知。
     */
    public static boolean isFrozenJingDong(ExpressItem item) {
        return item != null && item.isJingDongSource()
                && (!item.isAccountOrder() || !item.projectedWaybill.isEmpty())
                && item.semantic == StatusSemantic.COMPLETED;
    }

    static boolean shouldPostUpdate(
            StatusSemantic previousSemantic, String previousTitle, String previousDetail,
            long previousEventTime,
            StatusSemantic currentSemantic, String currentTitle, String currentDetail,
            long currentEventTime) {
        boolean statusChanged = previousSemantic != currentSemantic;
        boolean visibleChanged = !previousTitle.equals(currentTitle)
                || !breakableText(previousDetail).toString().equals(
                        breakableText(currentDetail).toString());
        // 上一版没有事件时间（列表摘要那一轮把行写回成没有时间的摘要，下一轮按件详情再写回
        // 带时间的全量：Fold7 2026-09-05 15:30 实测六票已签收件 previous=COMPLETED@0 → current@T）
        // 不算「更新的事件」——那不是新事件，是同一件事的两种写法。
        boolean newerEvent = previousEventTime > 0L && currentEventTime > previousEventTime;
        return statusChanged || (visibleChanged && newerEvent);
    }

    public static long eventTime(ExpressItem item) {
        if (item.statusEventTime > 0L) return item.statusEventTime;
        String clean = item.latestTime == null ? "" : item.latestTime.trim();
        if (clean.isEmpty()) return 0L;
        for (String pattern : new String[]{"yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss"}) {
            java.text.SimpleDateFormat parser =
                    new java.text.SimpleDateFormat(pattern, java.util.Locale.CHINA);
            parser.setLenient(false);
            try {
                java.util.Date parsed = parser.parse(clean);
                if (parsed != null) return parsed.getTime();
            } catch (java.text.ParseException ignored) {
                // Try the next accepted shape.
            }
        }
        return 0L;
    }

    static String channelId(StatusSemantic semantic) {
        switch (semantic == null ? StatusSemantic.UNKNOWN : semantic) {
            case PICKED: return CHANNEL_PICKED;
            case DELIVERY: return CHANNEL_DELIVERY;
            case WAITING_PICKUP: return CHANNEL_WAITING_PICKUP;
            case DANGER: return CHANNEL_DANGER;
            case CANCELLED: return CHANNEL_CANCELLED;
            case ORDERED: return CHANNEL_ORDERED;
            case SHIPPED: return CHANNEL_SHIPPED;
            case TRANSIT: return CHANNEL_TRANSIT;
            case COMPLETED: return CHANNEL_COMPLETED;
            default: return null;
        }
    }

    private static void createChannel(
            NotificationManager manager, Context context, String id, int name,
            String group, int importance) {
        NotificationChannel channel = new NotificationChannel(
                id, context.getString(name), importance);
        channel.setDescription(context.getString(R.string.notification_channel_description));
        channel.setGroup(group);
        manager.createNotificationChannel(channel);
    }

    static String notificationTitle(ExpressItem item) {
        if (item == null) return "";
        String number = item.displayWaybill();
        String suffix = number.length() <= 4
                ? number : number.substring(number.length() - 4);
        String meta = suffix.isEmpty()
                ? item.displayStatus() : suffix + " · " + item.displayStatus();
        return item.displayCompany() + " " + meta;
    }

    private static int statusColor(StatusSemantic semantic) {
        switch (semantic == null ? StatusSemantic.UNKNOWN : semantic) {
            case DANGER: return 0xFFD43D3D;
            case ORDERED:
            case SHIPPED: return 0xFFFBC02D;
            case PICKED:
            case TRANSIT: return 0xFF3275D6;
            case DELIVERY: return 0xFF1A8A4A;
            case WAITING_PICKUP: return 0xFFE65B17;
            case COMPLETED: return 0;
            default: return 0xFF757575;
        }
    }

    private static CharSequence breakableText(String value) {
        if (value == null || value.isEmpty()) return "";
        StringBuilder output = new StringBuilder(value.length() * 2);
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (index > 0 && asciiWord(value.charAt(index - 1)) && asciiWord(current)) {
                output.append('\u200B');
            }
            output.append(current);
        }
        return output;
    }

    private static boolean asciiWord(char value) {
        return (value >= '0' && value <= '9')
                || (value >= 'A' && value <= 'Z')
                || (value >= 'a' && value <= 'z');
    }
}
