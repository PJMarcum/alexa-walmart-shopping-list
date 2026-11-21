# Install

This takes about half an hour the first time. You need SSH access to Home
Assistant (the Advanced SSH & Web Terminal add-on works) and the AppDaemon
add-on installed.

## 1. Find your AppDaemon folder

Newer versions of the add-on keep their config under `/addon_configs`, older
ones under `/config/appdaemon`. Check which one you have:

```bash
ls -d /addon_configs/a0d7b954_appdaemon 2>/dev/null || ls -d /config/appdaemon
```

The rest of this page calls that folder `$AD`.

## 2. Copy the AppDaemon apps

```bash
mkdir -p $AD/apps/walmart_cart $AD/walmart/runs
```

From this repo, copy:

| From | To |
| --- | --- |
| `apps/walmart_cart/*.py` | `$AD/apps/walmart_cart/` |
| `apps/*.py` | `$AD/apps/` |
| `apps/apps.yaml` | `$AD/apps/apps.yaml` (merge it if you already have one) |
| `catalog.example.json` | `$AD/walmart/catalog.json` |

The catalog file is the one piece of state that matters. It holds every
phrase you've matched to a product, so keep it somewhere that survives
add-on updates, and back it up. The app refuses to start with a missing or
broken catalog instead of quietly making a new empty one.

If `$AD` is under `/addon_configs`, fix `catalog_path` and `run_dir` in
`apps.yaml` to match.

## 3. Add your secrets

In AppDaemon's `secrets.yaml` (`$AD/secrets.yaml`):

```yaml
serpapi_key: your-serpapi-key
mealie_token: your-mealie-api-token   # only if you use the Mealie pages
```

Get the SerpAPI key from your SerpAPI dashboard. Make the Mealie token in
Mealie under your profile, **API Tokens**.

## 4. Add the Home Assistant pieces

All of these go in `/homeassistant` (also called `/config`).

- **Scripts.** Add the contents of `ha/scripts.yaml` to your
  `scripts.yaml`. Add them; don't replace the file.
- **Helper.** Add `ha/helpers.yaml` under `input_text:` in
  `configuration.yaml`, or to your helpers file if you keep one.
- **Automation.** `ha/automations.yaml` holds the weekly build. Add it to
  your `automations.yaml`, or build the same thing in the UI. It's a time
  trigger, a weekday condition and one script call.
- **Theme.** Copy `ha/themes/kitchen_cream.yaml` into your themes folder.
- **Panel.** Paste the `panel_custom:` block from `ha/panel_custom.yaml`
  into `configuration.yaml`.

Texting the cart link through Twilio is optional and has its own setup. See
[Texts through Twilio](configuration.md#texts-through-twilio). Until then,
leave `sms_recipients` empty in `apps.yaml` and texting stays off.

## 5. Copy the panel files

The panel goes into a versioned folder under `/homeassistant/www/kitchen/`.
The version is in the folder name because Home Assistant tells browsers to
cache `/local/` files for 31 days. A new folder is the only reliable way to
make the tablet load new code.

From a machine with this repo checked out:

```bash
HA_HOST=homeassistant.local HA_USER=your-ssh-user tools/deploy_panel.sh v1
```

That copies the files, checks each one arrived intact, and points
`module_url` in `configuration.yaml` at the new folder. You can also copy
`ha/www/kitchen/*.js` into `/homeassistant/www/kitchen/v1/` by hand and set
`module_url: /local/kitchen/v1/panel.js` yourself.

## 6. Restart

Restart Home Assistant (the panel only registers at startup), then restart
the AppDaemon add-on. A **Kitchen** entry shows up in the sidebar.

## 7. Check it works

Do these in order. Each one depends on the one before.

1. The AppDaemon log says `walmart_cart ready`.
2. In **Developer Tools > Actions**, run `script.build_walmart_cart_dry_run`.
   The log says `build finished: dry_run`, a new file shows up in
   `$AD/walmart/runs/`, and your Alexa list is **unchanged**. A dry run never
   touches the list.
3. `sensor.walmart_pending` exists.
4. Say "Alexa, add milk to my Walmart list." Open the panel. Milk shows up
   as **no match yet**, because your catalog is empty. Tap it, press
   **Search Walmart**, and pick the right product from the results.
5. Press **Build cart**. The cart link arrives on your phone, and milk is
   gone from the list.

## Optional: build by voice

1. In **Settings > Home Assistant Cloud > Alexa**, expose
   `script.build_walmart_cart`.
2. In the Alexa app, make a routine with a voice trigger like "build my
   Walmart cart" and the action **Smart Home > Build Walmart Cart**.

## Optional: the tablet

We run the panel on an Android tablet in Fully Kiosk Browser, signed in as
its own non-admin Home Assistant user. Add `?kiosk` to the start URL
(`/kitchen?kiosk`) and the panel hides Home Assistant's sidebar for that user
only. The **hulu**, **chatgpt** and timer buttons need the Fully Kiosk
integration and some setup; see
[the hulu and chatgpt buttons](configuration.md#the-hulu-and-chatgpt-buttons).
