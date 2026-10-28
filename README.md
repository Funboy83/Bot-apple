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
3. **Checking.** How often to check (five minutes is the default; checking too often
   can get you blocked).
4. **Checkout mode:**
   - *Alert only*: just tells you.
   - *Stop before Place Order*: fills in everything and waits for you to press Place Order.
     **Use Alert only for pickup notifications.**
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
- **Blocked checks.** HTTP 403/541 pauses checks for at least an hour. Other failures use
  increasing delays from 5 minutes to one hour and respect longer Retry-After values.
  Manual checks share the same cooldown. Successful inventory checks are at least 60 seconds apart.
  Failed or missing availability is **unknown**, never out of stock. Do not repeatedly refresh.
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

## Inventory source and limits

The inventory adapter now uses `/shop/retail/pickup-message`, with `body.stores`
responses and `messageTypes.regular`. This is a community-observed website endpoint,
not a verified Apple-supported public API or a guarantee of permitted automation or US availability.
On October 27, 2026, one ordinary US lookup for MK1F4LL/A near ZIP 95014 returned HTTP 200 and 12 store records, which this parser read successfully. This does not guarantee future access. If access is refused, let the cooldown
expire and use Apple's website manually; there is no browser, CAPTCHA, header-spoofing,
or proxy fallback. Cooldowns are in memory and reset when the server restarts; do not restart
to evade a cooldown. Unknown stock never triggers a stock alert or checkout.

References: [hteen issue 131](https://github.com/hteen/apple-store-helper/issues/131)
and [Apple Pickup Watcher](https://github.com/ENCHIGO/apple-pickup-watcher).
The parser and cooldown changes here are independently implemented; no GPL source was copied.

## Scheduled pickup alerts

Choose your model (including iPhone Duo), storage, color, ZIP, and stores in settings.
Select **Alert only**, configure Telegram, email, or text, and use **Send test** to verify
that your notification channel works. Enable **Only check during these hours each day**,
choose the start/end and time zone, then press **Start bot**. Overnight windows work.
The default interval is five minutes. Keep the computer awake and the app running;
the phone does not need to stay open. Saved existing settings remain in place.
Manual **Check stock now** can run outside the hours but shares the same cooldown.
Only confirmed available inventory triggers a stock alert. Live notification delivery
requires your own channel credentials and has not been tested with your account.
