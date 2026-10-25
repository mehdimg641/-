<?php
// Bale bridge for Sepand Inbox: called only by the Sepand Core (Supabase); see api/lib/chat_bridge.php.
declare(strict_types=1);

require __DIR__ . '/api/lib/bootstrap.php';
require __DIR__ . '/api/lib/auth.php';
require __DIR__ . '/api/lib/settings.php';
require __DIR__ . '/api/lib/accounts.php';
require __DIR__ . '/api/lib/rules.php';
require __DIR__ . '/api/lib/graph.php';
require __DIR__ . '/api/lib/inbox.php';
require __DIR__ . '/api/lib/chat_bridge.php';

chat_bridge_handle('bale', 'بله');
