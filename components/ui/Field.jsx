"use client";
import { forwardRef } from "react";
import { cx } from "@/lib/browser/cx";

export const INPUT = "w-full rounded-[10px] border border-line bg-bg px-[13px] py-3 text-[15px] text-ink outline-none focus:border-accent";

export function Label({ htmlFor, children, className }) {
  return (
    <label htmlFor={htmlFor} className={cx("mt-4 mb-1.5 block text-xs tracking-[1px] text-muted uppercase", className)}>
      {children}
    </label>
  );
}

// The mono/uppercase variant of Label the solo builder uses.
export function FieldLabel({ htmlFor, children, className }) {
  return (
    <label htmlFor={htmlFor} className={cx("mt-4 mb-[7px] block font-mono text-[11px] tracking-[1px] text-muted uppercase", className)}>
      {children}
    </label>
  );
}

const TextInput = forwardRef(function TextInput({ className, shake = false, ...rest }, ref) {
  return <input ref={ref} className={cx(INPUT, shake && "animate-shake border-bad!", className)} {...rest} />;
});
export default TextInput;

export const SELECT = "w-full cursor-pointer rounded-[10px] border border-line2 bg-bg py-3 pr-[38px] pl-[13px] text-base text-ink outline-none focus:border-accent";

export const Select = forwardRef(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx(SELECT, className)} {...rest} />;
});
