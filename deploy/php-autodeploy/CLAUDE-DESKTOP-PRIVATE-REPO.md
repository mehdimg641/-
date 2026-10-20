# Task: make the GitHub repo private without breaking the host's automatic updates

Reply to me in Persian. Use Claude in Chrome in my own Chrome. I am already signed in to GitHub and cPanel. If a page asks me to sign in, for 2FA, or for "sudo mode", stop and let me do it.

## Context (already done, do not redo)
- The repo is `https://github.com/mehdimg641/-`. It is public right now.
- The site `https://inbox.sepandsteel.com` is on a cPanel host. A cPanel **Cron Job** runs every 10 minutes.
  - It pulls the `deploy-php` branch of the repo into `~/sepand-deploy`.
  - It runs `update.sh`, which copies new builds into the site folder.
  - It appends output to `~/sepand-deploy.log`.
- `https://inbox.sepandsteel.com/version.json` already shows `"commit": "6400330"`. That build's `update.sh` reads a GitHub token from the file `~/sepand-github-token` when that file exists.
- After the repo becomes private, the host can only pull with that token. Without the file, updates stop.

## Hard rules for secrets
- **Never read, copy, type, store or repeat the token yourself.** Do not put it in chat, a screenshot description, a file you create, or a form other than the one below.
  - When the token appears on screen, stop and tell me to copy it.
  - I will paste it into the cPanel editor myself.
  - Do not use the GIF recorder or screenshots while the token is visible.
- Do not change anything else in GitHub or cPanel, such as other tokens, cron jobs, files or settings.
- Ask me before every irreversible step. Changing the repo's visibility is one.

## Steps (check each one before moving on)

### 1. Create a read-only fine-grained token
1. Open `https://github.com/settings/personal-access-tokens/new`. The path is Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Fill in the form:
   - **Token name:** `sepand-inbox-host-deploy`
   - **Expiration:** Custom, one year from today, or the longest the form allows.
   - **Resource owner:** `mehdimg641`
   - **Repository access:** *Only select repositories*, then pick `mehdimg641/-`.
   - **Permissions → Repository permissions → Contents:** `Read-only`. Leave every other permission as *No access*. GitHub adds *Metadata: Read-only* by itself; that is expected.
3. Show me the summary, then click **Generate token**.
4. **Stop here.** Tell me: "Copy the token now (starts with `github_pat_`). It is shown only once. Tell me when it is copied." Wait for me. Do not read it.

### 2. Store the token on the host
1. In cPanel, open **File Manager**. Go to the **home folder**: the top of the tree, where `public_html` and `sepand-deploy` are. **Do not** go into the site folder `inbox.sepandsteel.com`.
2. Check whether `sepand-github-token` already exists there. If it does, ask me before touching it.
3. Click **+ File**. The new file name is `sepand-github-token`, with no extension. The folder is the home folder. Click **Create New File**.
4. Right-click the file, choose **Edit**, then **Edit** again in the dialog. The editor opens in a new tab.
5. **Stop.** Tell me: "Paste the token into the editor (just the token, nothing else), click Save Changes, then tell me." Wait for me. Do not look at the editor content.
6. Close the editor tab. Back in File Manager, right-click `sepand-github-token` and choose **Change Permissions**. Set **600**: Owner read and write only; nothing for Group and World. Click **Change Permissions**.
7. Check: the file shows permissions `0600`, and its size is about 90–100 bytes. Report only the size, never the content.

### 3. Make the repo private
1. Open `https://github.com/mehdimg641/-/settings`. At the bottom, in **Danger Zone**, click **Change repository visibility** → **Change to private**.
2. **Ask me to confirm** before the final click. GitHub may ask me to type the repo name or re-authenticate; let me do that.
3. Check: the repo page shows the **Private** badge.

### 4. Check that the host can still pull
1. Note the current time. Wait about 12 minutes so at least one cron run happens after the change. Use the time for nothing else in cPanel or GitHub.
2. In File Manager's home folder, open `sepand-deploy.log`: right-click → View. Read only the lines written after the noted time.
   - **Healthy:** no new lines at all. The script is silent when nothing changed. Lines starting with `✓ deployed` are also healthy.
   - **Broken:** lines with `Authentication failed`, `Repository not found`, `could not read Username`, or `fatal:`.
3. If it is broken:
   - Check that the file is named exactly `sepand-github-token` and sits in the home folder, not in `sepand-deploy` or the site folder.
   - Check that the token has *Contents: Read-only* on `mehdimg641/-` and has not expired: GitHub → Settings → Fine-grained tokens → `sepand-inbox-host-deploy`.
   - If the token itself is wrong, regenerate it on its GitHub page and repeat step 2.4–2.5 so I paste the new one. Never undo step 3 without asking me.
4. Also open `https://inbox.sepandsteel.com/version.json` and report what it shows.

## Done when
- The repo is private.
- `~/sepand-github-token` exists in the home folder with permissions 0600, and I pasted the token into it myself.
- No authentication errors appear in `sepand-deploy.log` after the change.

Report back in Persian:
- what you did
- the log lines you saw after the change
- what `version.json` shows
- anything I still need to do

Then tell me to send this message to the Claude session that maintains the app: «مخزن خصوصی شد؛ یک نسخهٔ آزمایشی منتشر کن». That session will publish a new build. When `version.json` changes within about 10 minutes, the private pull is confirmed.
