import { useState } from "react";
import { Link, useLocation } from "wouter";
import { Menu, Home, ListTodo, Settings, LogOut, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface MobileNavProps {
  user: {
    name?: string | null;
    email?: string | null;
    role?: string;
  } | null;
  onLogout: () => void;
}

export function MobileNav({ user, onLogout }: MobileNavProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: Home },
    { href: "/aptlss", label: "APTLSS Management", icon: ListTodo },
    ...(user?.role === "admin" ? [{ href: "/founder", label: "VA Management", icon: Users }] : []),
    { href: "/settings", label: "Settings", icon: Settings },
  ];

  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      {/* Hamburger button - only visible on mobile */}
      <SheetTrigger asChild>
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-72 max-w-full gap-0 overflow-y-auto p-0" aria-describedby={undefined}>
        <SheetHeader className="border-b">
          <SheetTitle>Menu</SheetTitle>
        </SheetHeader>

        {/* User info */}
        <div className="p-4 border-b">
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarImage src={user?.email ? `https://www.gravatar.com/avatar/${user.email}?d=mp` : undefined} />
              <AvatarFallback>
                {user?.name?.split(' ').map(n => n[0]).join('').toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate">{user?.name || 'User'}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email || ''}</p>
            </div>
          </div>
        </div>

        {/* Navigation items */}
        <nav className="p-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <button
                  onClick={() => setIsOpen(false)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "hover:bg-secondary"
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span>{item.label}</span>
                </button>
              </Link>
            );
          })}
        </nav>

        {/* Logout button */}
        <SheetFooter className="border-t">
          <Button
            variant="outline"
            className="w-full text-destructive hover:text-destructive"
            onClick={() => {
              setIsOpen(false);
              onLogout();
            }}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Log out
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
