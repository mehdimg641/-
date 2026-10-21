<?php
/** Meta webhook: GET verification challenge, POST signed Instagram events. */

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/settings.php';
require __DIR__ . '/lib/rules.php';
require __DIR__ . '/lib/graph.php';
require __DIR__ . '/lib/meta_webhook.php';
require __DIR__ . '/lib/inbox.php';

const MAX_BODY_BYTES = 1048576;
const WEBHOOK_HELLO = "✓ وبهوک Sepand Inbox فعال است.\nاین آدرس را در داشبورد Meta به‌عنوان Callback URL وارد کنید؛ Meta با Verify Token تأییدش می‌کند (باز کردن در مرورگر لازم نیست).\nنتیجهٔ درخواست‌های Meta: تنظیمات ← عیب‌یابی دریافت پیام.\n\n✓ Sepand Inbox webhook is up. Use this URL as the Callback URL in the Meta dashboard; Meta verifies it with the Verify Token.\n";

try {
    meta_settings();
} catch (Throwable $e) {
    error_log('[Sepand Webhook] ' . $e->getMessage());
    send_json(503, ['error' => 'Temporarily unavailable']);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET' && !isset($_GET['hub_mode'])) {
    // Someone opened the URL in a browser; Meta always sends hub.mode. Say it works instead of "invalid".
    http_response_code(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo WEBHOOK_HELLO;
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    // PHP turns "hub.mode" into "hub_mode" in $_GET.
    $challenge = webhook_challenge($_GET['hub_mode'] ?? null, $_GET['hub_verify_token'] ?? null, $_GET['hub_challenge'] ?? null);
    if ($challenge === null) {
        record_webhook('GET', 403, 'challenge_bad_token');
        send_json(403, ['error' => 'Invalid webhook verification token']);
    } else {
        record_webhook('GET', 200, 'challenge_ok');
        http_response_code(200);
        header('Content-Type: text/plain');
        echo $challenge;
    }
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    send_json(405, ['error' => 'Method not allowed']);
    exit;
}

$raw = (string) file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if (strlen($raw) > MAX_BODY_BYTES) {
    send_json(413, ['error' => 'Payload too large']);
    exit;
}
if (!verify_signature($raw, $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? null)) {
    record_webhook('POST', 401, 'bad_signature');
    send_json(401, ['error' => 'Invalid signature']);
    exit;
}
$body = json_decode($raw, true, 64, JSON_BIGINT_AS_STRING);
if (!is_array($body)) {
    record_webhook('POST', 400, 'bad_json');
    send_json(400, ['error' => 'Invalid JSON']);
    exit;
}
if (($body['object'] ?? '') !== 'instagram') {
    record_webhook('POST', 404, 'other_object', (string) ($body['object'] ?? ''));
    send_json(404, ['error' => 'Unsupported Meta object']);
    exit;
}

// Store before acknowledging: on a storage error Meta gets a 5xx and retries later.
$payload = describe_payload($body);
try {
    $events = extract_events($body);
    $result = ingest_events($events);
    record_webhook('POST', 200, 'received', sprintf('accounts: %s | fields: %s | stored %d, duplicate %d, ignored %d',
        implode(',', $payload['accounts']) ?: '-', implode(',', $payload['fields']) ?: '-', $result['stored'], $result['duplicates'], $payload['items'] - count($events)), $payload['accounts']);
} catch (Throwable $e) {
    error_log('[Sepand Webhook] Failed to store events: ' . $e->getMessage());
    record_webhook('POST', 503, 'error', $e->getMessage());
    header('Retry-After: 60');
    send_json(503, ['error' => 'Temporarily unavailable']);
    exit;
}

send_json(200, ['received' => true]);
finish_response();

foreach ($result['toSend'] as $replyId) {
    try {
        send_reply($replyId, null);
    } catch (Throwable $e) {
        error_log('[Sepand Webhook] Auto-reply failed: ' . $e->getMessage());
    }
}
