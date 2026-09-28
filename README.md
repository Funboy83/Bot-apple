# Bot Apple

Watches Apple Store **pickup** stock for the iPhone you want (unlocked), alerts you by
**text, email and Telegram**, and can **check out automatically**.

It runs on your own Windows PC or Mac and you control it from a settings page in your
browser at http://localhost:3777. It has to run on your computer: Apple blocks stock checks
from cloud servers, and your card details and Apple sign-in stay on your machine.

## Start it

1. Install **Node.js 20 or newer** from https://nodejs.org (the LTS button).
2. Download this repo (green **Code** button > **Download ZIP**) and unzip it.
3. Start it:
   - **Windows:** double-click `start-windows.bat`
   - **Mac:** double-click `start-mac.command` (the first time, right-click it > Open)

   The first run installs what it needs, then opens the settings page.
   Keep that window open while the bot runs.

## Set it up

1. **What to buy.** Pick model, storage and color. Add backup choices in order. Leave part
   number blank and the bot looks it up on apple.com.
2. **Store pickup.** Your ZIP code and how far you'll drive. You can limit it to specific
   stores by store number (shown in the Stock table after a check).
3. **Checking.** How often to check (60 seconds is a sensible default; checking too often
   can get you blocked).
4. **Checkout mode:**
   - *Alert only*: just tells you.
   - *Stop before Place Order*: fills in everything and waits for you to press Place Order.
     **Use this for your first test.**
   - *Buy fully automatically*: presses Place Order for you, then stops after the number of
     orders you set.
   - *Guest* or *Apple ID*: for Apple ID, press **Open bot browser**, sign in once and
     approve the 2FA code. The bot never sees or saves your Apple ID password.
5. **Alerts.** Tick Telegram, Email and/or Text message.
6. **Private details.** Choose a passphrase, then enter your contact, pickup person (if
   someone else collects it), card, billing address and alert logins. Use **Send test** on each
   alert. These are encrypted with your passphrase in `data/secrets.enc`; the passphrase is
   never saved, so you unlock again each time you restart the app.

Press **Check stock now** to confirm it can see Apple's stock, then **Start bot**.

## How it works

- Stock comes from the same service apple.com uses for "Check availability" at stores near
  your ZIP.
- When your top choice is available, it alerts you, then opens a Chrome window, adds the
  phone to the bag, chooses store pickup at the closest store with stock, fills pickup and
  payment details, and places the order (or stops before it, depending on the mode).
- If a checkout step fails, you get an alert telling you to buy by hand, a screenshot is
  saved in `data/screenshots/`, and it tries again 2 minutes later.

## Things to know

- **Apple changes its pages.** The checkout steps match on visible text, so small
  changes are fine, but a redesign can break a step. Test with *Stop before Place Order*
  first, and watch the Activity log.
- **Bot checks.** If "Check stock now" fails with a bot-check message, tick *Check stock in a
  real browser*.
- **Your card's bank may ask for a verification code** on a large purchase. The bot can't
  answer that; leave the bot window visible so you can.
- Apple limits iPhones per customer, and may cancel orders it thinks were placed by bots.
- Everything private lives in the `data/` folder, which is never uploaded to GitHub.

## For developers

```
npm install
npx playwright install chromium
npm test      # stock parsing, encryption, and checkout against a practice store page
npm start
```

Add future models in `CATALOG` in `src/settings.js`.
