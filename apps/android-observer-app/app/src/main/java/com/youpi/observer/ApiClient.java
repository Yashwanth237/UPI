package com.youpi.observer;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class ApiClient {
    private static final String TAG = "YoupiApiClient";
    private static final String PREFS_NAME = "youpi_gateway_prefs";
    /** Reported in heartbeats so the gateway can tell which build a phone runs. */
    static final String APP_VERSION = "1.1.1";
    /** Why the last pairing attempt failed, for the toast (never contains the token). */
    private volatile String lastPairError = null;

    public String getLastPairError() {
        return lastPairError;
    }
    private final SharedPreferences prefs;
    private final Context context;

    public ApiClient(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public boolean isPaired() {
        return prefs.getString("device_id", null) != null && prefs.getString("signing_key", null) != null;
    }

    public String getBaseUrl() {
        return prefs.getString("base_url", "http://10.0.2.2:6100");
    }

    public String getDeviceId() {
        return prefs.getString("device_id", "-");
    }

    public boolean pair(String baseUrl, String enrollmentToken, String deviceName) {
        return pair(baseUrl, enrollmentToken, deviceName, "00000000-0000-0000-0000-000000000001", "v1", 0);
    }

    public boolean pair(String baseUrl, String enrollmentToken, String deviceName, String merchantId, String version, long expiresAt) {
        String cleanUrl = baseUrl.replaceAll("/+$", "");
        String endpoint = cleanUrl + "/api/v1/pollers/android/pair";

        try {
            JSONObject body = new JSONObject();
            body.put("version", version != null ? version : "v1");
            body.put("enrollmentToken", enrollmentToken);
            body.put("merchantId", merchantId != null ? merchantId : "00000000-0000-0000-0000-000000000001");
            if (expiresAt > 0) body.put("expiresAt", expiresAt);
            body.put("deviceName", deviceName != null && !deviceName.isEmpty() ? deviceName : Build.MODEL);
            body.put("deviceModel", Build.MANUFACTURER + " " + Build.MODEL);
            // Re-pairing: prove we hold the current registration's key so the gateway retires it
            // instead of leaving it active next to the new one.
            String oldDeviceId = prefs.getString("device_id", null);
            String oldKey = prefs.getString("signing_key", null);
            if (oldDeviceId != null && oldKey != null) {
                body.put("previousDeviceId", oldDeviceId);
                body.put("previousProof", calculateHmacSha256("replace:" + oldDeviceId + ":" + enrollmentToken, oldKey));
            }

            lastPairError = null;
            String response = postJson(endpoint, body.toString(), null, null, null);
            if (response == null) {
                int code = lastHttpStatus;
                lastPairError = code == 409 ? "This pairing QR was already used. Show a new QR in Merchant Admin."
                    : code == 401 ? "Pairing QR invalid or expired. Show a new QR in Merchant Admin."
                    : code == -1 ? "Gateway unreachable at " + cleanUrl + "."
                    : "Gateway answered HTTP " + code + ".";
                return false;
            }

            JSONObject json = new JSONObject(response);
            if (json.optBoolean("paired", false) || json.has("deviceId")) {
                String deviceId = json.getString("deviceId");
                String signingKey = json.getString("signingKey");

                prefs.edit()
                    .putString("base_url", cleanUrl)
                    .putString("device_id", deviceId)
                    .putString("signing_key", signingKey)
                    .putString("merchant_id", merchantId)
                    .apply();

                Log.i(TAG, "Device paired successfully: " + deviceId);
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "Pairing error: " + e.getMessage(), e);
        }
        return false;
    }

    public boolean sendSms(String sender, String body, long timestamp) {
        int status = sendSmsStatus(sender, body, timestamp);
        return status >= 200 && status < 300;
    }

    /**
     * Forwards one bank SMS. Returns the HTTP status, or -1 when the gateway could not be reached
     * (or the device is not paired), so the outbox can tell "retry later" from "processed".
     */
    public int sendSmsStatus(String sender, String body, long timestamp) {
        if (!isPaired()) return -1;

        String deviceId = prefs.getString("device_id", null);
        String signingKey = prefs.getString("signing_key", null);
        String baseUrl = getBaseUrl();
        String endpoint = baseUrl + "/api/v1/observers/sms";

        try {
            // X-Timestamp is the signing (send) time, checked by the server's replay window.
            // The SMS receive time travels in the body: signing with it made every SMS that
            // was forwarded late (offline, retry) fail the window and be silently dropped.
            String tsStr = String.valueOf(System.currentTimeMillis());
            long receivedAt = timestamp > 0 ? timestamp : Long.parseLong(tsStr);
            JSONObject json = new JSONObject();
            json.put("deviceId", deviceId);
            json.put("sender", sender != null ? sender : "UNKNOWN");
            json.put("body", body != null ? body : "");
            json.put("timestamp", receivedAt);

            String bodyString = json.toString();
            String sigPayload = bodyString + ":" + tsStr;
            String signature = calculateHmacSha256(sigPayload, signingKey);

            int status = postJsonStatus(endpoint, bodyString, deviceId, tsStr, signature);
            Log.i(TAG, "SMS dispatched to YouPI Gateway: HTTP " + status + (lastResponseReason != null ? " " + lastResponseReason : ""));
            return status;
        } catch (Exception e) {
            Log.e(TAG, "sendSms error: " + e.getMessage());
        }
        return -1;
    }

    /**
     * Signed liveness ping. Returns the HTTP status, or -1 when the gateway was unreachable.
     * 401 means the signature or the phone's clock was refused; 403 means this device was unpaired.
     */
    public int sendHeartbeatStatus(int pendingObservations) {
        if (!isPaired()) return -1;

        String deviceId = prefs.getString("device_id", null);
        String signingKey = prefs.getString("signing_key", null);
        String endpoint = getBaseUrl() + "/api/v1/pollers/android/heartbeat";

        try {
            String tsStr = String.valueOf(System.currentTimeMillis());
            JSONObject json = new JSONObject();
            json.put("deviceId", deviceId);
            json.put("timestamp", Long.parseLong(tsStr));
            json.put("pendingObservations", pendingObservations);
            // Counts only (DeliveryStats): lets Merchant Admin show where an SMS stopped.
            JSONObject telemetry = DeliveryStats.snapshot(context);
            telemetry.put("workerRunning", ForegroundService.isRunning());
            if (ForegroundService.startedAt() > 0) telemetry.put("workerStartedAt", ForegroundService.startedAt());
            telemetry.put("smsPermissionGranted",
                context.checkSelfPermission(android.Manifest.permission.RECEIVE_SMS) == android.content.pm.PackageManager.PERMISSION_GRANTED);
            telemetry.put("appVersion", APP_VERSION);
            json.put("telemetry", telemetry);
            android.os.BatteryManager bm = (android.os.BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
            if (bm != null) {
                json.put("batteryPercent", bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY));
                json.put("isCharging", bm.isCharging());
            }

            String bodyString = json.toString();
            String signature = calculateHmacSha256(bodyString + ":" + tsStr, signingKey);
            int status = postJsonStatus(endpoint, bodyString, deviceId, tsStr, signature);
            prefs.edit()
                .putLong("last_heartbeat_attempt_at", System.currentTimeMillis())
                .putInt("last_heartbeat_status", status)
                .apply();
            return status;
        } catch (Exception e) {
            Log.e(TAG, "Heartbeat error: " + e.getMessage());
        }
        return -1;
    }

    public boolean sendHeartbeat() {
        int status = sendHeartbeatStatus(SmsOutbox.pendingCount(context));
        return status >= 200 && status < 300;
    }

    public long getLastHeartbeatAttemptAt() {
        return prefs.getLong("last_heartbeat_attempt_at", 0);
    }

    /** HTTP status of the last heartbeat (-1 unreachable, 0 never sent). */
    public int getLastHeartbeatStatus() {
        return prefs.getInt("last_heartbeat_status", 0);
    }

    public boolean sendObservation(long amountPaise, double amount, String bankRef, String senderVpa, String title, String text, String packageName) {
        if (!isPaired()) return false;

        String deviceId = prefs.getString("device_id", null);
        String signingKey = prefs.getString("signing_key", null);
        String baseUrl = getBaseUrl();
        String endpoint = baseUrl + "/api/v1/pollers/android/events";

        try {
            String tsStr = String.valueOf(System.currentTimeMillis());
            JSONObject raw = new JSONObject();
            raw.put("title", title != null ? title : "");
            raw.put("text", text != null ? text : "");
            if (packageName != null && !packageName.isEmpty()) {
                raw.put("package", packageName);
            }

            JSONObject json = new JSONObject();
            json.put("deviceId", deviceId);
            json.put("amountPaise", amountPaise);
            json.put("amount", amount);
            json.put("bankReferenceNumber", bankRef);
            json.put("senderVpa", senderVpa);
            json.put("observedAt", System.currentTimeMillis());
            json.put("rawNotification", raw);

            String bodyString = json.toString();
            String sigPayload = bodyString + ":" + tsStr;
            String signature = calculateHmacSha256(sigPayload, signingKey);

            String response = postJson(endpoint, bodyString, deviceId, tsStr, signature);
            return response != null;
        } catch (Exception e) {
            Log.e(TAG, "sendObservation error: " + e.getMessage());
        }
        return false;
    }

    public boolean sendObservation(long amountPaise, double amount, String bankRef, String senderVpa, String title, String text) {
        return sendObservation(amountPaise, amount, bankRef, senderVpa, title, text, null);
    }

    public void unpair() {
        prefs.edit().remove("device_id").remove("signing_key").apply();
    }

    /** POSTs and returns only the HTTP status (-1 when no response was received). */
    private volatile String lastResponseReason = null;
    private volatile long lastRetryAfterMs = 0;

    /** Reason code from the last observation/heartbeat response, or null. Codes only, never text. */
    public String getLastResponseReason() {
        return lastResponseReason;
    }

    /** Retry-After from the last response, in ms (0 when absent). */
    public long getLastRetryAfterMs() {
        return lastRetryAfterMs;
    }

    /** "reason", else "status", from a JSON response, if it is an UPPER_SNAKE code. */
    static String extractReason(String body) {
        if (body == null || body.isEmpty()) return null;
        try {
            JSONObject json = new JSONObject(body);
            for (String key : new String[] { "reason", "status" }) {
                String v = json.optString(key, "");
                if (v.matches("[A-Z][A-Z0-9_]{2,63}")) return v;
            }
        } catch (Exception ignored) {
            // Not JSON (e.g. a proxy error page): no reason code.
        }
        return null;
    }

    private int postJsonStatus(String urlString, String jsonBody, String deviceId, String timestamp, String signature) {
        lastResponseReason = null;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlString);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setDoOutput(true);
            if (deviceId != null) conn.setRequestProperty("X-Device-Id", deviceId);
            if (timestamp != null) conn.setRequestProperty("X-Timestamp", timestamp);
            if (signature != null) conn.setRequestProperty("X-Signature", signature);

            byte[] input = jsonBody.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(input, 0, input.length);
            }
            int code = conn.getResponseCode();
            lastRetryAfterMs = 0;
            String retryAfter = conn.getHeaderField("Retry-After");
            if (retryAfter != null && retryAfter.trim().matches("\\d{1,6}")) {
                lastRetryAfterMs = Long.parseLong(retryAfter.trim()) * 1000L;
            }
            // Keep only the gateway's machine-readable reason code (e.g. NO_ACTIVE_SESSION,
            // PERSONAL_SMS_REJECTED). Its human "error" text can quote the sender, so it is
            // never stored or logged.
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            StringBuilder sb = new StringBuilder();
            if (is != null) {
                try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                    char[] buf = new char[1024];
                    int n;
                    while ((n = br.read(buf)) != -1) {
                        if (sb.length() < 16384) sb.append(buf, 0, n);
                    }
                }
            }
            lastResponseReason = extractReason(sb.toString());
            return code;
        } catch (Exception e) {
            Log.w(TAG, "POST to " + urlString + " failed: " + e.getMessage());
            return -1;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** HTTP status of the last postJson call (-1 when no response arrived). */
    private volatile int lastHttpStatus = 0;

    private String postJson(String urlString, String jsonBody, String deviceId, String timestamp, String signature) {
        lastHttpStatus = -1;
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlString);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setDoOutput(true);

            if (deviceId != null) {
                conn.setRequestProperty("X-Device-Id", deviceId);
            }
            if (timestamp != null) {
                conn.setRequestProperty("X-Timestamp", timestamp);
            }
            if (signature != null) {
                conn.setRequestProperty("X-Signature", signature);
            }

            byte[] input = jsonBody.getBytes(StandardCharsets.UTF_8);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(input, 0, input.length);
            }

            int code = conn.getResponseCode();
            lastHttpStatus = code;
            InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
            if (is == null) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    sb.append(line);
                }
            }

            return (code >= 200 && code < 300) ? sb.toString() : null;
        } catch (Exception e) {
            Log.e(TAG, "postJson to " + urlString + " failed: " + e.getMessage());
            return null;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private String calculateHmacSha256(String data, String key) throws Exception {
        Mac sha256_HMAC = Mac.getInstance("HmacSHA256");
        SecretKeySpec secret_key = new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        sha256_HMAC.init(secret_key);
        byte[] rawHmac = sha256_HMAC.doFinal(data.getBytes(StandardCharsets.UTF_8));
        StringBuilder result = new StringBuilder();
        for (byte b : rawHmac) {
            result.append(String.format("%02x", b));
        }
        return result.toString();
    }
}
