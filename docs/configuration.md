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
| `sms_service`, `sms_recipients` | Optional SMS. Empty recipients means off. See below. |
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

## Tablet buttons (Fully Kiosk)

The top bar has **hulu**, **chatgpt** and a timer button that start apps on
the tablet. They need the Fully Kiosk Browser integration.

- Set `TABLET_DEVICE` in `panel.js` to the tablet's device ID. Open the
  device under **Settings > Devices**; the ID is the last part of the page
  URL.
- `HULU_PACKAGE` and `CHATGPT_PACKAGE` are Android package names. Swap them
  for any apps you'd rather have, and change the button labels in `panel.js`
  to match.
- The timer button calls a script named `kitchen_tablet_timer`, which isn't
  included. Fully's integration can't fire an Android intent, so ours calls
  Fully's REST API with a `rest_command` to open the clock app's timer tab.
  Without that script the button does nothing (it logs a warning).

If you don't use Fully Kiosk, the buttons fail quietly and everything else
works.

## SMS

SMS is off by default. To turn it on:

1. Set up any Home Assistant notify platform that sends texts and takes the
   phone numbers as `target`.
2. Change the action in `script.walmart_send_sms` (`ha/scripts.yaml`) to that
   notify service.
3. Put the numbers in `sms_recipients` in `apps.yaml`, in `+15555550100`
   format.

The app goes through the script instead of calling the notify service
directly because AppDaemon treats the word `target` specially and mangles
it. The script takes `recipients` and passes them on as `target`.

US carriers filter or block texts sent by software unless the sender is
registered (A2P 10DLC or a verified toll-free number). Check what your SMS
provider requires before you count on it.

## Mealie pages

The **Recipes**, **Weekly Menu** and **Ingredients** pages need the Mealie
integration in Home Assistant, which provides `sensor.mealie_recipes` and
`calendar.mealie_dinner`, plus the `mealie_parse` app and its token. The
menu week starts on Saturday (`menu.js`), because our groceries arrive on
Friday.

## Theme

The panel brings its own styles. `ha/themes/kitchen_cream.yaml` is there if
you want the rest of a dashboard to match.
