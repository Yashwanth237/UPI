package com.youpi.observer;

/**
 * Runs the outbox's pure delivery rules on a desktop JVM (no device). Driven by
 * android-outbox-policy.test.js; prints "OK" or throws.
 */
public final class OutboxPolicyCheck {
    private static void expect(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
    }

    public static void main(String[] args) {
        // Only an explicit 2xx counts as delivered.
        expect(SmsOutbox.outcome(200) == SmsOutbox.Outcome.ACCEPTED, "200 accepted");
        expect(SmsOutbox.outcome(201) == SmsOutbox.Outcome.ACCEPTED, "201 accepted");
        // The gateway's decisions are kept for review, never counted as delivered or resent.
        for (int s : new int[] { 400, 409, 413, 422 }) {
            expect(SmsOutbox.outcome(s) == SmsOutbox.Outcome.REVIEW, s + " review");
        }
        // Transient or credential problems are retried, not dropped.
        for (int s : new int[] { -1, 401, 403, 408, 429, 500, 502, 503 }) {
            expect(SmsOutbox.outcome(s) == SmsOutbox.Outcome.RETRY, s + " retry");
        }
        // Bounded exponential back-off: 15 s, 30 s, 60 s ... capped at 10 min.
        expect(SmsOutbox.backoffMs(1) == 15_000L, "first retry 15 s");
        expect(SmsOutbox.backoffMs(2) == 30_000L, "second retry 30 s");
        expect(SmsOutbox.backoffMs(3) == 60_000L, "third retry 60 s");
        expect(SmsOutbox.backoffMs(50) == 600_000L, "capped at 10 min");
        // Same SMS, same id (duplicate broadcasts collapse); different SMS, different id.
        String a = SmsOutbox.idFor("VM-HDFCBK", "Rs.1.00 credited", 1000L);
        expect(a.equals(SmsOutbox.idFor("VM-HDFCBK", "Rs.1.00 credited", 1000L)), "stable id");
        expect(!a.equals(SmsOutbox.idFor("VM-HDFCBK", "Rs.1.00 credited", 1001L)), "time in id");
        expect(!a.equals(SmsOutbox.idFor("VM-HDFCBK", "Rs.2.00 credited", 1000L)), "text in id");
        // Multipart bank alerts and normal personal messages, through the real filter.
        expect(SmsFilter.isEligible("Rs.165.00 credited to a/c XX1234 (UPI Ref No 512345678901)."), "credit kept");
        expect(!SmsFilter.isEligible("See you at 6"), "personal filtered");
        expect(!SmsFilter.isEligible("Rs 340.00 debited from A/c XX1234 to VPA shop@okicici"), "debit filtered");
        System.out.println("OK");
    }
}
