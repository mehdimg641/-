<?php
// Unit checks for the PHP backend: php tests/php/run.php  (no database needed)
declare(strict_types=1);

$lib = __DIR__ . '/../../deploy/php/api/lib';
require "$lib/bootstrap.php";
require "$lib/superjson.php";
require "$lib/settings.php";
require "$lib/accounts.php";
require "$lib/rules.php";
require "$lib/meta_webhook.php";
require "$lib/graph.php";

function test_config_secret(): string { return 'unit-test-secret-unit-test-secret-1234'; }
$GLOBALS['fails'] = 0;
function check(string $name, $actual, $expected): void
{
    $ok = $actual === $expected;
    echo ($ok ? "✓ " : "✗ ") . $name . ($ok ? '' : "\n    expected " . var_export($expected, true) . "\n    got      " . var_export($actual, true)) . "\n";
    if (!$ok) $GLOBALS['fails']++;
}

// Stand-in config, no database.
$tmp = sys_get_temp_dir() . '/sepand-test-' . getmypid() . '.php';
file_put_contents($tmp, "<?php return ['secret' => '" . test_config_secret() . "'];");
putenv("SEPAND_CONFIG=$tmp");

$base = ['enabled' => true, 'templateId' => null, 'dmTemplate' => null, 'dmTemplateId' => null, 'mediaIds' => null];
$rules = array_map(function ($r, $i) use ($base) { return ['id' => $i + 1] + $r + $base; }, default_rules(), array_keys(default_rules()));
check('price rule + username', decide_reply($rules, [], 'comment', 'ali', 'قیمت شمش چنده؟')['message'], 'سلام ali، برای اعلام قیمت دقیق لطفاً سایز، تناژ و شهر مقصد را دایرکت کنید.');
check('sensitive before price', decide_reply($rules, [], 'dm', '', 'قیمت با تخفیف؟')['rule']['name'], 'تخفیف / قرارداد / تحویل');
check('persian digits', decide_reply($rules, [], 'dm', '', 'آنالیز ۳SP')['rule']['name'], 'آنالیز و کیفیت');

// Per-post rule: replies in place from a template and sends a DM; scoped rules win over general ones.
$templates = [['id' => 7, 'title' => 'لیست قیمت', 'category' => '', 'text' => 'سلام {{username}}، لیست قیمت را دایرکت کردیم.']];
$scoped = ['id' => 99, 'name' => 'پست تیرآهن', 'keywords' => ['قیمت'], 'channels' => ['comment'], 'action' => 'approval', 'template' => '',
    'priority' => 500, 'templateId' => 7, 'dmTemplate' => 'لیست قیمت امروز: ...', 'mediaIds' => ['1789']] + $base;
$withPost = array_merge($rules, [$scoped]);
$d = decide_reply($withPost, $templates, 'comment', 'ali', 'قیمت؟', '1789');
check('scoped rule wins', $d['rule']['id'], 99);
check('reply from template', $d['message'], 'سلام ali، لیست قیمت را دایرکت کردیم.');
check('dm text', $d['dmMessage'], 'لیست قیمت امروز: ...');
check('other post → general rule', decide_reply($withPost, $templates, 'comment', 'ali', 'قیمت؟', '555')['rule']['id'] !== 99, true);
check('dm channel ignores scoped', decide_reply([$scoped], $templates, 'dm', 'ali', 'قیمت؟', '1789'), null);
check('no dm for dm events', decide_reply($rules, [], 'dm', '', 'قیمت؟')['dmMessage'], '');
check('missing template → empty', decide_reply([['templateId' => 1234] + $scoped], $templates, 'comment', '', 'قیمت', '1789')['message'], '');
check('split messages', split_messages("اول\n---\n دوم \n-----\n\n---\n"), ['اول', 'دوم']);
check('join messages', join_messages("الف\n---\nب"), "الف\n\nب");
check('separators survive empty username', split_messages(render_template("سلام {{username}}، خوش آمدید\n---\nلیست", '')), ['سلام، خوش آمدید', 'لیست']);
check('message length', messages_fit(str_repeat('a', 1000) . "\n---\n" . str_repeat('b', 1000)) && !messages_fit(str_repeat('a', 1001)), true);
check('empty username tidy', render_template('سلام {{username}}، لطفاً دایرکت کنید.', ''), 'سلام، لطفاً دایرکت کنید.');
check('arabic letters', normalize_text('قيمت'), 'قیمت');

$sj = superjson_serialize([['at' => new DateTimeImmutable('2026-10-20T10:00:00Z'), 'n' => 1]]);
check('superjson date', $sj['json'][0]['at'], '2026-10-20T10:00:00.000Z');
check('superjson meta', $sj['meta'], ['values' => ['0.at' => ['Date']]]);
check('superjson no dates', superjson_serialize(['a' => 1]), ['json' => ['a' => 1]]);

check('encrypt round-trip', decrypt_setting(encrypt_setting('IGAA-token')), 'IGAA-token');
// Produced by the Node.js backend (server/metaSettings.ts) with the same secret: both backends share the database format.
if ($nodeCipher = getenv('NODE_CIPHER')) check('decrypts Node.js ciphertext', decrypt_setting($nodeCipher), 'IGAA-from-node');
check('mask', mask_secret('IGAAabcdefghijklmnop'), 'IGAA…mnop');

unlink($tmp);

check('meta error: deleted comment', describe_meta_error(400, ['message' => "Object with ID '1' does not exist", 'code' => 100, 'error_subcode' => 33, 'fbtrace_id' => 'AbC']),
    "این کامنت یا پیام دیگر وجود ندارد (احتمالاً حذف شده) یا با این توکن قابل دسترسی نیست. — Meta API 400: Object with ID '1' does not exist (کد 100/33 · trace AbC)");
check('meta error: temporary', describe_meta_error(500, ['message' => 'An unknown error has occurred.', 'code' => 1, 'fbtrace_id' => 'Xy']),
    'خطای موقت سرور اینستاگرام؛ چند دقیقه بعد دوباره امتحان کنید. — Meta API 500: An unknown error has occurred. (کد 1 · trace Xy)');
check('meta error: plain', describe_meta_error(400, ['message' => 'Error validating access token']), 'Meta API 400: Error validating access token');
// Pages: each page's rows are filtered, and Graph calls use the page's token.
$args = [];
check('page rows sql', [page_rows_sql('accountId', '222', $args), $args], ['(accountId IS NULL OR accountId = ?)', ['222']]);
$args = [];
check('no page: no filter', [page_events_sql('accountId', null, $args), $args], ['1=1', []]);
$GLOBALS['sepand_graph_account'] = null;
check('graph token falls back to settings', with_token('9', 'IGAApage', 'current_graph_token'), 'IGAApage');
check('graph token restored', $GLOBALS['sepand_graph_account'], null);

echo $GLOBALS['fails'] ? "\n{$GLOBALS['fails']} failed\n" : "\nall passed\n";
exit($GLOBALS['fails'] ? 1 : 0);
