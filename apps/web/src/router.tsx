import React, { createContext, useContext, useState, useEffect, ReactNode } from "react";

export interface NavigateOptions {
  replace?: boolean;
}

interface RouterContextType {
  currentPath: string;
  navigate: (path: string, options?: NavigateOptions) => void;
}

const RouterContext = createContext<RouterContextType>({
  currentPath: "/",
  navigate: () => {},
});

export const useRouter = () => useContext(RouterContext);

export interface RouterProviderProps {
  children: ReactNode;
}

export const RouterProvider: React.FC<RouterProviderProps> = ({ children }) => {
  const [currentPath, setCurrentPath] = useState<string>(() => {
    return window.location.pathname || "/";
  });

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname || "/");
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = (path: string, options?: NavigateOptions) => {
    const dummyOrigin = "https://velvet.internal";
    const targetUrl = new URL(path, dummyOrigin);
    const targetPath = targetUrl.pathname || "/";
    const targetFull = `${targetPath}${targetUrl.search}${targetUrl.hash}`;
    const currentFull = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    if (currentFull !== targetFull || options?.replace) {
      if (options?.replace) {
        window.history.replaceState(null, "", targetFull);
      } else {
        window.history.pushState(null, "", targetFull);
      }
      setCurrentPath(targetPath);
      window.scrollTo(0, 0);
    }
  };

  return (
    <RouterContext.Provider value={{ currentPath, navigate }}>{children}</RouterContext.Provider>
  );
};

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
  activeClassName?: string;
}

export const Link: React.FC<LinkProps> = ({
  to,
  children,
  className = "",
  activeClassName = "",
  onClick,
  ...props
}) => {
  const { currentPath, navigate } = useRouter();
  const isActive = currentPath === to;
  const combinedClassName = `${className} ${isActive ? activeClassName : ""}`.trim();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (onClick) {
      onClick(e);
    }
    // Allow normal browser navigation if cmd/ctrl key is pressed
    if (
      !e.defaultPrevented &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      e.button === 0
    ) {
      e.preventDefault();
      navigate(to);
    }
  };

  return (
    <a href={to} className={combinedClassName} onClick={handleClick} {...props}>
      {children}
    </a>
  );
};
