# Task: take the Sepand Steel Meta app from Development to Live

Reply to me in Persian. Work in my own Chrome with Claude in Chrome. I am already signed in to developers.facebook.com.
- If Meta asks me to sign in, for 2FA, a password, ID documents or business verification documents, stop and let me do it.
- Never type, copy or repeat passwords, the App Secret or access tokens. If one appears on screen, don't read it out.
- Ask me before every submit, publish or delete click.

## Context
- The app is a Meta app using **Instagram API with Instagram Login** (Business Login for Instagram). It serves the company's own Instagram professional account **@sepandsteel**.
- The dashboard runs at `https://inbox.sepandsteel.com`. Its webhook is `https://inbox.sepandsteel.com/api/meta/webhook`.
- The app is in **Development** mode. In that mode, Meta only sends comments and messages from accounts that have a role on the app, so customer comments never arrive. The goal is to switch the app to **Live**, with the permissions the dashboard needs.
- Pages Meta needs already exist on the site. Open both first to confirm they load:
  - Privacy policy: `https://inbox.sepandsteel.com/privacy.html`
  - Data deletion instructions: `https://inbox.sepandsteel.com/data-deletion.html`

## Steps (check each one before moving on)

### 1. Find the app
Go to `https://developers.facebook.com/apps/`, open the app I use for Sepand Inbox, and tell me its name and App ID. If there is more than one app, ask me which one.

### 2. App settings → Basic
Fill in only what is empty or wrong, show me the values, then click **Save changes**:
- **Privacy Policy URL:** `https://inbox.sepandsteel.com/privacy.html`
- **User data deletion:** choose *Data deletion instructions URL*, then `https://inbox.sepandsteel.com/data-deletion.html`
- **Category:** *Business and pages*, or the closest "Business" option
- **App icon (1024×1024):** if none is set, ask me to upload the Sepand Steel logo myself
- **Contact email:** if empty, ask me which address to use; don't invent one
- Leave App Secret, App Domains and everything else unchanged unless I say so.

### 3. Check the webhook setup
Go to Use cases → Instagram API (Manage messaging & content on Instagram) → **API setup with Instagram business login**, or the Webhooks section of the Instagram product.
- Callback URL should be `https://inbox.sepandsteel.com/api/meta/webhook`. If it differs, tell me; don't change it yourself.
- The `comments` and `messages` fields should be **Subscribed**. If they are not, ask me, then subscribe them.

### 4. Permissions
Under the Instagram use case's permissions (Customize → Permissions, or App Review → Permissions and Features), make sure these are added:
- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`

Tell me the access level each one shows (Standard or Advanced) and whether Meta requires **App Review** or **Business Verification** for Advanced Access.

### 5. App Review (only if Meta requires it)
Start a request for the permissions above.
- Paste these descriptions as they are:
  - **instagram_business_basic:** Sepand Steel Inbox is an internal dashboard used only by Sepand Steel staff to manage the company's own Instagram professional account @sepandsteel. We use instagram_business_basic to read the connected account's ID and username, and to list the account's own posts (caption, thumbnail, permalink, comment count) so staff can see the comments under each post.
  - **instagram_business_manage_comments:** Customers ask about steel prices, sizes and delivery in the comments under @sepandsteel posts. The dashboard receives new comments through the comments webhook, shows the comments of each post, and lets staff reply publicly under a comment. Replies are drafted from saved templates and are sent only after a staff member approves them, or by a rule that staff explicitly enabled. We also read existing comments on our own posts so older customer questions can be answered.
  - **instagram_business_manage_messages:** When a customer comments with a keyword such as "price", the dashboard sends that customer one private reply to their comment with the requested details. Staff also answer customers' direct messages from the same inbox. Messages arrive through the messages webhook, and replies go only to people who contacted @sepandsteel first, within Meta's messaging windows.
- **Screencast:** Meta needs a screen recording. Don't record it yourself; tell me the script below so I can record it. The UI is in Persian, so I should add English captions or narration.
  1. Open `https://inbox.sepandsteel.com` and log in.
  2. Settings: the Instagram connection shows @sepandsteel as connected.
  3. From a tester account, comment "price?" under a @sepandsteel post. It appears in the Inbox and on the Posts page under that post.
  4. Approve the drafted public reply. Show it under the comment in Instagram.
  5. Approve the drafted DM. Show it arriving in the tester account's Instagram Direct.
  6. Reply to a direct message from the Inbox. Show it arriving in Instagram.
- If Meta asks for test credentials, tell me. Don't create accounts or share logins.
- **Stop before Submit** and show me the summary.

### 6. Publish
Open the **Publish** page from the left menu, or the App Mode switch at the top. List any requirement Meta still shows as missing. If none is missing, ask me, then switch the app to **Live**.

### 7. While review is pending: testers
If the app has to stay in Development until review finishes, offer to add one or two of my other Instagram accounts as testers: App roles → Roles → **Instagram Testers** → Add. Ask me for the usernames. Then tell me that each account must accept the invite in Instagram → Settings → Apps and websites → Tester invites. Comments and DMs from those accounts will then reach the dashboard.

## Report back (in Persian)
- What you changed: field → new value.
- Each permission's access level, and whether App Review or Business Verification is pending.
- Whether the app is Live now, and if not, exactly what is still missing.
- What I still need to do myself: the screencast, documents, icon, accepting tester invites.

After the app is Live, I will:
- generate a new token in the dashboard's Instagram setup and save it in Sepand Inbox → Settings
- press «فعال‌سازی دریافت کامنت و دایرکت» in the «عیب‌یابی دریافت پیام» card
