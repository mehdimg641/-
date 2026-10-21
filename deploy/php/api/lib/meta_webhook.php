<?php
/** Webhook verification and payload parsing; mirrors server/metaWebhook.ts. */

declare(strict_types=1);

const MAX_EVENTS_PER_REQUEST = 1000;

function webhook_challenge($mode, $token, $challenge): ?string
{
    // Copying from a web page easily picks up a space or newline; neither side may contain one on purpose.
    $expected = trim(meta_setting('META_WEBHOOK_VERIFY_TOKEN'));
    if ($expected === '' || $mode !== 'subscribe' || !is_string($token) || $challenge === null || $challenge === '') return null;
    return hash_equals($expected, trim($token)) ? (string) $challenge : null;
}

/** "ab…yz (24)": enough to tell two verify tokens apart in the log without writing either one down. */
function token_hint(?string $value): string
{
    $value = trim((string) $value);
    if ($value === '') return '(empty)';
    $n = mb_strlen($value);
    return ($n <= 6 ? str_repeat('•', $n) : mb_substr($value, 0, 2) . '…' . mb_substr($value, -2)) . " ($n)";
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

// --- webhook log: shows in Settings whether Meta calls in and why a call was dropped ----------

/** Never throws: logging must not turn a delivery into an error. */
function record_webhook(string $method, int $status, string $outcome, string $detail = '', array $accounts = []): void
{
    try {
        $pdo = db();
        $pdo->prepare("INSERT INTO webhookLog (method, status, outcome, detail, accounts) VALUES (?, ?, ?, ?, ?)")
            ->execute([$method, $status, $outcome, mb_substr($detail, 0, 255), mb_substr(implode(',', $accounts), 0, 255)]);
        $pdo->exec("DELETE FROM webhookLog WHERE id < " . ((int) $pdo->lastInsertId() - 200));
    } catch (Throwable $e) {
        error_log('[Sepand Webhook] log failed: ' . $e->getMessage());
    }
}

function list_webhook_log(int $limit = 20): array
{
    $rows = db()->query("SELECT * FROM webhookLog ORDER BY id DESC LIMIT " . $limit)->fetchAll();
    return array_map(function ($r) {
        return ['at' => db_time($r['at']), 'method' => $r['method'], 'status' => (int) $r['status'], 'outcome' => $r['outcome'],
            'detail' => $r['detail'], 'accounts' => $r['accounts'] === '' ? [] : explode(',', $r['accounts'])];
    }, $rows);
}

/** Which accounts and fields a payload carried. */
function describe_payload(array $body): array
{
    $accounts = [];
    $fields = [];
    $items = 0;
    foreach ($body['entry'] ?? [] as $entry) {
        if (!is_array($entry)) continue;
        if (isset($entry['id'])) $accounts[(string) $entry['id']] = true;
        foreach ($entry['changes'] ?? [] as $change) {
            $fields[(string) ($change['field'] ?? '?')] = true;
            $items++;
        }
        if (!empty($entry['messaging']) && is_array($entry['messaging'])) {
            $fields['messaging'] = true;
            $items += count($entry['messaging']);
        }
    }
    return ['accounts' => array_keys($accounts), 'fields' => array_keys($fields), 'items' => $items];
}

