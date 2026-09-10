package me.pipi.deliveries.network;

import static org.junit.Assert.*;
import org.junit.Test;

public class ExpressStageBudgetTest {
    @Test public void parentCancellationStopsItsActiveProviderStages() throws Exception {
        ExpressQueryCancellation parent = new ExpressQueryCancellation(10000L);
        try (ExpressQueryCancellation first = parent.child(5000L);
             ExpressQueryCancellation second = parent.child(5000L)) {
            parent.cancel();
            assertTrue(first.isCancelled());
            assertTrue(second.isCancelled());
        }
    }

    @Test public void oneStageTimeoutLeavesTheNextStageAvailable() throws Exception {
        ExpressQueryCancellation parent = new ExpressQueryCancellation(10000L);
        try (ExpressQueryCancellation stage = parent.child(1L)) {
            Thread.sleep(5L);
            assertTrue(stage.isCancelled());
            assertFalse(parent.isCancelled());
        }
        try (ExpressQueryCancellation next = parent.child(5000L)) {
            next.throwIfCancelled();
        }
        assertFalse(parent.isCancelled());
    }
}
