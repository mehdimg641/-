<?php
/** Inbox events, reply drafts, sending and the dashboard views; mirrors server/inboxService.ts. */

declare(strict_types=1);

const TONES = ['orange', 'gold', 'blue', 'green', 'violet'];
const THREAD_EVENT_LIMIT = 2000;

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
        'createdAt' => db_time($row['createdAt']),
    ];
}

function reply_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'eventId' => (int) $row['eventId'],
        'ruleId' => $row['ruleId'] === null ? null : (int) $row['ruleId'],
        'source' => $row['source'],
        'text' => $row['text'],
        'status' => $row['status'],
        'error' => $row['error'],
        'decidedBy' => $row['decidedBy'] === null ? null : (int) $row['decidedBy'],
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

function create_reply(int $eventId, ?int $ruleId, string $source, string $text, ?int $decidedBy = null): int
{
    db()->prepare("INSERT INTO replies (eventId, ruleId, source, text, status, decidedBy) VALUES (?, ?, ?, ?, 'pending', ?)")
        ->execute([$eventId, $ruleId, $source, $text, $decidedBy]);
    return (int) db()->lastInsertId();
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
function ingest_events(array $events): array
{
    if (!$events) return ['stored' => 0, 'duplicates' => 0, 'toSend' => []];
    $rules = list_rules();
    $pdo = db();
    $result = ['stored' => 0, 'duplicates' => 0, 'toSend' => []];
    $insert = $pdo->prepare("INSERT IGNORE INTO igEvents (accountId, kind, externalId, senderId, username, text, mediaId, ruleId) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    foreach ($events as $e) {
        $decision = decide_reply($rules, $e['kind'], (string) ($e['username'] ?? ''), $e['text']);
        $insert->execute([$e['accountId'], $e['kind'], $e['externalId'], $e['senderId'], $e['username'], $e['text'], $e['mediaId'], $decision ? $decision['rule']['id'] : null]);
        if ($insert->rowCount() === 0) {
            $result['duplicates']++;
            continue;
        }
        $result['stored']++;
        if (!$decision) continue;
        $replyId = create_reply((int) $pdo->lastInsertId(), $decision['rule']['id'], 'rule', $decision['message']);
        if (auto_reply_enabled() && $decision['rule']['action'] === 'send') $result['toSend'][] = $replyId;
    }
    return $result;
}

function send_reply(int $replyId, ?int $operatorId, ?string $editedText = null): array
{
    $reply = get_reply($replyId);
    if (!$reply) throw new ApiError('CONFLICT', 'پاسخ پیدا نشد');
    $event = get_event($reply['eventId']);
    if (!$event) throw new ApiError('CONFLICT', 'پیام اصلی پیدا نشد');
    if (!claim_reply($replyId, ['pending', 'failed'])) throw new ApiError('CONFLICT', 'این پاسخ قبلاً ارسال یا رد شده است');

    $text = trim($editedText ?? $reply['text']);
    try {
        if ($text === '') throw new MetaApiError('متن پاسخ خالی است');
        if ($event['kind'] === 'comment') reply_to_comment($event['externalId'], $text);
        else send_direct_message($event['senderId'], $text);
        db()->prepare("UPDATE replies SET text = ?, status = 'sent', error = NULL, decidedBy = ?, sentAt = UTC_TIMESTAMP() WHERE id = ?")->execute([$text, $operatorId, $replyId]);
        return ['ok' => true];
    } catch (Throwable $e) {
        $message = $e instanceof MetaApiError ? $e->getMessage() : 'خطای داخلی هنگام ارسال';
        if (!$e instanceof MetaApiError) error_log('[Sepand] send failed: ' . $e->getMessage());
        db()->prepare("UPDATE replies SET text = ?, status = 'failed', error = ?, decidedBy = ? WHERE id = ?")->execute([$text, mb_substr($message, 0, 1000), $operatorId, $replyId]);
        return ['ok' => false, 'error' => $message];
    }
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
    $result = send_reply(create_reply($eventId, null, 'manual', $text, $operatorId), $operatorId);
    if ($result['ok']) {
        // The operator answered this conversation directly; its rule drafts are now stale.
        $stmt = db()->prepare("SELECT r.id FROM replies r JOIN igEvents e ON e.id = r.eventId WHERE r.status = 'pending' AND e.kind = ? AND e.senderId = ?");
        $stmt->execute([$event['kind'], $event['senderId']]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $draftId) {
            if (claim_reply((int) $draftId, ['pending'])) {
                db()->prepare("UPDATE replies SET status = 'rejected', decidedBy = ? WHERE id = ?")->execute([$operatorId, $draftId]);
            }
        }
    }
    return $result;
}

function mark_read(string $kind, string $senderId): void
{
    db()->prepare("UPDATE igEvents SET isRead = true WHERE kind = ? AND senderId = ?")->execute([$kind, $senderId]);
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

function recent_events(): array
{
    $rows = db()->query("SELECT * FROM igEvents ORDER BY createdAt DESC, id DESC LIMIT " . THREAD_EVENT_LIMIT)->fetchAll();
    return array_map('event_row', $rows);
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
        $thread['messages'][] = ['id' => 'e' . $event['id'], 'from' => 'contact', 'text' => $event['text'], 'at' => $event['createdAt']];
        foreach ($byEvent[$event['id']] ?? [] as $reply) {
            if ($reply['status'] === 'pending') $thread['priority'] = true;
            if ($reply['status'] === 'pending' || $reply['status'] === 'rejected') continue; // drafts live in the approval queue
            $thread['messages'][] = ['id' => 'r' . $reply['id'], 'from' => 'agent', 'text' => $reply['text'], 'at' => $reply['sentAt'] ?? $reply['createdAt'], 'status' => $reply['status'], 'error' => $reply['error']];
        }
        unset($threads[$id]); // re-insert so the most recent thread ends up last
        $threads[$id] = $thread;
    }
    return array_reverse(array_values($threads));
}

function list_approvals(): array
{
    $style = rule_style(list_rules());
    $rows = db()->query("SELECT r.*, e.kind, e.senderId, e.username, e.text AS incoming FROM replies r JOIN igEvents e ON e.id = r.eventId
        WHERE r.status IN ('pending', 'failed') ORDER BY r.createdAt, r.id")->fetchAll();
    $items = [];
    foreach ($rows as $row) {
        $reply = reply_row($row);
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
