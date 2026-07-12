import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, children, className = "", ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
