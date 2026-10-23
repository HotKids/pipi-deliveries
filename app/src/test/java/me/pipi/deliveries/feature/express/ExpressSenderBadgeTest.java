package me.pipi.deliveries.feature.express;
import android.app.Application;
import android.view.View;
import android.widget.TextView;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(sdk=31,manifest=Config.NONE,application=Application.class)
public class ExpressSenderBadgeTest {
 @Test public void rebindingAReceiverHidesTheExistingSenderBadge() {
  BadgeView view=new BadgeView();
  ExpressSenderBadge.apply(view,true,0xff008800);
  assertEquals("寄",view.getText().toString()); assertEquals(View.VISIBLE,view.getVisibility());
  int surface = com.google.android.material.color.MaterialColors.getColor(view,
    com.google.android.material.R.attr.colorSurface);
  int background = androidx.core.graphics.ColorUtils.compositeColors(0x1a008800, surface);
  assertTrue(androidx.core.graphics.ColorUtils.calculateContrast(view.getCurrentTextColor(), background) >= 4.5);
  assertFalse(view.getIncludeFontPadding()); assertEquals(android.graphics.Typeface.BOLD,view.requestedStyle);
  ExpressSenderBadge.apply(view,false,0xffff0000);
  assertEquals(View.GONE,view.getVisibility());
 }
 private static final class BadgeView extends TextView {
  int requestedStyle;
  BadgeView() { super(new android.view.ContextThemeWrapper(RuntimeEnvironment.getApplication(), com.google.android.material.R.style.Theme_Material3_DayNight)); }
  @Override public void setTypeface(android.graphics.Typeface typeface,int style) {
   requestedStyle=style;
   super.setTypeface(typeface,style);
  }
 }
}
