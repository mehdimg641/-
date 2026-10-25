<?php
/**
 * Telegram bridge for Sepand Inbox (new file; changes no existing file, so auto-updates leave it).
 * Upload to the site's document root, next to index.html. Called only by the Sepand Core
 * (Supabase), never by a browser: every request is signed with the shared bridge_secret.
 *
 * Telegram is blocked from Iranian hosts, so the Core talks to Telegram and this file only talks to
 * the inbox database:
 *   POST ?action=ingest  a customer's message (+ Gemini draft) → igEvents + a pending draft
 *   POST ?action=outbox  replies the operator sent from the dashboard → the Core delivers them
 *   POST ?action=ack     the Core reports each delivery → reply marked sent / failed
 *
 * Telegram chats live under their own page, «تلگرام» (igAccounts id "telegram"), so they never mix
 * with an Instagram page. Pressing «ارسال» there first fails (the inbox tries Instagram); this bridge
 * picks those replies up within a minute, delivers them through Telegram and marks them sent.
 *
 * The shared key is derived from the inbox's own `secret` in api/config.php, so nothing has to be
 * edited by hand. An admin logged in to the dashboard opens /telegram-bridge.php in the browser to
 * see it once and copies it into Supabase as SEPAND_BRIDGE_SECRET. (An explicit 'bridge_secret' in
 * api/config.php takes precedence, if one is ever set.)
 */

declare(strict_types=1);

require __DIR__ . '/api/lib/bootstrap.php';
require __DIR__ . '/api/lib/auth.php';
require __DIR__ . '/api/lib/settings.php';
require __DIR__ . '/api/lib/accounts.php';
require __DIR__ . '/api/lib/rules.php';
require __DIR__ . '/api/lib/graph.php';
require __DIR__ . '/api/lib/inbox.php';

const TG_PAGE = 'telegram';
const TG_FAILED_PREFIX = 'تلگرام: ';
const SIGNATURE_MAX_AGE = 300;
const OUTBOX_BATCH = 20;

/** The key shared with the Core: config's bridge_secret, or one derived from the inbox's secret. */
function bridge_secret(): string
{
    $explicit = (string) (config()['bridge_secret'] ?? '');
    if (strlen($explicit) >= 24) return $explicit;
    return hash_hmac('sha256', 'sepand-telegram-bridge', app_secret());
}

/** Signature = hex HMAC-SHA256 of "<unix time>.<raw body>" with bridge_secret(). */
function verify_bridge_request(string $raw): void
{
    $secret = bridge_secret();
    $time = (string) ($_SERVER['HTTP_X_SEPAND_TIME'] ?? '');
    $given = strtolower((string) ($_SERVER['HTTP_X_SEPAND_SIGNATURE'] ?? ''));
    if (!ctype_digit($time) || abs(time() - (int) $time) > SIGNATURE_MAX_AGE) throw new ApiError('UNAUTHORIZED', 'stale or missing timestamp');
    if (!hash_equals(hash_hmac('sha256', $time . '.' . $raw, $secret), $given)) throw new ApiError('UNAUTHORIZED', 'bad signature');
}

/** The «تلگرام» page; its token is a placeholder (Instagram refresh only touches tokens starting "IG"). */
function ensure_telegram_page(): void
{
    db()->prepare("INSERT IGNORE INTO igAccounts (id, username, name, token, enabled) VALUES (?, ?, ?, ?, 1)")
        ->execute([TG_PAGE, 'telegram', 'تلگرام', encrypt_setting('telegram-bridge')]);
}

function clip(string $value, int $max): string
{
    return mb_substr(trim($value), 0, $max);
}

function bridge_ingest(array $in): array
{
    $chatId = (string) ($in['chat_id'] ?? '');
    $messageId = (string) ($in['message_id'] ?? '');
    if (!preg_match('/^-?\d{1,20}$/', $chatId) || !preg_match('/^\d{1,20}$/', $messageId)) throw new ApiError('BAD_REQUEST', 'bad ids');
    $text = clip((string) ($in['text'] ?? ''), 4000);
    if ($text === '') $text = '[پیام غیرمتنی: عکس، صوت یا فایل؛ در تلگرام ببینید]';
    ensure_telegram_page();

    $pdo = db();
    // externalId is unique per page: Telegram retrying the same update stores nothing new.
    $insert = $pdo->prepare("INSERT IGNORE INTO igEvents (accountId, kind, externalId, senderId, username, text) VALUES (?, 'dm', ?, ?, ?, ?)");
    $insert->execute([TG_PAGE, $chatId . ':' . $messageId, 'tg' . $chatId, clip((string) ($in['name'] ?? ''), 64) ?: null, $text]);
    if ($insert->rowCount() === 0) return ['stored' => false, 'duplicate' => true];
    $eventId = (int) $pdo->lastInsertId();

    // Gemini's draft goes into the normal approval queue; nothing is sent from here.
    $draft = clip((string) ($in['draft'] ?? ''), 1500);
    $replyId = $draft !== '' ? create_reply($eventId, null, 'rule', $draft) : null;
    return ['stored' => true, 'eventId' => $eventId, 'replyId' => $replyId];
}

/**
 * Replies the operator approved in the dashboard: the inbox tried Instagram, failed, and left them
 * "failed" with its own error. Our own failed deliveries carry TG_FAILED_PREFIX and are left for the
 * operator to retry. Claimed atomically ("sending") so two outbox calls never deliver one twice.
 */
function bridge_outbox(): array
{
    $stmt = db()->prepare("SELECT r.id, r.text, e.externalId FROM replies r JOIN igEvents e ON e.id = r.eventId
        WHERE e.accountId = ? AND r.status = 'failed' AND r.decidedBy IS NOT NULL
          AND (r.error IS NULL OR r.error NOT LIKE ?) ORDER BY r.id LIMIT " . OUTBOX_BATCH);
    $stmt->execute([TG_PAGE, TG_FAILED_PREFIX . '%']);
    $items = [];
    foreach ($stmt->fetchAll() as $row) {
        if (!claim_reply((int) $row['id'], ['failed'])) continue;
        [$chatId, $messageId] = array_pad(explode(':', (string) $row['externalId'], 2), 2, '');
        $items[] = ['replyId' => (int) $row['id'], 'chatId' => $chatId, 'replyTo' => $messageId, 'text' => (string) $row['text']];
    }
    return ['items' => $items];
}

function bridge_ack(array $in): array
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
            $stmt->execute([TG_FAILED_PREFIX . clip((string) ($r['error'] ?? 'ارسال نشد'), 300), $id]);
        }
        $done += $stmt->rowCount();
    }
    return ['updated' => $done];
}

// Opened in the browser by a logged-in admin: show the key to copy into Supabase. Nobody else sees it.
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    header('Cache-Control: no-store');
    header('X-Robots-Tag: noindex');
    try {
        if (!current_user()) {
            http_response_code(401);
            header('Content-Type: text/plain; charset=utf-8');
            echo "ابتدا وارد داشبورد اینباکس شوید، سپس همین صفحه را دوباره باز کنید.";
            exit;
        }
        header('Content-Type: text/html; charset=utf-8');
        echo '<!doctype html><meta charset="utf-8"><body dir="rtl" style="font-family:sans-serif;max-width:640px;margin:40px auto;line-height:2">'
            . '<h3>کلید پل تلگرام</h3><p>این مقدار را کپی کنید و در Supabase با نام <code>SEPAND_BRIDGE_SECRET</code> ذخیره کنید. آن را جای دیگری نفرستید.</p>'
            . '<input readonly style="width:100%;font-family:monospace;padding:8px" onclick="this.select()" value="'
            . htmlspecialchars(bridge_secret(), ENT_QUOTES) . '"></body>';
    } catch (ApiError $e) {
        http_response_code(412);
        header('Content-Type: text/plain; charset=utf-8');
        echo $e->getMessage();
    }
    exit;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') throw new ApiError('METHOD_NOT_SUPPORTED', 'POST only');
    $raw = (string) file_get_contents('php://input');
    verify_bridge_request($raw);
    $in = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($in)) throw new ApiError('BAD_REQUEST', 'invalid JSON');
    $action = (string) ($_GET['action'] ?? '');
    if ($action === 'ingest') send_json(200, bridge_ingest($in));
    elseif ($action === 'outbox') send_json(200, bridge_outbox());
    elseif ($action === 'ack') send_json(200, bridge_ack($in));
    else throw new ApiError('NOT_FOUND', 'unknown action');
} catch (ApiError $e) {
    $status = ['UNAUTHORIZED' => 401, 'BAD_REQUEST' => 400, 'NOT_FOUND' => 404, 'METHOD_NOT_SUPPORTED' => 405, 'PRECONDITION_FAILED' => 412][$e->trpcCode] ?? 400;
    send_json($status, ['error' => $e->getMessage()]);
} catch (Throwable $e) {
    error_log('[Sepand] telegram bridge: ' . $e->getMessage());
    send_json(500, ['error' => 'internal error']);
}
