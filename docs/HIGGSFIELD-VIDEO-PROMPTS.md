# Cinematic hero video — Higgsfield workflow

The homepage cinematic hero has a drop-in slot at `web/brand/hero.mp4`. Until the file lands, a CSS/SVG placeholder runs in the same canvas. The moment the MP4 is present, the video takes over and scroll-scrubbing kicks in.

## The video brief

**Length**: 10–14 seconds (scrubbed, so duration is "frames you scroll through")
**Aspect**: 16:9 (1920x1080 minimum, 3840x2160 ideal)
**Format**: MP4, h.264 baseline OR h.265, frequent keyframes (every 6–10 frames)
**Audio**: none — the video plays muted in autoplay/scrub mode anyway
**Style**: Apple product-page cinematography. Soft, slow, deliberate. No fast cuts. Camera moves slowly and the subject moves slowly. Dark navy background, cyan accent matching brand.

## Higgsfield prompt — primary

Paste this into Higgsfield. Tune the camera language if their model prefers different keywords.

```
A close-up cinematic product reveal: a single white sheet of paper, like a
contract document, floating gently against a deep navy background. The
paper has black text on it — three short typewritten lines at the top, a
paragraph below, and two signature lines at the bottom marked with thin
gray underscores.

A soft cyan light source from above-left illuminates the page. The camera
pulls back slowly, very slowly, no jitter. As the camera pulls back, glowing
cyan rectangles bloom into existence one at a time over the signature
lines and date fields — like detection markers materializing. Each
rectangle pulses gently for a half-second after it appears.

The mood is calm, confident, almost reverent. Think Apple product
launch, not tech demo. Soft particles drift through the air like dust
motes catching light.

No people. No text overlays. No music in the brief. The paper is the hero,
the cyan glow is the brand, the camera move is what carries time.

Length: 12 seconds.
Aspect: 16:9.
Style reference: Apple AirPods Pro product film, Vision Pro hero loop.
Camera: slow dolly back, ease in/out, no jitter.
Color: deep navy (#011434) background, cyan (#00CBF6) glow, white (#FFFFFF)
paper, no other colors.
Resolution: 1920x1080 minimum, 3840x2160 if available.
```

## Higgsfield prompt — alternate (more abstract)

If the literal "paper with fields" feels too on-the-nose, try this:

```
A cinematic abstract sequence: thin cyan lines draw themselves across a
deep navy background, forming a grid that suggests a document being
parsed. The lines extend slowly, deliberately, like ink on paper. As they
complete, soft cyan glows blossom at the intersections — small,
restrained, never showy. The camera drifts almost imperceptibly to the
right.

Mood: Apple product film. Slow, confident, mathematical. No people, no
text, no music. The grid is the subject.

Length: 12 seconds.
Aspect: 16:9.
Color: deep navy (#011434) background, cyan (#00CBF6) lines and glows,
nothing else.
Camera: very slow horizontal drift, ease in/out.
```

## Higgsfield prompt — alternate (story-driven)

If you want a clearer "look what we do" narrative:

```
A cinematic five-act sequence, 15 seconds total:

Act 1 (0-3s): A folded paper contract lying flat on a dark navy desk
surface. Soft cyan light from above. Camera pushes in.

Act 2 (3-6s): The contract unfolds smoothly. As it opens, the signature
line at the bottom is empty.

Act 3 (6-9s): A glowing cyan rectangle materializes precisely over the
signature line — not drawn, not placed, just appears. Then another over
a date field. Then a third over an initial line. Each rectangle pulses
softly once.

Act 4 (9-12s): The rectangles fade gently as a delicate ink-flow
animation fills the signature line — a handwritten signature appearing
character by character.

Act 5 (12-15s): The contract slowly closes itself back into a folded
state, signed. Soft cyan light fades to navy.

Style: Apple product film. Slow, deliberate, reverent. No people, no
text overlays, no music in the brief.

Length: 15 seconds.
Aspect: 16:9.
Color: deep navy (#011434) background, cyan (#00CBF6) detection glow,
white (#FFFFFF) paper, faint warm white for the signed ink.
Camera: slow controlled push, ease in/out, no jitter.
Resolution: 1920x1080 minimum.
```

## Export checklist

After Higgsfield generates the video:

1. Download the highest-quality MP4 they offer.
2. Re-encode with `ffmpeg` for scroll-scrub smoothness:

   ```
   ffmpeg -i higgsfield-original.mp4 \
     -c:v libx264 \
     -crf 22 \
     -preset slow \
     -g 8 \
     -keyint_min 8 \
     -sc_threshold 0 \
     -pix_fmt yuv420p \
     -movflags +faststart \
     -an \
     web/brand/hero.mp4
   ```

   The `-g 8` flag forces a keyframe every 8 frames, which is the magic
   that makes scroll-scrubbing smooth (the browser can seek to any
   frame near-instantly). The `+faststart` puts the moov atom at the
   beginning of the file so playback starts before the file fully
   downloads. `-an` strips audio (we don't need it).

3. Optionally re-encode a smaller mobile version:

   ```
   ffmpeg -i web/brand/hero.mp4 \
     -vf "scale=1280:720" \
     -c:v libx264 -crf 26 -preset slow \
     -g 8 -keyint_min 8 -sc_threshold 0 \
     -movflags +faststart -an \
     web/brand/hero-mobile.mp4
   ```

   Wire `<source media="(max-width: 768px)" src="brand/hero-mobile.mp4">`
   into the `<video>` element. (Skip this on first pass — Cloudflare's
   edge caching makes the full-size file cheap.)

4. Drop the final file at `web/brand/hero.mp4`. Add to git:

   ```
   git add web/brand/hero.mp4
   git commit -m "Cinematic hero: drop Higgsfield-rendered MP4 into the slot"
   git push
   ```

5. `npm run build && npx wrangler deploy`. Hard-reload the homepage.
   The cinematic plays. The CSS/SVG placeholder is now invisible.

## When the file is missing

The page is fine. `cinematic-hero.js` listens for `loadedmetadata` on
the video; if 4 seconds pass without it (404 or decode error), the JS
removes the video element and the placeholder stays. No console errors,
no broken layout.

## When to update the video

The cinematic should evolve. Quarterly is reasonable — refresh the
prompt with whatever new product capability is worth showing (Phase 3
ML when it ships, mobile signing, branded sender domains). Same file
location, same `wrangler deploy`, instant rollout.
