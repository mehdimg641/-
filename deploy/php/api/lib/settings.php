<?php
/**
 * Meta connection settings entered in the dashboard. Stored AES-256-GCM encrypted in appSettings,
 * in the same "v1:iv:tag:data" format as the Node.js version, so either backend can read them.
 */

declare(strict_types=1);

const META_SETTING_KEYS = ['META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'INSTAGRAM_ACCOUNT_IDS', 'META_AUTO_REPLY'];

function settings_key(): string
{
    return hash('sha256', 'sepand-inbox:settings:' . app_secret(), true);
}

function encrypt_setting(string $plain): string
{
    $iv = random_bytes(12);
    $tag = '';
    $data = openssl_encrypt($plain, 'aes-256-gcm', settings_key(), OPENSSL_RAW_DATA, $iv, $tag, '', 16);
    return implode(':', ['v1', base64_encode($iv), base64_encode($tag), base64_encode($data)]);
}

function decrypt_setting(string $stored): ?string
{
    $parts = explode(':', $stored);
    if (count($parts) !== 4 || $parts[0] !== 'v1') return null;
    $plain = openssl_decrypt(base64_decode($parts[3]), 'aes-256-gcm', settings_key(), OPENSSL_RAW_DATA, base64_decode($parts[1]), base64_decode($parts[2]));
    return $plain === false ? null : $plain;
}

/** @return array<string,string> decrypted settings, loaded once per request */
function meta_settings(bool $reload = false): array
{
    static $cache = null;
    if ($cache !== null && !$reload) return $cache;
    $cache = [];
    $rows = db()->query("SELECT `key`, `value` FROM appSettings")->fetchAll();
    foreach ($rows as $row) {
        if (!in_array($row['key'], META_SETTING_KEYS, true)) continue;
        $value = decrypt_setting($row['value']);
        if ($value === null) error_log("[Sepand] Could not decrypt {$row['key']}; was the secret in config.php changed?");
        else $cache[$row['key']] = $value;
    }
    return $cache;
}

function meta_setting(string $key): string
{
    return meta_settings()[$key] ?? '';
}

function meta_setting_source(string $key): string
{
    return meta_setting($key) !== '' ? 'panel' : 'unset';
}

/** string = set, null = clear, missing key = keep. */
function save_meta_settings(array $patch): void
{
    $pdo = db();
    foreach (META_SETTING_KEYS as $key) {
        if (!array_key_exists($key, $patch)) continue;
        $value = trim((string) ($patch[$key] ?? ''));
        if ($value === '') {
            $pdo->prepare("DELETE FROM appSettings WHERE `key` = ?")->execute([$key]);
        } else {
            $encrypted = encrypt_setting($value);
            $pdo->prepare("INSERT INTO appSettings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)")->execute([$key, $encrypted]);
        }
    }
    meta_settings(true);
}

function mask_secret(string $value): string
{
    if ($value === '') return '';
    return strlen($value) > 12 ? substr($value, 0, 4) . '…' . substr($value, -4) : '••••';
}

function auto_reply_enabled(): bool
{
    return meta_setting('META_AUTO_REPLY') === 'true';
}

function meta_configured(): bool
{
    return meta_setting('META_WEBHOOK_VERIFY_TOKEN') !== '' && meta_setting('META_ACCESS_TOKEN') !== '' && meta_setting('META_APP_SECRET') !== '';
}

/** @return string[] */
function allowed_account_ids(): array
{
    return array_values(array_filter(array_map('trim', explode(',', meta_setting('INSTAGRAM_ACCOUNT_IDS'))), 'strlen'));
}
