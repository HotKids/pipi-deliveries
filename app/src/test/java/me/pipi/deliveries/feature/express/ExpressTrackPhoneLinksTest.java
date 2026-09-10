package me.pipi.deliveries.feature.express;

import static org.junit.Assert.*;
import android.app.Activity;
import android.content.Intent;
import android.text.Spanned;
import android.text.style.ClickableSpan;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36, application = android.app.Application.class)
public final class ExpressTrackPhoneLinksTest {
    @Test public void onlyPhoneSpansDialAndOriginalTextIsPreserved() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        TextView view = new TextView(activity);
        String original = "快递员电话：17717262250，网点0755-12345678，官方95338。运单SF5111792798482、1238138001380009，日期2026-09-09。";
        view.setText(original);
        ExpressTrackPhoneLinks.apply(view, 0xff1e85e5);
        assertEquals(original, view.getText().toString());
        Spanned text = (Spanned) view.getText();
        ClickableSpan[] links = text.getSpans(0, text.length(), ClickableSpan.class);
        assertEquals(3, links.length);
        links[0].onClick(view);
        Intent intent = Shadows.shadowOf(activity).getNextStartedActivity();
        assertEquals(Intent.ACTION_DIAL, intent.getAction());
        assertEquals("tel:17717262250", intent.getDataString());
    }
}
