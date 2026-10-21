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
        $message = $data['error']['message'] ?? substr((string) $text, 0, 300);
        throw new MetaApiError("Meta API $status: $message");
    }
    return $data;
}

function reply_to_comment(string $commentId, string $message): array
{
    return graph_request('POST', '/' . rawurlencode($commentId) . '/replies', ['message' => $message]);
}

/** Meta only allows DM replies within 24 hours of the user's last message. */
function send_direct_message(string $recipientId, string $text): array
{
    return graph_request('POST', '/me/messages', ['recipient' => ['id' => $recipientId], 'message' => ['text' => $text]]);
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
function send_private_reply(string $commentId, string $text): array
{
    return graph_request('POST', '/me/messages', ['recipient' => ['comment_id' => $commentId], 'message' => ['text' => $text]]);
}

function media_owner(): string
{
    if (meta_api_host() === 'instagram') return 'me';
    $ids = allowed_account_ids();
    if (!$ids) throw new MetaApiError('ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید (تست اتصال آن را پر می‌کند)');
    return rawurlencode($ids[0]);
}

const WEBHOOK_FIELDS = ['comments', 'messages'];

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
    graph_request('POST', '/me/subscribed_apps?subscribed_fields=' . implode(',', WEBHOOK_FIELDS));
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
function graph_list(string $path, int $maxPages): array
{
    $items = [];
    $after = null;
    for ($page = 0; $page < $maxPages; $page++) {
        $sep = strpos($path, '?') === false ? '?' : '&';
        $result = graph_request('GET', $after ? $path . $sep . 'after=' . rawurlencode($after) : $path);
        foreach ($result['data'] ?? [] as $item) $items[] = $item;
        $after = !empty($result['paging']['next']) ? ($result['paging']['cursors']['after'] ?? null) : null;
        if (!$after) break;
    }
    return $items;
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

function list_media_comments(string $mediaId): array
{
    $comments = graph_list('/' . rawurlencode($mediaId) . '/comments?fields=id,text,timestamp,username,from&limit=50', 4);
    $out = [];
    foreach ($comments as $c) {
        if (empty($c['text'])) continue;
        $out[] = ['id' => (string) $c['id'], 'text' => (string) $c['text'], 'username' => $c['from']['username'] ?? ($c['username'] ?? null),
            'fromId' => isset($c['from']['id']) ? (string) $c['from']['id'] : null, 'at' => graph_time($c['timestamp'] ?? null)];
    }
    return $out;
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
