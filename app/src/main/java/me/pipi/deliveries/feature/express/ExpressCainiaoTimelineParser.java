package me.pipi.deliveries.feature.express;

import org.json.*;
import java.util.*;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.data.*;

/** Cainiao 0.0.8 adapter, matching services/cainiao-h5.ts first-party fields. */
final class ExpressCainiaoTimelineParser {
    private ExpressCainiaoTimelineParser() {}

    static String readScript() {
        return "(function(){\n    return (() => {\n      const clean = (value) => String(value == null ? \"\" : value).trim().replace(/\\s+/g, \" \");\n      const trustedHost = (hostname) => {\n        const host = clean(hostname).toLowerCase();\n        return host === \"cainiao.com\" || host.endsWith(\".cainiao.com\") ||\n          host === \"taobao.com\" || host.endsWith(\".taobao.com\");\n      };\n      try {\n        const page = new URL(window.location.href);\n        if (page.protocol !== \"https:\" || !trustedHost(page.hostname)) {\n          return { extractionSource: \"none\", statusText: \"\", tracks: [] };\n        }\n      } catch (_) {\n        return { extractionSource: \"none\", statusText: \"\", tracks: [] };\n      }\n      const domStatus = () => clean(\n        document.querySelector(\".package-status\") &&\n          document.querySelector(\".package-status\").textContent\n      );\n      const compactTracks = (values) => values\n        .map((item) => ({\n          timeText: clean(item && item.time),\n          detail: clean(item && item.standerdDesc),\n        }))\n        .filter((item) => item.timeText && item.detail)\n        .slice(0, 100);\n      const roots = [\n        document.body,\n        document.querySelector(\".container\"),\n        document.querySelector(\".mcn\"),\n        document.querySelector(\"#app\"),\n      ].filter(Boolean);\n      const queue = [];\n      const seen = new Set();\n      for (const root of roots) {\n        if (root && root.__vue__) queue.push(root.__vue__);\n      }\n      let vueStatus = \"\";\n      for (let index = 0; index < queue.length && index < 32; index++) {\n        const vm = queue[index];\n        if (!vm || typeof vm !== \"object\" || seen.has(vm)) continue;\n        seen.add(vm);\n        const data = vm._data && typeof vm._data === \"object\" ? vm._data : vm;\n        const cpInfo = data.cpInfo && typeof data.cpInfo === \"object\" ? data.cpInfo : null;\n        if (!vueStatus && cpInfo) vueStatus = clean(cpInfo.statusDesc);\n        const feed = Array.isArray(data.feed) ? data.feed : Array.isArray(vm.feed) ? vm.feed : null;\n        if (feed) {\n          const tracks = compactTracks(feed);\n          if (tracks.length) {\n            return {\n              extractionSource: \"vue\",\n              statusText: vueStatus || domStatus(),\n              tracks,\n            };\n          }\n        }\n        const children = Array.isArray(vm.$children) ? vm.$children : [];\n        for (const child of children) queue.push(child);\n      }\n      const tracks = Array.from(document.querySelectorAll(\".feed-item\"))\n        .map((item) => {\n          const time = clean(item.querySelector(\".feed-item_time\") &&\n            item.querySelector(\".feed-item_time\").textContent);\n          const date = clean(item.querySelector(\".feed-item_date\") &&\n            item.querySelector(\".feed-item_date\").textContent);\n          const detail = clean(item.querySelector(\".feed-item_content\") &&\n            item.querySelector(\".feed-item_content\").textContent);\n          return { timeText: date && time ? date + \" \" + time : date || time, detail };\n        })\n        .filter((item) => item.timeText && item.detail)\n        .slice(0, 100);\n      return {\n        extractionSource: tracks.length ? \"dom\" : \"none\",\n        statusText: vueStatus || domStatus(),\n        tracks,\n      };\n    })();\n  })()";
    }

    static ExpressQueryResult parse(String payload, ExpressItem owner) {
        if (owner == null) return null;
        try {
            Object value = new JSONTokener(payload == null ? "" : payload).nextValue();
            if (value instanceof String) value = new JSONTokener((String) value).nextValue();
            if (!(value instanceof JSONObject)) return null;
            JSONObject packet = (JSONObject) value;
            String source = packet.optString("extractionSource");
            if (!source.equals("vue") && !source.equals("dom")) return null;
            JSONArray raw = packet.optJSONArray("tracks");
            if (raw == null) return null;
            JSONArray nodes = new JSONArray();
            for (int i = 0; i < Math.min(100, raw.length()); i++) {
                JSONObject node = raw.optJSONObject(i);
                if (node == null) continue;
                String time = node.optString("timeText").trim().replace('T', ' ')
                        .replace('/', '-').replace('.', '-');
                if (time.matches("\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}")) time += ":00";
                String detail = node.optString("detail").trim();
                if (!Kuaidi100TimelinePolicy.isValidTrack(time, detail)) continue;
                nodes.put(new JSONObject().put("time", time).put("context", detail)
                        .put("_pipiStatusSource", "web"));
            }
            String tracks = ExpressTimeline.mergeJson("[]", nodes.toString());
            List<ExpressTimeline.Track> parsed = ExpressTimeline.parse(tracks, "", "");
            if (parsed.isEmpty()) return null;
            ExpressTimeline.Track latest = parsed.get(0);
            return new ExpressQueryResult(owner.displayWaybill(), owner.courierCode,
                    owner.companyName, StatusSemantic.UNKNOWN, 0L, latest.time,
                    latest.detail, tracks, "", owner.phone, TimelineSlot.CN_H5,
                    "", "", owner.sourceProvider);
        } catch (JSONException invalid) {
            return null;
        }
    }
}
