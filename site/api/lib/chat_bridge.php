<?php
/**
 * Bridge between the inbox and the Sepand Core (Supabase) for messengers the host cannot reach
 * itself (Bale; Telegram uses its own copy, telegram-bridge.php, uploaded by hand). The Core talks
 * to the messenger and Gemini; this file only touches the inbox database. Every request is signed
 * with the same key as telegram-bridge.php, so the Core needs no extra secret:
 *   POST ?action=ingest  a customer's message (+ Gemini draft) → igEvents + a pending draft
 *   POST ?action=outbox  replies the operator approved → the Core delivers them
 *   POST ?action=ack     the Core reports each delivery → reply marked sent / failed
 *
 * Each messenger's chats live under their own page (igAccounts id = the messenger's name). Approving
 * a reply there queues it without calling Instagram (send_reply, BRIDGE_PAGES); the outbox picks it
 * up within a minute. A delivery that failed carries "<label>: " in its error and is left for the
 * operator to retry.
 */

declare(strict_types=1);

const CHAT_BRIDGE_SIGNATURE_MAX_AGE = 300;
const CHAT_BRIDGE_OUTBOX_BATCH = 20;

/** The key shared with the Core: config's bridge_secret, or one derived from the inbox's secret. */
function chat_bridge_secret(): string
{
    $explicit = (string) (config()['bridge_secret'] ?? '');
    if (strlen($explicit) >= 24) return $explicit;
    return hash_hmac('sha256', 'sepand-telegram-bridge', app_secret());
}

/** Signature = hex HMAC-SHA256 of "<unix time>.<raw body>" with chat_bridge_secret(). */
function chat_bridge_verify(string $raw): void
{
    $time = (string) ($_SERVER['HTTP_X_SEPAND_TIME'] ?? '');
    $given = strtolower((string) ($_SERVER['HTTP_X_SEPAND_SIGNATURE'] ?? ''));
    if (!ctype_digit($time) || abs(time() - (int) $time) > CHAT_BRIDGE_SIGNATURE_MAX_AGE) throw new ApiError('UNAUTHORIZED', 'stale or missing timestamp');
    if (!hash_equals(hash_hmac('sha256', $time . '.' . $raw, chat_bridge_secret()), $given)) throw new ApiError('UNAUTHORIZED', 'bad signature');
}

function chat_bridge_clip(string $value, int $max): string
{
    return mb_substr(trim($value), 0, $max);
}

function chat_bridge_ingest(string $page, string $label, array $in): array
{
    $chatId = (string) ($in['chat_id'] ?? '');
    $messageId = (string) ($in['message_id'] ?? '');
    if (!preg_match('/^-?\d{1,20}$/', $chatId) || !preg_match('/^\d{1,20}$/', $messageId)) throw new ApiError('BAD_REQUEST', 'bad ids');
    $text = chat_bridge_clip((string) ($in['text'] ?? ''), 4000);
    if ($text === '') $text = "[پیام غیرمتنی: عکس، صوت یا فایل؛ در $label ببینید]";
    // The page's token is a placeholder (Instagram refresh only touches tokens starting "IG").
    db()->prepare("INSERT IGNORE INTO igAccounts (id, username, name, token, enabled) VALUES (?, ?, ?, ?, 1)")
        ->execute([$page, $page, $label, encrypt_setting($page . '-bridge')]);

    $pdo = db();
    // externalId is unique per page: the messenger retrying the same update stores nothing new.
    $insert = $pdo->prepare("INSERT IGNORE INTO igEvents (accountId, kind, externalId, senderId, username, text) VALUES (?, 'dm', ?, ?, ?, ?)");
    $insert->execute([$page, $chatId . ':' . $messageId, $page . $chatId, chat_bridge_clip((string) ($in['name'] ?? ''), 64) ?: null, $text]);
    if ($insert->rowCount() === 0) return ['stored' => false, 'duplicate' => true];
    $eventId = (int) $pdo->lastInsertId();

    // Gemini's draft goes into the normal approval queue; nothing is sent from here.
    $draft = chat_bridge_clip((string) ($in['draft'] ?? ''), 1500);
    $replyId = $draft !== '' ? create_reply($eventId, null, 'rule', $draft) : null;
    return ['stored' => true, 'eventId' => $eventId, 'replyId' => $replyId];
}

/** Approved replies waiting for the Core, claimed atomically ("sending") so none is delivered twice. */
function chat_bridge_outbox(string $page, string $label): array
{
    $stmt = db()->prepare("SELECT r.id, r.text, e.externalId FROM replies r JOIN igEvents e ON e.id = r.eventId
        WHERE e.accountId = ? AND r.status = 'failed' AND r.decidedBy IS NOT NULL
          AND (r.error IS NULL OR r.error NOT LIKE ?) ORDER BY r.id LIMIT " . CHAT_BRIDGE_OUTBOX_BATCH);
    $stmt->execute([$page, $label . ': %']);
    $items = [];
    foreach ($stmt->fetchAll() as $row) {
        if (!claim_reply((int) $row['id'], ['failed'])) continue;
        [$chatId, $messageId] = array_pad(explode(':', (string) $row['externalId'], 2), 2, '');
        $items[] = ['replyId' => (int) $row['id'], 'chatId' => $chatId, 'replyTo' => $messageId, 'text' => (string) $row['text']];
    }
    return ['items' => $items];
}

function chat_bridge_ack(string $label, array $in): array
{
    $done = 0;
    foreach (($in['results'] ?? []) as $r) {
        $id = (int) ($r['replyId'] ?? 0);
        if ($id <= 0) continue;
        if (!empty($r['ok'])) {
            $stmt = db()->prepare("UPDATE replies SET status = 'sent', error = NULL, sentAt = UTC_TIMESTAMP(), externalId = ? WHERE id = ? AND status = 'sending'");
            $stmt->execute([isset($r['messageId']) ? (string) $r['messageId'] : null, $id]);
        } else {
            $stmt = db()->prepare("UPDATE replies SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'");
            $stmt->execute([$label . ': ' . chat_bridge_clip((string) ($r['error'] ?? 'ارسال نشد'), 300), $id]);
        }
        $done += $stmt->rowCount();
    }
    return ['updated' => $done];
}

/** Handles one signed request from the Core for the given page and exits. */
function chat_bridge_handle(string $page, string $label): void
{
    try {
        if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new ApiError('METHOD_NOT_SUPPORTED', 'POST only');
        $raw = (string) file_get_contents('php://input');
        chat_bridge_verify($raw);
        $in = $raw === '' ? [] : json_decode($raw, true);
        if (!is_array($in)) throw new ApiError('BAD_REQUEST', 'invalid JSON');
        $action = (string) ($_GET['action'] ?? '');
        if ($action === 'ingest') send_json(200, chat_bridge_ingest($page, $label, $in));
        elseif ($action === 'outbox') send_json(200, chat_bridge_outbox($page, $label));
        elseif ($action === 'ack') send_json(200, chat_bridge_ack($label, $in));
        else throw new ApiError('NOT_FOUND', 'unknown action');
    } catch (ApiError $e) {
        $status = ['UNAUTHORIZED' => 401, 'BAD_REQUEST' => 400, 'NOT_FOUND' => 404, 'METHOD_NOT_SUPPORTED' => 405, 'PRECONDITION_FAILED' => 412][$e->trpcCode] ?? 400;
        send_json($status, ['error' => $e->getMessage()]);
    } catch (Throwable $e) {
        error_log("[Sepand] $page bridge: " . $e->getMessage());
        send_json(500, ['error' => 'internal error']);
    }
}
