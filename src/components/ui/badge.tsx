import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's badge, used here for exactly one thing: WHAT HAPPENED when a suite
 * was run.
 *
 * ## Seven variants, and the seventh is the one this module exists for
 *
 * Six verdicts plus `none`. Six and not two is the point of the module rather
 * than decoration — `timeout` is not `failed`, one hung and one said no; and
 * `stopped` is neither; and `crashed` is a fourth thing again, because a hung
 * suite, an abandoned one and a missing binary send a person to three different
 * places. Rounding any of them to a red badge would send them to a fourth that
 * has nothing for them.
 *
 * `none` is the one that is easiest to get wrong and matters most, and it is why
 * this variant list is not a colour scale. A reference nothing has been run
 * against is NOT a pass and NOT a failure. So `none` is drawn dashed and muted,
 * it says the words "not run" rather than nothing at all, and — this is the part
 * a badge cannot do on its own — the card that holds it also prints the sentence
 * in full. A chip alone, however carefully coloured, is a thing a reader skims
 * as "no problem here". The sentence is what stops that, and the badge never
 * replaces it. See `RefCard` in `src/app.tsx`.
 *
 * ## The word is never dropped in favour of the colour
 *
 * Every badge on this page carries its verdict as text. Colour is the fastest
 * channel a reader has and the distinctions live in it as well as in the words,
 * but colour alone is a claim a person with any kind of colour blindness cannot
 * read — and a page whose entire purpose is telling "not run" from "passed" from
 * "we do not know" cannot afford to say the distinction in hue only.
 *
 * `whitespace-nowrap` is deliberate at 220px: a badge that wraps to two lines
 * reads as two badges.
 */
const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[0.65rem] font-medium leading-4 whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground border-transparent',
        outline: 'text-muted-foreground',
        passed: 'bg-passed/10 text-passed border-passed/30',
        failed: 'bg-failed/10 text-failed border-failed/30',
        /* Not a seventh terminal state. `running` is a process that is alive
           right now, so it is the one variant with a ring and a moving dot —
           see `Verdict` in `src/view/verdict.tsx`, which supplies the dot. */
        running: 'bg-running/10 text-running border-running/40 ring-1 ring-running/20',
        timeout: 'bg-timeout/10 text-timeout border-timeout/30',
        stopped: 'bg-stopped/10 text-stopped border-stopped/30',
        crashed: 'bg-crashed/10 text-crashed border-crashed/30',
        /* The colour token behind this one is spelled `unrun` rather than
           `none`, and it has to be: `border-none` is Tailwind's own utility for
           `border-style: none`, so a token called `none` would give this variant
           a class that silently removes the border it is asking for. */
        none: 'bg-transparent text-unrun border-unrun/60 border-dashed',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
