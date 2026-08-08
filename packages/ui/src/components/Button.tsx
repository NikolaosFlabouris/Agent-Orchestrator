import type { ComponentPropsWithRef } from 'react';

/** Shared button recipes. Each variant is one of the class strings that
 *  was already in the codebase, copied verbatim — the primitive exists to
 *  stop them drifting, not to restyle anything. The one deliberate change
 *  is that `primary` is now always `bg-blue-600 hover:bg-blue-500`; the
 *  sign-in link on `/signed-out` used to be a shade darker.
 *
 *  Sizing stays at the call site. The existing buttons use half a dozen
 *  different padding/text-size combinations that are tuned to where they
 *  sit (a header chip, an actions bar, a form's submit), and Tailwind has
 *  no reliable last-one-wins override for conflicting utilities without a
 *  merge helper. So a variant owns colour and border only, and the call
 *  site passes padding, text size and the `min-h-11 sm:min-h-0` touch
 *  target through `className` — see the touch-target convention in
 *  docs/06-web-ui.md. */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'danger'
  | 'success'
  | 'warn'
  | 'caution'
  | 'info'
  | 'tonal-success'
  | 'tonal-warn';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  /** Filled call-to-action: form submits, Save. Call sites add their own
   *  `disabled:` treatment (some grey the fill, some also grey the text). */
  primary: 'bg-blue-600 hover:bg-blue-500 text-white',
  /** Gray-border ghost — the neutral action (Reset, modal Cancel). */
  secondary: 'border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50',
  /** Destructive: Cancel task, Close task. */
  danger: 'border border-red-800 text-red-400 hover:bg-red-950 disabled:opacity-50',
  /** Force Approve. */
  success: 'border border-green-800 text-green-400 hover:bg-green-950 disabled:opacity-50',
  /** Force Fail. */
  warn: 'border border-yellow-800 text-yellow-400 hover:bg-yellow-950 disabled:opacity-50',
  /** Extend — orange is this app's "waiting on a human" hue. */
  caution: 'border border-orange-800 text-orange-400 hover:bg-orange-950 disabled:opacity-50',
  /** Requeue — an informational re-run, not a destructive act. */
  info: 'border border-blue-800 text-blue-400 hover:bg-blue-950 disabled:opacity-50',
  /** Filled tonal pair, borderless and in the badge palette. Used by the
   *  dashboard's Pause/Resume toggle, where the fill reads as the state
   *  the click moves the orchestrator *to*. */
  'tonal-success': 'bg-green-900 text-green-300 hover:bg-green-800',
  'tonal-warn': 'bg-yellow-900 text-yellow-300 hover:bg-yellow-800',
};

/** Class list for a variant, for the few call sites that are not a
 *  `<button>` (the sign-in `<a>` on `/signed-out`). */
export function buttonClasses(variant: ButtonVariant, className = ''): string {
  return `rounded ${VARIANT_CLASSES[variant]}${className ? ` ${className}` : ''}`;
}

/** `ComponentPropsWithRef` rather than `ButtonHTMLAttributes` so a call
 *  site can still take a `ref` — TaskDetail's Extend button needs one to
 *  restore focus when its modal closes. React 19 passes `ref` through as
 *  an ordinary prop, so no `forwardRef` is required. */
export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={buttonClasses(variant, className)} {...rest} />;
}
