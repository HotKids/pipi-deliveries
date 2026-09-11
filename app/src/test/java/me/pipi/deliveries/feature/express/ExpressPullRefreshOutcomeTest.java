package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;

import android.app.Application;
import android.content.Intent;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import me.pipi.deliveries.data.ExpressRepository;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowToast;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 31, manifest = Config.NONE, application = Application.class)
public class ExpressPullRefreshOutcomeTest {
    @Test public void committedListWithFailedSupplementReportsListUpdatedOnce() throws Exception {
        ExpressListActivity activity = Robolectric.buildActivity(ExpressListActivity.class).get();
        set(activity, "swipeRefresh", new SwipeRefreshLayout(RuntimeEnvironment.getApplication()));
        set(activity, "pullRefreshPending", true);
        set(activity, "pullRefreshWorkId", "list-updated");
        Method announce = ExpressListActivity.class.getDeclaredMethod(
                "announcePullRefreshOutcome", Intent.class);
        announce.setAccessible(true);
        ShadowToast.reset();
        Intent completed = new Intent(ExpressRepository.ACTION_SYNC_FINISHED)
                .putExtra(ExpressRepository.EXTRA_SYNC_WORK_ID, "list-updated")
                .putExtra(ExpressRepository.EXTRA_SYNC_ATTEMPTED, 2)
                .putExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, 1)
                .putExtra(ExpressRepository.EXTRA_SYNC_FAILED, 1)
                .putExtra(ExpressRepository.EXTRA_SYNC_ACCOUNT_LIST_UPDATED, true);
        announce.invoke(activity, completed);
        assertEquals("列表已更新", ShadowToast.getTextOfLatestToast());
        announce.invoke(activity, completed);
        assertEquals(1, ShadowToast.shownToastCount());
        assertEquals(ExpressToastCopy.REFRESH_PARTIAL,
                ExpressToastCopy.refreshSummary(2, 1, 1, false));
    }

    @Test public void olderOrPeriodicCompletionCannotFinishTheCurrentPull() throws Exception {
        ExpressListActivity activity = Robolectric.buildActivity(ExpressListActivity.class).get();
        set(activity, "swipeRefresh", new SwipeRefreshLayout(RuntimeEnvironment.getApplication()));
        set(activity, "pullRefreshPending", true);
        set(activity, "pullRefreshWorkId", "current-work");
        Method announce = ExpressListActivity.class.getDeclaredMethod(
                "announcePullRefreshOutcome", Intent.class);
        announce.setAccessible(true);
        ShadowToast.reset();
        Intent completed = new Intent(ExpressRepository.ACTION_SYNC_FINISHED)
                .putExtra(ExpressRepository.EXTRA_SYNC_WORK_ID, "older-work")
                .putExtra(ExpressRepository.EXTRA_SYNC_ATTEMPTED, 1)
                .putExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, 0)
                .putExtra(ExpressRepository.EXTRA_SYNC_FAILED, 1);
        announce.invoke(activity, completed);
        assertTrue((Boolean) get(activity, "pullRefreshPending"));
        assertNull(ShadowToast.getTextOfLatestToast());

        completed.putExtra(ExpressRepository.EXTRA_SYNC_WORK_ID, "current-work")
                .putExtra(ExpressRepository.EXTRA_SYNC_SUCCEEDED, 1)
                .putExtra(ExpressRepository.EXTRA_SYNC_FAILED, 0);
        announce.invoke(activity, completed);
        assertFalse((Boolean) get(activity, "pullRefreshPending"));
        assertEquals(ExpressToastCopy.refreshSummary(1, 1, 0, false), ShadowToast.getTextOfLatestToast());
        assertEquals(1, ShadowToast.shownToastCount());
        announce.invoke(activity, completed);
        assertEquals(1, ShadowToast.shownToastCount());
    }

    private static Field field(String name) throws Exception {
        Field field = ExpressListActivity.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
    private static void set(Object target, String name, Object value) throws Exception {
        field(name).set(target, value);
    }
    private static Object get(Object target, String name) throws Exception {
        return field(name).get(target);
    }
}
