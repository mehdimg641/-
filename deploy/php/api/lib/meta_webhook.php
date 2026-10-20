<?php
/** Webhook verification and payload parsing; mirrors server/metaWebhook.ts. */

declare(strict_types=1);

const MAX_EVENTS_PER_REQUEST = 1000;

function webhook_challenge($mode, $token, $challenge): ?string
{
    $expected = meta_setting('META_WEBHOOK_VERIFY_TOKEN');
    if ($expected === '' || $mode !== 'subscribe' || !is_string($token) || $challenge === null || $challenge === '') return null;
    return hash_equals($expected, $token) ? (string) $challenge : null;
}

/** X-Hub-Signature-256 over the raw body. Fails closed without an app secret. */
function verify_signature(string $rawBody, ?string $header): bool
{
    $secret = meta_setting('META_APP_SECRET');
    if ($secret === '' || $header === null || !preg_match('/^sha256=[a-f0-9]{64}$/i', $header)) return false;
    return hash_equals(hash_hmac('sha256', $rawBody, $secret), strtolower(substr($header, 7)));
}

/**
 * Turns a verified payload into inbox events. Skips our own comments and echoed DMs (replying
 * to them would loop), deleted messages, receipts, other fields and accounts not in the allowlist.
 */
function extract_events(array $body): array
{
    $allowed = allowed_account_ids();
    $events = [];
    $seen = 0;
    foreach ($body['entry'] ?? [] as $entry) {
        $accountId = isset($entry['id']) ? (string) $entry['id'] : '';
        if ($accountId === '' || ($allowed && !in_array($accountId, $allowed, true))) continue;
        $isOwn = function ($id) use ($accountId, $allowed): bool {
            return $id !== null && ((string) $id === $accountId || in_array((string) $id, $allowed, true));
        };
        foreach ($entry['changes'] ?? [] as $change) {
            if (++$seen > MAX_EVENTS_PER_REQUEST) return $events;
            $v = $change['value'] ?? null;
            if (($change['field'] ?? '') !== 'comments' || empty($v['id']) || empty($v['text']) || empty($v['from']['id']) || $isOwn($v['from']['id'])) continue;
            $events[] = ['accountId' => $accountId, 'kind' => 'comment', 'externalId' => (string) $v['id'], 'senderId' => (string) $v['from']['id'],
                'username' => isset($v['from']['username']) ? (string) $v['from']['username'] : null, 'text' => (string) $v['text'],
                'mediaId' => isset($v['media']['id']) ? (string) $v['media']['id'] : null];
        }
        foreach ($entry['messaging'] ?? [] as $m) {
            if (++$seen > MAX_EVENTS_PER_REQUEST) return $events;
            $message = $m['message'] ?? null;
            $senderId = $m['sender']['id'] ?? null;
            if (empty($message['mid']) || empty($message['text']) || !empty($message['is_echo']) || !empty($message['is_deleted'])) continue;
            if ($senderId === null || $isOwn($senderId)) continue;
            $events[] = ['accountId' => $accountId, 'kind' => 'dm', 'externalId' => (string) $message['mid'], 'senderId' => (string) $senderId,
                'username' => null, 'text' => (string) $message['text'], 'mediaId' => null];
        }
    }
    return $events;
}
