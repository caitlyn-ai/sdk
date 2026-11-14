---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - google-workspace
operations: []
---

# Set up Google Workspace SSO

This guide walks your IT administrator through connecting Caitlyn to your organisation's Google Workspace, so your team can sign in with their existing Google work accounts. Setup takes about 30 minutes across Google Cloud Console and the Google Admin console, plus a few minutes in Caitlyn.

## What You'll Accomplish

By the end of this guide, you'll have:

- A Google OAuth client that lets your people sign in to Caitlyn with their Google work accounts
- A service account with read-only access to your users and groups, which Caitlyn uses to match people to your Caitlyn groups and to fill its sharing pickers
- Two groups (`Caitlyn_Chat` and `Caitlyn_Admin`) that control who can use chat and who can administer the platform
- Google added as a sign-in method in Caitlyn, with a **Sign in with Google** button on your login page

## Who Should Set This Up

The Google side (Steps 1 to 5) is a task for an **IT administrator** who can create projects and credentials in Google Cloud Console and is a **super administrator** in the Google Admin console. Creating an admin role and assigning it needs super administrator rights, or a delegated admin role that can manage admin roles.

The Caitlyn side (Steps 6 and 7) can be done in one of two ways. Agree which with your Caitlyn onboarding contact before you start:

- **We add it for you.** We start the sign-in method and send you its callback URL. You complete Steps 1 to 5, registering the callback URL as you go, and send us the values listed at the end of Step 5.
- **You add it yourself.** We invite you to Caitlyn with a role that can add sign-in methods. Start with the first part of Step 6, which gives you the callback URL, then complete every step.

Either way, the callback URL is known before you start in Google, so the whole setup is one pass. If a Caitlyn administrator in your organisation sent you a message listing what to set up, it includes the callback URL.

## Prerequisites

Before you begin, ensure you have:

- **Google Cloud Console access**: permission to create a project (or use an existing one), configure its OAuth consent screen, and create OAuth clients and service accounts.
- **Google Admin console super administrator access**: needed in Step 4 to give the service account a read-only admin role.
- **Your Caitlyn domain**: the URL we have provisioned for you (e.g. `https://your-company.getcaitlyn.ai`). We provide this. Contact us if you don't have it yet.
- **If you are adding the sign-in method yourself**: a Caitlyn account that can open **Settings → Sign-in Methods** and add a method. We send you an email invite with a suitable role.

## Step 1: Configure the OAuth Consent Screen

The consent screen is what your people see the first time they sign in with Google. Setting its audience to **Internal** limits sign-in to accounts in your own Google Workspace organisation.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and select (or create) the project you want to hold Caitlyn's credentials, for example **`Caitlyn`**.
2. Open **APIs & Services → OAuth consent screen**. Newer versions of the console show this as **Google Auth Platform**.
3. Enter an app name (for example **`Caitlyn`**) and a support email.
4. Under **Audience** (or **User type**), choose **Internal**. If **Internal** is not offered, the project is not in your Workspace organisation: create it under your organisation instead.
5. Save.

> **Note**: With an **External** audience, anyone with a Google account could complete the Google side of sign-in. They would reach Caitlyn with no role, because roles come from your groups, but **Internal** keeps everyone outside your organisation out at Google's door.

## Step 2: Create the OAuth Client

The OAuth client is the identity Caitlyn uses to ask Google "is this person who they say they are?". It gives Caitlyn no access to your directory on its own; that comes from Step 4.

1. In the same project, open **APIs & Services → Credentials**, click **Create credentials**, then choose **OAuth client ID**.
2. Under **Application type**, choose **Web application**, and give it a name, for example **`Caitlyn`**.
3. Under **Authorised redirect URIs**, click **Add URI** and paste the callback URL you were sent, exactly as written. If you were sent more than one (one for each of your Caitlyn addresses), add each one. If you do not have it yet, leave this empty and add it in Step 7.
4. Click **Create**.
5. Copy the **Client ID** and **Client secret** from the dialog that opens.

The client ID ends in `.apps.googleusercontent.com`. That is the value Caitlyn's **Client ID** field takes. The service account you create next has a long numeric client ID of its own, which is a different value; Caitlyn refuses it in this field.

> **Important**: Treat the client secret like a password. Send it to Caitlyn through a secure channel, never plain email.

## Step 3: Create the Service Account and Its Key

Caitlyn reads which of your groups each person belongs to through a service account: a Google identity for software rather than for a person. Directory reads go through the Admin SDK API, so that API must be switched on in the same project.

1. In the same project, open **APIs & Services → Library**, search for **Admin SDK API**, open it and click **Enable**.
2. Open **IAM & Admin → Service accounts**, then click **Create service account**.
3. Give it a name, for example **`caitlyn-directory-reader`**, and click **Create and continue**. It needs no project roles, so skip the optional steps and click **Done**.
4. Open the new service account and copy its **email** (it ends in `.iam.gserviceaccount.com`). You need it in Step 4.
5. Open the **Keys** tab, click **Add key → Create new key**, choose **JSON**, and click **Create**. The key file downloads to your computer. If Google says key creation is disabled, see [Service account key creation is disabled](#issue-service-account-key-creation-is-disabled).

> **Important**: The JSON key file grants whatever access the service account has. Store it securely, send it to Caitlyn through a secure channel, and delete your local copy once the sign-in method is set up.

The key file is not the same as the file Google offers when you download the OAuth client from Step 2. Caitlyn checks the file when it is chosen and says so if you pick the OAuth client file by mistake.

## Step 4: Give the Service Account Read-Only Directory Access

The service account can't read anything in your directory until you give it an admin role. Create a role that can only read users and groups, and assign it to the service account.

1. In the [Google Admin console](https://admin.google.com/), go to **Account → Admin roles**, then click **Create new role**.
2. Name it, for example **`Caitlyn directory reader`**, and click **Continue**.
3. Under **Admin API privileges**, tick **Users → Read** and **Groups → Read**. Leave everything else unticked.
4. Click **Continue**, then **Create role**.

5. On the new role's page, open **Admins**, choose **Assign service accounts**, paste the service account email from Step 3, and click **Add**, then **Assign role**.

Caitlyn does not need domain-wide delegation, and the service account never signs in as one of your users.

## Why Caitlyn Needs Directory Access

A fair question from any security-conscious administrator is: "Why does a chat assistant need an admin role in our directory?" Here is exactly what Caitlyn does with it.

| What Caitlyn reads                                                    | When                                                           | Why                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| The groups a person is a direct member of                             | Each time they sign in                                         | To match them against `Caitlyn_Chat` and `Caitlyn_Admin` and give them the right role |
| A person's directory record (Caitlyn keeps only their Google user ID) | Each time they sign in                                         | So documents an admin has shared with that person by name reach them                  |
| The list of groups in your Workspace domain                           | When an admin picks a group to give a role or share a document | To populate the group picker                                                          |
| The list of people in your Workspace domain                           | When an admin shares a document with a named person            | To populate the people picker                                                         |

Every one of these is a read. The role you created in Step 4 holds only **Users → Read** and **Groups → Read**, so the service account cannot create, change or delete anything in your directory, and it cannot read email, files or calendars. Caitlyn only asks for the users and groups in the **Workspace Domain** you give it.

Google's directory API only answers an identity that holds an admin role, and an ordinary staff sign-in has none. Caitlyn therefore reads through a service account with a read-only role, rather than with the signed-in person's own token as it does for Microsoft Entra ID.

## Step 5: Create the Caitlyn Groups

Caitlyn decides what each person can do based on which Google groups they belong to. Membership takes effect at the person's next sign-in.

| Group name      | Who to add                                          | What it grants               |
| --------------- | --------------------------------------------------- | ---------------------------- |
| `Caitlyn_Chat`  | Everyone who should be able to use Caitlyn chat     | Access to the chat interface |
| `Caitlyn_Admin` | People who manage Caitlyn settings, documents, etc. | Access to the admin panel    |

To create each group:

1. In the [Google Admin console](https://admin.google.com/), go to **Directory → Groups**, then click **Create group**.
2. Enter the group name (`Caitlyn_Chat`, then repeat for `Caitlyn_Admin`) and a group email in your Workspace domain, then finish creating it.
3. Add the relevant people as members.

> **Note**: Add people to these groups **directly**. Caitlyn reads only the groups a person is a direct member of, so someone who belongs only through another group they are in is not counted. A person who needs admin access should be added to **both** groups; admin access does not automatically include chat access.

After creating each group, find its **unique ID**. Open the group in the Admin console: the ID is the last part of the address in your browser's address bar, after `/groups/`, and looks like `03dy6vkm0osm5wg`. Caitlyn needs this ID, not the group's name or email address.

If we are adding the sign-in method for you, send your Caitlyn onboarding contact these values, with the client secret and key file through a secure channel rather than plain email:

```text
Client ID                 — <OAuth client ID ending .apps.googleusercontent.com>
Client Secret             — <OAuth client secret>
Service account key file  — <the JSON key file from Step 3>
Workspace domain          — <your primary domain, e.g. your-org.com>
Caitlyn_Admin group       — <unique ID>
Caitlyn_Chat group        — <unique ID>
```

If you have not registered the callback URL yet, do Step 7 now. We'll do Step 6, then let you know, so you can go to Verify It Works.

## Step 6: Add the Sign-in Method in Caitlyn

Skip this step if we are adding the sign-in method for you.

Caitlyn walks you through adding the method as a checklist of four steps. Finishing its first step gives you the callback URL, so you can do that before Step 2 and register the URL as you create the OAuth client.

1. Sign in to Caitlyn and open **Settings → Sign-in Methods**, then click **Add sign-in method**.
2. Under **Choose a provider**, select **Google Workspace**. This can't be changed later.
3. **Login button label** (optional): the text on the login button, for example "Staff login". Leave it empty to show the provider's own name. You can change it later with **Edit label**.
4. Click **Continue**. Under **Send a request to your IT team**, Caitlyn shows the method's **Callback URL**, with a message listing everything to set up in Google. Leave this page open, or close it with **Finish later** and come back with **Finish setup** on the method's card in **Settings → Sign-in Methods**.
5. Under **Enter what they send back**, fill in:
   - **Workspace Domain**: your primary domain, the part after the `@` in your staff email addresses.
   - **Client ID** and **Client Secret**: from Step 2.
   - **Service Account Key File**: click the area or drop the JSON key file from Step 3 onto it. Caitlyn reads the file in your browser and shows the service account's email. Check it is the account you assigned the role to in Step 4.
6. Under **Choose who gets access**, a table maps each Caitlyn role to a group, in the **Google group ID** column:
   - In the **Admin** row, which is required, enter the `Caitlyn_Admin` group's unique ID.
   - The **Chat user** row is there already, with its group empty, which would let everyone who signs in through the method use chat. Enter the `Caitlyn_Chat` group's unique ID in it, so only members of that group can.
   - To give another Caitlyn role to a group, click **Role mapping** under the table and fill in the new row.
7. Click **Finish setup**.

> **Important**: Caitlyn stores the client secret and key without ever reading them back, so it cannot show them to you again or check they are correct. A method can look correctly set up and still fail. The sign-in test under **Verify It Works** is the only real check.

Full detail on this page, including renaming and replacing credentials later, is in **Managing Sign-in Methods** in Caitlyn's Help.

## Step 7: Register the Callback URL

Skip this step if you registered the callback URL in Step 2. Caitlyn shows the **Callback URL** from the moment the sign-in method is created. It looks like this:

```text
https://your-company.getcaitlyn.ai/api/auth/callback/google__<id>
```

Sign-in fails until this URL is registered on the OAuth client.

1. In [Google Cloud Console](https://console.cloud.google.com/), open **APIs & Services → Credentials** and click your OAuth client's name.
2. Under **Authorised redirect URIs**, click **Add URI** and paste the callback URL exactly as Caitlyn shows it. Use the copy button in Caitlyn rather than retyping it.
3. If Caitlyn shows more than one callback URL (one for each address your Caitlyn site is reached on), add each one.
4. Click **Save**. Google says a change can take a few minutes to apply.

> **Note**: If you have both a staging and a production Caitlyn domain, each has its own sign-in method and its own callback URL. Add both URLs to the same OAuth client.

## Verify It Works

1. Open your Caitlyn domain in a private/incognito browser window.
2. Click the Google sign-in button.
3. Sign in with a Google work account that is a direct member of `Caitlyn_Chat`.
4. You should be redirected back to Caitlyn and signed in.

**It works when:**

- You're redirected back to Caitlyn and land in the chat interface.
- A member of `Caitlyn_Admin` additionally sees the settings/admin area.
- A member of neither group is signed in by Google but has no access inside Caitlyn, confirming that group membership is the gate.

**If it doesn't:**

- Google shows an error before returning to Caitlyn, or people arrive with no access: see Troubleshooting below.

## Troubleshooting

### Issue: Sign-in fails with redirect_uri_mismatch

**Symptoms**: Google shows **Error 400: redirect_uri_mismatch** after the person chooses their account. The error quotes a Caitlyn URL, so it reads like a Caitlyn fault.

**Solutions**:

1. In the OAuth client's **Authorised redirect URIs**, confirm the callback URL from Step 7 is listed and matches exactly, including `https://`, the subdomain, and the `google__<id>` ending.
2. Check it was not pasted with a trailing slash.
3. If Caitlyn shows several callback URLs, or you have staging and production domains, confirm every one is registered.
4. Wait a few minutes after saving, then try again.

### Issue: "Access blocked: this app can only be used within its organisation"

**Symptoms**: Google refuses the sign-in with an `org_internal` error.

**Solutions**:

1. The person is signing in with an account outside your Workspace organisation, and the consent screen is set to **Internal** (Step 1). Have them use their work account.
2. If they are using their work account, confirm the OAuth client is in a Cloud project that belongs to your Workspace organisation.

### Issue: Saving fails with a message about the client ID

**Symptoms**: **Finish setup** is refused with a message that the Google client ID must end in `.apps.googleusercontent.com`.

**Solutions**:

1. The numeric client ID of the service account was entered in **Client ID**. Use the OAuth client's ID from Step 2 instead.

### Issue: Service account key creation is disabled

**Symptoms**: In Step 3, Google refuses to create the JSON key with a message that service account key creation is disabled by an organisation policy.

**Solutions**:

1. Google turns on the `iam.disableServiceAccountKeyCreation` policy by default in newer Google Cloud organisations. Caitlyn needs a JSON key, so ask someone with the **Organization Policy Administrator** role to override that policy for the Caitlyn project only, then create the key.
2. Leave the policy in force everywhere else. The override applies to the one project that holds Caitlyn's service account.

### Issue: The key file is rejected

**Symptoms**: Caitlyn says the chosen file is not a service-account key, or is missing values.

**Solutions**:

1. Make sure you chose the JSON key from the service account's **Keys** tab (Step 3), not the OAuth client download from Step 2.
2. Upload the file exactly as Google downloaded it, without opening and saving it in an editor.
3. If it is still refused, create a new JSON key for the service account and use that.

### Issue: People sign in but get no access

**Symptoms**: People sign in with Google and reach Caitlyn, but chat or the admin area is missing.

**Solutions**:

1. Confirm the person is a **direct** member of `Caitlyn_Chat` or `Caitlyn_Admin`, then have them sign out and back in.
2. Confirm the IDs entered in Step 6 are the groups' unique IDs, not their names or email addresses.
3. Confirm the **Chat user** row holds the `Caitlyn_Chat` group's unique ID. Afterwards, the mappings live in **Settings → Users → Manage Roles**, under the role chat users hold (usually **Guest**). **Managing Roles and Permissions** in Caitlyn's Help covers role and group bindings in full.
4. Confirm the service account holds the read-only admin role (Step 4), and that the **Admin SDK API** is enabled in its project (Step 3). Without both, Caitlyn cannot read anyone's groups.
5. Confirm **Workspace Domain** is your primary domain and that the groups' email addresses are in it. Caitlyn cannot show the stored values, so if in doubt, use **Replace credentials** to enter the full set again, or resend the values to us.

### Issue: The group or people picker is empty

**Symptoms**: An admin tries to give a group a role or share a document, and the picker shows nothing.

**Solutions**:

1. Check the same things as the previous issue: the service account's admin role, the Admin SDK API, and the Workspace domain. The pickers use the same directory access as sign-in.

## What's next

- **Managing Sign-in Methods** in Caitlyn's Help: rename the sign-in button, replace the client secret or key file, or remove the method.
- [Sign-in options](/sign-in/options/): how Caitlyn handles sign-in, sessions and access across every provider.
- [Embed chat in five minutes](/embed/quick-start/): put the chat on your intranet once your people can sign in.
- [Microsoft SSO](/sign-in/microsoft/) and [Auth0 SSO](/sign-in/auth0/): the same setup for other providers.
