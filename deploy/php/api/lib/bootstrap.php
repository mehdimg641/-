<?php
/** Shared setup for the PHP backend: config, database, JSON helpers. Requires PHP 7.4+. */

declare(strict_types=1);

if (PHP_VERSION_ID < 70400) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Sepand Inbox needs PHP 7.4 or newer (cPanel → Select PHP Version)']);
    exit;
}

ini_set('display_errors', '0');
date_default_timezone_set('UTC');

const SEPAND_COOKIE = 'app_session_id';

/** Thrown for errors the client should see (mapped to tRPC error codes). */
class ApiError extends Exception
{
    public string $trpcCode;

    public function __construct(string $trpcCode, string $message)
    {
        parent::__construct($message);
        $this->trpcCode = $trpcCode;
    }
}

function config(): array
{
    static $config = null;
    if ($config !== null) return $config;
    // SEPAND_CONFIG lets the config live outside the web root (and lets tests use their own).
    $file = getenv('SEPAND_CONFIG') ?: __DIR__ . '/../config.php';
    if (!is_file($file)) {
        throw new ApiError('PRECONDITION_FAILED', 'فایل api/config.php وجود ندارد؛ config.example.php را کپی کرده و با نام config.php ذخیره کنید');
    }
    $loaded = require $file;
    if (!is_array($loaded)) throw new ApiError('PRECONDITION_FAILED', 'api/config.php باید یک آرایه برگرداند');
    $config = $loaded + ['db_host' => 'localhost', 'db_name' => '', 'db_user' => '', 'db_pass' => '', 'admin_username' => '', 'admin_password' => '', 'secret' => ''];
    return $config;
}

function app_secret(): string
{
    $secret = (string) config()['secret'];
    if (strlen($secret) < 32) throw new ApiError('PRECONDITION_FAILED', 'در api/config.php مقدار secret را حداقل ۳۲ نویسه تنظیم کنید');
    return $secret;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $c = config();
    if ($c['db_name'] === '' || $c['db_user'] === '') throw new ApiError('PRECONDITION_FAILED', 'اطلاعات پایگاه داده در api/config.php تنظیم نشده است');
    try {
        $pdo = new PDO(
            "mysql:host={$c['db_host']};dbname={$c['db_name']};charset=utf8mb4",
            (string) $c['db_user'],
            (string) $c['db_pass'],
            [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]
        );
    } catch (PDOException $e) {
        error_log('[Sepand] DB connection failed: ' . $e->getMessage());
        throw new ApiError('INTERNAL_SERVER_ERROR', 'اتصال به پایگاه داده ناموفق بود؛ اطلاعات api/config.php را بررسی کنید');
    }
    // All timestamps are stored and read as UTC.
    $pdo->exec("SET time_zone = '+00:00'");
    ensure_schema($pdo);
    return $pdo;
}

/** Creates any missing table, so neither a fresh install nor an update needs a manual SQL import. */
function ensure_schema(PDO $pdo): void
{
    $tables = [
        "CREATE TABLE IF NOT EXISTS `users` (
            `id` int AUTO_INCREMENT NOT NULL, `openId` varchar(64) NOT NULL, `name` text, `email` varchar(320),
            `loginMethod` varchar(64), `role` enum('user','admin') NOT NULL DEFAULT 'user',
            `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            `lastSignedIn` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`), UNIQUE KEY `users_openId_unique` (`openId`))",
        "CREATE TABLE IF NOT EXISTS `igEvents` (
            `id` int AUTO_INCREMENT NOT NULL, `accountId` varchar(64) NOT NULL, `kind` enum('comment','dm') NOT NULL,
            `externalId` varchar(191) NOT NULL, `senderId` varchar(64) NOT NULL, `username` varchar(64), `text` text NOT NULL,
            `mediaId` varchar(64), `ruleId` int, `isRead` boolean NOT NULL DEFAULT false,
            `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`), UNIQUE KEY `igEvents_external_unique` (`accountId`,`kind`,`externalId`), KEY `igEvents_sender_idx` (`senderId`))",
        "CREATE TABLE IF NOT EXISTS `replyRules` (
            `id` int AUTO_INCREMENT NOT NULL, `name` varchar(120) NOT NULL, `keywords` json NOT NULL, `channels` json NOT NULL,
            `action` enum('send','approval') NOT NULL DEFAULT 'approval', `template` text NOT NULL,
            `priority` int NOT NULL DEFAULT 100, `enabled` boolean NOT NULL DEFAULT true,
            `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
            `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`))",
        "CREATE TABLE IF NOT EXISTS `replies` (
            `id` int AUTO_INCREMENT NOT NULL, `eventId` int NOT NULL, `ruleId` int, `source` enum('rule','manual') NOT NULL,
            `text` text NOT NULL, `status` enum('pending','sending','sent','rejected','failed') NOT NULL DEFAULT 'pending',
            `error` text, `decidedBy` int, `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, `sentAt` timestamp NULL,
            PRIMARY KEY (`id`), KEY `replies_event_idx` (`eventId`), KEY `replies_status_idx` (`status`))",
        "CREATE TABLE IF NOT EXISTS `appSettings` (
            `key` varchar(64) NOT NULL, `value` text NOT NULL,
            `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (`key`))",
        "CREATE TABLE IF NOT EXISTS `loginFailures` (
            `ip` varchar(64) NOT NULL, `count` int NOT NULL DEFAULT 0, `resetAt` bigint NOT NULL,
            PRIMARY KEY (`ip`))",
    ];
    // Cheap check first: skip the DDL once every table exists.
    $have = $pdo->query("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('users','igEvents','replyRules','replies','appSettings','loginFailures')")->fetchColumn();
    if ((int) $have === count($tables)) return;
    foreach ($tables as $ddl) $pdo->exec($ddl . ' DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
}

/** MySQL timestamp (UTC) → DateTimeImmutable. */
function db_time(?string $value): ?DateTimeImmutable
{
    return $value === null ? null : new DateTimeImmutable($value, new DateTimeZone('UTC'));
}

function client_ip(): string
{
    // cPanel/LiteSpeed passes the real address in REMOTE_ADDR; X-Forwarded-For can be forged.
    return substr((string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), 0, 64);
}

function is_https(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https'
        || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443;
}

function send_json(int $status, $body): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** Ends the HTTP response but keeps the script running (used to send auto-replies after acking Meta). */
function finish_response(): void
{
    ignore_user_abort(true);
    if (function_exists('litespeed_finish_request')) litespeed_finish_request();
    elseif (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
    else flush();
}
