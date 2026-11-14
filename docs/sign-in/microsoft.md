---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - microsoft-entra-id
operations: []
---

# Set up Microsoft SSO

This guide walks your IT administrator through connecting Caitlyn to your organisation's Microsoft Entra ID (formerly Azure Active Directory) so your team can sign in with their existing Microsoft work accounts. Setup takes about 20–30 minutes in the Azure portal, plus a few minutes in Caitlyn.

## What You'll Accomplish

By the end of this guide, you'll have:

- A Microsoft Entra ID app registration that lets your people sign in to Caitlyn with their Microsoft work accounts
- Two security groups (`Caitlyn_Chat` and `Caitlyn_Admin`) that control who can use chat and who can administer the platform
- Microsoft Entra ID added as a sign-in method in Caitlyn, with a **Sign in with Microsoft** button on your login page
- A clear understanding of every Microsoft Graph permission we request and why

## Who Should Set This Up

The Azure side (Steps 1 to 4) is a task for an **IT administrator** or someone with the **Application Administrator** (or higher) role in your Microsoft Entra ID tenant. Creating an app registration and granting admin consent both require directory-level privileges.

The Caitlyn side (Steps 5 and 6) can be done in one of two ways. Agree which with your Caitlyn onboarding contact before you start:

- **We add it for you.** We start the sign-in method and send you its callback URL. You complete Steps 1 to 4, registering the callback URL as you go, and send us the values listed at the end of Step 4.
- **You add it yourself.** We invite you to Caitlyn with a role that can add sign-in methods. Start with the first part of Step 5, which gives you the callback URL, then complete every step.

Either way, the callback URL is known before you start in Azure, so the whole setup is one pass. If a Caitlyn administrator in your organisation sent you a message listing what to set up, it includes the callback URL.

## Prerequisites

Before you begin, ensure you have:

- **Microsoft Entra ID admin access**: An account with permission to create app registrations and grant admin consent (Application Administrator, Cloud Application Administrator, or Global Administrator).
- **Your Caitlyn domain**: The URL we have provisioned for you (e.g. `https://your-company.getcaitlyn.ai`). We provide this. Contact us if you don't have it yet.
- **If you are adding the sign-in method yourself**: A Caitlyn account that can open **Settings → Sign-in Methods** and add a method. We send you an email invite with a suitable role.

> **Note**: Caitlyn is configured as **single-tenant** by default. Only members of your organisation's Entra ID directory will be able to sign in. You do not need to expose anything to the public internet or to other Microsoft tenants.

## Step 1: Create the App Registration

The app registration is the identity Caitlyn uses to ask Microsoft "is this person who they say they are?". It does not grant Caitlyn any standing access to your directory on its own. That access is governed by the permissions you set in Step 3.

1. Go to the [Azure portal](https://portal.azure.com).
2. Open **Microsoft Entra ID → App registrations**, then click **New registration**.

3. Give it a clear name, for example **`Caitlyn`**.
4. Under **Supported account types**, choose **Single tenant only** followed by your organisation's name.
5. Under **Redirect URI**, choose **Web** and paste the callback URL you were sent, exactly as written. If you do not have it yet, leave this empty and add it in Step 6.
6. Click **Register**.

## Step 2: Collect the Credentials

Caitlyn needs three values from the registration you just created. Each one goes into a field of the same name when the sign-in method is added in Step 5.

| Caitlyn field             | Where to find it in the Azure portal                                             | Example                                |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| **Client ID**             | **Overview → Application (client) ID**                                           | `b4c1e0f7-9d3a-4a52-8f6b-7c21e0d94a18` |
| **Client Secret**         | **Certificates & secrets → New client secret**, then copy the secret's **Value** | a long random string                   |
| **Directory (Tenant) ID** | **Overview → Directory (tenant) ID**                                             | `8f7a2c14-3b9e-4d61-a0c5-71fbb0e5c9d2` |

### Client ID and Tenant ID

Both values are on the app registration's **Overview** page, under **Essentials**. Use the copy button beside each value rather than selecting the text.

### Client Secret

1. In the app's left sidebar, go to **Certificates & secrets**, open the **Client secrets** tab, and click **New client secret**.
2. Enter a **Description** (for example **`Caitlyn`**), choose an **Expires** period, and click **Add**.

> **Note**: Client secrets expire. Note the expiry date you chose, and before then create a new secret and replace the stored one in Caitlyn (**Settings → Sign-in Methods → Edit → Replace credentials**), or send it to us. We recommend a 12- or 24-month expiry.

3. Copy the new secret's **Value** with the copy button beside it.

## Step 3: Add Microsoft Graph Permissions

This is the step most administrators rightly scrutinise, so the next section explains the reasoning in full. In short, Caitlyn requests four narrow delegated permissions: three are needed for sign-in, session refresh, and group-based access control; the fourth powers an optional sharing picker and doesn't require admin consent.

1. In the app's left sidebar, go to **API permissions → Add a permission**.

2. Choose **Microsoft Graph → Delegated permissions**.

> **Note**: Choose **Delegated permissions**, not **Application permissions**. Delegated permissions mean Caitlyn only ever acts _as the person who is signed in_, and only ever sees what that person is already allowed to see. Application permissions would let Caitlyn read your directory unattended, in the background, which is **not** how Caitlyn works and not something we ask for.

3. Tick the permissions (see the table below for what each one does):
   - **`User.Read`**: required for sign-in.
   - **`GroupMember.Read.All`**: required; how Caitlyn reads which of your security groups the signed-in person belongs to (the `Caitlyn_Chat` / `Caitlyn_Admin` mapping in Step 4).
   - **`User.ReadBasic.All`**: optional; only for per-document sharing with named people.
   - **`offline_access`**: required, so your team isn't forced to re-authenticate every hour.

Microsoft Graph sorts its permissions into groups, so the four permissions are in three different places in the list. Expand each group to find them, or type a permission's name into the **Select permissions** search box.

`offline_access` is in **OpenId permissions**, the first group in the list:

`User.Read` and `User.ReadBasic.All` are in the **User** group:

`GroupMember.Read.All` is in the **GroupMember** group:

4. Click **Add permissions**. If you are adding permissions to a registration that already has some, the button reads **Update permissions**.

The four permissions are now listed under **Configured permissions**. `GroupMember.Read.All` shows **Not granted** in the **Status** column until you grant admin consent in the next step.

5. Click **Grant admin consent for `{Your Organisation}`**, then click **Yes** to confirm. You should see a green tick in the **Status** column for each permission.

## Why Caitlyn Asks for These Permissions

A fair question from any security-conscious administrator is: "Why do you need to read group memberships and list users? Isn't a `*.All` permission an overreach?" Here is exactly what Caitlyn does with each permission, so you can make an informed decision.

### Caitlyn only acts as the signed-in user

Every call Caitlyn makes to Microsoft Graph uses **delegated permissions**: that is, it acts on behalf of the person who just signed in, using their token, and can only see what that person could already see. Caitlyn does not hold a standalone, app-only credential that reads your directory in the background.

### The permissions in detail

| Permission                 | What Caitlyn does with it                                                                                                                                                                     | Required?                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **`User.Read`**            | Reads **the signed-in user's own** profile (their name and email).                                                                                                                            | **Required** for sign-in                    |
| **`offline_access`**       | Lets Caitlyn quietly refresh the sign-in session so your team isn't kicked out every hour. It grants no directory access of its own.                                                          | **Required** for usable sessions            |
| **`GroupMember.Read.All`** | Reads **the signed-in user's own** group memberships, so we can map your security groups to a role inside Caitlyn, and lists group names so an admin can share a document with a named group. | **Required** for group-based access control |
| **`User.ReadBasic.All`**   | Lists basic profiles (name and email) in your directory **only** to populate a picker when an admin chooses to share a specific document with a specific named person.                        | **Optional** — no admin consent needed      |

### Why `GroupMember.Read.All` is on the list

The whole "who can chat / who can administer" decision works by reading _the signed-in person's own_ group memberships and matching them against `Caitlyn_Chat` and `Caitlyn_Admin` (Step 4). Microsoft only offers group-membership reads behind an admin-consent permission, and `GroupMember.Read.All` is the **least-privileged** one they provide — it reads group names and memberships, and nothing else in your directory.

Caitlyn deliberately does **not** request `User.Read.All` (full user profiles), `Group.Read.All` (full group objects) or `Directory.Read.All` (the entire directory: devices, applications, contacts, and more). If a member of your team suggests granting one of those instead, decline — they are supersets of what Caitlyn uses.

### What you lose by declining `User.ReadBasic.All`

`User.ReadBasic.All` powers a single optional feature: restricting an **individual document** to **specific named people**. To offer that, Caitlyn needs to show your admins a picker of the people in your directory.

If you decline it:

- Sign-in works normally.
- Access via the `Caitlyn_Chat` and `Caitlyn_Admin` groups works normally.
- Admins can still mark a document as available to **all signed-in users**, restrict it to **named groups**, or keep it **private**.
- The only thing unavailable is the "share this one document with this one named person" picker: it simply won't populate.

You can change the granted permissions in the Azure portal at any time.

## Step 4: Create the Caitlyn Security Groups

Caitlyn decides what each person can do based on which security groups they belong to. Membership takes effect at the user's next sign-in.

| Group name      | Who to add                                          | What it grants               |
| --------------- | --------------------------------------------------- | ---------------------------- |
| `Caitlyn_Chat`  | Everyone who should be able to use Caitlyn chat     | Access to the chat interface |
| `Caitlyn_Admin` | People who manage Caitlyn settings, documents, etc. | Access to the admin panel    |

To create each group:

1. In the [Microsoft Entra admin centre](https://entra.microsoft.com/), go to **Entra ID → Groups → All groups**, then select **New group**.

2. Configure:
   - **Group type:** Security
   - **Group name:** `Caitlyn_Chat` (then repeat for `Caitlyn_Admin`)
   - **Membership type:** Assigned

3. Add the relevant members under **Members**, then select **Create**. You can also add members after the group is created, from the group's **Members** page with **Add members**.

4. Repeat for the second group.

> **Note**: A person who needs admin access should be added to **both** groups; admin access does not automatically include chat access. You can add or remove members at any time; changes take effect at that person's next sign-in.

After creating each group, open it and copy its **Object ID** from the group's **Overview** page with the copy button beside it. Caitlyn needs the Object ID, not the group's name.

If we are adding the sign-in method for you, send your Caitlyn onboarding contact these values, with the client secret through a secure channel rather than plain email:

```text
Client ID              — <Application (client) ID>
Client Secret          — <client secret Value>
Directory (tenant) ID  — <Directory (tenant) ID>
Caitlyn_Admin group    — <Object ID>
Caitlyn_Chat group     — <Object ID>
```

If you have not registered the callback URL yet, do Step 6 now. We'll do Step 5, then let you know, so you can go to Verify It Works.

## Step 5: Add the Sign-in Method in Caitlyn

Skip this step if we are adding the sign-in method for you.

Caitlyn walks you through adding the method as a checklist of four steps. Finishing its first step gives you the callback URL, so you can do that before Step 1 and register the URL as you create the app registration.

1. Sign in to Caitlyn and open **Settings → Sign-in Methods**, then click **Add sign-in method**.
2. Under **Choose a provider**, select **Microsoft Entra ID**. This can't be changed later.
3. **Login button label** (optional): the text on the login button, for example "Staff login". Leave it empty to show the provider's own name. You can change it later with **Edit label**, before or after the credentials are entered.
4. Click **Continue**. Under **Send a request to your IT team**, Caitlyn shows the method's **Callback URL**, with a message listing everything to set up in Azure. Leave this page open, or close it with **Finish later** and come back with **Finish setup** on the method's card in **Settings → Sign-in Methods**.
5. Under **Enter what they send back**, enter the **Client ID**, **Client Secret** and **Directory (Tenant) ID** from Step 2. Caitlyn checks the tenant ID is in the right format before it saves.
6. Under **Choose who gets access**, a table maps each Caitlyn role to a group, in the **Group Object ID** column:
   - In the **Admin** row, which is required, enter the `Caitlyn_Admin` group's Object ID.
   - The **Chat user** row is there already, with its group empty, which would let everyone who signs in through the method use chat. Enter the `Caitlyn_Chat` group's Object ID in it, so only members of that group can.
   - To give another Caitlyn role to a group, click **Role mapping** under the table and fill in the new row.
7. Click **Finish setup**.

> **Important**: Caitlyn stores the client secret without ever reading it back, so it cannot show it to you again or check it is correct. A method can look correctly set up and still fail. The sign-in test under **Verify It Works** is the only real check.

Full detail on this page, including renaming and replacing credentials later, is in **Managing Sign-in Methods** in Caitlyn's Help.

## Step 6: Register the Callback URL

Skip this step if you registered the callback URL in Step 1. Caitlyn shows the **Callback URL** from the moment the sign-in method is created. It looks like this:

```text
https://your-company.getcaitlyn.ai/api/auth/callback/microsoftEntraId__<id>
```

Sign-in fails until this URL is registered on the app registration.

1. In the [Azure portal](https://portal.azure.com), open **App registrations → your app → Authentication**. The portal may label this page **Authentication (Preview)**.
2. On the **Redirect URI configuration** tab, click **Add Redirect URI**, then choose **Web** under **Web applications**. If a Web platform already exists, add a new entry to it instead.

3. Paste the callback URL into **Redirect URI** exactly as Caitlyn shows it. Use the copy button in Caitlyn rather than retyping it.
4. Under **Implicit grant and hybrid flows**, ensure **Access tokens** and **ID tokens** are both ticked.
5. Click **Configure**. In the older Authentication page, this button is **Save**.

The callback URL is now listed under the **Web** platform.

> **Note**: If you have both a staging and a production Caitlyn domain, each has its own sign-in method and its own callback URL. Add both URLs to the same app registration.

## Verify It Works

1. Open your Caitlyn domain in a private/incognito browser window.
2. Click the Microsoft sign-in button.
3. Sign in with a Microsoft work account that is a member of `Caitlyn_Chat`.
4. You should be redirected back to Caitlyn and signed in.

**It works when:**

- You're redirected back to Caitlyn and land in the chat interface.
- A member of `Caitlyn_Admin` additionally sees the settings/admin area.
- A member of neither group is signed in by Microsoft but has no access inside Caitlyn, confirming that group membership is the gate.

**If it doesn't:**

- Sign-in is rejected with a tenant or redirect error: see Troubleshooting below.

## Troubleshooting

### Issue: "AADSTS50020: User account from identity provider does not exist in tenant"

**Symptoms**: A user is bounced out during sign-in with this error.

**Solutions**:

1. Confirm the user is a member of the Entra ID tenant whose Directory (tenant) ID was entered on the sign-in method.
2. Confirm the sign-in method has the correct **Directory (Tenant) ID**. Caitlyn cannot show the stored value, so if in doubt, use **Replace credentials** to enter the full set again, or resend the values to us.

### Issue: Sign-in fails with redirect_uri_mismatch

**Symptoms**: Microsoft shows an error about the reply/redirect URL after you enter your credentials. The error quotes a Caitlyn URL, so it reads like a Caitlyn fault.

**Solutions**:

1. In **Authentication → Web**, confirm the callback URL from Step 6 is listed and matches exactly, including `https://`, the subdomain, and the `microsoftEntraId__<id>` ending.
2. Check it was not pasted with a trailing slash.
3. If you have staging and production domains, confirm both callback URLs are registered.

### Issue: Sign-in works but grants no access

**Symptoms**: People sign in with Microsoft and reach Caitlyn, but chat or the admin area is missing.

**Solutions**:

1. Confirm the person is a member of `Caitlyn_Chat` or `Caitlyn_Admin` in Entra, then have them sign out and back in.
2. Confirm the Object IDs entered in Step 5 are the Object IDs of those groups, not their names or another group's ID.
3. Confirm the **Chat user** row holds the `Caitlyn_Chat` Object ID. Afterwards, the mappings live in **Settings → Users → Manage Roles**, under the role chat users hold (usually **Guest**). **Managing Roles and Permissions** in Caitlyn's Help covers role and group bindings in full.

### Issue: Permissions or consent error

**Symptoms**: Users see a message that the app requires permissions an administrator must approve, and sign-in can't complete.

**Solutions**:

1. In **API permissions**, confirm **Grant admin consent** shows a green tick for each permission you added.
2. Confirm the permissions are **Delegated**, not Application.
3. Caitlyn requests all the Step 3 permissions together at sign-in, so if any of them was skipped in the portal, Microsoft will prompt for approval. Granting admin consent for the full Step 3 list up front prevents the prompt entirely.

### Issue: The document-sharing picker is empty

**Symptoms**: An admin tries to share a document with a specific person, and the picker shows nobody.

**Solutions**:

1. This is expected if `User.ReadBasic.All` wasn't granted. To enable the people picker, add it in **API permissions** and grant consent.
2. After adding the permission, the change takes effect on the next sign-in.

### Issue: Users are signed out after about an hour

**Symptoms**: Sessions drop roughly every hour and require re-authentication.

**Solutions**:

1. Confirm `offline_access` is among the granted permissions: it's what lets Caitlyn refresh the session silently.

## What's next

- **Managing Sign-in Methods** in Caitlyn's Help: rename the sign-in button, replace an expiring client secret, or remove the method.
- [Sign-in options](/sign-in/options/): how Caitlyn handles sign-in, sessions and access across every provider.
- [Embed chat in five minutes](/embed/quick-start/): put the chat on your intranet once your people can sign in.
- [Google Workspace SSO](/sign-in/google-workspace/) and [Auth0 SSO](/sign-in/auth0/): the same setup for other providers.
