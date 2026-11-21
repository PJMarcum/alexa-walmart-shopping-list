# Building Your Product List

The catalog starts empty. `catalog.example.json` has no products and no
phrases, and that's on purpose: the list is your household's, built from the
things you actually buy.

The catalog does two jobs:

- It's where every spoken phrase gets matched to a product. "dad's
  toothpaste" means one specific tube, and that only has to be decided once.
- It feeds the **What We Buy** page, the tap-to-add grid of your usual
  products.

There are three ways to fill it. Most people only need the first.

## 1. Just use it

Add things to your Alexa Walmart list the way you normally would. Each new
phrase shows up on the panel as **no match yet**. Tap it, press
**Search Walmart**, and pick the right product. The app saves that phrase and
that product to the catalog, and from then on the phrase matches by itself
and the product appears on **What We Buy**.

You can also skip a phrase ("not from Walmart") and it won't ask again.

After a couple of weeks of normal shopping, most of your list matches on its
own.

## 2. Seed phrases from Walmart links

If you already know what you want a phrase to mean, map it directly. Find
the product on walmart.com, copy its link, and run:

```bash
cp catalog.example.json walmart_catalog.json
python tools/seed_alias.py "milk=https://www.walmart.com/ip/Some-Milk/123456789"
python tools/seed_alias.py "dad's toothpaste=https://www.walmart.com/ip/Some-Toothpaste/987654321"
python tools/seed_alias.py --list
```

You can also put one `phrase=link` per line in a text file and run
`python tools/seed_alias.py --file pairs.txt`. Use `--catalog` to edit a
catalog somewhere other than `walmart_catalog.json` in the repo folder.
That file is in `.gitignore`, so your list never gets committed by accident.

Then copy the file to `$AD/walmart/catalog.json` and restart the AppDaemon
add-on.

Phrases that name someone in your house ("mom's shampoo") get special
handling. They never go to Walmart search, because searching for "mom's
shampoo" returns junk. Put your household's names in `HOUSEHOLD_NAMES` in
`apps/walmart_cart/resolver.py`, all lowercase (the shipped names are just
examples), and seed those phrases this way.

## 3. Add products in bulk

The catalog is a JSON file, so you can add products to `index` directly. A
good source is your Walmart account's **Purchase history** or **Buy Again**
page, where you can copy product links.

Each product looks like this. Only `item_id` and `display_name` are
required.

```json
"123456789": {
  "item_id": "123456789",
  "display_name": "Brand 2% Reduced Fat Milk, Gallon",
  "category": "Dairy & Eggs",
  "bought_count": "4",
  "thumbnail": "https://i5.walmartimages.com/...jpeg",
  "product_page_url": "https://www.walmart.com/ip/123456789"
}
```

- `item_id` is the number at the end of the product's walmart.com link.
- `category` helps matching. "apples" leans toward Fresh Produce, for
  example. Use Walmart's own category names.
- `bought_count` is how often you buy it. Products you buy more often rank
  higher when two match equally well.
- `thumbnail` is the product image the panel shows. Leave it out and the
  tile just has no picture.

A product in the index matches when a phrase is close to its name, even with
no alias. For example, "2% milk" finds "Brand 2% Reduced Fat Milk, Gallon".
New phrases still wait for you to confirm the pick, so a loose match never
goes into the cart on its own.

By default **What We Buy** shows only products that have at least one
phrase mapped to them. To show everything in the index, set
`ui_aliased_only: false` in `apps.yaml`.

## Keep a backup

The catalog is the only thing here that takes real effort to rebuild. Back it
up along with your Home Assistant backups, or copy it somewhere now and then.
The app writes it safely (to a temp file, then renamed), but a backup is
still the only fix for a bad hand edit.
