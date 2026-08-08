import type {
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/** The form-control recipe, which was written out ~16 times across
 *  Settings, Create Task and Task Detail. It covers `<input>`, `<select>`
 *  and `<textarea>` — all three carry the identical class string today.
 *
 *  `surface` picks the fill: `gray-800` on the Settings cards (which sit
 *  on a `gray-900` panel) and `gray-900` on Create Task (whose page
 *  background is `gray-950`). Both already existed; the prop just names
 *  the choice instead of leaving it to a copy-paste.
 *
 *  Everything else — `w-full`, `min-w-0`, `font-mono`, `min-h-[150px]`,
 *  the per-field `disabled:` colours — stays at the call site, since it
 *  varies per field and is layout, not styling. */
export type InputSurface = 'gray-800' | 'gray-900';

const SURFACE_CLASSES: Record<InputSurface, string> = {
  'gray-800': 'bg-gray-800',
  'gray-900': 'bg-gray-900',
};

export function inputClasses(surface: InputSurface = 'gray-800', className = ''): string {
  return `${SURFACE_CLASSES[surface]} border border-gray-700 rounded px-3 py-2 text-sm${
    className ? ` ${className}` : ''
  }`;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & { surface?: InputSurface };

export function Input({ surface, className, ...rest }: InputProps) {
  return <input className={inputClasses(surface, className)} {...rest} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { surface?: InputSurface };

export function Select({ surface, className, ...rest }: SelectProps) {
  return <select className={inputClasses(surface, className)} {...rest} />;
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  surface?: InputSurface;
};

export function Textarea({ surface, className, ...rest }: TextareaProps) {
  return <textarea className={inputClasses(surface, className)} {...rest} />;
}
