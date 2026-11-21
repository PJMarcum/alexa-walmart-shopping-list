// ha/www/kitchen/styles.js
/**
 * Target is 1280x800 CSS pixels, landscape, sidebar collapsed.
 *
 * The visual language is a design system shared by the person whose panel
 * this was modelled on: Unbounded for the clock, titles and numbers, Plus
 * Jakarta Sans for everything else, small uppercase labels instead of big
 * headers, 26px cards with a soft two-layer shadow, and list rows as their
 * own rounded tiles.
 *
 * CARD is white rather than cream, and that is deliberate. It is also the
 * odnBg value sent to Walmart's image CDN, which only fills TRANSPARENT
 * areas: a product photographed as an opaque JPEG keeps its own white
 * background whatever we ask for. Measured 2026-10-07, roughly half the list
 * did, so cream cards gave a ragged mix of blended and boxed thumbnails.
 * White cards plus a white thumbnail tile make every product look the same
 * whether or not the CDN can help.
 */
export const CARD = "#FFFFFF";

export const STYLES = `
/* ── Tokens ────────────────────────────────────────────────────────────── */
:host {
  --bg: #f1eee7;
  --card: ${CARD};
  --card-hi: #f7f5f0;
  --line: rgba(27,38,56,.07);
  --line-2: rgba(27,38,56,.12);
  --shadow: 0 1px 2px rgba(27,38,56,.05), 0 8px 24px -12px rgba(27,38,56,.18);
  --text: #172234;
  --dim: #56617a;
  --faint: #717a8e;
  --navy: #3A4B6A;
  --c-brand: 143,111,51;
  --c-ok: 15,138,95;
  --c-attn: 183,119,12;
  --bad: #A3402B;
  --r-card: 26px; --r-tile: 20px; --r-btn: 15px;
  --f-num: "Unbounded", ui-rounded, system-ui, sans-serif;
  --f-txt: "Plus Jakarta Sans", system-ui, sans-serif;
  --ease: cubic-bezier(.2,.8,.2,1);
}

/* 100vh, not height:100% and not min-height.
 *
 * height:100% resolves against Home Assistant's partial-panel-resolver,
 * which is height:auto, so it collapses to the content: an 800px
 * viewport with a short list gave the host 393px and left 407px of
 * white below the cream.
 *
 * min-height fixed the white but let the page grow past the viewport, so
 * a long list scrolled the WHOLE screen, taking the top bar, the clock,
 * the rail and the Build cart button out of reach. A viewport unit is
 * exact and depends on no ancestor, so the grid stays pinned to the
 * screen and the cards scroll inside themselves. */
:host { display:block; height:100vh; box-sizing:border-box; overflow:hidden;
  background:var(--bg); color:var(--text);
  font-family:var(--f-txt); font-size:16px; font-weight:600; line-height:1.25;
  -webkit-font-smoothing:antialiased; }
.wrap { display:grid; grid-template-rows:auto minmax(0,1fr); gap:16px;
  padding:16px; height:100vh; box-sizing:border-box; overflow:hidden; }
#view { min-height:0; }
/* The list is the only page that wants the rail beside it. The other two
 * are a single column that scrolls. */
#view.list { display:grid; grid-template-columns:1fr 380px;
  grid-template-rows:minmax(0,1fr) auto; gap:16px; min-height:0; }
/* The list card deliberately FILLS the column rather than hugging its
 * contents. Tried hugging on 2026-10-07 and reverted the same hour: a card
 * that resizes with the list makes Build cart and the rail jump up and down
 * as items are added and matched, and the list is the page's subject, so it
 * should hold its shape whether it has two items or twenty. The empty space
 * under a short list is the cost of a layout that does not move. */
#view.list #list { grid-column:1; grid-row:1; }
#view.list #rail { grid-column:2; grid-row:1; }
#view.list .buildbar { grid-column:1; grid-row:2; }
#view.page { overflow:auto; }
/* The rail's cards HUG their content rather than stretching to the full
 * column height, so an empty "Tonight" is a small card and not a tall
 * expanse of white. min-height:0 still lets the lower card scroll inside
 * itself instead of pushing Build cart off screen. */
#rail { min-height:0; display:grid; gap:16px;
  grid-template-rows:auto auto; align-content:start; }
#tonight { overflow:visible; }
#needs { min-height:0; overflow:auto; }
#tonight .rhero { max-height:170px; }
.topbar { display:flex; align-items:center; gap:12px; }
.nav { display:flex; gap:8px; }

/* ── Nav pills ─────────────────────────────────────────────────────────── */
.chip {
  display:inline-flex; align-items:center; gap:6px; height:40px; padding:0 16px;
  border-radius:999px; font-size:14px; font-weight:700;
  background:var(--card); color:var(--text);
  border:1px solid var(--line); box-shadow:var(--shadow); cursor:pointer;
  transition:all .3s var(--ease); }
.chip.on { background:var(--navy); color:#fff; border-color:transparent; }
.chip:active { transform:scale(.975); }
.add { flex:1; }
.add input { width:100%; box-sizing:border-box; background:var(--card);
  border:1px solid var(--line); border-radius:var(--r-btn); padding:14px 16px;
  font-size:16px; font-weight:600; color:var(--text);
  box-shadow:var(--shadow); }
.inlinemsg { color:var(--bad); font-weight:700; font-size:14px;
  margin:6px 4px 0; }

/* ── Clock ─────────────────────────────────────────────────────────────── */
/* Pinned right, and the space is RESERVED. The clock sat at the right
 * edge already, but its own width changes between "1:05 PM" and
 * "12:05 PM", so the block shifted every hour and again whenever the
 * weekday name changed length. A fixed min-width stops it moving. */
.clock { text-align:right; line-height:1.1; margin-left:auto;
  flex:0 0 auto; min-width:160px; }
/* Tabular figures: proportional digits are different widths, so the time
 * would otherwise shuffle sideways every minute. */
/* clamp rather than a fixed size: this panel also gets opened on a phone and
 * on a desktop, and the clock is the one element that looks absurd when it
 * does not scale with the viewport. */
.clock .t { font-family:var(--f-num); font-weight:500;
  font-size:clamp(28px, 4.8vh, 40px); line-height:1;
  letter-spacing:-.05em; font-variant-numeric:tabular-nums; }
/* The meridiem is a footnote, not part of the number. Same size as it would
 * be set it at the digits' scale, it competes with the time for attention
 * across a kitchen, which is the one thing the clock has to win. */
.clock .ampm { font-family:var(--f-txt); font-size:14px; font-weight:700;
  letter-spacing:.02em; color:var(--dim); margin-left:4px; }
.clock .d { font-size:11.5px; font-weight:800; letter-spacing:.08em;
  text-transform:uppercase; color:var(--dim); margin-top:2px; }

/* ── Cards ─────────────────────────────────────────────────────────────── */
.card { background:var(--card); border:1px solid var(--line);
  border-radius:var(--r-card); padding:16px; overflow:auto; min-height:0;
  box-shadow:var(--shadow); }
/* Small uppercase labels rather than big bold headers: "WALMART LIST",
 * "TONIGHT". The card's own shape carries the weight, so the heading does
 * not have to. */
.card h2, .phead h2 { margin:0 0 12px; font-size:11.5px; font-weight:800;
  letter-spacing:.08em; text-transform:uppercase; color:var(--dim); }
.phead h2 { margin:0; }

/* ── List rows as tiles ────────────────────────────────────────────────── */
.row { display:grid; grid-template-columns:52px 1fr 40px; gap:14px;
  align-items:center; padding:10px 12px; border-radius:var(--r-tile);
  background:var(--card-hi); border:1px solid var(--line); cursor:pointer;
  transition:background-color .3s var(--ease), transform .2s var(--ease); }
.row + .row { margin-top:8px; }
.row:hover { background:#f2efe9; }
.row:active { transform:scale(.985); }
/* A row still waiting on a match is the only one asking anything of you, so
 * it is the only one that gets colour. Everything else on the list is settled
 * and reads as calm by comparison. */
.row.attn { background:rgba(var(--c-attn), .10);
  border-color:rgba(var(--c-attn), .30); }
.row.attn:hover { background:rgba(var(--c-attn), .16); }
.row.attn .warn, .row.attn .match { color:rgb(var(--c-attn)); }
/* Grid and flex items default to min-width:auto, which refuses to shrink
 * below the content's intrinsic width. The 1fr column therefore grew to fit
 * the longest phrase instead of ellipsing it, and the text ran out of the
 * 380px rail. Seen with "Brightsmile pro-health gum detoxify deep clean sensitive
 * toothpaste, 2.6 oz". The ellipsis rules on .said and .match cannot work
 * without this. */
.row > * { min-width:0; }
/* The product sits on its own white square. See the note on CARD: the CDN
 * cannot recolour an opaque photo, so rather than fight it, every thumbnail
 * gets the same deliberate tile and they all match. */
.thumb { width:52px; height:52px; border-radius:14px; object-fit:contain;
  background:#fff; padding:4px; box-sizing:border-box;
  border:1px solid var(--line); }
.warn { width:52px; height:52px; display:grid; place-items:center;
  font-size:26px; }
.said { font-size:16px; font-weight:700;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.match { font-size:12.5px; font-weight:600; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.kebab { background:none; border:0; font-size:20px; color:var(--faint);
  cursor:pointer; }

/* ── Buttons ───────────────────────────────────────────────────────────── */
.buildbar { display:flex; justify-content:flex-end;
  align-items:center; gap:12px; }
.build { height:52px; padding:0 22px; border-radius:var(--r-btn);
  background:rgb(var(--c-brand)); color:#fff; border:1px solid transparent;
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  font-weight:700; font-size:15px; cursor:pointer;
  box-shadow:var(--shadow); transition:all .3s var(--ease); }
.build:active { transform:scale(.975); }
.build:disabled { opacity:.5; cursor:default; transform:none; }
.empty { color:var(--faint); font-size:14px; font-weight:600; padding:8px 6px; }
.dot { display:inline-block; width:8px; height:8px; border-radius:50%;
  background:rgb(var(--c-ok)); margin-right:8px; vertical-align:middle; }

/* ── Sheets ────────────────────────────────────────────────────────────── */
.overlay { position:fixed; inset:0; background:rgba(23,34,52,.45);
  display:grid; place-items:center; z-index:10; }
.sheet { background:var(--card); border:1px solid var(--line);
  border-radius:var(--r-card); padding:20px; width:720px;
  max-width:calc(100vw - 32px); max-height:80vh; overflow:auto;
  box-shadow:0 10px 40px rgba(27,38,56,.25); }
.sheet h3 { margin:0 0 4px; font-family:var(--f-num); font-weight:600;
  font-size:20px; letter-spacing:-.03em; }
.sheet p { margin:0 0 16px; color:var(--dim); font-size:14px; }
.sheet p.problem { color:var(--bad); font-weight:700; }
.cand { display:grid; grid-template-columns:72px 1fr; gap:14px;
  align-items:center; padding:10px; border-radius:var(--r-tile);
  cursor:pointer; }
.cand:hover { background:var(--card-hi); }
.cand img { width:72px; height:72px; object-fit:contain; border-radius:14px;
  background:#fff; padding:4px; box-sizing:border-box;
  border:1px solid var(--line); }
.menusheet { position:fixed; width:300px; box-sizing:border-box;
  background:var(--card); border:1px solid var(--line);
  border-radius:var(--r-tile); padding:8px;
  box-shadow:0 10px 40px rgba(27,38,56,.25); }
.menusheet p.problem { margin:4px 8px 8px; font-size:14px;
  color:var(--bad); font-weight:700; }
.menusheet p[hidden] { display:none; }
.menuitem { display:block; width:100%; min-height:56px; box-sizing:border-box;
  padding:16px; border:0; border-radius:var(--r-btn); background:none;
  text-align:left; font-size:16px; font-weight:600; font-family:inherit;
  color:var(--text); cursor:pointer; }
.menuitem:hover { background:var(--card-hi); }
.menuitem:disabled { opacity:.5; }
.cand.busy { opacity:.5; pointer-events:none; }
/* A pick writes an alias and starts a cart build, so the whole sheet locks
   on the first tap, not just the tile that was tapped. */
.sheet.busy { opacity:.6; pointer-events:none; }

/* --- what we buy, and admin ------------------------------------------- */
.pcard { max-width:1200px; }
.phead { display:flex; align-items:center; gap:12px; margin-bottom:10px; }
.pmeta { color:var(--dim); font-size:12.5px; font-weight:600;
  margin-left:auto; }
#psearch { width:100%; box-sizing:border-box; background:var(--card-hi);
  border:1px solid var(--line); border-radius:var(--r-btn); padding:14px 16px;
  font-size:16px; font-weight:600; color:var(--text); }
.chips { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.chips .chip { height:36px; padding:0 14px; font-size:13px; }
.pgrid { display:grid; gap:12px;
  grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); }
/* 44px of touch target everywhere: this is used standing up, one-handed,
 * often with something in the other hand. */
.tile { position:relative; display:flex; flex-direction:column; gap:6px;
  background:var(--card-hi); border:1px solid var(--line);
  border-radius:var(--r-tile); padding:10px; cursor:pointer; min-height:44px;
  transition:transform .2s var(--ease); }
.tile:active { transform:scale(.985); }
.tile.added { outline:2px solid rgb(var(--c-brand)); }
.ptumb { width:100%; aspect-ratio:1; object-fit:contain; border-radius:14px;
  background:#fff; border:1px solid var(--line); box-sizing:border-box; }
.pname { font-size:13px; font-weight:700; line-height:1.3; overflow:hidden;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; }
.phrases { display:flex; flex-wrap:wrap; gap:4px; }
.phrase { font-size:11px; font-weight:700; line-height:1.7; padding:0 8px;
  border-radius:999px; background:var(--card); border:1px solid var(--line);
  color:var(--dim); white-space:nowrap; }
.foot { margin-top:auto; display:flex; justify-content:space-between;
  align-items:center; font-size:12px; font-weight:600; color:var(--dim); }
.badge { position:absolute; top:8px; right:8px; border-radius:999px;
  background:rgb(var(--c-brand)); color:#fff; font-size:11px; font-weight:800;
  padding:3px 9px; }
.plink { color:var(--dim); }
.more { display:block; width:100%; margin-top:14px; height:52px;
  border-radius:var(--r-btn); border:1px solid var(--line-2);
  background:var(--card-hi); color:var(--text);
  font-size:15px; font-weight:700; cursor:pointer; }
.pend { border-top:1px solid var(--line-2); padding:12px 0; }
.pendhead { display:flex; align-items:center; gap:12px; }
.pendhead h3 { margin:0; font-family:var(--f-num); font-weight:600;
  font-size:16px; letter-spacing:-.03em; }
.pendhead .skip { margin-left:auto; }
.adminbar { margin-top:20px; padding-top:16px;
  border-top:1px solid var(--line-2); }
.problem { color:var(--bad); font-weight:700; padding:12px 4px; }

/* --- recipes and the week --------------------------------------------- */
#rsearch { width:100%; box-sizing:border-box; background:var(--card-hi);
  border:1px solid var(--line); border-radius:var(--r-btn); padding:14px 16px;
  font-size:16px; font-weight:600; color:var(--text); margin-bottom:12px; }
.rgrid { display:grid; gap:12px;
  grid-template-columns:repeat(auto-fill, minmax(240px, 1fr)); }
.rcard { background:var(--card-hi); border:1px solid var(--line);
  border-radius:var(--r-tile); padding:14px; cursor:pointer; min-height:44px;
  display:flex; flex-direction:column; gap:6px;
  transition:transform .2s var(--ease); }
.rcard:active { transform:scale(.985); }
.rname { font-family:var(--f-num); font-size:16px; font-weight:600;
  letter-spacing:-.03em; line-height:1.25; }
/* The detail sheet is read at arm's length with your hands full, so it is
 * deliberately larger than anything else in the panel. The design system's
 * smaller body scale is NOT applied here for that reason. */
.sheet.recipe { width:820px; }
.sheet.recipe h4 { margin:18px 0 8px; font-family:var(--f-num);
  font-weight:600; font-size:17px; letter-spacing:-.03em; }
.rdesc { color:var(--dim); font-size:14px; margin:4px 0 0; }
.ings, .steps { margin:0; padding-left:22px; }
.ings li { font-size:17px; font-weight:600; line-height:1.9; }
.steps li { font-size:16px; font-weight:600; line-height:1.6;
  margin-bottom:12px; }
.week { display:grid; gap:12px;
  grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); }
.day { background:var(--card-hi); border:1px solid var(--line);
  border-radius:var(--r-tile); padding:12px; min-height:110px; }
/* Today is the one people look for first, so it gets the accent rather than
 * being another identical tile. */
.day.today { outline:2px solid rgb(var(--c-brand)); }
.dayhead { display:flex; align-items:center; gap:8px; margin-bottom:8px; }
.dayhead h3 { margin:0; font-size:11.5px; font-weight:800;
  letter-spacing:.08em; text-transform:uppercase; color:var(--dim); }
.dayhead .pmeta { margin-left:0; }
.dayhead .plan { margin-left:auto; height:32px; padding:0 12px;
  font-size:12.5px; }
.mealrow { display:flex; gap:8px; align-items:baseline; padding:4px 0; }
.mealtype { font-size:11px; font-weight:800; text-transform:uppercase;
  letter-spacing:.08em; color:var(--dim); min-width:58px; }
.mealrow .said { font-size:15px; font-weight:700; }
.railmeal { font-family:var(--f-num); font-size:16px; font-weight:600;
  letter-spacing:-.03em; margin:4px 0 2px; }

/* Recipe pictures. onerror removes the element, so a missing image leaves a
 * clean card rather than a broken-image glyph: Mealie's port may not be
 * published, and recipes imported before the picture existed have none. */
.rthumb { width:100%; aspect-ratio:16/10; object-fit:cover;
  border-radius:14px; }
.rhero { width:100%; max-height:260px; object-fit:cover;
  border-radius:var(--r-tile); margin-bottom:12px; }

/* The remove control sits on the row rather than behind a menu: the whole
 * point is undoing a mis-tap, which should not need a second decision. */
.unplan { margin-left:auto; background:none; border:0; font-size:20px;
  line-height:1; color:var(--faint); cursor:pointer; padding:4px 8px;
  min-width:44px; min-height:36px; }
.unplan:hover { color:var(--bad); }

/* --- the week's ingredients -------------------------------------------- */
.inglist { list-style:none; margin:0; padding:0; }
/* Amount, then the thing, then where it came from. The amount is first and
 * right-aligned so the numbers line up and you can scan them in a shop. */
.ingrow { display:grid; grid-template-columns:44px 110px 1fr; gap:14px;
  align-items:baseline; padding:9px 4px;
  border-bottom:1px solid var(--line); }
.ingamt { font-family:var(--f-num); text-align:right; font-weight:500;
  letter-spacing:-.03em; font-variant-numeric:tabular-nums; font-size:15px; }
.inglabel { font-size:16px; font-weight:600; }

/* Every text input in the panel, not one id at a time.
 *
 * #plan-search was added without a rule and inherited Home Assistant's dark
 * default: a black box on a cream sheet. Styling inputs by element means the
 * next one cannot repeat it. */
input[type="search"], input[type="text"], .sheet input {
  background:var(--card-hi); border:1px solid var(--line);
  border-radius:var(--r-btn); padding:14px 16px; font-family:var(--f-txt);
  font-size:16px; font-weight:600; color:var(--text); box-sizing:border-box;
}
.sheet input { width:100%; margin:4px 0 10px; }

/* Meal names wrap in a day tile instead of truncating. The tiles are narrow
 * and "Chef Rita's Shepherd's Pie" has no useful prefix: "Chef Rita's..."
 * tells you nothing about what is for dinner. */
.day .mealrow { align-items:flex-start; }
.day .mealrow .said { white-space:normal; overflow:visible; line-height:1.3;
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical;
  overflow:hidden; }
.day .mealtype { padding-top:2px; }

/* Day buttons in the plan-from-recipe step: the date sits under the weekday
 * so the button reads as one choice rather than two.
 *
 * Seven equal columns rather than a wrapping flex row. Wrapping put a lone
 * Friday on a second line, and "Wednesday" is wide enough that the week could
 * run past the edge of the sheet on a narrower screen, which hides the end of
 * the week rather than showing it badly. A grid makes the week one row at any
 * width, because the columns share whatever space there is. */
#plan-days { display:grid; grid-template-columns:repeat(7, 1fr); gap:6px; }
#plan-days .chip { display:flex; flex-direction:column; align-items:flex-start;
  justify-content:center; gap:2px; height:auto; padding:10px 8px;
  font-size:13px; min-width:0; border-radius:var(--r-btn); }
#plan-days .chip .pmeta { margin-left:0; font-size:11px; }
#plan-days .chip.on .pmeta { color:rgba(255,255,255,.75); }
.planthis { margin-bottom:6px; }

/* Chips inside a sheet take the PAGE colour, not the card colour.
 *
 * .chip is the card colour and a sheet is too, so "Plan this" and the
 * Dinner/Side chips were card-on-card and effectively invisible. The page
 * background is the next step darker and is what the top row's chips sit on,
 * so the contrast is one people have already seen. */
.sheet .chip { background:var(--bg); }
.sheet .chip.on { background:var(--navy); color:#fff; }
.sheet .chip:hover { background:#e9e5dc; }

/* The fallback sits below the candidates, separated, because it is what you
 * reach for when none of them is right.
 *
 * It carries a heavier outline than the other chips. A chip on a card reads
 * as a button because the card is lighter than it; on a SHEET the two are
 * close enough in tone that it just looked like a label. */
.sheetfoot { margin-top:14px; padding-top:12px;
  border-top:1px solid var(--line-2); }
.sheetfoot .chip { border:1px solid var(--line-2); font-weight:700; }
.sheetfoot .chip:hover { background:#e4e0d6; }
.sheet .chip.on:hover { background:#33425d; }

/* Ticked means "we already have this", so the row stays visible but steps
 * back. Striking it through reads as done, which is what the review is. */
.tick { width:30px; height:30px; border-radius:10px;
  border:2px solid var(--line-2); background:var(--card); cursor:pointer;
  font-size:17px; line-height:1; color:rgb(var(--c-ok)); padding:0; }
.ingrow.got .tick { background:rgb(var(--c-ok)); border-color:rgb(var(--c-ok));
  color:#fff; }
.ingrow.got .inglabel, .ingrow.got .ingamt { color:var(--faint);
  text-decoration:line-through; }

/* Week stepper. Sits next to the heading rather than off to one side, so the
 * week you are looking at and the control that changes it read as one thing. */
.weeknav { display:flex; gap:6px; align-items:center; margin-left:14px; }
.weeknav .chip { height:36px; padding:0 14px; font-size:13px; min-width:44px; }
.weeknav .chip#week-now { min-width:96px; }

/* The planner's own week stepper. Same control as the Weekly Menu heading,
 * but it starts a line rather than sitting beside a title. */
.sheet .weeknav { margin:0 0 10px; }

/* A link that leaves the panel. Styled EXACTLY like the chips beside it:
 * the outlined version was correct in theory and nearly invisible on the
 * tablet, which is the only opinion that counts. */
.extlink { display:inline-flex; align-items:center; gap:7px; flex:none;
  text-decoration:none; white-space:nowrap; }
/* The Hulu chip IS the wordmark: their green on their black, lowercase and
 * heavy. Done in CSS rather than as an image so it stays crisp at any size,
 * needs no file served from /local, and cannot go stale across a deploy.
 * The letterforms are a stand-in, not their actual typeface. */
#go-hulu { background:#0B0C0F; color:#1CE783; font-weight:800;
  font-size:18px; letter-spacing:-0.5px; padding:0 17px;
  border:2px solid #1CE783; box-shadow:none;
  font-family:var(--f-txt); }
#go-hulu:hover { background:#17181C; }
/* Icon-only chip: square, so a round mark sits centred with even space,
 * and sized to the nav chips' height rather than to the image. */
.iconbtn { padding:0 7px; line-height:0; flex:none; }
.iconbtn img { height:26px; width:26px; display:block; border-radius:50%; }

.searchrow { display:flex; align-items:center; gap:10px; }
.searchrow input { flex:1; }

.tickbar { display:flex; gap:8px; margin:4px 0 12px; }
.tickbar .chip { height:36px; padding:0 14px; font-size:13px; }

@media (prefers-reduced-motion: reduce) {
  * { transition:none !important; animation:none !important; }
}
`;
