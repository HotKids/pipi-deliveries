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
        if (manager != null) manager.notify((int) (item.rowId & 0x7fffffff), notification);
    }

    public static void cancel(Context context, long rowId) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel((int) (rowId & 0x7fffffff));
    }

    public static boolean shouldPostUpdate(ExpressItem previous, ExpressItem current) {
        return previous != null && current != null
                && (!notificationTitle(previous).equals(notificationTitle(current))
                || !breakableText(previous.latestDetail).toString().equals(
                        breakableText(current.latestDetail).toString()));
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
