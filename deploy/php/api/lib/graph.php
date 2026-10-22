<?php
/**
 * Calls to Meta. Instagram Login tokens ("IGAA…") use graph.instagram.com;
 * Facebook Login page tokens ("EAA…") use graph.facebook.com.
 */

declare(strict_types=1);

class MetaApiError extends Exception {}

function meta_api_host(): string
{
    return strpos(meta_setting('META_ACCESS_TOKEN'), 'EAA') === 0 ? 'facebook' : 'instagram';
}

function graph_base(): string
{
    $host = meta_api_host();
    return "https://graph.$host.com/" . ($host === 'instagram' ? 'v23.0' : 'v21.0');
}

/** Meta ids can exceed PHP_INT_MAX on 32-bit hosts; keep long integers as strings. */
function parse_graph_json(string $text): array
{
    $decoded = json_decode($text, true, 512, JSON_BIGINT_AS_STRING);
    return is_array($decoded) ? $decoded : [];
}

function graph_request(string $method, string $path, ?array $body = null): array
{
    $token = meta_setting('META_ACCESS_TOKEN');
    if ($token === '') throw new MetaApiError('توکن دسترسی اینستاگرام تنظیم نشده است (تنظیمات → اتصال اینستاگرام)');
    $url = graph_base() . $path;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Authorization: Bearer ' . $token],
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $text = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    if ($text === false) {
        $host = parse_url($url, PHP_URL_HOST);
        throw new MetaApiError("ارتباط سرور با $host برقرار نشد ($error)");
    }
    $data = parse_graph_json((string) $text);
    if ($status < 200 || $status >= 300) {
        throw new MetaApiError(describe_meta_error($status, ($data['error'] ?? []) + ['message' => substr((string) $text, 0, 300)]));
    }
    return $data;
}

/**
 * Meta's error in Persian for the cases an operator can act on, keeping Meta's own text, code and
 * trace id after it so an unknown failure can still be looked up.
 */
function describe_meta_error(int $status, array $error): string
{
    $message = (string) ($error['message'] ?? '');
    $code = isset($error['code']) ? (int) $error['code'] : null;
    $subcode = isset($error['error_subcode']) ? (int) $error['error_subcode'] : null;
    if ($subcode === 2534022 || ($code === 10 && stripos($message, 'allowed window') !== false)) {
        return 'مهلت ارسال اینستاگرام گذشته (دایرکت: ۲۴ ساعت بعد از آخرین پیام مشتری؛ دایرکت به نویسندهٔ کامنت: ۷ روز بعد از کامنت).';
    }
    $hint = '';
    if ($subcode === 2534025) $hint = 'این کامنت قابل پاسخ خصوصی نیست (قبلاً دایرکت گرفته، یا مال یک صفحهٔ دیگر است).';
    elseif ($code === 551 || $subcode === 1545041) $hint = 'این کاربر در دسترس نیست (پیج را مسدود کرده یا تنظیمات حریم خصوصی‌اش اجازه نمی‌دهد).';
    elseif ($subcode === 33 || preg_match('/does not exist|cannot be loaded/i', $message)) $hint = 'این کامنت یا پیام دیگر وجود ندارد (احتمالاً حذف شده) یا با این توکن قابل دسترسی نیست.';
    elseif ($code === 190) $hint = 'توکن اینستاگرام نامعتبر یا منقضی شده؛ در تنظیمات توکن جدید بگذارید.';
    elseif (in_array($code, [4, 17, 32, 613], true)) $hint = 'محدودیت تعداد درخواست اینستاگرام؛ چند دقیقه بعد دوباره امتحان کنید.';
    elseif ($code === 1 || $code === 2 || $status >= 500) $hint = 'خطای موقت سرور اینستاگرام؛ چند دقیقه بعد دوباره امتحان کنید.';
    $details = array_filter([
        $code !== null ? 'کد ' . $code . ($subcode ? '/' . $subcode : '') : '',
        !empty($error['fbtrace_id']) ? 'trace ' . $error['fbtrace_id'] : '',
    ]);
    $raw = "Meta API $status: " . (!empty($error['error_user_msg']) ? $error['error_user_msg'] : $message) . ($details ? ' (' . implode(' · ', $details) . ')' : '');
    return $hint !== '' ? "$hint — $raw" : $raw;
}

function reply_to_comment(string $commentId, string $message): array
{
    return graph_request('POST', '/' . rawurlencode($commentId) . '/replies', ['message' => $message]);
}

/** Meta only allows DM replies within 24 hours of the user's last message. */
function with_quick_replies(string $text, ?array $quickReplies): array
{
    if (!$quickReplies) return ['text' => $text];
    return ['text' => $text, 'quick_replies' => array_map(function ($q) {
        return ['content_type' => 'text', 'title' => $q['title'], 'payload' => $q['payload']];
    }, $quickReplies)];
}

function send_direct_message(string $recipientId, string $text, ?array $quickReplies = null): array
{
    return graph_request('POST', '/me/messages', ['recipient' => ['id' => $recipientId], 'message' => with_quick_replies($text, $quickReplies)]);
}

function test_meta_connection(): array
{
    $host = meta_api_host();
    try {
        if ($host === 'instagram') {
            $me = graph_request('GET', '/me?fields=user_id,username');
            if (empty($me['user_id'])) return ['ok' => false, 'host' => $host, 'error' => 'Meta شناسهٔ حساب را برنگرداند'];
            return ['ok' => true, 'host' => $host, 'accounts' => [['id' => (string) $me['user_id'], 'username' => (string) ($me['username'] ?? '')]]];
        }
        $pages = graph_request('GET', '/me/accounts?fields=name,instagram_business_account{id,username}');
        $accounts = [];
        foreach ($pages['data'] ?? [] as $page) {
            $ig = $page['instagram_business_account'] ?? null;
            if (!empty($ig['id'])) $accounts[] = ['id' => (string) $ig['id'], 'username' => (string) ($ig['username'] ?? '')];
        }
        if (!$accounts) return ['ok' => false, 'host' => $host, 'error' => 'هیچ حساب اینستاگرام حرفه‌ای به صفحه‌های این توکن وصل نیست'];
        return ['ok' => true, 'host' => $host, 'accounts' => $accounts];
    } catch (MetaApiError $e) {
        return ['ok' => false, 'host' => $host, 'error' => $e->getMessage()];
    }
}

/** DM to the author of a comment (Instagram "private reply"); once per comment, within 7 days. */
/** Puts a heart on (or takes it off) a customer's DM. Instagram only sends the "love" reaction. */
function react_to_message(string $recipientId, string $messageId, bool $on): array
{
    return graph_request('POST', '/me/messages', [
        'recipient' => ['id' => $recipientId],
        'sender_action' => $on ? 'react' : 'unreact',
        'payload' => $on ? ['message_id' => $messageId, 'reaction' => 'love'] : ['message_id' => $messageId],
    ]);
}

/** Hides (or shows again) a comment under one of our posts. A hidden comment can't be replied to. */
function set_comment_hidden(string $commentId, bool $hidden): array
{
    return graph_request('POST', '/' . rawurlencode($commentId), ['hide' => $hidden]);
}

/** Deletes a comment under one of our posts on Instagram. */
function delete_comment(string $commentId): array
{
    return graph_request('DELETE', '/' . rawurlencode($commentId));
}

function send_private_reply(string $commentId, string $text, ?array $quickReplies = null): array
{
    return graph_request('POST', '/me/messages', ['recipient' => ['comment_id' => $commentId], 'message' => with_quick_replies($text, $quickReplies)]);
}

function media_owner(): string
{
    if (meta_api_host() === 'instagram') return 'me';
    $ids = allowed_account_ids();
    if (!$ids) throw new MetaApiError('ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید (تست اتصال آن را پر می‌کند)');
    return rawurlencode($ids[0]);
}

const WEBHOOK_FIELDS = ['comments', 'messages'];
/** Wanted but not required: customers' reactions to our DMs. */
const OPTIONAL_WEBHOOK_FIELDS = ['message_reactions'];

function require_instagram_login(): void
{
    if (meta_api_host() !== 'instagram') {
        throw new MetaApiError('این بخش فقط برای توکن Instagram Login (IGAA…) است؛ در Facebook Login اشتراک از تنظیمات صفحه انجام می‌شود');
    }
}

/** Which webhook fields Meta delivers for this account. Without a subscription no event arrives. */
function get_webhook_subscription(): array
{
    require_instagram_login();
    $result = graph_request('GET', '/me/subscribed_apps');
    $fields = [];
    foreach ($result['data'] ?? [] as $app) foreach ($app['subscribed_fields'] ?? [] as $f) $fields[(string) $f] = true;
    $fields = array_keys($fields);
    return ['fields' => $fields, 'missing' => array_values(array_diff(WEBHOOK_FIELDS, $fields))];
}

/** Asks Meta to deliver comment and message events for this account to the app's webhook. */
function subscribe_webhooks(): array
{
    require_instagram_login();
    try {
        graph_request('POST', '/me/subscribed_apps?subscribed_fields=' . implode(',', array_merge(WEBHOOK_FIELDS, OPTIONAL_WEBHOOK_FIELDS)));
    } catch (MetaApiError $e) {
        // An optional field Meta refuses must not cost us comments and messages.
        graph_request('POST', '/me/subscribed_apps?subscribed_fields=' . implode(',', WEBHOOK_FIELDS));
    }
    return get_webhook_subscription();
}

/** The connected account's username, or null if Meta won't say. */
function own_username(): ?string
{
    try {
        $me = graph_request('GET', '/' . media_owner() . '?fields=username');
        return isset($me['username']) ? (string) $me['username'] : null;
    } catch (MetaApiError $e) {
        return null;
    }
}

/** Follows cursor pagination up to $maxPages. */
/** Follows cursor pagination up to $maxPages, from $after if given; 'next' resumes where it stopped. */
function graph_pages(string $path, int $maxPages, ?string $after = null): array
{
    $items = [];
    for ($page = 0; $page < $maxPages; $page++) {
        $sep = strpos($path, '?') === false ? '?' : '&';
        $result = graph_request('GET', $after ? $path . $sep . 'after=' . rawurlencode($after) : $path);
        foreach ($result['data'] ?? [] as $item) $items[] = $item;
        $after = !empty($result['paging']['next']) ? ($result['paging']['cursors']['after'] ?? null) : null;
        if (!$after) break;
    }
    return ['items' => $items, 'next' => $after ?: null];
}

function graph_list(string $path, int $maxPages): array
{
    return graph_pages($path, $maxPages)['items'];
}

function list_recent_media(): array
{
    $media = graph_list('/' . media_owner() . '/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,comments_count&limit=50', 2);
    return array_map(function ($m) {
        $posted = null;
        if (!empty($m['timestamp'])) $posted = (new DateTimeImmutable((string) $m['timestamp']))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
        return ['id' => (string) $m['id'], 'caption' => $m['caption'] ?? null, 'mediaType' => $m['media_type'] ?? null, 'mediaUrl' => $m['media_url'] ?? null,
            'thumbnailUrl' => $m['thumbnail_url'] ?? null, 'permalink' => $m['permalink'] ?? null, 'postedAt' => $posted,
            'commentsCount' => isset($m['comments_count']) ? (int) $m['comments_count'] : null];
    }, $media);
}

/** Pages per call: 4 × 50 comments keeps one request well under the host's gateway timeout. */
const COMMENT_PAGES_PER_CALL = 4;

/** One slice of a post's comments with their threads; pass 'next' back for the following slice. */
function list_media_comments(string $mediaId, ?string $after = null): array
{
    $base = 'id,text,timestamp,username,from';
    $read = function (string $fields) use ($mediaId, $after) {
        return graph_pages('/' . rawurlencode($mediaId) . '/comments?fields=' . rawurlencode($fields) . '&limit=50', COMMENT_PAGES_PER_CALL, $after);
    };
    try {
        $page = $read($base . ',replies.limit(50){' . $base . '}');
    } catch (MetaApiError $e) {
        // Without the threads we can't tell which comments were answered, but the comments still come in.
        $page = $read($base);
    }
    $shape = function (array $c): array {
        return ['id' => (string) $c['id'], 'text' => (string) $c['text'], 'username' => $c['from']['username'] ?? ($c['username'] ?? null),
            'fromId' => isset($c['from']['id']) ? (string) $c['from']['id'] : null, 'at' => graph_time($c['timestamp'] ?? null)];
    };
    $out = [];
    foreach ($page['items'] as $c) {
        if (empty($c['text'])) continue;
        $replies = [];
        foreach ($c['replies']['data'] ?? [] as $r) if (!empty($r['text'])) $replies[] = $shape($r);
        usort($replies, function ($a, $b) { return strcmp((string) $a['at'], (string) $b['at']); });
        $out[] = $shape($c) + ['replies' => $replies];
    }
    return ['comments' => $out, 'next' => $page['next']];
}

/** Graph timestamp ("2026-10-19T09:00:00+0000") → MySQL UTC string, or null. */
function graph_time(?string $value): ?string
{
    if (!$value) return null;
    try {
        return (new DateTimeImmutable($value))->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s');
    } catch (Exception $e) {
        return null;
    }
}

/** Recent DMs of the connected account (Instagram Login only): the last 20 messages (Meta's limit) of up to 50 conversations. */
function list_recent_messages(): array
{
    require_instagram_login();
    try {
        $conversations = graph_list('/me/conversations?platform=instagram&limit=25&fields=' . rawurlencode('messages.limit(20){id,created_time,from,message}'), 2);
    } catch (MetaApiError $e) {
        // Some accounts reject nested fields; fall back to one request per conversation and message.
        $conversations = [];
        foreach (graph_list('/me/conversations?platform=instagram&limit=10', 1) as $c) {
            $refs = graph_request('GET', '/' . rawurlencode((string) $c['id']) . '?fields=messages');
            $data = [];
            foreach (array_slice($refs['messages']['data'] ?? [], 0, 5) as $ref) {
                $data[] = graph_request('GET', '/' . rawurlencode((string) $ref['id']) . '?fields=id,created_time,from,message');
            }
            $conversations[] = ['id' => $c['id'], 'messages' => ['data' => $data]];
        }
    }
    $out = [];
    foreach ($conversations as $c) {
        foreach ($c['messages']['data'] ?? [] as $m) {
            if (empty($m['message']) || empty($m['from']['id'])) continue;
            $out[] = ['id' => (string) $m['id'], 'text' => (string) $m['message'], 'fromId' => (string) $m['from']['id'],
                'username' => isset($m['from']['username']) ? (string) $m['from']['username'] : null, 'at' => graph_time($m['created_time'] ?? null)];
        }
    }
    return $out;
}
