import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  const titleClassName = [toastOptions?.classNames?.title, "aptlss-toast-title"]
    .filter(Boolean)
    .join(" ");

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          title: titleClassName,
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
