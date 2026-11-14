---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - auth0
operations: []
---

# Set up Auth0 SSO

This guide walks your IT administrator through connecting Caitlyn to your organisation's Auth0 tenant, so your team can sign in with the accounts Auth0 already manages for them, including any enterprise connection (such as Okta, SAML or a corporate directory) you have set up in Auth0. Setup takes about 15 minutes in the Auth0 dashboard, plus a few minutes in Caitlyn.

## What You'll Accomplish

By the end of this guide, you'll have:

- An Auth0 application that lets your people sign in to Caitlyn
- A post-login Action that tells Caitlyn which groups or roles each person has
- Your Auth0 roles or groups mapped to Caitlyn's roles, so the right people can use chat and administer the platform
- Auth0 added as a sign-in method in Caitlyn, with a login button on your login page

## Who Should Set This Up

The Auth0 side (Steps 1 to 3) is a task for someone who can create applications and Actions in your Auth0 tenant, usually a tenant **Admin**.

The Caitlyn side (Step 4) can be done in one of two ways. Agree which with your Caitlyn onboarding contact before you start:

- **We add it for you.** We start the sign-in method and send you a message with what to set up. You complete Steps 1 to 3 and send us the values listed at the end of Step 3.
- **You add it yourself.** We invite you to Caitlyn with a role that can add sign-in methods. Start with the first part of Step 4, which gives you the message with what to set up, then complete every step.

If a Caitlyn administrator in your organisation sent you a message listing what to set up, it includes the address to import from (or the callback URL, if you are creating the application by hand).

## If You Manage Both Auth0 and Caitlyn

If you can add sign-in methods in Caitlyn and you are an **Admin** of your Auth0 tenant, Caitlyn can do Steps 1 to 3 for you. It creates the application, enables your connections for it, and adds the Action that sends groups to Caitlyn.

1. In Caitlyn, open **Settings → Sign-in Methods**, click **Add sign-in method**, choose **Auth0**, and click **Continue**.
2. Under **Connect your Auth0 tenant**, leave **Set it up for me** chosen.
3. In the [Auth0 dashboard](https://manage.auth0.com), open **Applications → APIs → Auth0 Management API → API Explorer**, and copy the token. Caitlyn uses it once to set things up and does not keep it.
4. Back in Caitlyn, enter your **Auth0 domain** (your custom domain from **Branding → Custom Domains**, if people sign in through one), paste the token into **Temporary Management API token**, and click **Connect**. Caitlyn checks what the token can do and lists your Auth0 roles and connections. Nothing is created yet.
5. Under **Choose who gets access**, pick the Auth0 role for **Admin**, which is required. If your tenant has no suitable role, choose **Create a “Caitlyn Admin” role**: Caitlyn creates it, and gives it to you in the last step. Leave **Chat user** on **Everyone who signs in**, or pick or create a role, and use **Role mapping** to add any other Caitlyn role. If you add a role in Auth0 meanwhile, reload the list with the button beside **Auth0 role**.
6. Under **Auth0 connections**, tick the connections your staff sign in with. Connections anyone can sign up through start unticked and carry a badge: a database or passwordless connection with Auth0's **Disable Sign Ups** turned off says **Anyone can sign up**, and a social connection names its accounts, such as **Any Google account**. Tick one only if you have restricted it, for example a Google client set to Internal; to keep sign-in to your own Google Workspace, use Auth0's Google Workspace connection, which is an enterprise connection. To add or change a connection, use **Authentication** in the Auth0 dashboard, then reload the list.
7. Click **Set up Auth0**. If any part fails, Caitlyn removes what it created, so you can try again. If Auth0 refuses one of those removals, the error names what is left in your tenant, such as the application, a role or the Action. Remove those by hand in the Auth0 dashboard before you try again: the next attempt fails while an Action of the same name is still there.
8. Under **Connect your own Auth0 sign-in**, click **Sign in with** your new login button and sign in as yourself in the window that opens, or sign up through one of the connections you ticked. Caitlyn connects that sign-in to the account you are using, so you can sign in to it either way. If Caitlyn created the admin role, it gives the role to the Auth0 login you just used, so you can manage Caitlyn through Auth0 from the start. Do this before your Management API token expires. If the sign-in already opens a different Caitlyn account, Caitlyn changes nothing and says so: sign in with another Auth0 login. You can **Skip for now** and connect it later from your profile, but a role Caitlyn created then has nobody in it until you give it out under **User Management → Roles**.

Then skip to **Verify It Works**. The rest of this guide is for when your IT team sets Auth0 up instead.

## Prerequisites

Before you begin, ensure you have:

- **Auth0 admin access**: an account that can create applications and Actions in your tenant.
- **Your Caitlyn domain**: the URL we have provisioned for you (e.g. `https://your-company.getcaitlyn.ai`). We provide this. Contact us if you don't have it yet.
- **If you are adding the sign-in method yourself**: a Caitlyn account that can open **Settings → Sign-in Methods** and add a method. We send you an email invite with a suitable role.

## Step 1: Create the Application

The application is the identity Caitlyn uses to ask Auth0 "is this person who they say they are?". It gives Caitlyn no access to your Auth0 tenant beyond the signed-in person's own profile.

There are two ways to create it. Importing is quicker and creates no client secret, so there is nothing secret to send back. Use the second way if your Auth0 plan cannot import applications.

### Option A: Import Caitlyn by URL (recommended)

Caitlyn publishes a description of itself for each Auth0 sign-in method, at an address like this:

```text
https://your-company.getcaitlyn.ai/api/oauth/client-metadata/auth0__<id>
```

1. In the [Auth0 dashboard](https://manage.auth0.com), go to **Applications → Applications**, then click **Create Application**.
2. Choose **Import from URL**, paste the address you were sent, and click **Preview**.
3. Check the preview shows Caitlyn's callback URL on your Caitlyn domain, then create the application.
4. Open the connection your staff sign in with (under **Authentication**), turn on **Promote connection to domain level**, and enable it for the new application.

Auth0 treats imported applications as third-party, which is why the connection has to be promoted. It also means people see a short consent screen the first time they sign in.

### Option B: Create the application by hand

1. In the [Auth0 dashboard](https://manage.auth0.com), go to **Applications → Applications**, then click **Create Application**.
2. Give it a clear name, for example **`Caitlyn`**, choose **Regular Web Applications**, then click **Create**.
3. Open the new application's **Settings** tab. Under **Application URIs**, paste the callback URL you were sent into **Allowed Callback URLs**, exactly as written. Separate several URLs with commas.
4. Scroll to **Advanced Settings**, open the **Grant Types** tab, and make sure **Authorization Code** and **Refresh Token** are both ticked. Without the refresh-token grant, Caitlyn cannot renew a person's Auth0 access when it expires, after about a day, so they are signed out and have to sign in again.
5. If you turn on refresh token rotation for the application (under **Refresh Token Rotation** on the **Settings** tab), also set its reuse interval to at least 60 seconds. Auth0 may label this setting **Rotation Overlap Period**. Caitlyn can send several requests for the same person at once, and each of them may renew that person's access with the same refresh token. Without a reuse interval, Auth0 treats the second use of a refresh token as a stolen token and signs the person out. When Caitlyn sets Auth0 up for you, it sets 60 seconds itself.
6. Click **Save Changes**.
7. Open the application's **Credentials** tab, set **Authentication Method** to **Client Secret (Basic)**, and save. Caitlyn sends the client secret this way, so with **Client Secret (Post)** Auth0 refuses the sign-in after the login page. When Caitlyn sets Auth0 up for you, it sets this itself.

From the application's **Settings** tab, note its **Client ID** and **Client Secret** for Step 3.

## Step 2: Send Groups to Caitlyn

Caitlyn decides what each person can do from the groups or roles they have. Auth0 has no standard place for groups in the information it gives an application, so a short post-login Action adds them. Caitlyn reads them from this claim:

```text
https://getcaitlyn.ai/groups
```

1. Go to **Actions → Library**, click **Create Action**, then **Build from scratch**.
2. Name it **`Send groups to Caitlyn`**, choose the **Login / Post Login** trigger, and click **Create**.
3. Replace the code with:

```js
exports.onExecutePostLogin = async (event, api) => {
  // Only for Caitlyn, so other applications' tokens are unchanged.
  if (event.client.client_id !== 'YOUR_CLIENT_ID') return;

  const groups = event.authorization?.roles ?? [];
  api.idToken.setCustomClaim('https://getcaitlyn.ai/groups', groups);
};
```

4. Change **`YOUR_CLIENT_ID`** on the second line to the application's **Client ID**, copied from the application's **Settings** tab in Auth0. For an imported application, the Client ID is the address you imported Caitlyn from. The Action matches on the Client ID rather than the application's name, because names can repeat and can be changed.
5. Click **Deploy**.
6. Go to **Actions → Triggers**, open **post-login**, drag **Send groups to Caitlyn** from the panel on the right into the flow, and click **Apply**.

> **Using your own groups**: the Action above sends each person's Auth0 **roles**. If your enterprise connection already sends groups (for example in `event.user.groups`), set the claim to that list instead. Caitlyn matches whatever names appear in the claim, so the names you map in Step 4 must be exactly the names in that list.

## Step 3: Choose Who Gets Access

Choose, or create under **User Management → Roles**, the Auth0 roles (or groups) whose members should:

- **manage Caitlyn**: this one is required, and its members get Caitlyn's admin role
- **use Caitlyn chat**: optional, and if you leave it out, everyone who signs in through Auth0 can use chat

Role names can be anything, spaces included. A person who should manage Caitlyn and also chat needs both, unless chat is open to everyone. A change to someone's roles reaches Caitlyn at their next sign-in, and within about an hour for people already signed in, when Caitlyn next reads their roles.

If we are adding the sign-in method for you, send your Caitlyn onboarding contact:

```text
Domain              — <Domain, from the application's Settings tab>
Admin role or group — <name>
Chat role or group  — <name, or "everyone">
Client ID           — <only if you created the application by hand>
Client Secret       — <only if you created the application by hand>
```

Send the client secret through a secure channel rather than plain email. An imported application has no secret, so there is nothing secret to send.

> **Note**: If your tenant uses an Auth0 **custom domain** (for example `login.your-org.com`) and your users sign in through it, send that domain instead. Caitlyn must use the same domain that appears in the tokens Auth0 issues.

## Step 4: Add the Sign-in Method in Caitlyn

Skip this step if we are adding the sign-in method for you.

Caitlyn walks you through adding the method as a checklist. Finishing its first step gives you the message for your IT team, so you can do that before Step 1.

1. Sign in to Caitlyn and open **Settings → Sign-in Methods**, then click **Add sign-in method**.
2. Under **Choose a provider**, select **Auth0**. This can't be changed later.
3. **Login button label** (optional): the text on the login button, for example "Staff login". Leave it empty to show "Auth0". An imported application takes this label as its name in Auth0, or the name "Caitlyn" when the label is empty.
4. Click **Continue**, then choose **Ask my IT team** (or see **If You Manage Both Auth0 and Caitlyn** above). Caitlyn shows the import address and a message listing everything to set up. If your Auth0 plan cannot import applications, click **Their Auth0 plan can’t import applications? Ask for a client ID and secret instead**, which shows the callback URL and a message for an application created by hand. Leave this page open, or close it with **Finish later** and come back with **Finish setup** on the method's card in **Settings → Sign-in Methods**.
5. Under **Enter what they send back**, enter the **Domain**, and for an application created by hand its **Client ID** and **Client Secret**. Caitlyn checks the domain is a valid host name before it saves.
6. Under **Choose who gets access**, enter the role or group name for **Admin**, exactly as it is spelt in Auth0. The **Chat user** row is filled in already: leave its name empty to let everyone who signs in use chat, or enter a role or group name. Use **Role mapping** to add any other Caitlyn role.
7. Click **Finish setup**.

> **Important**: Caitlyn stores the client secret without ever reading it back, so it cannot show it to you again or check it is correct. A method can look correctly set up and still fail. The sign-in test under **Verify It Works** is the only real check.

Full detail on this page, including renaming and replacing credentials later, is in **Managing Sign-in Methods** in Caitlyn's Help. To change role mappings later, use **Settings → Users → Manage Roles**, covered in **Managing Roles and Permissions** in Caitlyn's Help.

## Verify It Works

1. Open your Caitlyn domain in a private/incognito browser window.
2. Click the Auth0 sign-in button.
3. Sign in as someone who should be able to use chat. For an imported application, accept the consent screen.
4. You should be redirected back to Caitlyn and signed in.

**It works when:**

- You're redirected back to Caitlyn and land in the chat interface.
- Someone with the admin role or group additionally sees the settings/admin area.

**If it doesn't:**

- Sign-in is rejected with a callback error, or succeeds without access: see Troubleshooting below.

## Troubleshooting

### Issue: "Callback URL mismatch"

**Symptoms**: Auth0 shows a callback URL mismatch error instead of the login page. The error quotes a Caitlyn URL, so it reads like a Caitlyn fault.

**Solutions**:

1. For an imported application, confirm it was imported from this sign-in method's own address. A Caitlyn alias host added after the import needs the application refreshed from its URL in Auth0.
2. For an application created by hand, confirm the callback URL is listed in **Settings → Allowed Callback URLs** exactly as Caitlyn shows it, including `https://`, the subdomain, and the `auth0__<id>` ending, with no trailing slash.

### Issue: Auth0 says the connection is not enabled

**Symptoms**: An imported application shows an error that no connection is available, or people cannot choose their usual login.

**Solutions**:

1. Open the connection your staff use, turn on **Promote connection to domain level**, and enable it for the application. Imported applications can only use domain-level connections.

### Issue: Sign-in works but grants no access

**Symptoms**: People sign in with Auth0 and reach Caitlyn, but chat or the admin area is missing.

**Solutions**:

1. Confirm the person holds the right Auth0 role or group, then have them sign out and back in.
2. Confirm the **Send groups to Caitlyn** Action is deployed and is in the **post-login** flow, and that the Client ID in its code matches the application's **Client ID** in Auth0.
3. Confirm the names mapped in Caitlyn are spelt exactly as in Auth0, including capital letters and spaces.

### Issue: Sign-in fails after the Auth0 login page

**Symptoms**: People enter their Auth0 credentials, then land on a Caitlyn error page instead of being signed in.

**Solutions**:

1. Confirm the **Domain** entered in Caitlyn is the one your users sign in through. If your tenant has a custom domain, use that, not the `auth0.com` one.
2. For an application created by hand, confirm the **Client ID** and **Client Secret** belong to the same application. If in doubt, use **Replace credentials** in Caitlyn to enter the full set again, or resend the values to us.
3. For an application created by hand, confirm its **Authentication Method** on the **Credentials** tab is **Client Secret (Basic)** (Step 1, Option B).

### Issue: Caitlyn can't connect with the token

**Symptoms**: After **Connect**, Caitlyn says the token was not accepted, has expired, or can't do everything setup needs.

**Solutions**:

1. Copy a new token from **API Explorer** under **Applications → APIs → Auth0 Management API**. A token from there grants every permission setup needs. A token created for another application may not.
2. Check the domain belongs to the same tenant as the token. A custom domain must be listed under **Branding → Custom Domains** in that tenant.

### Issue: People are signed out after about a day

**Symptoms**: Sessions end sooner than expected, and people have to sign in again.

**Solutions**:

1. For an application created by hand, confirm **Refresh Token** is ticked under **Advanced Settings → Grant Types** (Step 1, Option B).
2. If refresh token rotation is turned on for the application, confirm its reuse interval (**Rotation Overlap Period**) is at least 60 seconds (Step 1, Option B).

## What's next

- **Managing Sign-in Methods** in Caitlyn's Help: rename the sign-in button, replace a client secret, or remove the method.
- [Sign-in options](/sign-in/options/): how Caitlyn handles sign-in, sessions and access across every provider.
- [Embed chat in five minutes](/embed/quick-start/): put the chat on your intranet once your people can sign in.
- [Microsoft SSO](/sign-in/microsoft/) and [Google Workspace SSO](/sign-in/google-workspace/): the same setup for other providers.
