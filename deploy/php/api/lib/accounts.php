<?php
/**
 * Connected Instagram pages; mirrors server/accounts.ts. Each page has its own token (encrypted
 * like the settings) and its own rules, templates and posts. The dashboard shows one page at a
 * time (X-Sepand-Account header); sending always uses the page the message came to.
 */

declare(strict_types=1);

/** The page this request works on, or null before any page is connected (then nothing is filtered). */
function active_page(): ?string
{
    return $GLOBALS['sepand_active_page'] ?? null;
}

function set_active_page(?string $accountId): void
{
    $GLOBALS['sepand_active_page'] = $accountId;
}

/**
 * SQL condition for rules, templates and posts of a page. Rows from before pages existed have no
 * page; they count for every page until ensure_accounts() gives them to the first one.
 */
function page_rows_sql(string $column, ?string $accountId, array &$args): string
{
    if ($accountId === null) return '1=1';
    $args[] = $accountId;
    return "($column IS NULL OR $column = ?)";
}

/** SQL condition for events of a page (every event knows its page). */
function page_events_sql(string $column, ?string $accountId, array &$args): string
{
    if ($accountId === null) return '1=1';
    $args[] = $accountId;
    return "$column = ?";
}

// Outside with_account() (old single-page installs): the token from Settings.
function current_graph_token(): string
{
    $account = $GLOBALS['sepand_graph_account'] ?? null;
    return $account ? $account['token'] : meta_setting('META_ACCESS_TOKEN');
}

function current_graph_account_id(): string
{
    $account = $GLOBALS['sepand_graph_account'] ?? null;
    if ($account && $account['id'] !== '') return $account['id'];
    return allowed_account_ids()[0] ?? '';
}

/** Runs $fn with Graph calls using this token. */
function with_token(string $accountId, string $token, callable $fn)
{
    $previous = $GLOBALS['sepand_graph_account'] ?? null;
    $GLOBALS['sepand_graph_account'] = ['id' => $accountId, 'token' => $token];
    try {
        return $fn();
    } finally {
        $GLOBALS['sepand_graph_account'] = $previous;
    }
}

/** Runs $fn with Graph calls using this page's token (the Settings token if it has none). */
function with_account(?string $accountId, callable $fn)
{
    $account = $accountId ? get_account($accountId) : null;
    $token = $account ? decrypt_setting($account['token']) : null;
    if (!$token) return $fn();
    return with_token($accountId, $token, $fn);
}

function account_row(array $row): array
{
    return [
        'id' => (string) $row['id'],
        'username' => $row['username'],
        'name' => $row['name'],
        'token' => (string) $row['token'],
        'tokenExpiresAt' => db_time($row['tokenExpiresAt']),
        'tokenRefreshedAt' => db_time($row['tokenRefreshedAt']),
        'lastError' => $row['lastError'],
        'enabled' => (bool) $row['enabled'],
        'createdAt' => db_time($row['createdAt']),
    ];
}

function list_accounts(): array
{
    return array_map('account_row', db()->query("SELECT * FROM igAccounts ORDER BY createdAt, id")->fetchAll());
}

function get_account(string $id): ?array
{
    $stmt = db()->prepare("SELECT * FROM igAccounts WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? account_row($row) : null;
}

/** Insert or replace a page (keeps createdAt). */
function save_account(string $id, ?string $username, string $token): void
{
    db()->prepare("INSERT INTO igAccounts (id, username, token, tokenRefreshedAt, tokenExpiresAt, lastError, enabled) VALUES (?, ?, ?, UTC_TIMESTAMP(), NULL, NULL, 1)
        ON DUPLICATE KEY UPDATE username = COALESCE(VALUES(username), username), token = VALUES(token), tokenRefreshedAt = VALUES(tokenRefreshedAt),
        tokenExpiresAt = NULL, lastError = NULL, enabled = 1")->execute([$id, $username, encrypt_setting($token)]);
}

function set_account_error(string $id, ?string $error): void
{
    db()->prepare("UPDATE igAccounts SET lastError = ? WHERE id = ?")->execute([$error === null ? null : mb_substr($error, 0, 1000), $id]);
}

/** Gives rules, templates and posts without a page to this one. */
function assign_orphans(string $accountId): void
{
    foreach (['replyRules', 'replyTemplates', 'igMedia'] as $table) {
        db()->prepare("UPDATE `$table` SET accountId = ? WHERE accountId IS NULL")->execute([$accountId]);
    }
}

/**
 * Pages came after the single-page settings. The first time, the page in Settings (token +
 * account id) becomes the first page, and rules, templates and posts without a page join it.
 */
function ensure_accounts(): void
{
    static $done = false;
    if ($done) return;
    $done = true;
    $accounts = list_accounts();
    $legacyToken = meta_setting('META_ACCESS_TOKEN');
    $legacyId = allowed_account_ids()[0] ?? '';
    if (!$accounts && $legacyToken !== '' && $legacyId !== '') {
        // The username is only for the page switcher; without it the page shows by id.
        try {
            $username = with_token($legacyId, $legacyToken, 'own_username');
        } catch (Throwable $e) {
            $username = null;
        }
        db()->prepare("INSERT IGNORE INTO igAccounts (id, username, token, enabled) VALUES (?, ?, ?, 1)")->execute([$legacyId, $username, encrypt_setting($legacyToken)]);
        $accounts = list_accounts();
    }
    if ($accounts) assign_orphans($accounts[0]['id']);
}

function enabled_accounts(): array
{
    ensure_accounts();
    return array_values(array_filter(list_accounts(), function ($a) { return $a['enabled']; }));
}

/** The page a request asked for, or the first connected page. */
function resolve_account(?string $requested): ?array
{
    $accounts = enabled_accounts();
    foreach ($accounts as $a) if ($a['id'] === $requested) return $a;
    return $accounts[0] ?? null;
}

/** What the dashboard sees of a page; the token itself never leaves the server. */
function account_summary(array $account): array
{
    return [
        'id' => $account['id'],
        'username' => $account['username'],
        'name' => $account['name'],
        'tokenPreview' => mask_secret((string) decrypt_setting($account['token'])),
        'tokenExpiresAt' => $account['tokenExpiresAt'],
        'lastError' => $account['lastError'],
        'enabled' => $account['enabled'],
    ];
}

/**
 * Connects a page from its access token: Meta says which professional account it belongs to,
 * the page is saved (or its token replaced) and its webhooks are subscribed.
 */
function add_account(string $token, ?string $expectedId = null): array
{
    ensure_accounts();
    $test = with_token('', $token, 'test_meta_connection');
    if (!$test['ok']) throw new MetaApiError($test['error']);
    // A Facebook Login token can reach several professional accounts.
    $me = $test['accounts'][0] ?? null;
    foreach ($test['accounts'] as $a) if ($a['id'] === $expectedId) $me = $a;
    if (!$me) throw new MetaApiError('این توکن به هیچ حساب حرفه‌ای اینستاگرام وصل نیست');
    if ($expectedId !== null && $me['id'] !== $expectedId) {
        throw new MetaApiError('این توکن مال ' . ($me['username'] !== '' ? '@' . $me['username'] : $me['id']) . ' است، نه این پیج');
    }
    $first = !list_accounts();
    save_account($me['id'], $me['username'] !== '' ? $me['username'] : null, $token);
    if ($first) assign_orphans($me['id']);
    $subscribeError = null;
    if ($test['host'] === 'instagram') {
        try {
            with_token($me['id'], $token, 'subscribe_webhooks');
        } catch (MetaApiError $e) {
            $subscribeError = $e->getMessage();
            set_account_error($me['id'], 'فعال‌سازی وب‌هوک: ' . $subscribeError);
        }
    }
    return ['account' => account_summary(get_account($me['id'])), 'subscribeError' => $subscribeError];
}

/** Refreshes one page's Instagram Login token and records the new expiry (or the error). */
function refresh_account(array $account): void
{
    $token = decrypt_setting($account['token']);
    if (!$token) throw new MetaApiError('توکن این پیج خوانده نشد؛ توکن جدید بگذارید');
    try {
        $fresh = refresh_instagram_token($token);
    } catch (MetaApiError $e) {
        db()->prepare("UPDATE igAccounts SET lastError = ?, tokenRefreshedAt = UTC_TIMESTAMP() WHERE id = ?")->execute([mb_substr('تمدید توکن: ' . $e->getMessage(), 0, 1000), $account['id']]);
        throw $e;
    }
    db()->prepare("UPDATE igAccounts SET token = ?, tokenExpiresAt = ?, tokenRefreshedAt = UTC_TIMESTAMP(), lastError = NULL WHERE id = ?")
        ->execute([encrypt_setting($fresh['token']), $fresh['expiresAt'], $account['id']]);
}

/**
 * Keeps tokens alive without a cron: called from the dashboard's status poll, it refreshes at most
 * one Instagram Login token a week old (Meta needs it to be at least a day old). Failures are kept
 * on the page and shown in Settings; they never break the poll.
 */
function refresh_due_token(): ?string
{
    $now = time();
    foreach (enabled_accounts() as $account) {
        $token = (string) decrypt_setting($account['token']);
        if (strpos($token, 'IG') !== 0) continue;
        $last = ($account['tokenRefreshedAt'] ?? $account['createdAt'])->getTimestamp();
        $expiringSoon = $account['tokenExpiresAt'] && $account['tokenExpiresAt']->getTimestamp() - $now < 10 * 86400;
        if ($now - $last < ($expiringSoon ? 86400 : 7 * 86400)) continue;
        try {
            refresh_account($account);
        } catch (MetaApiError $e) {
            // Recorded on the page.
        }
        return $account['id'];
    }
    return null;
}

/**
 * Starts a page off with another page's templates and rules. Rules point at the copied templates;
 * rules limited to the other page's posts are left out, since those posts aren't on this page.
 */
function copy_rules_from(string $fromAccountId, string $toAccountId): array
{
    if ($fromAccountId === $toAccountId) throw new ApiError('CONFLICT', 'مبدأ و مقصد یک پیج است');
    $pdo = db();
    $ids = [];
    $templates = $pdo->prepare("SELECT * FROM replyTemplates WHERE accountId = ? ORDER BY id");
    $templates->execute([$fromAccountId]);
    $insert = $pdo->prepare("INSERT INTO replyTemplates (accountId, title, category, text) VALUES (?, ?, ?, ?)");
    foreach ($templates->fetchAll() as $t) {
        $insert->execute([$toAccountId, $t['title'], $t['category'], $t['text']]);
        $ids[(int) $t['id']] = (int) $pdo->lastInsertId();
    }
    $rules = $pdo->prepare("SELECT * FROM replyRules WHERE accountId = ? ORDER BY priority, id");
    $rules->execute([$fromAccountId]);
    $copied = 0;
    $skipped = 0;
    foreach (array_map('rule_row', $rules->fetchAll()) as $rule) {
        if (rule_is_scoped($rule)) {
            $skipped++;
            continue;
        }
        $rule['templateId'] = $rule['templateId'] === null ? null : ($ids[$rule['templateId']] ?? null);
        $rule['dmTemplateId'] = $rule['dmTemplateId'] === null ? null : ($ids[$rule['dmTemplateId']] ?? null);
        insert_rule($rule, $toAccountId);
        $copied++;
    }
    return ['rules' => $copied, 'templates' => count($ids), 'skipped' => $skipped];
}
