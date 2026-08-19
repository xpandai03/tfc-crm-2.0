import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation } from "wouter";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Universal search — Tier 2 MVP.
 *
 * Substring (case-insensitive) match over already-loaded client-side data:
 * contacts by name / email / phone, providers by name / credentials. No
 * server-side search, no fuzzy matching, no keyboard navigation. Built on a
 * plain Input + custom dropdown rather than cmdk so the MVP doesn't inherit
 * cmdk's built-in fuzzy filter and arrow-key behaviour.
 */

// Local types — declare only what search needs, without coupling to the
// global schema (which doesn't type email/phone on board contacts even
// though the runtime sync-cache payload includes them).
export interface ContactSearchItem {
  contactId: string | number;
  name?: string;
  // Nullable to match the waitlist payload these come from: the DB columns are
  // nullable and always were. Surfaced when email/phone were typed onto
  // waitlistContactSchema for the optional list columns.
  email?: string | null;
  phone?: string | null;
  status?: string;
  serviceRequested?: string;
}

export interface ProviderSearchItem {
  id: string | number;
  name?: string;
  nameWithCredentials?: string;
  credentials?: string;
  location?: string;
}

interface UniversalSearchProps {
  contacts: ContactSearchItem[];
  providers: ProviderSearchItem[];
}

const MAX_PER_SECTION = 6;
const MIN_QUERY_LENGTH = 2;

export function UniversalSearch({ contacts, providers }: UniversalSearchProps) {
  const [location, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const normalizedQuery = query.trim().toLowerCase();
  const shouldShowDropdown = normalizedQuery.length >= MIN_QUERY_LENGTH;

  // Close the dropdown whenever the route changes.
  useEffect(() => {
    setIsOpen(false);
  }, [location]);

  // Esc closes the dropdown while it is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen]);

  // Click outside the search container closes the dropdown.
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [isOpen]);

  const filteredContacts = useMemo(() => {
    if (!shouldShowDropdown) return [];
    return contacts.filter((c) =>
      c.name?.toLowerCase().includes(normalizedQuery) ||
      c.email?.toLowerCase().includes(normalizedQuery) ||
      c.phone?.includes(normalizedQuery)
    );
  }, [contacts, normalizedQuery, shouldShowDropdown]);

  const filteredProviders = useMemo(() => {
    if (!shouldShowDropdown) return [];
    return providers.filter((p) => {
      const nameField = p.nameWithCredentials || p.name || "";
      return (
        nameField.toLowerCase().includes(normalizedQuery) ||
        p.credentials?.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [providers, normalizedQuery, shouldShowDropdown]);

  const contactsToShow = filteredContacts.slice(0, MAX_PER_SECTION);
  const providersToShow = filteredProviders.slice(0, MAX_PER_SECTION);
  const moreContacts = Math.max(0, filteredContacts.length - MAX_PER_SECTION);
  const moreProviders = Math.max(0, filteredProviders.length - MAX_PER_SECTION);
  const noResults = contactsToShow.length === 0 && providersToShow.length === 0;

  const handleContactClick = (contact: ContactSearchItem) => {
    setIsOpen(false);
    setQuery("");
    navigate(`/contact/${contact.contactId}`);
  };

  const handleProviderClick = () => {
    setIsOpen(false);
    setQuery("");
    navigate("/providers");
  };

  return (
    <div ref={containerRef} className="relative w-64 hidden md:block">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
      <Input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          if (query.trim().length >= MIN_QUERY_LENGTH) setIsOpen(true);
        }}
        placeholder="Search contacts and providers..."
        className="pl-9 h-9 text-sm"
        data-testid="input-universal-search"
      />

      {isOpen && shouldShowDropdown && (
        <div
          className="absolute top-full mt-1 w-full max-h-96 overflow-y-auto rounded-md border border-gray-200/60 dark:border-gray-800 bg-white/95 dark:bg-gray-950/95 backdrop-blur-sm shadow-lg z-50"
          data-testid="dropdown-universal-search"
        >
          {contactsToShow.length > 0 && (
            <div>
              <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Contacts
              </div>
              {contactsToShow.map((contact) => {
                const context = [contact.serviceRequested, contact.status]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <button
                    key={contact.contactId}
                    onClick={() => handleContactClick(contact)}
                    className="w-full text-left px-3 py-2 hover:bg-muted transition-colors"
                    data-testid={`result-contact-${contact.contactId}`}
                  >
                    <div className="text-sm font-medium text-foreground truncate">
                      {contact.name || "Unnamed contact"}
                    </div>
                    {context && (
                      <div className="text-xs text-muted-foreground truncate">{context}</div>
                    )}
                  </button>
                );
              })}
              {moreContacts > 0 && (
                <div className="px-3 py-1 text-xs text-muted-foreground">
                  +{moreContacts} more
                </div>
              )}
            </div>
          )}

          {providersToShow.length > 0 && (
            <div className={cn(contactsToShow.length > 0 && "border-t border-gray-200/60 dark:border-gray-800")}>
              <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Providers
              </div>
              {providersToShow.map((provider) => (
                <button
                  key={provider.id}
                  onClick={handleProviderClick}
                  className="w-full text-left px-3 py-2 hover:bg-muted transition-colors"
                  data-testid={`result-provider-${provider.id}`}
                >
                  <div className="text-sm font-medium text-foreground truncate">
                    {provider.nameWithCredentials || provider.name || "Unnamed provider"}
                  </div>
                  {provider.location && (
                    <div className="text-xs text-muted-foreground truncate">{provider.location}</div>
                  )}
                </button>
              ))}
              {moreProviders > 0 && (
                <div className="px-3 py-1 text-xs text-muted-foreground">
                  +{moreProviders} more
                </div>
              )}
            </div>
          )}

          {noResults && (
            <div className="px-3 py-4 text-sm text-muted-foreground text-center">
              No results
            </div>
          )}
        </div>
      )}
    </div>
  );
}
