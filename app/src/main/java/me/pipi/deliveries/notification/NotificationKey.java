package me.pipi.deliveries.notification;

import android.app.Notification;
import android.app.NotificationManager;
import android.service.notification.StatusBarNotification;
import java.util.Objects;

/** Framework identity shared by live publication, dismissal and cancellation. */
public final class NotificationKey {
    public final int id;
    private final String label;

    private NotificationKey(String label, int id) { this.label = label; this.id = id; }

    static NotificationKey singleton(String namespace, int id) {
        return new NotificationKey(namespace + ":singleton", id);
    }

    static NotificationKey persisted(String label, int id) {
        return new NotificationKey(label == null ? "" : label, id);
    }

    String persistenceKey() { return label; }
    void notify(NotificationManager manager, Notification notification) { manager.notify(id, notification); }
    void cancel(NotificationManager manager) { manager.cancel(id); }

    boolean matches(StatusBarNotification notification, String packageName) {
        return notification != null && notification.getId() == id
                && notification.getTag() == null
                && Objects.equals(packageName, notification.getPackageName());
    }

    @Override public boolean equals(Object value) {
        return value instanceof NotificationKey && id == ((NotificationKey) value).id;
    }

    @Override public int hashCode() { return id; }
    @Override public String toString() { return label + "/0x" + Integer.toHexString(id); }

    /**
     * The key for a logcat line: its namespace and framework id, without the stable id, as Pipi's NotificationKey
     * logs it for the shared PromotedNotificationPublisher (G-HIGH-19, 2026-11-20 review).
     */
    public String logLabel() {
        int colon = label.indexOf(':');
        return (colon < 0 ? label : label.substring(0, colon)) + "/0x" + Integer.toHexString(id);
    }
}
