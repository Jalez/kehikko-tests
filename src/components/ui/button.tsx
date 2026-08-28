import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import type * as React from 'react'

import { cn } from '@/lib/utils.ts'

/**
 * shadcn's button, with one size added for this app's normal case and one
 * variant that exists because of what a button here can do.
 *
 * `pane` is a target sized for a pane 220 pixels wide, and it is a variant
 * rather than a set of overrides at each call site so that every press on this
 * page is the same height. The default `sm` is 32 pixels tall and fine on a
 * page; in a narrow column beside a row per suite it eats the column.
 *
 * `destructive` is for Stop, and for nothing else. This is the only module in
 * this workspace whose buttons START AND END PROCESSES, and a stop is
 * destructive in a quiet way — the run ends as `stopped`, which is honestly not
 * a verdict, so somebody who has waited four minutes for a suite loses it and
 * learns nothing. The colour is the first half of saying so; the two-press
 * confirmation in `src/app.tsx` is the second.
 *
 * `whitespace-normal text-left` rather than shadcn's stock `whitespace-nowrap`,
 * and that is a real departure with a reason: a suite may be called
 * `integration-postgres`, and at 220 pixels a button that refuses to wrap sets
 * the width of the row, and the row sets the width of the page. Wrapping is what
 * keeps this page from scrolling sideways.
 */
const buttonVariants = cva(
  "inline-flex max-w-full items-center justify-center gap-1.5 rounded-md text-left font-medium transition-colors [overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        destructive: 'border border-failed/40 bg-failed/10 text-failed hover:bg-failed/20',
      },
      size: {
        default: 'h-9 px-4 py-2 text-sm',
        sm: 'h-8 rounded-md px-3 text-sm',
        /* `min-h` rather than `h`, because a wrapped label needs somewhere to
           go and a fixed height would put the second line outside the button. */
        pane: 'min-h-6 rounded px-2 py-0.5 text-xs',
        icon: 'size-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
