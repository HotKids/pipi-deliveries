package me.pipi.deliveries.feature.express;

import android.view.View;

import java.util.ArrayList;
import java.util.List;

/** Owns delayed callbacks whose lifetime must not outlive a temporary view. */
final class ExpressDelayedCallbackRegistry {
    private final List<Entry> pending = new ArrayList<>();

    void post(View target, Runnable action, long delayMillis) {
        if (target == null || action == null) return;
        Entry[] holder = new Entry[1];
        Runnable guarded = () -> {
            Entry entry = holder[0];
            if (entry == null || !pending.remove(entry)) return;
            action.run();
        };
        Entry entry = new Entry(target, guarded);
        holder[0] = entry;
        pending.add(entry);
        if (!target.postDelayed(guarded, Math.max(0L, delayMillis))) {
            pending.remove(entry);
        }
    }

    void clear() {
        List<Entry> callbacks = new ArrayList<>(pending);
        pending.clear();
        for (Entry entry : callbacks) {
            entry.target.removeCallbacks(entry.callback);
        }
    }

    int pendingCount() {
        return pending.size();
    }

    private static final class Entry {
        final View target;
        final Runnable callback;

        Entry(View target, Runnable callback) {
            this.target = target;
            this.callback = callback;
        }
    }
}
