<?php
/**
 * Sepand Inbox settings. Copy this file to config.php (same folder) and fill it in.
 * config.php is never overwritten by updates and cannot be downloaded from the web.
 *
 * The Instagram token and other Meta values are NOT set here; enter them in the
 * dashboard: Settings → «اتصال اینستاگرام».
 */
return [
    // MySQL database from cPanel → MySQL® Databases (full names, including the cPanel prefix).
    'db_host' => 'localhost',
    'db_name' => 'cpaneluser_sepand',
    'db_user' => 'cpaneluser_sepand',
    'db_pass' => '',

    // Dashboard login. Use a long, unique password (at least 10 characters).
    'admin_username' => 'admin',
    'admin_password' => '',

    // Random string of 32+ characters. Signs the login cookie and encrypts the saved Instagram token.
    // Changing it logs everyone out and means re-entering the Instagram settings.
    'secret' => '',
];
