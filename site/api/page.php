<?php
/**
 * Serves the static privacy and data deletion pages with a plain 200. Meta's crawler asks for a
 * byte range, LiteSpeed answers static files with "206 Partial Content", and Meta's privacy policy
 * check rejects anything but 200. No Content-Length and no LiteSpeed cache entry, so the server has
 * nothing to cut a range from.
 */

declare(strict_types=1);

const PAGES = ['privacy', 'data-deletion'];

$name = (string) ($_GET['name'] ?? '');
$file = dirname(__DIR__) . '/' . $name . '.html';
if (!in_array($name, PAGES, true) || !is_file($file)) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not found';
    exit;
}
http_response_code(200);
header('Content-Type: text/html; charset=utf-8');
header('Accept-Ranges: none');
header('Cache-Control: no-cache, no-transform');
header('X-LiteSpeed-Cache-Control: no-cache');
// Lets anyone check, e.g. in the browser's network tab, that the request came through here.
header('X-Sepand-Page: ' . $name);
echo file_get_contents($file);
