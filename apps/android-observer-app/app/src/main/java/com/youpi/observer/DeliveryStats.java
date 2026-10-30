package com.youpi.observer;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * What happened to incoming SMS on this phone, counted at each step so "the phone got an SMS but
 * the dashboard did not change" can be traced to the step where it stopped. Counts only: no
 * message text, sender or phone number is stored here or sent to the gateway.
 */
final class DeliveryStats {
    private static final String PREFS = "youpi_delivery_stats";
    private static final Object LOCK = new Object();

    static final String SMS_RECEIVED = "smsReceived";
    static final String SMS_KEPT_ON_DEVICE = "smsKeptOnDevice";
    static final String SMS_QUEUED = "smsQueued";
    static final String DUPLICATES_IGNORED = "duplicatesIgnored";
    static final String UPLOAD_ATTEMPTS = "uploadAttempts";
    static final String UPLOADS_ACCEPTED = "uploadsAccepted";
    static final String UPLOADS_REJECTED = "uploadsRejected";
    static final String UPLOADS_RETRIED = "uploadsRetried";
    static final String EXPIRED_UNSENT = "expiredUnsent";

    static final String LAST_SMS_RECEIVED_AT = "lastSmsReceivedAt";
    static final String LAST_QUEUED_AT = "lastQueuedAt";
    static final String LAST_UPLOAD_ATTEMPT_AT = "lastUploadAttemptAt";
    static final String LAST_UPLOAD_ACCEPTED_AT = "lastUploadAcceptedAt";
    static final String LAST_UPLOAD_HTTP_STATUS = "lastUploadHttpStatus";

    private static final String[] COUNTERS = {
        SMS_RECEIVED, SMS_KEPT_ON_DEVICE, SMS_QUEUED, DUPLICATES_IGNORED, UPLOAD_ATTEMPTS,
        UPLOADS_ACCEPTED, UPLOADS_REJECTED, UPLOADS_RETRIED, EXPIRED_UNSENT
    };
    private static final String[] TIMES = {
        LAST_SMS_RECEIVED_AT, LAST_QUEUED_AT, LAST_UPLOAD_ATTEMPT_AT, LAST_UPLOAD_ACCEPTED_AT
    };

    private DeliveryStats() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Adds one to a counter and, when given, stamps a "last ... at" time with now. */
    static void count(Context context, String counter, String timeKey) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            SharedPreferences.Editor e = p.edit().putLong(counter, p.getLong(counter, 0) + 1);
            if (timeKey != null) e.putLong(timeKey, System.currentTimeMillis());
            e.apply();
        }
    }

    static void recordUploadAttempt(Context context, int httpStatus) {
        synchronized (LOCK) {
            SharedPreferences p = prefs(context);
            p.edit()
                .putLong(UPLOAD_ATTEMPTS, p.getLong(UPLOAD_ATTEMPTS, 0) + 1)
                .putLong(LAST_UPLOAD_ATTEMPT_AT, System.currentTimeMillis())
                .putInt(LAST_UPLOAD_HTTP_STATUS, httpStatus)
                .apply();
        }
    }

    static long get(Context context, String key) {
        return prefs(context).getLong(key, 0);
    }

    static int lastUploadHttpStatus(Context context) {
        return prefs(context).getInt(LAST_UPLOAD_HTTP_STATUS, 0);
    }

    /** Counters and times for the signed heartbeat (times in epoch ms, absent when never). */
    static JSONObject snapshot(Context context) throws Exception {
        SharedPreferences p = prefs(context);
        JSONObject json = new JSONObject();
        for (String k : COUNTERS) json.put(k, p.getLong(k, 0));
        for (String k : TIMES) {
            long t = p.getLong(k, 0);
            if (t > 0) json.put(k, t);
        }
        if (p.contains(LAST_UPLOAD_HTTP_STATUS)) json.put(LAST_UPLOAD_HTTP_STATUS, p.getInt(LAST_UPLOAD_HTTP_STATUS, 0));
        return json;
    }
}
