import { useEffect, useRef } from "react";

// Google Identity Services types
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            element: HTMLElement,
            config: {
              theme?: string;
              size?: string;
              width?: number;
              text?: string;
              shape?: string;
            }
          ) => void;
        };
      };
    };
  }
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

interface Props {
  onCredential: (credential: string) => void;
}

export function GoogleSignIn({ onCredential }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || initialized.current) return;

    function tryInit() {
      if (!window.google || !ref.current) return false;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: (response) => onCredential(response.credential),
      });
      window.google.accounts.id.renderButton(ref.current, {
        theme: "outline",
        size: "large",
        width: 384,
        text: "signin_with",
        shape: "rectangular",
      });
      initialized.current = true;
      return true;
    }

    // Google script may not be loaded yet
    if (!tryInit()) {
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 100);
      return () => clearInterval(interval);
    }
  }, [onCredential]);

  if (!GOOGLE_CLIENT_ID) return null;

  return <div ref={ref} className="flex justify-center" />;
}
