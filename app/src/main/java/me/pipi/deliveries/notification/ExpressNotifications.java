package me.pipi.deliveries.notification;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
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
    private static final String CHANNEL = "express_status";

    private ExpressNotifications() {}

    public static void ensureChannel(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL, context.getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.notification_channel_description));
        manager.createNotificationChannel(channel);
    }

    public static void post(Context context, ExpressItem item) {
        if (item == null) return;
        if (Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        ensureChannel(context);
        Intent open = new Intent(context, ExpressDetailActivity.class)
                .putExtra(ExpressDetailActivity.EXTRA_ROW_ID, item.rowId);
        PendingIntent content = PendingIntent.getActivity(
                context, (int) (item.rowId & 0x7fffffff), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String detail = item.latestDetail;
        Notification.Builder builder = new Notification.Builder(context, CHANNEL)
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
