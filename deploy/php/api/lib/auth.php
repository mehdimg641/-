<?php
/** Single-admin login with an HS256 session cookie and a per-IP lockout after repeated failures. */

declare(strict_types=1);

const SESSION_SECONDS = 7 * 24 * 3600;
const MIN_PASSWORD_LENGTH = 10;
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

function b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64url_decode(string $data): string
{
    return (string) base64_decode(strtr($data, '-_', '+/'));
}

function jwt_sign(array $payload): string
{
    $head = b64url(json_encode(['alg' => 'HS256', 'typ' => 'JWT']));
    $body = b64url(json_encode($payload, JSON_UNESCAPED_UNICODE));
    return "$head.$body." . b64url(hash_hmac('sha256', "$head.$body", app_secret(), true));
}

function jwt_verify(string $token): ?array
{
    $parts = explode('.', $token);
    if (count($parts) !== 3) return null;
    [$head, $body, $sig] = $parts;
    $header = json_decode(b64url_decode($head), true);
    if (($header['alg'] ?? '') !== 'HS256') return null;
    if (!hash_equals(b64url(hash_hmac('sha256', "$head.$body", app_secret(), true)), $sig)) return null;
    $payload = json_decode(b64url_decode($body), true);
    if (!is_array($payload) || (int) ($payload['exp'] ?? 0) < time()) return null;
    return $payload;
}

function admin_open_id(): string
{
    return 'local:' . config()['admin_username'];
}

function set_session_cookie(string $value, int $maxAge): void
{
    setcookie(SEPAND_COOKIE, $value, [
        'expires' => $maxAge > 0 ? time() + $maxAge : time() - 3600,
        'path' => '/',
        'secure' => is_https(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}

/** The logged-in admin, or null. A cookie for a since-renamed admin is not accepted. */
function current_user(): ?array
{
    static $user = false;
    if ($user !== false) return $user;
    $user = null;
    $token = $_COOKIE[SEPAND_COOKIE] ?? '';
    if ($token === '' || (string) config()['admin_username'] === '') return null;
    $session = jwt_verify($token);
    if (!$session || ($session['openId'] ?? '') !== admin_open_id()) return null;
    $stmt = db()->prepare("SELECT * FROM users WHERE openId = ? LIMIT 1");
    $stmt->execute([$session['openId']]);
    $row = $stmt->fetch();
    if (!$row) return null;
    $user = [
        'id' => (int) $row['id'],
        'openId' => $row['openId'],
        'name' => $row['name'],
        'email' => $row['email'],
        'loginMethod' => $row['loginMethod'],
        'role' => 'admin',
        'createdAt' => db_time($row['createdAt']),
        'updatedAt' => db_time($row['updatedAt']),
        'lastSignedIn' => db_time($row['lastSignedIn']),
    ];
    return $user;
}

function require_admin(): array
{
    $user = current_user();
    if (!$user) throw new ApiError('UNAUTHORIZED', 'Please login (10001)');
    return $user;
}

function login(string $username, string $password): void
{
    $c = config();
    if ((string) $c['admin_username'] === '' || strlen((string) $c['admin_password']) < MIN_PASSWORD_LENGTH) {
        throw new ApiError('PRECONDITION_FAILED', 'ورود پیکربندی نشده: admin_username و admin_password (حداقل ۱۰ نویسه) را در api/config.php تنظیم کنید');
    }
    app_secret();
    $pdo = db();
    $ip = client_ip();
    $now = time();
    $stmt = $pdo->prepare("SELECT `count`, resetAt FROM loginFailures WHERE ip = ?");
    $stmt->execute([$ip]);
    $failure = $stmt->fetch();
    if ($failure && (int) $failure['resetAt'] > $now && (int) $failure['count'] >= MAX_FAILURES) {
        throw new ApiError('TOO_MANY_REQUESTS', 'تلاش‌های ناموفق زیاد بود؛ ۱۵ دقیقه دیگر دوباره امتحان کنید');
    }
    // Compare HMACs so both checks take the same time whatever the input length.
    $key = app_secret();
    $userOk = hash_equals(hash_hmac('sha256', (string) $c['admin_username'], $key), hash_hmac('sha256', $username, $key));
    $passOk = hash_equals(hash_hmac('sha256', (string) $c['admin_password'], $key), hash_hmac('sha256', $password, $key));
    if (!$userOk || !$passOk) {
        if ($failure && (int) $failure['resetAt'] > $now) {
            $pdo->prepare("UPDATE loginFailures SET `count` = `count` + 1 WHERE ip = ?")->execute([$ip]);
        } else {
            $pdo->prepare("REPLACE INTO loginFailures (ip, `count`, resetAt) VALUES (?, 1, ?)")->execute([$ip, $now + LOCKOUT_SECONDS]);
        }
        throw new ApiError('UNAUTHORIZED', 'نام کاربری یا رمز عبور اشتباه است');
    }
    $pdo->prepare("DELETE FROM loginFailures WHERE ip = ?")->execute([$ip]);
    $pdo->prepare("INSERT INTO users (openId, name, loginMethod, role, lastSignedIn) VALUES (?, ?, 'local', 'admin', UTC_TIMESTAMP())
        ON DUPLICATE KEY UPDATE name = VALUES(name), role = 'admin', lastSignedIn = UTC_TIMESTAMP()")
        ->execute([admin_open_id(), $c['admin_username']]);
    set_session_cookie(jwt_sign(['openId' => admin_open_id(), 'appId' => 'sepand-inbox', 'name' => $c['admin_username'], 'exp' => $now + SESSION_SECONDS]), SESSION_SECONDS);
}

function logout(): void
{
    set_session_cookie('', -1);
}
