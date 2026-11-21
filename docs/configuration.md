# Configuration

Most settings are in `apps/apps.yaml`. A few are constants near the top of
`ha/www/kitchen/panel.js`.

## apps.yaml

| Setting | What it is |
| --- | --- |
| `store_id` | Your Walmart store number. It's on your store's page on walmart.com. Search results use it, so the prices and stock match your store. |
| `serpapi_key` | Read from `secrets.yaml`. Leave it out and new phrases just wait for a manual pick, with no search. |
| `notify_targets` | The phones that get the cart link, as `notify/mobile_app_<name>`. Each one is tried separately, so a phone that's off doesn't stop the others. |
| `announce_targets` | Echo `notify` entities that announce "your cart is ready". Leave the list empty to turn announcements off. |
| `sms_service`, `sms_recipients` | Optional texts through Twilio. Empty recipients means off. See [Texts through Twilio](#texts-through-twilio). |
| `reload_anchor_entity` | Any `todo` entity from the Alexa Devices integration. The app uses it to make the integration refresh the list before a build. |
| `catalog_path`, `run_dir` | Where the catalog and the build logs live. |
| `ui_data_path` | Where the app writes the panel's copy of the catalog. Leave it alone unless you've moved `/config/www`. |
| `ui_aliased_only` | `true` shows only products with a phrase mapped to them on **What We Buy**. `false` shows the whole index. |

## Your Alexa list

The app finds the Alexa list named **walmart** by its name, not its entity
ID, so you shouldn't need to change anything. The panel is different. It
reads the list by entity ID, so set `LIST_ENTITY` at the top of `panel.js`
to yours. Look in **Settings > Entities** and search for "walmart". It looks
something like `todo.you_example_com_walmart`.

Make the list in the Alexa app first if you don't have one: **Lists > Create
List > walmart**.

## The schedule

`ha/automations.yaml` builds the cart every Thursday at noon. Change the
time and the weekday to suit you. We build the day before delivery, so
there's time to look over the cart.

The scheduled run announces on the Echoes. If yours runs while people are
asleep, point it at `script.build_walmart_cart_quiet` instead. That one
builds and notifies the phones without speaking.

## The hulu and chatgpt buttons

The top bar of the panel has two app buttons, **hulu** and **chatgpt**, and
a timer button. Tap one and the app opens on the kitchen tablet, on top of
Fully Kiosk.

They need the **Fully Kiosk Browser** integration in Home Assistant, and the
tablet needs both apps installed.

1. Find the tablet's device ID. Open it under **Settings > Devices**; the ID
   is the last part of the page URL.
2. Set `TABLET_DEVICE` near the top of `ha/www/kitchen/panel.js` to that ID.
3. Deploy the panel again (a new version folder, see [install](install.md)).

Each button calls `fully_kiosk.start_application` with an Android package
name, `com.hulu.plus` and `com.openai.chatgpt`. To launch different apps,
change `HULU_PACKAGE` and `CHATGPT_PACKAGE` in `panel.js` and the button
labels in the panel's top-bar markup. You can find any app's package name in
its Google Play link, after `id=`.

The buttons start the app by package name instead of opening a web link on
purpose. A link to hulu.com opened in Chrome, not the Hulu app, because
Android only hands a link to an app when the app claims that exact path, and
nothing claims the bare homepage.

The buttons always act on the tablet, even when you press them from another
device. On the kitchen tablet that's what you want. From your desk it starts
Hulu in the kitchen.

### The timer button

The timer button calls a script named `kitchen_tablet_timer`, which isn't
included because it needs your tablet's Fully Kiosk password. Fully's Home
Assistant integration can only start an app, not open a specific screen in
it, and starting the clock app lands on the big desk clock instead of the
timer. Ours uses a `rest_command` to call Fully's own REST API on the tablet
and open the clock app's timer screen with the
`android.intent.action.SHOW_TIMERS` intent. Without the script the button
does nothing and logs a warning.

If you don't use Fully Kiosk at all, all three buttons fail quietly and
everything else works.

## Texts through Twilio

The cart link always goes to the phones in `notify_targets` through the
Home Assistant app. Texting it as well is optional.

### Before you start: registration

US carriers filter or block texts sent by software unless the sending
number is registered. With Twilio that means an **A2P 10DLC** brand and
campaign registration for a normal number, or **toll-free verification**
for a toll-free number. Approval takes days, so start it first.

Read Twilio's current rules before you apply. When we set this up, Twilio
didn't accept personal-use programs (texts only to yourself, family or
friends) for either 10DLC or toll-free verification, so a purely household
use may not qualify on its own.

### Setup

1. Create a Twilio account, buy a number, and finish registration.
2. Add your credentials to Home Assistant's `secrets.yaml`:

   ```yaml
   twilio_account_sid: ACxxxxxxxxxxxxxxxx
   twilio_auth_token: xxxxxxxxxxxxxxxx
   twilio_from_number: "+15555550100"
   ```

3. Add the `twilio:` block from `ha/twilio.yaml` and the `notify:` entry from
   `ha/twilio_notify.yaml` to `configuration.yaml`, then restart Home
   Assistant. `notify.twilio_sms` doesn't exist until that restart.
4. Make sure `script.walmart_send_sms` from `ha/scripts.yaml` is in your
   scripts. It already calls `notify.twilio_sms`.
5. Put the phone numbers in `sms_recipients` in `apps.yaml`, in
   `+15555550100` format, and restart the AppDaemon add-on. Start with just
   your own number until you've seen it work.

### Check it

1. In **Developer Tools > Actions**, call `notify.twilio_sms` with a
   `message` and your number as the `target`. The text should arrive within
   seconds. If it doesn't, check the message log in the Twilio console. It
   names the reason (unregistered number, bad credentials and so on).
2. Run `script.build_walmart_cart` and check that the text has the cart link
   and that tapping it opens the cart.

### Good to know

- **Long carts mean longer texts.** A big cart link runs to several hundred
  characters, so one text can be billed as three or four segments. It still
  costs pennies, and the link is the whole point, so it isn't shortened.
- **Why the script is there.** The app sends texts through
  `script.walmart_send_sms` instead of calling `notify.twilio_sms` itself,
  because AppDaemon treats the word `target` specially and mangles it. The
  script takes `recipients` and passes them on as `target`.
- **Texting is its own channel.** If Twilio is down or misconfigured, the
  app logs a warning, and the phone notification and Echo announcement
  still go out.
- **Other providers.** Any Home Assistant notify platform that takes phone
  numbers as `target` works. Point `script.walmart_send_sms` at it.

## Mealie pages

The **Recipes**, **Weekly Menu** and **Ingredients** pages need the Mealie
integration in Home Assistant, which provides `sensor.mealie_recipes` and
`calendar.mealie_dinner`, plus the `mealie_parse` app and its token. The
menu week starts on Saturday (`menu.js`), because our groceries arrive on
Friday.

## Theme

The panel brings its own styles. `ha/themes/kitchen_cream.yaml` is there if
you want the rest of a dashboard to match.
