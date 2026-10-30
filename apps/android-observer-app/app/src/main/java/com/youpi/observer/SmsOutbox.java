package com.youpi.observer;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * Durable queue of bank SMS waiting to reach the gateway. A forward that fails because the
 * laptop is off, the phone is off Wi-Fi or the API is restarting stays here and is retried with
 * back-off, so no credit alert is lost; the same SMS is never queued or delivered twice.
 *
 * Stored in app-private storage (excluded from backup by allowBackup=false). Only SMS that
 * passed {@link SmsFilter} are ever written here.
 */
final class SmsOutbox {
    private static final String TAG = "YoupiSmsOutbox";
    private static final String FILE_NAME = "sms_outbox.json";
    private static final Object LOCK = new Object();

    /** Pending entries kept at most; the oldest is dropped beyond this. */
    static final int MAX_PENDING = 200;
    /** Delivered ids remembered for duplicate detection (e.g. a re-sent broadcast). */
    static final int MAX_DELIVERED_IDS = 500;
    /**
     * How long an undelivered alert is kept. The gateway judges an alert by when the phone received
     * it, so one delivered late still settles the checkout that was open then, or is recorded.
     */
    static final long MAX_AGE_MS = 24L * 60 * 60 * 1000;
    static final long BASE_BACKOFF_MS = 15_000L;
    static final long MAX_BACKOFF_MS = 10L * 60 * 1000;

    private SmsOutbox() {}

    /** Queues one SMS. Returns false when it was already queued or delivered. */
    static boolean enqueue(Context context, String sender, String body, long receivedAt) {
        synchronized (LOCK) {
            try {
                JSONObject state = load(context);
                String id = idFor(sender, body, receivedAt);
                JSONArray pending = state.getJSONArray("pending");
                JSONArray delivered = state.getJSONArray("delivered");
                if (contains(delivered, id) || indexOf(pending, id) >= 0) {
                    Log.i(TAG, "Duplicate SMS ignored");
                    return false;
                }
                JSONObject entry = new JSONObject();
                entry.put("id", id);
                entry.put("sender", sender != null ? sender : JSONObject.NULL);
                entry.put("body", body);
                entry.put("receivedAt", receivedAt);
                entry.put("attempts", 0);
                entry.put("nextAttemptAt", 0);
                pending.put(entry);
                while (pending.length() > MAX_PENDING) pending.remove(0);
                save(context, state);
                return true;
            } catch (Exception e) {
                Log.e(TAG, "enqueue failed: " + e.getMessage());
                return false;
            }
        }
    }

    static int pendingCount(Context context) {
        synchronized (LOCK) {
            try {
                return load(context).getJSONArray("pending").length();
            } catch (Exception e) {
                return 0;
            }
        }
    }

    /**
     * Sends every due entry. Delivered or definitively processed entries leave the queue;
     * unreachable / server-error / clock-refused ones are rescheduled with back-off.
     * Returns the number still pending.
     */
    static int flush(Context context) {
        synchronized (LOCK) {
            ApiClient client = new ApiClient(context);
            try {
                JSONObject state = load(context);
                JSONArray pending = state.getJSONArray("pending");
                JSONArray delivered = state.getJSONArray("delivered");
                JSONArray keep = new JSONArray();
                long now = System.currentTimeMillis();
                boolean gatewayDown = false;

                for (int i = 0; i < pending.length(); i++) {
                    JSONObject entry = pending.getJSONObject(i);
                    long receivedAt = entry.optLong("receivedAt", now);
                    if (now - receivedAt > MAX_AGE_MS) {
                        Log.w(TAG, "Dropping SMS older than 24 h that never reached the gateway");
                        continue;
                    }
                    if (gatewayDown || !client.isPaired() || entry.optLong("nextAttemptAt", 0) > now) {
                        keep.put(entry);
                        continue;
                    }

                    String sender = entry.isNull("sender") ? null : entry.optString("sender", null);
                    int status = client.sendSmsStatus(sender, entry.getString("body"), receivedAt);
                    if (isFinal(status)) {
                        delivered.put(entry.getString("id"));
                        Log.i(TAG, "SMS processed by gateway: HTTP " + status);
                    } else {
                        int attempts = entry.optInt("attempts", 0) + 1;
                        entry.put("attempts", attempts);
                        entry.put("nextAttemptAt", now + backoffMs(attempts));
                        entry.put("lastStatus", status);
                        keep.put(entry);
                        // Unreachable gateway: the rest would fail the same way, so wait.
                        if (status == -1 || status >= 500) gatewayDown = true;
                        Log.w(TAG, "SMS forward will be retried (HTTP " + status + ", attempt " + attempts + ")");
                    }
                }

                while (delivered.length() > MAX_DELIVERED_IDS) delivered.remove(0);
                state.put("pending", keep);
                state.put("delivered", delivered);
                save(context, state);
                return keep.length();
            } catch (Exception e) {
                Log.e(TAG, "flush failed: " + e.getMessage());
                return pendingCount(context);
            }
        }
    }

    /**
     * 2xx: accepted. 400/409/413/422: the gateway read it and decided (unparseable, rejected,
     * duplicate, too large), so sending it again cannot change the answer.
     * Everything else (unreachable, 401 clock/signature, 403 unpaired, 429, 5xx) is retried.
     */
    static boolean isFinal(int status) {
        return (status >= 200 && status < 300) || status == 400 || status == 409 || status == 413 || status == 422;
    }

    static long backoffMs(int attempts) {
        long delay = BASE_BACKOFF_MS << Math.min(Math.max(attempts - 1, 0), 10);
        return Math.min(delay, MAX_BACKOFF_MS);
    }

    static String idFor(String sender, String body, long receivedAt) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            String key = (sender != null ? sender : "") + "\n" + receivedAt + "\n" + body;
            byte[] hash = md.digest(key.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 16; i++) sb.append(String.format("%02x", hash[i]));
            return sb.toString();
        } catch (Exception e) {
            return String.valueOf((sender + receivedAt + body).hashCode());
        }
    }

    private static boolean contains(JSONArray ids, String id) throws Exception {
        for (int i = 0; i < ids.length(); i++) if (id.equals(ids.getString(i))) return true;
        return false;
    }

    private static int indexOf(JSONArray entries, String id) throws Exception {
        for (int i = 0; i < entries.length(); i++) if (id.equals(entries.getJSONObject(i).optString("id"))) return i;
        return -1;
    }

    private static JSONObject load(Context context) throws Exception {
        File file = new File(context.getFilesDir(), FILE_NAME);
        JSONObject state = null;
        if (file.exists()) {
            try (FileInputStream in = new FileInputStream(file)) {
                byte[] data = new byte[(int) file.length()];
                int read = 0;
                while (read < data.length) {
                    int n = in.read(data, read, data.length - read);
                    if (n < 0) break;
                    read += n;
                }
                state = new JSONObject(new String(data, 0, read, StandardCharsets.UTF_8));
            } catch (Exception e) {
                Log.e(TAG, "Outbox file unreadable, starting empty: " + e.getMessage());
            }
        }
        if (state == null) state = new JSONObject();
        if (!state.has("pending")) state.put("pending", new JSONArray());
        if (!state.has("delivered")) state.put("delivered", new JSONArray());
        return state;
    }

    /** Write-then-rename, so a crash mid-write never leaves a half-written queue. */
    private static void save(Context context, JSONObject state) throws IOException {
        File dir = context.getFilesDir();
        File tmp = new File(dir, FILE_NAME + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(state.toString().getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        File target = new File(dir, FILE_NAME);
        if (!tmp.renameTo(target)) {
            throw new IOException("Could not replace " + target.getName());
        }
    }
}
