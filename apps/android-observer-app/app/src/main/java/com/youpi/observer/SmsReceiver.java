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

        final ApiClient client = new ApiClient(context);
        if (!client.isPaired()) {
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

        for (java.util.Map.Entry<String, StringBuilder> entry : bodies.entrySet()) {
            final String sender = entry.getKey().isEmpty() ? null : entry.getKey();
            final String body = entry.getValue().toString();
            final long timestamp = firstTimestamps.get(entry.getKey());

            Log.i(TAG, "Captured incoming SMS: " + body.length() + " chars");

            // Dispatch to YouPI Gateway in asynchronous worker thread
            new Thread(new Runnable() {
                @Override
                public void run() {
                    boolean success = client.sendSms(sender, body, timestamp);
                    Log.i(TAG, "Dispatched SMS to YouPI Gateway: " + (success ? "SUCCESS" : "FAILED"));
                }
            }).start();
        }
    }
}
