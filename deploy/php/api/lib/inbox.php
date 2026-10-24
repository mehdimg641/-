<?php
/** Inbox events, reply drafts, sending and the dashboard views; mirrors server/inboxService.ts. */

declare(strict_types=1);

const TONES = ['orange', 'gold', 'blue', 'green', 'violet'];
const THREAD_EVENT_LIMIT = 5000;

function event_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'accountId' => $row['accountId'],
        'kind' => $row['kind'],
        'externalId' => $row['externalId'],
        'senderId' => $row['senderId'],
        'username' => $row['username'],
        'text' => $row['text'],
        'mediaId' => $row['mediaId'],
        'ruleId' => $row['ruleId'] === null ? null : (int) $row['ruleId'],
        'isRead' => (bool) $row['isRead'],
        'reaction' => $row['reaction'] ?? null,
        'hidden' => (bool) ($row['hidden'] ?? false),
        'deleted' => (bool) ($row['deleted'] ?? false),
        'createdAt' => db_time($row['createdAt']),
    ];
}

// Telegram chats (telegram-bridge.php) are delivered by the Sepand Core, not Instagram. The bridge's
// outbox picks up replies left "failed", so a queued one is stored that way with TELEGRAM_QUEUED as
// its error, and shown as "sending" so the operator never sees a failure that is not one.
const TELEGRAM_PAGE = 'telegram';
const TELEGRAM_QUEUED = 'در صف تلگرام؛ تا یک دقیقهٔ دیگر خودکار فرستاده می‌شود';

function reply_row(array $row): array
{
    $queued = $row['status'] === 'failed' && $row['error'] === TELEGRAM_QUEUED;
    return [
        'id' => (int) $row['id'],
        'eventId' => (int) $row['eventId'],
        'ruleId' => $row['ruleId'] === null ? null : (int) $row['ruleId'],
        'source' => $row['source'],
        'channel' => $row['channel'] ?? 'reply',
        'text' => $row['text'],
        'quickReplies' => ($row['quickReplies'] ?? null) === null ? null : array_values(json_decode((string) $row['quickReplies'], true) ?: []),
        'status' => $queued ? 'sending' : $row['status'],
        'error' => $queued ? null : $row['error'],
        'decidedBy' => $row['decidedBy'] === null ? null : (int) $row['decidedBy'],
        'externalId' => $row['externalId'] ?? null,
        'customerReaction' => $row['customerReaction'] ?? null,
        'createdAt' => db_time($row['createdAt']),
        'sentAt' => db_time($row['sentAt']),
    ];
}

function get_event(int $id): ?array
{
    $stmt = db()->prepare("SELECT * FROM igEvents WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? event_row($row) : null;
}

function get_reply(int $id): ?array
{
    $stmt = db()->prepare("SELECT * FROM replies WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? reply_row($row) : null;
}

function create_reply(int $eventId, ?int $ruleId, string $source, string $text, ?int $decidedBy = null, string $channel = 'reply', ?array $quickReplies = null): int
{
    db()->prepare("INSERT INTO replies (eventId, ruleId, source, channel, text, quickReplies, status, decidedBy) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
        ->execute([$eventId, $ruleId, $source, $channel, $text, $quickReplies ? json_encode($quickReplies, JSON_UNESCAPED_UNICODE) : null, $decidedBy]);
    return (int) db()->lastInsertId();
}

function button_payload(int $ruleId, int $index, int $eventId): string
{
    return "SEPAND:$ruleId:$index:$eventId";
}

function parse_button_payload(?string $payload): ?array
{
    if ($payload === null || !preg_match('/^SEPAND:(\d+):(\d+):(\d+)$/', $payload, $m)) return null;
    return ['ruleId' => (int) $m[1], 'index' => (int) $m[2], 'eventId' => (int) $m[3]];
}

/** When Instagram refuses the buttons, the options go into the text; typing one counts as a tap. */
function options_as_text(string $text, array $buttons): string
{
    return $text . "\n\nبرای ادامه یکی از این‌ها را بنویسید: " . implode('، ', array_map(function ($b) { return '«' . $b['title'] . '»'; }, $buttons));
}

/** How long after a DM with buttons a typed option still counts as a tap (Instagram's reply window). */
const TAP_WINDOW_SECONDS = 86400;

/**
 * A DM that answers one of our buttons: the tapped quick reply, or the same title typed by the
 * person we sent the buttons to. Returns the rule option to send, or null for an ordinary DM.
 */
function resolve_tap(array $event, array $rules): ?array
{
    if ($event['kind'] !== 'dm') return null;
    $tap = parse_button_payload($event['payload'] ?? null);
    if ($tap === null) {
        $typed = trim(normalize_text($event['text']));
        $stmt = db()->prepare("SELECT r.quickReplies FROM replies r JOIN igEvents e ON e.id = r.eventId
            WHERE e.accountId = ? AND e.senderId = ? AND r.status = 'sent' AND r.quickReplies IS NOT NULL AND r.sentAt >= NOW() - INTERVAL " . TAP_WINDOW_SECONDS . " SECOND
            ORDER BY r.sentAt DESC, r.id DESC LIMIT 20");
        $stmt->execute([$event['accountId'], $event['senderId']]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $json) {
            foreach (json_decode((string) $json, true) ?: [] as $q) {
                if (trim(normalize_text((string) $q['title'])) === $typed) { $tap = parse_button_payload((string) $q['payload']); break 2; }
            }
        }
    }
    if ($tap === null) return null;
    foreach ($rules as $rule) {
        if ($rule['id'] !== $tap['ruleId']) continue;
        $button = $rule['dmButtons'][$tap['index']] ?? null;
        if (!$button) return null;
        $source = get_event($tap['eventId']);
        return ['rule' => $rule, 'parts' => split_messages(render_template((string) $button['reply'], (string) ($source['username'] ?? '')))];
    }
    return null;
}

/** The drafts a decision calls for, in send order. */
function draft_parts(string $kind, array $decision, int $eventId): array
{
    // Each "---" part is its own reply, drafted (and later sent) in order.
    $parts = array_map(function ($text) { return ['channel' => 'reply', 'text' => $text, 'quickReplies' => null]; }, split_messages($decision['message']));
    // Instagram allows one private reply per comment, so its parts go out as one message.
    $dm = $kind === 'comment' ? join_messages($decision['dmMessage']) : '';
    if ($dm !== '') $parts[] = ['channel' => 'private', 'text' => $dm, 'quickReplies' => null];
    // The rule's buttons ride on its direct message: the private reply for a comment, the last
    // message for a DM. A public comment reply can't carry buttons.
    $buttons = $decision['rule']['dmButtons'] ?? [];
    $carrier = null;
    if ($kind === 'comment') {
        foreach ($parts as $i => $p) if ($p['channel'] === 'private') $carrier = $i;
    } elseif ($parts) {
        $carrier = count($parts) - 1;
    }
    if ($buttons && $carrier !== null) {
        $ruleId = $decision['rule']['id'];
        $parts[$carrier]['quickReplies'] = array_map(function ($b, $i) use ($ruleId, $eventId) {
            return ['title' => $b['title'], 'payload' => button_payload($ruleId, $i, $eventId)];
        }, $buttons, array_keys($buttons));
    }
    return $parts;
}

/** Instagram accepts the one private reply to a comment for 7 days, and a DM reply for 24 hours. */
const PRIVATE_REPLY_WINDOW_SECONDS = 7 * 86400;
const DM_WINDOW_SECONDS = 86400;
const PRIVATE_WINDOW_CLOSED = 'مهلت اینستاگرام گذشته: دایرکت به نویسندهٔ کامنت فقط تا ۷ روز بعد از کامنت ممکن است. پاسخ زیر کامنت هنوز ممکن است.';
const DM_WINDOW_CLOSED = 'مهلت اینستاگرام گذشته: به دایرکت فقط تا ۲۴ ساعت بعد از آخرین پیام مشتری می‌شود جواب داد. اگر دوباره پیام بدهد، مهلت دوباره باز می‌شود.';

/**
 * When Instagram stops accepting a reply: $receivedAt is the comment's time for a private reply
 * and the customer's latest DM for a DM. Replies under a comment have no deadline.
 */
function reply_deadline(string $kind, string $channel, DateTimeImmutable $receivedAt): ?DateTimeImmutable
{
    if ($kind === 'comment' && $channel === 'reply') return null;
    return $receivedAt->modify('+' . ($kind === 'comment' ? PRIVATE_REPLY_WINDOW_SECONDS : DM_WINDOW_SECONDS) . ' seconds');
}

/** Channels Instagram no longer accepts for this message (drafting them would only fail). */
function closed_channels(string $kind, DateTimeImmutable $createdAt): array
{
    $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));
    $closed = [];
    foreach (['reply', 'private'] as $channel) {
        $deadline = reply_deadline($kind, $channel, $createdAt);
        if ($deadline && $deadline <= $now) $closed[$channel] = true;
    }
    return $closed;
}

/** The sender's latest DM to this page (a DM stays answerable for 24 hours after it), or $fallback. */
function latest_dm_at(string $accountId, string $senderId, DateTimeImmutable $fallback): DateTimeImmutable
{
    $stmt = db()->prepare("SELECT MAX(createdAt) FROM igEvents WHERE kind = 'dm' AND accountId = ? AND senderId = ?");
    $stmt->execute([$accountId, $senderId]);
    $latest = db_time($stmt->fetchColumn() ?: null);
    return $latest && $latest > $fallback ? $latest : $fallback;
}

/** The drafts a rule decision calls for: a reply in place and, for comments, a private DM. */
function create_drafts(int $eventId, string $kind, array $decision, DateTimeImmutable $createdAt): array
{
    $ids = [];
    $closed = closed_channels($kind, $createdAt);
    foreach (draft_parts($kind, $decision, $eventId) as $part) if (!isset($closed[$part['channel']])) $ids[] = create_reply($eventId, $decision['rule']['id'], 'rule', $part['text'], null, $part['channel'], $part['quickReplies']);
    return $ids;
}

/** Atomically moves a reply to "sending"; false means it was already sent, rejected or taken. */
function claim_reply(int $id, array $from): bool
{
    $placeholders = implode(',', array_fill(0, count($from), '?'));
    $stmt = db()->prepare("UPDATE replies SET status = 'sending' WHERE id = ? AND status IN ($placeholders)");
    $stmt->execute(array_merge([$id], $from));
    return $stmt->rowCount() === 1;
}

/**
 * Stores new events (Meta retries are ignored via the unique key) and drafts a reply for each
 * match. Returns reply ids to send right away: only when auto-reply is on and the rule says "send".
 */
function ingest_events(array $events, bool $allowAutoSend = true, bool $draft = true, bool $read = false): array
{
    if (!$events) return ['stored' => 0, 'duplicates' => 0, 'toSend' => []];
    // Each event is matched against its own page's rules.
    $rulesFor = page_rules();
    $autoSend = $allowAutoSend && auto_reply_enabled();
    $pdo = db();
    $result = ['stored' => 0, 'duplicates' => 0, 'toSend' => []];
    // Imported history keeps the time it was written; webhooks use the arrival time.
    $insert = $pdo->prepare("INSERT IGNORE INTO igEvents (accountId, kind, externalId, senderId, username, text, mediaId, ruleId, isRead, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))");
    foreach ($events as $e) {
        [$rules, $templates] = $rulesFor($e['accountId']);
        $tap = $draft ? resolve_tap($e, $rules) : null;
        $decision = $tap ? null : decide_reply($rules, $templates, $e['kind'], (string) ($e['username'] ?? ''), $e['text'], $e['mediaId']);
        $ruleId = $tap ? $tap['rule']['id'] : ($decision ? $decision['rule']['id'] : null);
        $insert->execute([$e['accountId'], $e['kind'], $e['externalId'], $e['senderId'], $e['username'], $e['text'], $e['mediaId'],
            $ruleId, $read ? 1 : 0, $e['at'] ?? null]);
        if ($insert->rowCount() === 0) {
            $result['duplicates']++;
            continue;
        }
        $result['stored']++;
        if ($tap) {
            // Approving the first DM approved its options: the answer goes out right away.
            $eventId = (int) $pdo->lastInsertId();
            foreach ($tap['parts'] as $text) $result['toSend'][] = create_reply($eventId, $tap['rule']['id'], 'rule', $text);
            continue;
        }
        if (!$decision || !$draft) continue;
        $at = !empty($e['at']) ? db_time($e['at']) : new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $ids = create_drafts((int) $pdo->lastInsertId(), $e['kind'], $decision, $at);
        if ($autoSend && $decision['rule']['action'] === 'send') $result['toSend'] = array_merge($result['toSend'], $ids);
    }
    return $result;
}

/** Messages this recent are re-checked when rules change; older ones need "apply to unanswered". */
const REDRAFT_WINDOW_DAYS = 7;

/**
 * Brings the approval queue in line with the current rules and templates. Looks at every message
 * that still has a pending rule draft (however old: "apply to unanswered" drafts old comments
 * too) and at recent messages without any reply. Each channel (reply in place, private DM) is
 * judged on its own: one with a sent, failed, rejected or manual reply is settled and left alone;
 * the pending drafts of the others are drafted again. Never sends anything.
 */
function redraft_pending(): array
{
    @set_time_limit(120);
    $rulesFor = page_rules();
    $pdo = db();
    $args = [];
    $page = page_events_sql('accountId', active_page(), $args);
    // The session runs in UTC (bootstrap), like the stored timestamps.
    $stmt = $pdo->prepare("SELECT * FROM igEvents WHERE $page AND (createdAt >= NOW() - INTERVAL " . REDRAFT_WINDOW_DAYS . " DAY
        OR id IN (SELECT eventId FROM replies WHERE status = 'pending' AND source = 'rule')) ORDER BY id");
    $stmt->execute($args);
    $events = array_map('event_row', $stmt->fetchAll());
    $byEvent = [];
    foreach (replies_for_events(array_column($events, 'id')) as $reply) $byEvent[$reply['eventId']][] = $reply;
    $updated = 0;
    foreach ($events as $event) {
        $own = $byEvent[$event['id']] ?? [];
        $sent = [];
        foreach ($own as $reply) {
            if ($reply['status'] === 'sending') continue 2;
            if ($reply['status'] !== 'pending' || $reply['source'] !== 'rule') $sent[$reply['channel']] = true;
        }
        // A channel past Instagram's deadline is left as it is: its drafts can only be rejected.
        $skip = $sent + closed_channels($event['kind'], $event['createdAt']);
        $drafts = array_values(array_filter($own, function ($r) use ($skip) { return $r['status'] === 'pending' && $r['source'] === 'rule' && !isset($skip[$r['channel']]); }));
        [$rules, $templates] = $rulesFor($event['accountId']);
        $decision = decide_reply($rules, $templates, $event['kind'], (string) ($event['username'] ?? ''), $event['text'], $event['mediaId']);
        $ruleId = $decision ? $decision['rule']['id'] : null;
        $wanted = $decision ? array_values(array_filter(draft_parts($event['kind'], $decision, $event['id']), function ($p) use ($skip) { return !isset($skip[$p['channel']]); })) : [];
        $current = array_map(function ($r) { return ['channel' => $r['channel'], 'text' => $r['text'], 'quickReplies' => $r['quickReplies']]; }, $drafts);
        $sameRule = !array_filter($drafts, function ($r) use ($ruleId) { return $r['ruleId'] !== $ruleId; });
        if ($sameRule && $current === $wanted && ($sent || $event['ruleId'] === $ruleId)) continue;
        if ($drafts) {
            $ids = array_column($drafts, 'id');
            $pdo->prepare("DELETE FROM replies WHERE status = 'pending' AND id IN (" . implode(',', array_fill(0, count($ids), '?')) . ")")->execute($ids);
        }
        // Keep the tag of the rule that answered, if part of the answer already went out.
        if (!$sent) $pdo->prepare("UPDATE igEvents SET ruleId = ? WHERE id = ?")->execute([$ruleId, $event['id']]);
        foreach ($wanted as $part) create_reply($event['id'], $ruleId, 'rule', $part['text'], null, $part['channel'], $part['quickReplies']);
        $updated++;
    }
    return ['updated' => $updated];
}

/** Drafts replies for events that never got one (e.g. they arrived before the rule). Never auto-sends. */
function apply_rules_to_unanswered(): array
{
    // First bring drafts already in the queue up to date with the current rules.
    $updated = redraft_pending()['updated'];
    $rulesFor = page_rules();
    $args = [];
    $stmt = db()->prepare("SELECT e.* FROM igEvents e LEFT JOIN replies r ON r.eventId = e.id WHERE r.id IS NULL AND " . page_events_sql('e.accountId', active_page(), $args)
        . " ORDER BY e.createdAt DESC, e.id DESC LIMIT " . THREAD_EVENT_LIMIT);
    $stmt->execute($args);
    $drafted = 0;
    foreach (array_map('event_row', $stmt->fetchAll()) as $event) {
        [$rules, $templates] = $rulesFor($event['accountId']);
        $decision = decide_reply($rules, $templates, $event['kind'], (string) ($event['username'] ?? ''), $event['text'], $event['mediaId']);
        if ($decision && create_drafts($event['id'], $event['kind'], $decision, $event['createdAt'])) $drafted++;
    }
    return ['drafted' => $drafted, 'updated' => $updated];
}

function send_reply(int $replyId, ?int $operatorId, ?string $editedText = null): array
{
    $reply = get_reply($replyId);
    if (!$reply) throw new ApiError('CONFLICT', 'پاسخ پیدا نشد');
    $event = get_event($reply['eventId']);
    if (!$event) throw new ApiError('CONFLICT', 'پیام اصلی پیدا نشد');
    if (!claim_reply($replyId, ['pending', 'failed'])) throw new ApiError('CONFLICT', 'این پاسخ قبلاً ارسال یا رد شده است');

    $text = trim($editedText ?? $reply['text']);
    // Queued for the Telegram bridge without calling Meta (see TELEGRAM_QUEUED).
    if ($event['accountId'] === TELEGRAM_PAGE && $text !== '') {
        db()->prepare("UPDATE replies SET text = ?, status = 'failed', error = ?, decidedBy = ? WHERE id = ?")->execute([$text, TELEGRAM_QUEUED, $operatorId, $replyId]);
        return ['ok' => true];
    }
    $buttons = $reply['quickReplies'] ?: null;
    // Always as the page the message came to, whatever page the dashboard shows.
    $send = function (string $body, ?array $quickReplies) use ($reply, $event): array {
        return with_account($event['accountId'], function () use ($reply, $event, $body, $quickReplies) {
            if ($reply['channel'] === 'private') return send_private_reply($event['externalId'], $body, $quickReplies);
            if ($event['kind'] === 'comment') return reply_to_comment($event['externalId'], $body);
            return send_direct_message($event['senderId'], $body, $quickReplies);
        });
    };
    try {
        if ($text === '') throw new MetaApiError('متن پاسخ خالی است');
        // Past Instagram's deadline the API only answers with an error; say why without calling it.
        $received = $event['kind'] === 'dm' ? latest_dm_at($event['accountId'], $event['senderId'], $event['createdAt']) : $event['createdAt'];
        $deadline = reply_deadline($event['kind'], $reply['channel'], $received);
        if ($deadline && $deadline <= new DateTimeImmutable('now', new DateTimeZone('UTC'))) {
            throw new MetaApiError($reply['channel'] === 'private' ? PRIVATE_WINDOW_CLOSED : DM_WINDOW_CLOSED);
        }
        try {
            $result = $send($text, $buttons);
        } catch (MetaApiError $e) {
            // If Instagram refuses the buttons, send the options as text; typing one still counts as a tap.
            if (!$buttons) throw $e;
            $text = options_as_text($text, $buttons);
            $result = $send($text, null);
        }
        // Kept so a customer's reaction to this DM (message_reactions webhook) finds it.
        $externalId = isset($result['message_id']) ? (string) $result['message_id'] : (isset($result['id']) ? (string) $result['id'] : null);
        db()->prepare("UPDATE replies SET text = ?, status = 'sent', error = NULL, decidedBy = ?, sentAt = UTC_TIMESTAMP(), externalId = ? WHERE id = ?")->execute([$text, $operatorId, $externalId, $replyId]);
        return ['ok' => true];
    } catch (Throwable $e) {
        $message = $e instanceof MetaApiError ? $e->getMessage() : 'خطای داخلی هنگام ارسال';
        if (!$e instanceof MetaApiError) error_log('[Sepand] send failed: ' . $e->getMessage());
        db()->prepare("UPDATE replies SET text = ?, status = 'failed', error = ?, decidedBy = ? WHERE id = ?")->execute([$text, mb_substr($message, 0, 1000), $operatorId, $replyId]);
        return ['ok' => false, 'error' => $message];
    }
}

const DM_INVITE_TEXT = 'سلام {{username}}، لطفاً به دایرکت پیج پیام بدهید تا جواب‌تان را همان‌جا بفرستیم 🌹';

/** The operator sent this one by hand in the Instagram app; record it as sent without calling Meta. */
function mark_sent_manually(int $replyId, int $operatorId, ?string $editedText = null): void
{
    $reply = get_reply($replyId);
    if (!$reply) throw new ApiError('CONFLICT', 'پاسخ پیدا نشد');
    $text = trim($editedText ?? $reply['text']);
    if ($text === '') throw new ApiError('CONFLICT', 'متن پاسخ خالی است');
    if (!claim_reply($replyId, ['pending', 'failed'])) throw new ApiError('CONFLICT', 'این پاسخ قبلاً ارسال یا رد شده است');
    db()->prepare("UPDATE replies SET text = ?, status = 'sent', error = NULL, decidedBy = ?, sentAt = UTC_TIMESTAMP() WHERE id = ?")->execute([$text, $operatorId, $replyId]);
}

/**
 * Turns a private DM to a commenter into a reply under the comment (which has no deadline), by
 * default asking them to DM the page. It becomes the operator's own draft, so rule changes leave it.
 */
function move_to_public_reply(int $replyId, int $operatorId, ?string $editedText = null): void
{
    $reply = get_reply($replyId);
    if (!$reply) throw new ApiError('CONFLICT', 'پاسخ پیدا نشد');
    $event = get_event($reply['eventId']);
    if (!$event || $event['kind'] !== 'comment' || $reply['channel'] !== 'private') throw new ApiError('CONFLICT', 'فقط دایرکت به نویسندهٔ کامنت را می‌شود زیر کامنت فرستاد');
    $text = trim($editedText ?? render_template(DM_INVITE_TEXT, (string) ($event['username'] ?? '')));
    if ($text === '') throw new ApiError('CONFLICT', 'متن پاسخ خالی است');
    if (!claim_reply($replyId, ['pending', 'failed'])) throw new ApiError('CONFLICT', 'این پاسخ قبلاً ارسال یا رد شده است');
    db()->prepare("UPDATE replies SET channel = 'reply', source = 'manual', quickReplies = NULL, text = ?, status = 'pending', error = NULL, decidedBy = ? WHERE id = ?")
        ->execute([$text, $operatorId, $replyId]);
}

/** Puts our heart on a customer's DM, or takes it off. */
function react_to_event(int $eventId, bool $on): void
{
    $event = get_event($eventId);
    if (!$event || $event['kind'] !== 'dm') throw new ApiError('CONFLICT', 'فقط روی دایرکت می‌شود ریکشن گذاشت');
    with_account($event['accountId'], function () use ($event, $on) { react_to_message($event['senderId'], $event['externalId'], $on); });
    db()->prepare("UPDATE igEvents SET reaction = ? WHERE id = ?")->execute([$on ? 'love' : null, $eventId]);
}

/** Hides, shows again or deletes a customer's comment on Instagram. Deleting drops its pending drafts. */
function moderate_comment(int $eventId, string $action, int $operatorId): void
{
    $event = get_event($eventId);
    if (!$event || $event['kind'] !== 'comment') throw new ApiError('CONFLICT', 'فقط کامنت‌ها را می‌شود مخفی یا حذف کرد');
    if ($event['deleted']) throw new ApiError('CONFLICT', 'این کامنت قبلاً حذف شده است');
    if ($action === 'delete') {
        with_account($event['accountId'], function () use ($event) { delete_comment($event['externalId']); });
        db()->prepare("UPDATE igEvents SET deleted = 1 WHERE id = ?")->execute([$eventId]);
        db()->prepare("UPDATE replies SET status = 'rejected', decidedBy = ? WHERE eventId = ? AND status = 'pending'")->execute([$operatorId, $eventId]);
        return;
    }
    with_account($event['accountId'], function () use ($event, $action) { set_comment_hidden($event['externalId'], $action === 'hide'); });
    db()->prepare("UPDATE igEvents SET hidden = ? WHERE id = ?")->execute([$action === 'hide' ? 1 : 0, $eventId]);
}

/** message_reactions webhook: the customer reacted to (or un-reacted from) one of our DMs. */
function apply_customer_reactions(array $reactions): int
{
    $applied = 0;
    $stmt = db()->prepare("UPDATE replies SET customerReaction = ? WHERE externalId = ?");
    foreach ($reactions as $r) {
        $stmt->execute([$r['emoji'], $r['mid']]);
        $applied += $stmt->rowCount();
    }
    return $applied;
}

function reject_reply(int $replyId, int $operatorId): void
{
    if (!claim_reply($replyId, ['pending', 'failed'])) throw new ApiError('CONFLICT', 'این پاسخ قبلاً ارسال یا رد شده است');
    db()->prepare("UPDATE replies SET status = 'rejected', decidedBy = ? WHERE id = ?")->execute([$operatorId, $replyId]);
}

function send_manual_reply(int $eventId, string $text, int $operatorId): array
{
    $event = get_event($eventId);
    if (!$event) throw new ApiError('CONFLICT', 'پیام اصلی پیدا نشد');
    // "---" lines split the text into several messages (several replies under a comment, or
    // several DMs), sent in order; a failure stops the rest so they never arrive out of order.
    $result = ['ok' => false, 'error' => 'متن پاسخ خالی است'];
    foreach (split_messages($text) as $part) {
        $result = send_reply(create_reply($eventId, null, 'manual', $part, $operatorId), $operatorId);
        if (!$result['ok']) break;
    }
    if ($result['ok']) {
        // The operator answered this conversation directly; its in-place rule drafts are now stale.
        // Private-DM drafts for comments are a separate action and stay in the queue.
        $stmt = db()->prepare("SELECT r.id FROM replies r JOIN igEvents e ON e.id = r.eventId WHERE r.status = 'pending' AND r.channel = 'reply' AND e.accountId = ? AND e.kind = ? AND e.senderId = ?");
        $stmt->execute([$event['accountId'], $event['kind'], $event['senderId']]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $draftId) {
            if (claim_reply((int) $draftId, ['pending'])) {
                db()->prepare("UPDATE replies SET status = 'rejected', decidedBy = ? WHERE id = ?")->execute([$operatorId, $draftId]);
            }
        }
    }
    return $result;
}

function mark_read(string $accountId, string $kind, string $senderId): void
{
    db()->prepare("UPDATE igEvents SET isRead = true WHERE accountId = ? AND kind = ? AND senderId = ?")->execute([$accountId, $kind, $senderId]);
}

function display_name(array $event): string
{
    return $event['username'] ?: 'کاربر ' . substr($event['senderId'], -4);
}

function channel_of(string $kind): string
{
    return $kind === 'dm' ? 'DM' : 'کامنت';
}

/** @return callable(?int): array{tag:string,tone:string} */
function rule_style(array $rules): callable
{
    $index = [];
    foreach (array_values($rules) as $i => $rule) $index[$rule['id']] = $i;
    return function (?int $ruleId) use ($index, $rules): array {
        if ($ruleId === null || !isset($index[$ruleId])) return ['tag' => 'بدون قانون', 'tone' => 'slate'];
        $i = $index[$ruleId];
        return ['tag' => $rules[$i]['name'], 'tone' => TONES[$i % count(TONES)]];
    };
}

/** The active page's latest events, newest first. */
function recent_events(): array
{
    $args = [];
    $stmt = db()->prepare("SELECT * FROM igEvents WHERE " . page_events_sql('accountId', active_page(), $args) . " ORDER BY createdAt DESC, id DESC LIMIT " . THREAD_EVENT_LIMIT);
    $stmt->execute($args);
    return array_map('event_row', $stmt->fetchAll());
}

function replies_for_events(array $eventIds): array
{
    if (!$eventIds) return [];
    $placeholders = implode(',', array_fill(0, count($eventIds), '?'));
    $stmt = db()->prepare("SELECT * FROM replies WHERE eventId IN ($placeholders) ORDER BY createdAt, id");
    $stmt->execute($eventIds);
    return array_map('reply_row', $stmt->fetchAll());
}

function build_threads(): array
{
    $events = recent_events();
    $style = rule_style(list_rules());
    $byEvent = [];
    foreach (replies_for_events(array_column($events, 'id')) as $reply) $byEvent[$reply['eventId']][] = $reply;

    $threads = [];
    // Oldest first, so messages are chronological and the latest event sets the header.
    foreach (array_reverse($events) as $event) {
        $id = $event['kind'] . ':' . $event['senderId'];
        $prev = $threads[$id] ?? null;
        $name = $event['username'] ? display_name($event) : ($prev['name'] ?? display_name($event));
        $style_ = $style($event['ruleId']);
        $thread = [
            'id' => $id,
            'kind' => $event['kind'],
            'channel' => channel_of($event['kind']),
            'senderId' => $event['senderId'],
            'name' => $name,
            'handle' => $event['username'] ?? ($prev['handle'] ?? $event['senderId']),
            'avatar' => mb_substr($name, 0, 1),
            'message' => $event['text'],
            'updatedAt' => $event['createdAt'],
            'tag' => $style_['tag'],
            'tagTone' => $style_['tone'],
            'unread' => ($prev['unread'] ?? false) || !$event['isRead'],
            'priority' => $prev['priority'] ?? false,
            'lastEventId' => $event['id'],
            'messages' => $prev['messages'] ?? [],
        ];
        $thread['messages'][] = ['id' => 'e' . $event['id'], 'from' => 'contact', 'text' => $event['text'], 'at' => $event['createdAt'], 'mediaId' => $event['mediaId'],
            'eventId' => $event['id'], 'reaction' => $event['reaction'], 'hidden' => $event['hidden'], 'deleted' => $event['deleted']];
        foreach ($byEvent[$event['id']] ?? [] as $reply) {
            if ($reply['status'] === 'pending') $thread['priority'] = true;
            if ($reply['status'] === 'pending' || $reply['status'] === 'rejected') continue; // drafts live in the approval queue
            $message = ['id' => 'r' . $reply['id'], 'from' => 'agent', 'text' => $reply['text'], 'at' => $reply['sentAt'] ?? $reply['createdAt'], 'status' => $reply['status'], 'error' => $reply['error'],
                'customerReaction' => $reply['customerReaction']];
            if ($reply['channel'] === 'private') $message['via'] = 'dm';
            $thread['messages'][] = $message;
        }
        unset($threads[$id]); // re-insert so the most recent thread ends up last
        $threads[$id] = $thread;
    }
    return array_reverse(array_values($threads));
}

function list_approvals(): array
{
    $style = rule_style(list_rules());
    $args = [];
    $stmt = db()->prepare("SELECT r.*, e.kind, e.senderId, e.username, e.mediaId, e.text AS incoming, e.createdAt AS receivedAt,
        EXISTS(SELECT 1 FROM replies s WHERE s.eventId = r.eventId AND s.status = 'sent') AS answered,
        (SELECT MAX(d.createdAt) FROM igEvents d WHERE d.kind = 'dm' AND d.accountId = e.accountId AND d.senderId = e.senderId) AS lastDmAt
        FROM replies r JOIN igEvents e ON e.id = r.eventId
        WHERE r.status IN ('pending', 'failed') AND " . page_events_sql('e.accountId', active_page(), $args) . " ORDER BY r.createdAt, r.id");
    $stmt->execute($args);
    $rows = $stmt->fetchAll();
    $items = [];
    foreach ($rows as $row) {
        $reply = reply_row($row);
        if ($reply['status'] === 'sending') continue; // a Telegram reply already approved, waiting for the bridge
        $s = $style($reply['ruleId']);
        $items[] = [
            'id' => $reply['id'],
            'threadId' => $row['kind'] . ':' . $row['senderId'],
            'channel' => channel_of($row['kind']),
            'name' => display_name(['username' => $row['username'], 'senderId' => $row['senderId']]),
            'handle' => $row['username'] ?? $row['senderId'],
            'incoming' => $row['incoming'],
            'draft' => $reply['text'],
            'reason' => $reply['source'] === 'manual' ? 'پاسخ دستی' : $s['tag'],
            'replyChannel' => $reply['channel'],
            'buttons' => array_column($reply['quickReplies'] ?? [], 'title'),
            'receivedAt' => db_time($row['receivedAt']),
            'answered' => (bool) $row['answered'],
            'expiresAt' => reply_deadline($row['kind'], $reply['channel'], $row['kind'] === 'dm' && $row['lastDmAt'] && db_time($row['lastDmAt']) > db_time($row['receivedAt']) ? db_time($row['lastDmAt']) : db_time($row['receivedAt'])),
            'mediaId' => $row['mediaId'],
            'tone' => $s['tone'],
            'status' => $reply['status'],
            'error' => $reply['error'],
            'createdAt' => $reply['createdAt'],
        ];
    }
    return $items;
}

function inbox_stats(): array
{
    $threads = build_threads();
    $events = recent_events();
    $replies = replies_for_events(array_column($events, 'id'));
    $sent = array_values(array_filter($replies, function ($r) { return $r['status'] === 'sent'; }));

    // Day buckets follow Tehran time, which is what the team reads the dashboard in.
    $tz = new DateTimeZone('Asia/Tehran');
    $today = (new DateTimeImmutable('now', $tz))->setTime(0, 0);
    $days = [];
    for ($i = 6; $i >= 0; $i--) $days[] = ['date' => $today->modify("-$i days"), 'dm' => 0, 'comment' => 0];
    foreach ($events as $event) {
        $index = (int) floor(($event['createdAt']->getTimestamp() - $days[0]['date']->getTimestamp()) / 86400);
        if ($index >= 0 && $index < 7) $days[$index][$event['kind']]++;
    }

    $created = [];
    foreach ($events as $event) $created[$event['id']] = $event['createdAt']->getTimestamp();
    $firstSent = [];
    foreach ($sent as $reply) {
        $at = ($reply['sentAt'] ?? $reply['createdAt'])->getTimestamp();
        $firstSent[$reply['eventId']] = min($firstSent[$reply['eventId']] ?? $at, $at);
    }
    $waits = [];
    foreach ($firstSent as $eventId => $at) $waits[] = $at - ($created[$eventId] ?? $at);

    $count = function (array $list, callable $fn): int { return count(array_filter($list, $fn)); };
    return [
        'threads' => count($threads),
        'unread' => $count($threads, function ($t) { return $t['unread']; }),
        'pending' => $count($replies, function ($r) { return $r['status'] === 'pending'; }),
        'failed' => $count($replies, function ($r) { return $r['status'] === 'failed'; }),
        'sent' => count($sent),
        'autoSent' => $count($sent, function ($r) { return $r['source'] === 'rule' && $r['decidedBy'] === null; }),
        'dm' => $count($events, function ($e) { return $e['kind'] === 'dm'; }),
        'comment' => $count($events, function ($e) { return $e['kind'] === 'comment'; }),
        'days' => $days,
        'avgResponseMinutes' => $waits ? (int) round(array_sum($waits) / count($waits) / 60) : null,
    ];
}

// --- posts --------------------------------------------------------------------------------------

function sync_posts(): array
{
    $media = list_recent_media();
    $stmt = db()->prepare("INSERT INTO igMedia (accountId, id, caption, mediaType, mediaUrl, thumbnailUrl, permalink, postedAt, commentsCount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE accountId = COALESCE(VALUES(accountId), accountId), caption = VALUES(caption), mediaType = VALUES(mediaType), mediaUrl = VALUES(mediaUrl), thumbnailUrl = VALUES(thumbnailUrl),
        permalink = VALUES(permalink), postedAt = VALUES(postedAt), commentsCount = VALUES(commentsCount)");
    foreach ($media as $m) {
        $stmt->execute([active_page(), $m['id'], $m['caption'], $m['mediaType'], $m['mediaUrl'], $m['thumbnailUrl'], $m['permalink'], $m['postedAt'], $m['commentsCount']]);
    }
    return ['synced' => count($media)];
}

function blank_post(string $id): array
{
    return ['id' => $id, 'caption' => null, 'mediaType' => null, 'imageUrl' => null, 'permalink' => null, 'postedAt' => null,
        'comments' => 0, 'igComments' => null, 'pending' => 0, 'repliesSent' => 0, 'dmsSent' => 0, 'rules' => 0, 'synced' => false];
}

function list_posts(): array
{
    $pdo = db();
    $page = active_page();
    $posts = [];
    $args = [];
    $stmt = $pdo->prepare("SELECT * FROM igMedia WHERE " . page_rows_sql('accountId', $page, $args) . " ORDER BY postedAt DESC");
    $stmt->execute($args);
    foreach ($stmt->fetchAll() as $m) {
        $posts[$m['id']] = ['caption' => $m['caption'], 'mediaType' => $m['mediaType'], 'imageUrl' => $m['thumbnailUrl'] ?: $m['mediaUrl'],
            'permalink' => $m['permalink'], 'postedAt' => db_time($m['postedAt']),
            'igComments' => $m['commentsCount'] === null ? null : (int) $m['commentsCount'], 'synced' => true] + blank_post($m['id']);
    }
    // Comments can arrive for posts that were never synced; list them anyway.
    $args = [];
    $stmt = $pdo->prepare("SELECT mediaId, COUNT(*) n FROM igEvents WHERE kind = 'comment' AND mediaId IS NOT NULL AND " . page_events_sql('accountId', $page, $args) . " GROUP BY mediaId");
    $stmt->execute($args);
    foreach ($stmt->fetchAll() as $row) {
        if (!isset($posts[$row['mediaId']])) $posts[$row['mediaId']] = blank_post($row['mediaId']);
        $posts[$row['mediaId']]['comments'] = (int) $row['n'];
    }
    $args = [];
    $stmt = $pdo->prepare("SELECT e.mediaId, r.status, r.channel, COUNT(*) n FROM replies r JOIN igEvents e ON e.id = r.eventId
        WHERE e.kind = 'comment' AND e.mediaId IS NOT NULL AND " . page_events_sql('e.accountId', $page, $args) . " GROUP BY e.mediaId, r.status, r.channel");
    $stmt->execute($args);
    $stats = $stmt->fetchAll();
    foreach ($stats as $row) {
        if (!isset($posts[$row['mediaId']])) continue;
        $n = (int) $row['n'];
        if ($row['status'] === 'pending') $posts[$row['mediaId']]['pending'] += $n;
        if ($row['status'] === 'sent') $posts[$row['mediaId']][$row['channel'] === 'private' ? 'dmsSent' : 'repliesSent'] += $n;
    }
    foreach (list_rules() as $rule) foreach ($rule['mediaIds'] ?? [] as $id) if (isset($posts[$id])) $posts[$id]['rules']++;
    $list = array_values($posts);
    usort($list, function ($a, $b) {
        $ta = $a['postedAt'] ? $a['postedAt']->getTimestamp() : PHP_INT_MAX;
        $tb = $b['postedAt'] ? $b['postedAt']->getTimestamp() : PHP_INT_MAX;
        return $tb <=> $ta;
    });
    return $list;
}

/** Every comment on a post with its public reply and private DM, newest first. */
function post_comments(string $mediaId): array
{
    $style = rule_style(list_rules());
    $args = [$mediaId];
    $stmt = db()->prepare("SELECT * FROM igEvents WHERE kind = 'comment' AND mediaId = ? AND " . page_events_sql('accountId', active_page(), $args) . " ORDER BY createdAt DESC, id DESC LIMIT " . THREAD_EVENT_LIMIT);
    $stmt->execute($args);
    $events = array_map('event_row', $stmt->fetchAll());
    $byEvent = [];
    foreach (replies_for_events(array_column($events, 'id')) as $reply) {
        if ($reply['status'] !== 'rejected') $byEvent[$reply['eventId']][] = $reply;
    }
    $out = [];
    foreach ($events as $e) {
        $s = $style($e['ruleId']);
        $out[] = [
            'eventId' => $e['id'], 'threadId' => 'comment:' . $e['senderId'], 'username' => display_name($e), 'text' => $e['text'], 'at' => $e['createdAt'],
            'rule' => $s['tag'], 'tone' => $s['tone'],
            'replies' => array_map(function ($r) {
                return ['id' => $r['id'], 'channel' => $r['channel'], 'text' => $r['text'], 'status' => $r['status'], 'error' => $r['error'], 'source' => $r['source']];
            }, $byEvent[$e['id']] ?? []),
        ];
    }
    return $out;
}

/** Imports a post's existing comments. Rules draft replies, but old comments always wait for approval. */
/**
 * Reads one slice of a post's comments (pass $after = the previous 'next' to continue, until it is
 * null) and stores the new ones, threaded replies from customers included. Comments that already
 * have our reply on Instagram, from this app or the Instagram app itself, are recorded as answered,
 * so no draft is made for them and stale public drafts are dropped.
 */
function import_post_comments(string $mediaId, string $accountId, bool $draft = true, bool $read = false, ?string $after = null): array
{
    $page = list_media_comments($mediaId, $after);
    $comments = $page['comments'];
    // Meta can leave out a comment's author; then the account's own comments are recognised by username.
    $anyUnknown = false;
    foreach ($comments as $c) {
        if ($c['fromId'] === null) $anyUnknown = true;
        foreach ($c['replies'] as $r) if ($r['fromId'] === null) $anyUnknown = true;
    }
    $ownName = $anyUnknown ? own_username() : null;
    $isOwn = function (array $c) use ($accountId, $ownName): bool {
        return ($c['fromId'] !== null && $c['fromId'] === $accountId) || ($ownName !== null && $c['username'] === $ownName);
    };
    $toEvent = function (array $c) use ($accountId, $mediaId): array {
        // Replies and private DMs only need the comment id, so an unknown author is no reason to skip.
        $senderId = $c['fromId'] ?? ($c['username'] !== null ? 'u:' . $c['username'] : 'c:' . $c['id']);
        return ['accountId' => $accountId, 'kind' => 'comment', 'externalId' => $c['id'], 'senderId' => $senderId, 'username' => $c['username'],
            'text' => $c['text'], 'mediaId' => $mediaId, 'at' => $c['at']];
    };
    $open = [];
    $answered = [];
    $skippedOwn = 0;
    $fetched = 0;
    foreach ($comments as $c) {
        $thread = array_merge([$c], $c['replies']);
        foreach ($thread as $i => $m) {
            // Our own replies in a thread are answers, not comments to count or skip.
            if ($isOwn($m)) { if ($i === 0) { $skippedOwn++; $fetched++; } continue; }
            $fetched++;
            // Our own reply anywhere after a message in the thread answers it.
            $answer = null;
            foreach (array_slice($thread, $i + 1) as $later) if ($isOwn($later)) { $answer = $later; break; }
            if ($answer) $answered[] = ['event' => $toEvent($m), 'answer' => $answer];
            else $open[] = $toEvent($m);
        }
    }
    $fresh = ingest_events($open, false, $draft, $read);
    $known = ingest_events(array_column($answered, 'event'), false, false, $read);
    $marked = 0;
    $pdo = db();
    $find = $pdo->prepare("SELECT id, createdAt FROM igEvents WHERE accountId = ? AND kind = 'comment' AND externalId = ?");
    foreach ($answered as $a) {
        $find->execute([$accountId, $a['event']['externalId']]);
        $row = $find->fetch();
        if (!$row) continue;
        $eventId = (int) $row['id'];
        // Drafts for a comment that was answered on Instagram would answer it twice.
        $pdo->prepare("UPDATE replies SET status = 'rejected' WHERE eventId = ? AND status = 'pending' AND channel = 'reply'")->execute([$eventId]);
        $sent = $pdo->prepare("SELECT COUNT(*) FROM replies WHERE eventId = ? AND channel = 'reply' AND status = 'sent'");
        $sent->execute([$eventId]);
        if ((int) $sent->fetchColumn() > 0) continue;
        $pdo->prepare("INSERT INTO replies (eventId, source, channel, text, status, externalId, sentAt) VALUES (?, 'manual', 'reply', ?, 'sent', ?, ?)")
            ->execute([$eventId, $a['answer']['text'], $a['answer']['id'], $a['answer']['at'] ?? $row['createdAt']]);
        $marked++;
    }
    return ['fetched' => $fetched, 'imported' => $fresh['stored'] + $known['stored'], 'alreadyThere' => $fresh['duplicates'] + $known['duplicates'],
        'own' => $skippedOwn, 'answered' => $marked, 'next' => $page['next']];
}

/** Posts whose comments the history import reads; each one is a Graph call. */
const HISTORY_POSTS = 12;

/**
 * Fills the inbox with what happened before the webhook worked: comments on recent posts and recent
 * DMs. Nothing is drafted or sent; "apply rules to unanswered" does that on request.
 * 'hidden' counts comments Instagram reports but won't return, which is what Meta does for people
 * without a role on the app while it is in Development mode.
 */
function import_history(string $accountId): array
{
    @set_time_limit(120);
    // Without this subscription Meta sends no new events either.
    try {
        if (get_webhook_subscription()['missing']) subscribe_webhooks();
    } catch (MetaApiError $e) {
        // Facebook Login tokens subscribe through the Page; nothing to do here.
    }

    sync_posts();
    $args = [];
    $stmt = db()->prepare("SELECT id, commentsCount FROM igMedia WHERE commentsCount > 0 AND " . page_rows_sql('accountId', active_page(), $args) . " ORDER BY postedAt DESC LIMIT " . HISTORY_POSTS);
    $stmt->execute($args);
    $posts = $stmt->fetchAll();
    $comments = ['posts' => count($posts), 'reported' => 0, 'fetched' => 0, 'imported' => 0, 'hidden' => 0, 'more' => 0];
    foreach ($posts as $post) {
        $result = import_post_comments($post['id'], $accountId, false, true);
        $comments['reported'] += (int) $post['commentsCount'];
        $comments['fetched'] += $result['fetched'];
        $comments['imported'] += $result['imported'];
        if (!$result['fetched']) $comments['hidden'] += (int) $post['commentsCount'];
        if ($result['next']) $comments['more']++;
    }

    $dms = ['fetched' => 0, 'imported' => 0, 'error' => null];
    try {
        $own = own_username();
        $events = [];
        foreach (list_recent_messages() as $m) {
            if ($m['fromId'] === $accountId || ($own !== null && $m['username'] === $own)) continue;
            $events[] = ['accountId' => $accountId, 'kind' => 'dm', 'externalId' => $m['id'], 'senderId' => $m['fromId'], 'username' => $m['username'],
                'text' => $m['text'], 'mediaId' => null, 'at' => $m['at']];
        }
        $result = ingest_events($events, false, false, true);
        $dms['fetched'] = count($events);
        $dms['imported'] = $result['stored'];
    } catch (MetaApiError $e) {
        $dms['error'] = $e->getMessage();
    }
    return ['comments' => $comments, 'dms' => $dms];
}
