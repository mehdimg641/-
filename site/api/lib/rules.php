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

/** Seeded into an empty templates table. */
function default_templates(): array
{
    return [
        ['title' => 'استعلام قیمت اولیه', 'category' => 'فروش', 'text' => 'سلام {{username}}، وقت بخیر. برای اعلام قیمت دقیق لطفاً نوع شمش، سایز، تناژ و شهر مقصد را بفرمایید تا همکار فروش راهنمایی کند.'],
        ['title' => 'آنالیز و کیفیت', 'category' => 'پشتیبانی', 'text' => 'سلام {{username}}، مشخصات فنی و آنالیز محصول موردنظر شما را بررسی می‌کنیم. لطفاً سایز و گرید موردنظر را بفرمایید.'],
        ['title' => 'ارسال به شهر مقصد', 'category' => 'فروش', 'text' => 'سلام {{username}}، ارسال به شهر شما قابل بررسی است. لطفاً تناژ و زمان موردنظر را بفرمایید تا زمان تحویل و هزینه حمل اعلام شود.'],
        ['title' => 'دریافت قراضه', 'category' => 'قراضه', 'text' => 'سلام {{username}}، برای بررسی خرید قراضه لطفاً نوع بار، وزن تقریبی، محل بارگیری و تصاویر را ارسال کنید.'],
        ['title' => 'دعوت به دایرکت', 'category' => 'کامنت', 'text' => 'سلام {{username}}، جزئیات را در دایرکت برایتان فرستادیم 🌹'],
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
        'templateId' => $row['templateId'] === null ? null : (int) $row['templateId'],
        'dmTemplate' => $row['dmTemplate'],
        'dmTemplateId' => $row['dmTemplateId'] === null ? null : (int) $row['dmTemplateId'],
        'mediaIds' => $row['mediaIds'] === null ? null : array_values(array_map('strval', json_decode((string) $row['mediaIds'], true) ?: [])),
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
    db()->prepare("INSERT INTO replyRules (name, keywords, channels, action, template, templateId, dmTemplate, dmTemplateId, mediaIds, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")->execute([
        $rule['name'],
        json_encode(array_values($rule['keywords']), JSON_UNESCAPED_UNICODE),
        json_encode(array_values($rule['channels'])),
        $rule['action'],
        $rule['template'],
        $rule['templateId'] ?? null,
        $rule['dmTemplate'] ?? null,
        $rule['dmTemplateId'] ?? null,
        isset($rule['mediaIds']) ? json_encode(array_values($rule['mediaIds'])) : null,
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
    foreach (['name', 'action', 'template', 'templateId', 'dmTemplate', 'dmTemplateId'] as $f) if (array_key_exists($f, $patch)) { $sets[] = "`$f` = ?"; $args[] = $patch[$f]; }
    if (array_key_exists('mediaIds', $patch)) { $sets[] = '`mediaIds` = ?'; $args[] = $patch['mediaIds'] === null ? null : json_encode(array_values($patch['mediaIds'])); }
    foreach (['keywords', 'channels'] as $f) if (array_key_exists($f, $patch)) { $sets[] = "`$f` = ?"; $args[] = json_encode(array_values($patch[$f]), JSON_UNESCAPED_UNICODE); }
    if (array_key_exists('priority', $patch)) { $sets[] = '`priority` = ?'; $args[] = (int) $patch['priority']; }
    if (array_key_exists('enabled', $patch)) { $sets[] = '`enabled` = ?'; $args[] = (int) (bool) $patch['enabled']; }
    if ($sets) {
        $args[] = $id;
        db()->prepare('UPDATE replyRules SET ' . implode(', ', $sets) . ' WHERE id = ?')->execute($args);
    }
    return get_rule($id);
}

function template_text(array $templates, ?int $id, ?string $inline): string
{
    if ($id !== null) {
        foreach ($templates as $t) if ($t['id'] === $id) return $t['text'];
        return '';
    }
    return (string) $inline;
}

function rule_is_scoped(array $rule): bool
{
    return !empty($rule['mediaIds']);
}

/**
 * First matching rule wins. Rules limited to specific posts are checked before rules for every
 * post; within each group, lower priority first. Returns the reply in place ('message') and,
 * for comments, the private DM to the commenter ('dmMessage'); either may be empty.
 */
function decide_reply(array $rules, array $templates, string $channel, string $username, string $text, ?string $mediaId = null): ?array
{
    $normalized = normalize_text($text);
    $candidates = array_values(array_filter($rules, function ($rule) use ($channel, $mediaId) {
        if (!$rule['enabled'] || !in_array($channel, $rule['channels'], true)) return false;
        return !rule_is_scoped($rule) || ($channel === 'comment' && $mediaId !== null && in_array($mediaId, $rule['mediaIds'], true));
    }));
    usort($candidates, function ($a, $b) {
        return [(int) rule_is_scoped($b), $a['priority'], $a['id']] <=> [(int) rule_is_scoped($a), $b['priority'], $b['id']];
    });
    foreach ($candidates as $rule) {
        $match = !$rule['keywords'];
        foreach ($rule['keywords'] as $keyword) {
            $k = trim((string) $keyword);
            if ($k !== '' && mb_strpos($normalized, normalize_text($k)) !== false) { $match = true; break; }
        }
        if (!$match) continue;
        $message = render_template(template_text($templates, $rule['templateId'], $rule['template']), $username);
        $dmMessage = $channel === 'comment' ? render_template(template_text($templates, $rule['dmTemplateId'], $rule['dmTemplate']), $username) : '';
        return ['rule' => $rule, 'message' => $message, 'dmMessage' => $dmMessage];
    }
    return null;
}

// --- templates ----------------------------------------------------------------------------------

function template_row(array $row): array
{
    return ['id' => (int) $row['id'], 'title' => $row['title'], 'category' => $row['category'], 'text' => $row['text'],
        'createdAt' => db_time($row['createdAt']), 'updatedAt' => db_time($row['updatedAt'])];
}

function list_templates(): array
{
    $pdo = db();
    $rows = $pdo->query("SELECT * FROM replyTemplates ORDER BY id")->fetchAll();
    if (!$rows && !(int) $pdo->query("SELECT COUNT(*) FROM appSettings WHERE `key` = 'TEMPLATES_SEEDED'")->fetchColumn()) {
        $insert = $pdo->prepare("INSERT INTO replyTemplates (title, category, text) VALUES (?, ?, ?)");
        foreach (default_templates() as $t) $insert->execute([$t['title'], $t['category'], $t['text']]);
        $pdo->exec("INSERT IGNORE INTO appSettings (`key`, `value`) VALUES ('TEMPLATES_SEEDED', '1')");
        $rows = $pdo->query("SELECT * FROM replyTemplates ORDER BY id")->fetchAll();
    }
    return array_map('template_row', $rows);
}

function get_template(int $id): ?array
{
    $stmt = db()->prepare("SELECT * FROM replyTemplates WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();
    return $row ? template_row($row) : null;
}
