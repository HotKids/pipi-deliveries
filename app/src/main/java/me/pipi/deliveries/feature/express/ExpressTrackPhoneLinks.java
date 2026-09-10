package me.pipi.deliveries.feature.express;

import android.content.Intent;
import android.net.Uri;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.TextPaint;
import android.text.method.LinkMovementMethod;
import android.text.style.ClickableSpan;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Adds dial actions without changing provider text or its paragraph layout. */
final class ExpressTrackPhoneLinks {
    private static final Pattern PHONE = Pattern.compile("(?<![A-Za-z0-9])(?:\\+86[- ]?)?(?:1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}|0[0-9]{2,3}[- ]?[0-9]{7,8}|(?:400|800)[- ]?[0-9]{3}[- ]?[0-9]{4}|95[0-9]{3,4})(?![A-Za-z0-9])");
    private ExpressTrackPhoneLinks() {}

    static void apply(TextView view, int color) {
        SpannableString text = new SpannableString(view.getText());
        Matcher matches = PHONE.matcher(text);
        while (matches.find()) {
            String phone = matches.group().replaceAll("[- ]", "");
            text.setSpan(new ClickableSpan() {
                @Override public void onClick(View widget) {
                    try {
                        widget.getContext().startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone)));
                    } catch (RuntimeException error) {
                        Toast.makeText(widget.getContext(), ExpressToastCopy.DIAL_UNAVAILABLE, Toast.LENGTH_SHORT).show();
                    }
                }
                @Override public void updateDrawState(TextPaint paint) {
                    paint.setColor(color);
                    paint.setUnderlineText(false);
                }
            }, matches.start(), matches.end(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        view.setText(text);
        view.setMovementMethod(LinkMovementMethod.getInstance());
    }
}
