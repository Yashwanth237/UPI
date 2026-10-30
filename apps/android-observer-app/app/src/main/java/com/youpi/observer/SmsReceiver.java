package com.youpi.observer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.util.Log;

public class SmsReceiver extends BroadcastReceiver {
    private static final String TAG = "YoupiSmsReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) {
            return;
        }

        SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
        if (messages == null || messages.length == 0) return;

        final Context appContext = context.getApplicationContext();
        Log.i(TAG, "SMS_RECEIVED broadcast: " + messages.length + " part(s)");
        if (!new ApiClient(appContext).isPaired()) {
            Log.w(TAG, "SMS received but device is not paired with YouPI Gateway. Skipping.");
            return;
        }

        // A bank alert longer than one SMS arrives as several PDUs in the same broadcast. Forwarding
        // each part separately split the amount and the UTR across observations, so neither part
        // could be verified. Join the parts per sender, in delivery order, before forwarding.
        java.util.LinkedHashMap<String, StringBuilder> bodies = new java.util.LinkedHashMap<>();
        java.util.HashMap<String, Long> firstTimestamps = new java.util.HashMap<>();
        for (SmsMessage part : messages) {
            if (part == null) continue;
            String from = part.getOriginatingAddress();
            String key = from != null ? from : "";
            StringBuilder sb = bodies.get(key);
            if (sb == null) {
                sb = new StringBuilder();
                bodies.put(key, sb);
                firstTimestamps.put(key, part.getTimestampMillis());
            }
            String text = part.getMessageBody();
            if (text != null) sb.append(text);
        }

        int queued = 0;
        for (java.util.Map.Entry<String, StringBuilder> entry : bodies.entrySet()) {
            final String sender = entry.getKey().isEmpty() ? null : entry.getKey();
            final String body = entry.getValue().toString();
            final long timestamp = firstTimestamps.get(entry.getKey());
            DeliveryStats.count(appContext, DeliveryStats.SMS_RECEIVED, DeliveryStats.LAST_SMS_RECEIVED_AT);

            // Personal messages, OTPs, promotions and debit alerts never leave the phone.
            if (!SmsFilter.isEligible(body)) {
                DeliveryStats.count(appContext, DeliveryStats.SMS_KEPT_ON_DEVICE, null);
                Log.i(TAG, "SMS received; not a credit alert, kept on device (" + body.length() + " chars)");
                continue;
            }
            // Queued first and persisted, so the alert survives the gateway being unreachable,
            // this process being killed, or the phone restarting before it is delivered.
            if (SmsOutbox.enqueue(appContext, sender, body, timestamp)) {
                DeliveryStats.count(appContext, DeliveryStats.SMS_QUEUED, DeliveryStats.LAST_QUEUED_AT);
                queued++;
            } else {
                DeliveryStats.count(appContext, DeliveryStats.DUPLICATES_IGNORED, null);
            }
        }
        if (queued == 0) return;

        Log.i(TAG, "Queued " + queued + " credit alert(s) for the gateway");
        // goAsync keeps the process alive while the queue is flushed off the main thread.
        final PendingResult pending = goAsync();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    int left = SmsOutbox.flush(appContext);
                    Log.i(TAG, "Outbox flushed; " + left + " still pending");
                } finally {
                    pending.finish();
                }
            }
        }).start();
    }
}
