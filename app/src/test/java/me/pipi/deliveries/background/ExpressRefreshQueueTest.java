package me.pipi.deliveries.background;

import org.junit.Test;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import static org.junit.Assert.*;

public class ExpressRefreshQueueTest {
    @Test public void twoRequestsOverlapButCommitsStayOnRefreshThread() throws Exception {
        CountDownLatch running = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger active = new AtomicInteger(), maximum = new AtomicInteger(), commits = new AtomicInteger();
        Thread owner = Thread.currentThread();
        try (ExpressRefreshQueue queue = new ExpressRefreshQueue()) {
            for (int index = 0; index < 3; index++) queue.submit(() -> {
                maximum.accumulateAndGet(active.incrementAndGet(), Math::max);
                running.countDown();
                try { assertTrue(release.await(2, TimeUnit.SECONDS)); }
                finally { active.decrementAndGet(); }
                return () -> { assertSame(owner, Thread.currentThread()); commits.incrementAndGet(); };
            });
            assertTrue("The first two providers must start before either completes", running.await(2, TimeUnit.SECONDS));
            assertEquals(2, active.get());
            assertEquals(0, commits.get());
            release.countDown();
            queue.drain();
            assertEquals(3, commits.get());
            assertEquals(2, maximum.get());
        } finally { release.countDown(); }
    }

    @Test public void closingRefreshInterruptsActualProviderTasks() throws Exception {
        CountDownLatch running = new CountDownLatch(2), cancelled = new CountDownLatch(2);
        ExpressRefreshQueue queue = new ExpressRefreshQueue();
        for (int index = 0; index < 2; index++) queue.submit(() -> {
            running.countDown();
            try { new CountDownLatch(1).await(); }
            catch (InterruptedException interrupted) { cancelled.countDown(); throw interrupted; }
            return null;
        });
        assertTrue(running.await(2, TimeUnit.SECONDS));
        queue.close();
        assertTrue(cancelled.await(2, TimeUnit.SECONDS));
    }
}
