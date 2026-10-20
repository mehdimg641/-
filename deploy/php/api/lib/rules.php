<?php
/** Keyword reply rules; mirrors server/replyRules.ts. */

declare(strict_types=1);

/** Seeded into an empty rules table. Lower priority runs first, so sensitive topics win. */
function default_rules(): array
{
    return [
        ['name' => 'تخفیف / قرارداد / تحویل', 'keywords' => ['تخفیف', 'قرارداد', 'تحویل', 'پیش پرداخت', 'عمده'], 'channels' => ['comment', 'dm'], 'action' => 'approval', 'template' => 'سلام {{username}}، درخواست شما ثبت شد و همکار فروش به‌زودی پاسخ می‌دهد.', 'priority' => 10],
        ['name' => 'درخواست قیمت', 'keywords' => ['قیمت', 'نرخ', 'استعلام'], 'channels' => ['comment', 'dm'], 'action' => 'approval', 'template' => 'سلام {{username}}، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.', 'priority' => 20],
        ['name' => 'آنالیز و کیفیت', 'keywords' => ['آنالیز', 'کیفیت', '3sp', '4sp', '5sp'], 'channels' => ['comment', 'dm'], 'action' => 'send', 'template' => 'سلام {{username}}، نوع شمش و سایز موردنظر را بفرمایید تا آنالیز و مشخصات فنی مناسب ارسال شود.', 'priority' => 30],
        ['name' => 'پاسخ پیش‌فرض', 'keywords' => [], 'channels' => ['comment', 'dm'], 'action' => 'approval', 'template' => 'سلام {{username}}، درخواست شما ثبت شد. لطفاً مشخصات کامل را بفرستید تا همکار فروش راهنمایی کند.', 'priority' => 1000],
    ];
}

/** Persian/Arabic digits and letter variants are folded so "۳SP" and "ي" match "3sp" and "ی". */
function normalize_text(string $text): string
{
    $map = ['ي' => 'ی', 'ك' => 'ک', "\u{200c}" => ' '];
    foreach (['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as $i => $d) $map[$d] = (string) $i;
    foreach (['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'] as $i => $d) $map[$d] = (string) $i;
    return mb_strtolower(strtr($text, $map), 'UTF-8');
}

function render_template(string $template, string $username): string
{
    $rendered = str_replace('{{username}}', $username, $template);
    if ($username !== '') return $rendered;
    // Without a username, "سلام ، ..." would read oddly; collapse the empty slot.
    return trim(preg_replace('/\s{2,}/u', ' ', preg_replace('/\s+،/u', '،', $rendered)));
}

function rule_row(array $row): array
{
    return [
        'id' => (int) $row['id'],
        'name' => $row['name'],
        'keywords' => json_decode((string) $row['keywords'], true) ?: [],
        'channels' => json_decode((string) $row['channels'], true) ?: [],
        'action' => $row['action'],
        'template' => $row['template'],
        'priority' => (int) $row['priority'],
        'enabled' => (bool) $row['enabled'],
        'createdAt' => db_time($row['createdAt']),
        'updatedAt' => db_time($row['updatedAt']),
    ];
}

function list_rules(): array
{
    $pdo = db();
    $rows = $pdo->query("SELECT * FROM replyRules ORDER BY priority, id")->fetchAll();
    if (!$rows && !(int) $pdo->query("SELECT COUNT(*) FROM appSettings WHERE `key` = 'RULES_SEEDED'")->fetchColumn()) {
        foreach (default_rules() as $rule) insert_rule($rule);
        // Remember the seeding so an operator who deletes every rule doesn't get the defaults back.
        $pdo->exec("INSERT IGNORE INTO appSettings (`key`, `value`) VALUES ('RULES_SEEDED', '1')");
        $rows = $pdo->query("SELECT * FROM replyRules ORDER BY priority, id")->fetchAll();
    }
    return array_map('rule_row', $rows);
}

function insert_rule(array $rule): int
{
    db()->prepare("INSERT INTO replyRules (name, keywords, channels, action, template, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)")->execute([
        $rule['name'],
        json_encode(array_values($rule['keywords']), JSON_UNESCAPED_UNICODE),
        json_encode(array_values($rule['channels'])),
        $rule['action'],
        $rule['template'],
        (int) $rule['priority'],
        isset($rule['enabled']) ? (int) (bool) $rule['enabled'] : 1,
    ]);
    return (int) db()->lastInsertId();
}

function get_rule(int $id): ?array
{
    $stmt = db()->prepare("SELECT * FROM replyRules WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? rule_row($row) : null;
}

function update_rule(int $id, array $patch): ?array
{
    $sets = [];
    $args = [];
    foreach (['name', 'action', 'template'] as $f) if (array_key_exists($f, $patch)) { $sets[] = "`$f` = ?"; $args[] = $patch[$f]; }
    foreach (['keywords', 'channels'] as $f) if (array_key_exists($f, $patch)) { $sets[] = "`$f` = ?"; $args[] = json_encode(array_values($patch[$f]), JSON_UNESCAPED_UNICODE); }
    if (array_key_exists('priority', $patch)) { $sets[] = '`priority` = ?'; $args[] = (int) $patch['priority']; }
    if (array_key_exists('enabled', $patch)) { $sets[] = '`enabled` = ?'; $args[] = (int) (bool) $patch['enabled']; }
    if ($sets) {
        $args[] = $id;
        db()->prepare('UPDATE replyRules SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }
    return get_rule($id);
}

/** First enabled rule (by priority) whose channel and keywords match; null if none. */
function decide_reply(array $rules, string $channel, string $username, string $text): ?array
{
    $normalized = normalize_text($text);
    foreach ($rules as $rule) {
        if (!$rule['enabled'] || !in_array($channel, $rule['channels'], true)) continue;
        $match = !$rule['keywords'];
        foreach ($rule['keywords'] as $keyword) {
            $k = trim((string) $keyword);
            if ($k !== '' && mb_strpos($normalized, normalize_text($k)) !== false) { $match = true; break; }
        }
        if ($match) return ['rule' => $rule, 'message' => render_template($rule['template'], $username)];
    }
    return null;
}
