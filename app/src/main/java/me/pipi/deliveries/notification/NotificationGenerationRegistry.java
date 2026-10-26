package me.pipi.deliveries.notification;

import java.util.concurrent.atomic.AtomicLong;
import java.util.HashMap;
import java.util.Map;

/** Monotonic per-key generations prevent stale probes from resurrecting cancelled posts. */
final class NotificationGenerationRegistry {
    private final AtomicLong sequence = new AtomicLong();
    private final Map<NotificationKey, Long> generations = new HashMap<>();

    synchronized long advance(NotificationKey key) {
        long generation = sequence.incrementAndGet();
        generations.put(key, generation);
        return generation;
    }

    synchronized boolean isCurrent(NotificationKey key, long generation) {
        Long current = generations.get(key);
        return current != null && current == generation;
    }

    synchronized void invalidate(NotificationKey key) {
        generations.remove(key);
    }

    synchronized void clearIfCurrent(NotificationKey key, long generation) {
        if (isCurrent(key, generation)) generations.remove(key);
    }
}
