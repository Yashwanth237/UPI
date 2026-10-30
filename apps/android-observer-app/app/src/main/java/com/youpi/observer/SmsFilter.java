package com.youpi.observer;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Decides on the phone which SMS may leave it. Only messages the gateway's bank SMS parser could
 * ever accept as a credit are uploaded; personal chats, OTPs, promotions and debit alerts (what
 * the merchant spent) stay on the device.
 *
 * The rules are copied from packages/core/src/bank-sms-parser.js, which returns null for any
 * message failing them, so nothing the gateway could verify is dropped here:
 * - a credit phrase must be present (CREDIT_KEYWORDS_REGEX);
 * - a debit word appearing before the first credit word makes it a debit alert;
 * - a message longer than the parser's scan limit is not a bank alert (those run to a few
 *   hundred characters even when split across several SMS parts).
 * The sender is deliberately not filtered: a "credited" SMS from a customer's own mobile number
 * is what the gateway's fraud check looks for, and it needs to see it to ban the sender.
 * apps/android-observer-app/__tests__/android-app-source.test.js keeps these in step.
 */
final class SmsFilter {
    static final String CREDIT_KEYWORDS_REGEX =
        "\\b(?:credited|received|deposit(?:ed)?|payment\\s+received|money\\s+received|upi\\/cr" +
        "|transferred\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)" +
        "|payment\\s+of\\s+(?:(?:rs\\b\\.?|inr\\b)\\s*)?[\\d,.]+\\s+(?:has\\s+been\\s+)?made\\s+to\\s+(?:your\\s+)?(?:a\\/c|account|wallet)" +
        "|added\\s+to\\s+(?:your\\s+)?(?:account|wallet))\\b";
    static final String DEBIT_WORD_REGEX = "\\b(?:debited|withdrawn|deducted|spent|paid rs|sent rs)\\b";
    static final String CREDIT_WORD_REGEX = "\\b(?:credited|received|deposit|deposited)\\b";

    /** The parser only scans this many characters; a bank alert is far shorter. */
    static final int MAX_BODY_CHARS = 4096;

    private static final Pattern CREDIT_KEYWORDS = Pattern.compile(CREDIT_KEYWORDS_REGEX, Pattern.CASE_INSENSITIVE);
    private static final Pattern DEBIT_WORD = Pattern.compile(DEBIT_WORD_REGEX, Pattern.CASE_INSENSITIVE);
    private static final Pattern CREDIT_WORD = Pattern.compile(CREDIT_WORD_REGEX, Pattern.CASE_INSENSITIVE);
    private static final Pattern HAS_DIGIT = Pattern.compile("\\d");

    private SmsFilter() {}

    static boolean isEligible(String body) {
        if (body == null) return false;
        String text = body.trim();
        if (text.isEmpty() || text.length() > MAX_BODY_CHARS) return false;
        if (!CREDIT_KEYWORDS.matcher(text).find() || !HAS_DIGIT.matcher(text).find()) return false;

        Matcher debit = DEBIT_WORD.matcher(text);
        if (debit.find()) {
            Matcher credit = CREDIT_WORD.matcher(text);
            if (!credit.find() || debit.start() < credit.start()) return false;
        }
        return true;
    }
}
