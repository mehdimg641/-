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

try {
    meta_settings();
} catch (Throwable $e) {
    error_log('[Sepand Webhook] ' . $e->getMessage());
    send_json(503, ['error' => 'Temporarily unavailable']);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    // PHP turns "hub.mode" into "hub_mode" in $_GET.
    $challenge = webhook_challenge($_GET['hub_mode'] ?? null, $_GET['hub_verify_token'] ?? null, $_GET['hub_challenge'] ?? null);
    if ($challenge === null) {
        send_json(403, ['error' => 'Invalid webhook verification token']);
    } else {
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
    send_json(401, ['error' => 'Invalid signature']);
    exit;
}
$body = json_decode($raw, true, 64, JSON_BIGINT_AS_STRING);
if (!is_array($body)) {
    send_json(400, ['error' => 'Invalid JSON']);
    exit;
}
if (($body['object'] ?? '') !== 'instagram') {
    send_json(404, ['error' => 'Unsupported Meta object']);
    exit;
}

// Store before acknowledging: on a storage error Meta gets a 5xx and retries later.
try {
    $result = ingest_events(extract_events($body));
} catch (Throwable $e) {
    error_log('[Sepand Webhook] Failed to store events: ' . $e->getMessage());
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
