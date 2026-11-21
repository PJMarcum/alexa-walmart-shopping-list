# Alexa Walmart Shopping List

A Home Assistant kitchen panel that turns your Alexa Walmart list into a
Walmart cart. It's the panel that runs on the tablet in our kitchen.

It started as one problem: all week we say "Alexa, add milk to my Walmart list", and on order
day somebody still had to retype that list into the Walmart app. Now the
list turns itself into a Walmart cart and the link lands on our phones.

It grew from there. The panel also shows our Mealie recipes, the week's
dinner plan, and one combined ingredient list for the week, so we can tick
off what's already in the pantry before we order.

## What it does

- Reads the Alexa shopping list named **walmart** through Home Assistant.
- Matches each spoken phrase ("doctor fizz", "dad's toothpaste") to a
  Walmart product. It checks phrases you've already matched first, then
  products you've bought before, and only then searches Walmart through
  SerpAPI.
- Never guesses on a new phrase. It shows the top matches on the tablet and
  waits for someone to tap the right one. After that, the phrase just works.
- Builds a Walmart cart link, pushes it to your phones (and optionally
  texts it through Twilio and announces it on your Echoes), and removes only
  the items that made it into the cart. Anything still waiting for a match stays on the list.
- Runs on a schedule, from the panel's **Build cart** button, or by voice.

The panel itself has five pages: **Walmart** (the list and review),
**What We Buy** (a tap-to-add grid of your usual products), **Recipes**,
**Weekly Menu** and **Ingredients**. Buttons in the top bar open Hulu,
ChatGPT and a cooking timer on the tablet.

## What you need

- Home Assistant with the **AppDaemon** add-on.
- The **Alexa Devices** integration, so your Alexa lists show up as `todo`
  entities.
- A free **SerpAPI** account for Walmart search. The free tier is 250
  searches a month, and we use a handful because matched phrases never
  search again.
- Optional: **Mealie** and its Home Assistant integration for the recipe and
  menu pages, and **Fully Kiosk Browser** on the tablet for the app buttons
  and screensaver.
- Optional: a **Twilio** account if you want the cart link texted too.

## Getting started

1. [Install it](docs/install.md).
2. [Configure it for your house](docs/configuration.md): store number,
   phones, Echoes, list names.
3. [Build up your product list](docs/catalog.md). It starts empty, and it
   fills in as you use it.

## Nothing here talks to Walmart directly

There is no Walmart login, no Walmart API key, and no scraping in the running
system. The cart link is a plain URL with product IDs in it. Whoever opens
it, signed in to their own Walmart account, gets those items in their cart.
Product search goes through SerpAPI.

The cart URL format isn't official, so Walmart could change it someday. It's
built in exactly one place (`apps/walmart_cart/cart_url.py`) to make that an
easy fix.

## Repo layout

```text
apps/                 AppDaemon apps (cart builder, Mealie parser, shared state)
apps/walmart_cart/    the cart builder's modules
ha/                   Home Assistant scripts, helpers, automation, theme
ha/www/kitchen/       the panel (plain JavaScript modules, no build step)
tools/                deploy script and alias seeding tool
tests/                pytest and node:test suites
catalog.example.json  an empty catalog to start from
```

Run the tests with `python -m pytest` and `node --test tests/js/*.test.js`.

## Not affiliated with anyone

This is a personal project. It isn't affiliated with or endorsed by Walmart,
Amazon, SerpAPI, Mealie, Twilio, Hulu or OpenAI. All of their names belong
to them.

## License

MIT. See [LICENSE](LICENSE).
