<?php
/**
 * tRPC-compatible endpoint (batched HTTP + superjson) so the existing dashboard works unchanged.
 * URL: /api/trpc/<proc>[,<proc>...]?batch=1&input={"0":{"json":...}}
 */

declare(strict_types=1);

require __DIR__ . '/lib/bootstrap.php';
require __DIR__ . '/lib/superjson.php';
require __DIR__ . '/lib/settings.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/rules.php';
require __DIR__ . '/lib/graph.php';
require __DIR__ . '/lib/meta_webhook.php';
require __DIR__ . '/lib/inbox.php';

const TRPC_CODES = [
    'BAD_REQUEST' => [-32600, 400], 'UNAUTHORIZED' => [-32001, 401], 'FORBIDDEN' => [-32003, 403],
    'NOT_FOUND' => [-32004, 404], 'METHOD_NOT_SUPPORTED' => [-32005, 405], 'CONFLICT' => [-32009, 409],
    'PRECONDITION_FAILED' => [-32012, 412], 'TOO_MANY_REQUESTS' => [-32029, 429], 'INTERNAL_SERVER_ERROR' => [-32603, 500],
];

// --- input validation helpers ---------------------------------------------------------------

function in_obj($input): array
{
    if ($input === null) return [];
    if (!is_array($input)) throw new ApiError('BAD_REQUEST', 'ورودی نامعتبر است');
    return $input;
}

function req_str(array $in, string $key, int $min = 1, int $max = 1000): string
{
    $v = $in[$key] ?? null;
    if (!is_string($v)) throw new ApiError('BAD_REQUEST', "$key الزامی است");
    $v = trim($v);
    $len = mb_strlen($v);
    if ($len < $min || $len > $max) throw new ApiError('BAD_REQUEST', "طول $key نامعتبر است");
    return $v;
}

function req_int(array $in, string $key): int
{
    $v = $in[$key] ?? null;
    if (!is_int($v)) throw new ApiError('BAD_REQUEST', "$key باید عدد صحیح باشد");
    return $v;
}

/** Validates a rule; with $partial only the given fields are checked. */
function rule_input(array $in, bool $partial): array
{
    $out = [];
    if (!$partial || array_key_exists('name', $in)) $out['name'] = req_str($in, 'name', 1, 120);
    if (!$partial || array_key_exists('keywords', $in)) {
        $k = $in['keywords'] ?? null;
        if (!is_array($k) || count($k) > 50) throw new ApiError('BAD_REQUEST', 'کلمات محرک نامعتبر است');
        $out['keywords'] = array_values(array_filter(array_map(function ($w) {
            if (!is_string($w) || mb_strlen(trim($w)) > 60) throw new ApiError('BAD_REQUEST', 'کلمهٔ محرک نامعتبر است');
            return trim($w);
        }, $k), 'strlen'));
    }
    if (!$partial || array_key_exists('channels', $in)) {
        $c = $in['channels'] ?? null;
        if (!is_array($c) || !$c || array_diff($c, ['comment', 'dm'])) throw new ApiError('BAD_REQUEST', 'کانال نامعتبر است');
        $out['channels'] = array_values(array_unique($c));
    }
    if (!$partial || array_key_exists('action', $in)) {
        if (!in_array($in['action'] ?? null, ['send', 'approval'], true)) throw new ApiError('BAD_REQUEST', 'اقدام نامعتبر است');
        $out['action'] = $in['action'];
    }
    if (!$partial || array_key_exists('template', $in)) $out['template'] = req_str($in, 'template', 0, 1000);
    if (!$partial || array_key_exists('dmTemplate', $in)) $out['dmTemplate'] = opt_str($in, 'dmTemplate', 1000);
    foreach (['templateId', 'dmTemplateId'] as $key) {
        if (!$partial || array_key_exists($key, $in)) $out[$key] = ($in[$key] ?? null) === null ? null : req_int($in, $key);
    }
    if (!$partial || array_key_exists('mediaIds', $in)) {
        $m = $in['mediaIds'] ?? null;
        if ($m !== null && (!is_array($m) || count($m) > 200)) throw new ApiError('BAD_REQUEST', 'پست‌ها نامعتبر است');
        $out['mediaIds'] = $m === null ? null : array_values(array_unique(array_map(function ($id) {
            if (!is_string($id) || !preg_match('/^[0-9A-Za-z_]{1,64}$/', $id)) throw new ApiError('BAD_REQUEST', 'شناسهٔ پست نامعتبر است');
            return $id;
        }, $m)));
    }
    if (!$partial || array_key_exists('priority', $in)) {
        $p = req_int($in, 'priority');
        if ($p < 0 || $p > 10000) throw new ApiError('BAD_REQUEST', 'اولویت نامعتبر است');
        $out['priority'] = $p;
    }
    if (!$partial || array_key_exists('enabled', $in)) {
        if (!is_bool($in['enabled'] ?? null)) throw new ApiError('BAD_REQUEST', 'وضعیت نامعتبر است');
        $out['enabled'] = $in['enabled'];
    }
    return $out;
}

/** Nullable trimmed string; empty becomes null. */
function opt_str(array $in, string $key, int $max): ?string
{
    $v = $in[$key] ?? null;
    if ($v === null) return null;
    if (!is_string($v) || mb_strlen(trim($v)) > $max) throw new ApiError('BAD_REQUEST', "$key نامعتبر است");
    $v = trim($v);
    return $v === '' ? null : $v;
}

/** A rule must reply somehow: in place (text or template) or, for comments, by DM. */
function assert_rule_replies(array $rule): void
{
    $inPlace = ($rule['template'] ?? '') !== '' || ($rule['templateId'] ?? null) !== null;
    $dm = ($rule['dmTemplate'] ?? null) !== null && $rule['dmTemplate'] !== '' || ($rule['dmTemplateId'] ?? null) !== null;
    if (!$inPlace && !$dm) throw new ApiError('BAD_REQUEST', 'متن پاسخ یا متن دایرکت (یا یک قالب) را وارد کنید');
}

function template_input(array $in, bool $partial): array
{
    $out = [];
    if (!$partial || array_key_exists('title', $in)) $out['title'] = req_str($in, 'title', 1, 120);
    if (!$partial || array_key_exists('category', $in)) $out['category'] = req_str($in, 'category', 0, 60);
    if (!$partial || array_key_exists('text', $in)) $out['text'] = req_str($in, 'text', 1, 1000);
    return $out;
}

/** Turns Meta errors into a message the dashboard can show. */
function meta_call(callable $fn)
{
    try {
        return $fn();
    } catch (MetaApiError $e) {
        throw new ApiError('PRECONDITION_FAILED', $e->getMessage());
    }
}

function media_id_input(array $in): string
{
    $id = req_str($in, 'mediaId', 1, 64);
    if (!preg_match('/^[0-9A-Za-z_]+$/', $id)) throw new ApiError('BAD_REQUEST', 'شناسهٔ پست نامعتبر است');
    return $id;
}

/** The build installed in the document root (written by scripts/publish-deploy-branch.sh), or null. */
function installed_version(): ?array
{
    $file = dirname(__DIR__) . '/version.json';
    $data = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
    if (!is_array($data) || !isset($data['commit'])) return null;
    return ['version' => (string) ($data['version'] ?? ''), 'commit' => (string) $data['commit'], 'builtAt' => (string) ($data['builtAt'] ?? '')];
}

/** Optional secret field: missing = keep, null = clear, string = set. */
function opt_secret(array $in, string $key, array &$patch, string $setting): void
{
    if (!array_key_exists($key, $in)) return;
    $v = $in[$key];
    if ($v !== null && (!is_string($v) || mb_strlen($v) > 1000)) throw new ApiError('BAD_REQUEST', "$key نامعتبر است");
    $patch[$setting] = $v;
}

// --- procedures -------------------------------------------------------------------------------

function procedures(): array
{
    $admin = function (callable $fn): callable {
        return function ($input) use ($fn) {
            $user = require_admin();
            return $fn(in_obj($input), $user);
        };
    };
    return [
        // [type, handler]
        'auth.me' => ['query', function () { return current_user(); }],
        'auth.login' => ['mutation', function ($input) {
            $in = in_obj($input);
            login(req_str($in, 'username', 1, 100), (string) ($in['password'] ?? ''));
            return ['success' => true];
        }],
        'auth.logout' => ['mutation', function () { logout(); return ['success' => true]; }],
        'system.health' => ['query', function () { return ['ok' => true]; }],

        'inbox.status' => ['query', $admin(function () {
            return ['metaConfigured' => meta_configured(), 'autoReply' => auto_reply_enabled(), 'apiHost' => meta_api_host(), 'accountIds' => allowed_account_ids(), 'persistent' => true,
                'lastEventAt' => db_time(db()->query("SELECT MAX(createdAt) FROM igEvents")->fetchColumn() ?: null),
                'serverVersion' => installed_version()];
        })],
        'inbox.threads' => ['query', $admin(function () { return build_threads(); })],
        'inbox.stats' => ['query', $admin(function () { return inbox_stats(); })],
        'inbox.markRead' => ['mutation', $admin(function ($in) {
            if (!in_array($in['kind'] ?? null, ['comment', 'dm'], true)) throw new ApiError('BAD_REQUEST', 'kind نامعتبر است');
            mark_read($in['kind'], req_str($in, 'senderId', 1, 64));
            return ['success' => true];
        })],
        'inbox.reply' => ['mutation', $admin(function ($in, $user) {
            return send_manual_reply(req_int($in, 'eventId'), req_str($in, 'text', 1, 1000), $user['id']);
        })],

        'approvals.list' => ['query', $admin(function () { return list_approvals(); })],
        'approvals.approve' => ['mutation', $admin(function ($in, $user) {
            $text = array_key_exists('text', $in) && $in['text'] !== null ? req_str($in, 'text', 1, 1000) : null;
            return send_reply(req_int($in, 'id'), $user['id'], $text);
        })],
        'approvals.reject' => ['mutation', $admin(function ($in, $user) {
            reject_reply(req_int($in, 'id'), $user['id']);
            return ['success' => true];
        })],

        'rules.list' => ['query', $admin(function () { return list_rules(); })],
        'rules.create' => ['mutation', $admin(function ($in) {
            $rule = rule_input($in, false);
            assert_rule_replies($rule);
            return get_rule(insert_rule($rule));
        })],
        'rules.update' => ['mutation', $admin(function ($in) {
            $id = req_int($in, 'id');
            $current = get_rule($id);
            if (!$current) throw new ApiError('NOT_FOUND', 'قانون پیدا نشد');
            $patch = rule_input(in_obj($in['patch'] ?? []), true);
            assert_rule_replies(array_merge($current, $patch));
            return update_rule($id, $patch);
        })],
        // Drafts replies for messages that arrived before a matching rule existed.
        'rules.applyToUnanswered' => ['mutation', $admin(function () { return apply_rules_to_unanswered(); })],
        'rules.delete' => ['mutation', $admin(function ($in) {
            db()->prepare("DELETE FROM replyRules WHERE id = ?")->execute([req_int($in, 'id')]);
            return ['success' => true];
        })],

        'templates.list' => ['query', $admin(function () { return list_templates(); })],
        'templates.create' => ['mutation', $admin(function ($in) {
            $t = template_input($in, false);
            db()->prepare("INSERT INTO replyTemplates (title, category, text) VALUES (?, ?, ?)")->execute([$t['title'], $t['category'], $t['text']]);
            return get_template((int) db()->lastInsertId());
        })],
        'templates.update' => ['mutation', $admin(function ($in) {
            $id = req_int($in, 'id');
            $patch = template_input(in_obj($in['patch'] ?? []), true);
            if ($patch) {
                $sets = implode(', ', array_map(function ($f) { return "`$f` = ?"; }, array_keys($patch)));
                db()->prepare("UPDATE replyTemplates SET $sets WHERE id = ?")->execute(array_merge(array_values($patch), [$id]));
            }
            $template = get_template($id);
            if (!$template) throw new ApiError('NOT_FOUND', 'قالب پیدا نشد');
            return $template;
        })],
        'templates.delete' => ['mutation', $admin(function ($in) {
            $id = req_int($in, 'id');
            foreach (list_rules() as $rule) {
                if ($rule['templateId'] === $id || $rule['dmTemplateId'] === $id) {
                    throw new ApiError('CONFLICT', "این قالب در قانون «{$rule['name']}» استفاده شده؛ ابتدا قانون را تغییر دهید");
                }
            }
            db()->prepare("DELETE FROM replyTemplates WHERE id = ?")->execute([$id]);
            return ['success' => true];
        })],

        'posts.list' => ['query', $admin(function () { return list_posts(); })],
        'posts.sync' => ['mutation', $admin(function () { return meta_call('sync_posts'); })],
        'posts.comments' => ['query', $admin(function ($in) { return post_comments(media_id_input($in)); })],
        'posts.importComments' => ['mutation', $admin(function ($in) {
            $mediaId = media_id_input($in);
            $accountId = allowed_account_ids()[0] ?? '';
            if ($accountId === '') throw new ApiError('PRECONDITION_FAILED', 'ابتدا شناسهٔ حساب اینستاگرام را در تنظیمات وارد کنید');
            return meta_call(function () use ($mediaId, $accountId) { return import_post_comments($mediaId, $accountId); });
        })],

        // Secrets are write-only: only a masked preview is returned, except the verify token,
        // which the operator has to copy into Meta.
        'settings.meta' => ['query', $admin(function () {
            meta_settings(true);
            $secret = function (string $key): array { return ['source' => meta_setting_source($key), 'preview' => mask_secret(meta_setting($key))]; };
            return [
                'accessToken' => $secret('META_ACCESS_TOKEN'),
                'appSecret' => $secret('META_APP_SECRET'),
                'verifyToken' => ['source' => meta_setting_source('META_WEBHOOK_VERIFY_TOKEN'), 'value' => meta_setting('META_WEBHOOK_VERIFY_TOKEN')],
                'accountIds' => ['source' => meta_setting_source('INSTAGRAM_ACCOUNT_IDS'), 'value' => meta_setting('INSTAGRAM_ACCOUNT_IDS')],
                'autoReply' => ['source' => meta_setting_source('META_AUTO_REPLY'), 'value' => auto_reply_enabled()],
                'apiHost' => meta_api_host(),
                'configured' => meta_configured(),
            ];
        })],
        'settings.saveMeta' => ['mutation', $admin(function ($in) {
            $patch = [];
            opt_secret($in, 'accessToken', $patch, 'META_ACCESS_TOKEN');
            opt_secret($in, 'appSecret', $patch, 'META_APP_SECRET');
            opt_secret($in, 'verifyToken', $patch, 'META_WEBHOOK_VERIFY_TOKEN');
            if (array_key_exists('accountIds', $in)) {
                $ids = $in['accountIds'];
                if ($ids !== null && (!is_string($ids) || !preg_match('/^[0-9,\s]*$/', $ids))) throw new ApiError('BAD_REQUEST', 'فقط شناسه‌های عددی، جداشده با ویرگول');
                $patch['INSTAGRAM_ACCOUNT_IDS'] = $ids === null ? null : preg_replace('/\s+/', '', $ids);
            }
            if (array_key_exists('autoReply', $in)) {
                if (!is_bool($in['autoReply'])) throw new ApiError('BAD_REQUEST', 'autoReply نامعتبر است');
                $patch['META_AUTO_REPLY'] = $in['autoReply'] ? 'true' : 'false';
            }
            save_meta_settings($patch);
            return ['success' => true];
        })],
        'settings.testMeta' => ['mutation', $admin(function () { return test_meta_connection(); })],
        // Why the inbox may be empty: does Meta call in, and is the account subscribed to the webhook fields?
        'settings.diagnostics' => ['query', $admin(function () {
            try {
                $subscription = ['ok' => true] + get_webhook_subscription();
            } catch (MetaApiError $e) {
                $subscription = ['ok' => false, 'error' => $e->getMessage()];
            }
            $counts = db()->query("SELECT kind, COUNT(*) n FROM igEvents GROUP BY kind")->fetchAll(PDO::FETCH_KEY_PAIR);
            return ['webhookLog' => list_webhook_log(20), 'subscription' => $subscription,
                'counts' => ['comments' => (int) ($counts['comment'] ?? 0), 'dms' => (int) ($counts['dm'] ?? 0)]];
        })],
        'settings.subscribeWebhooks' => ['mutation', $admin(function () { return meta_call('subscribe_webhooks'); })],
    ];
}

// --- dispatcher ---------------------------------------------------------------------------------

function trpc_error(ApiError $e, string $path): array
{
    [$num, $http] = TRPC_CODES[$e->trpcCode] ?? TRPC_CODES['INTERNAL_SERVER_ERROR'];
    return ['error' => superjson_serialize(['message' => $e->getMessage(), 'code' => $num, 'data' => ['code' => $e->trpcCode, 'httpStatus' => $http, 'path' => $path]])];
}

function handle_trpc(): void
{
    $uriPath = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
    $pos = strpos($uriPath, '/api/trpc/');
    $paths = $pos === false ? [] : array_filter(explode(',', rawurldecode(substr($uriPath, $pos + strlen('/api/trpc/')))), 'strlen');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $raw = $method === 'POST' ? (string) file_get_contents('php://input') : (string) ($_GET['input'] ?? '');
    $inputs = $raw === '' ? [] : json_decode($raw, true, 64, JSON_BIGINT_AS_STRING);
    if (!is_array($inputs)) $inputs = [];
    $isBatch = isset($_GET['batch']);
    if (!$isBatch) $inputs = [0 => $inputs];

    $procs = procedures();
    $results = [];
    $statuses = [];
    foreach (array_values($paths) as $i => $path) {
        $item = $inputs[(string) $i] ?? $inputs[$i] ?? null;
        $input = is_array($item) && array_key_exists('json', $item) ? $item['json'] : null;
        try {
            if (!isset($procs[$path])) throw new ApiError('NOT_FOUND', "No procedure found on path \"$path\"");
            [$type, $handler] = $procs[$path];
            if (($type === 'mutation') !== ($method === 'POST')) throw new ApiError('METHOD_NOT_SUPPORTED', "Unsupported method for $type");
            $results[] = ['result' => ['data' => superjson_serialize($handler($input))]];
            $statuses[] = 200;
        } catch (ApiError $e) {
            $results[] = trpc_error($e, $path);
            $statuses[] = TRPC_CODES[$e->trpcCode][1] ?? 500;
        } catch (Throwable $e) {
            error_log('[Sepand] ' . $path . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            $results[] = trpc_error(new ApiError('INTERNAL_SERVER_ERROR', 'خطای داخلی سرور'), $path);
            $statuses[] = 500;
        }
    }
    if (!$results) {
        send_json(404, trpc_error(new ApiError('NOT_FOUND', 'No procedure given'), ''));
        return;
    }
    $unique = array_values(array_unique($statuses));
    send_json(count($unique) === 1 ? $unique[0] : 207, $isBatch ? $results : $results[0]);
}

handle_trpc();
