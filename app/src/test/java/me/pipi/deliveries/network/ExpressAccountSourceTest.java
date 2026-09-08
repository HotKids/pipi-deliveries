package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class ExpressAccountSourceTest {
    @Test
    public void unknownOrMissingSelectionDefaultsToInterface6() {
        assertEquals(ExpressAccountSource.V6, ExpressAccountSource.normalize(null));
        assertEquals(ExpressAccountSource.V6, ExpressAccountSource.normalize(""));
        assertEquals(ExpressAccountSource.V6, ExpressAccountSource.normalize("unexpected"));
    }

    @Test
    public void hiddenSwitchTogglesBetweenBothSources() {
        assertEquals(ExpressAccountSource.V5,
                ExpressAccountSource.next(ExpressAccountSource.V6));
        assertEquals(ExpressAccountSource.V6,
                ExpressAccountSource.next(ExpressAccountSource.V5));
    }

    @Test
    public void userFacingNamesDoNotExposeProtocolNumbers() {
        assertEquals("主接口", ExpressAccountSource.displayName(ExpressAccountSource.V6));
        assertEquals("备用接口", ExpressAccountSource.displayName(ExpressAccountSource.V5));
    }

    @Test
    public void rowOwnerKeepsPhoneCandidatesInsideItsAccountSource() {
        assertEquals("interface5", ExpressAccountSource.bindingSourceForOwner("INTERFACE5"));
        assertEquals("interface5", ExpressAccountSource.bindingSourceForOwner("I5-JD"));
        assertEquals("interface5", ExpressAccountSource.bindingSourceForOwner("I5-K100"));
        assertEquals("interface6", ExpressAccountSource.bindingSourceForOwner("INTERFACE6"));
        assertEquals("interface6", ExpressAccountSource.bindingSourceForOwner("KD-100"));
    }
}
