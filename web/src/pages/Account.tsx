import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { account, DEV_EMAIL_KEY, LINK_TOKEN_KEY, LINK_TOKEN_EXPIRES_KEY, type MeResponse } from "../lib/api";
import { Link } from "react-router-dom";

const CF_LOGOUT_URL = "https://trips.prenticew.com/cdn-cgi/access/logout";

export function Account() {
  const { refreshUser, logout, pendingLink, confirmLink, cancelLink, linkResult, clearLinkResult } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileErr, setProfileErr] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  const [emailMsg, setEmailMsg] = useState("");
  const [emailErr, setEmailErr] = useState("");
  const [linkStarting, setLinkStarting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    account.getMe().then((data) => {
      setMe(data);
      setName(data.name);
      setLoading(false);
    });
  }, []);

  // Show merge result banner
  useEffect(() => {
    if (linkResult === "merged") {
      setEmailMsg("Accounts linked successfully! Your emails have been merged.");
      account.getMe().then((data) => {
        setMe(data);
        setName(data.name);
      });
      clearLinkResult();
    } else if (linkResult === "same") {
      clearLinkResult();
    }
  }, [linkResult, clearLinkResult]);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileMsg("");
    setProfileErr("");
    setProfileSaving(true);
    try {
      const updated = await account.updateProfile({ name });
      setMe(updated);
      await refreshUser();
      setProfileMsg("Profile updated");
    } catch (err: any) {
      setProfileErr(err.message);
    } finally {
      setProfileSaving(false);
    }
  };

  const handleLinkEmail = async () => {
    setEmailMsg("");
    setEmailErr("");
    setLinkStarting(true);
    try {
      const { token, expiresAt } = await account.generateLinkToken();
      localStorage.setItem(LINK_TOKEN_KEY, token);
      localStorage.setItem(LINK_TOKEN_EXPIRES_KEY, expiresAt);

      if (import.meta.env.DEV) {
        localStorage.removeItem(DEV_EMAIL_KEY);
        window.location.href = "/account";
      } else {
        await fetch(CF_LOGOUT_URL, { credentials: "include" });
        window.location.href = "/account";
      }
    } catch (err: any) {
      setEmailErr(err.message);
      setLinkStarting(false);
    }
  };

  const handleConfirmLink = async () => {
    setConfirming(true);
    setEmailErr("");
    try {
      await confirmLink();
    } catch (err: any) {
      setEmailErr(err.message);
    } finally {
      setConfirming(false);
    }
  };

  const handleSetPrimary = async (emailId: string) => {
    setEmailMsg("");
    setEmailErr("");
    try {
      const updated = await account.setPrimaryEmail(emailId);
      setMe((prev) => prev ? { ...prev, emails: updated, email: updated.find((e) => e.isPrimary)?.email ?? prev.email } : prev);
      await refreshUser();
      setEmailMsg("Primary email updated");
    } catch (err: any) {
      setEmailErr(err.message);
    }
  };

  const handleRemoveEmail = async (emailId: string) => {
    setEmailMsg("");
    setEmailErr("");
    try {
      const updated = await account.removeEmail(emailId);
      setMe((prev) => prev ? { ...prev, emails: updated } : prev);
      setEmailMsg("Email removed");
    } catch (err: any) {
      setEmailErr(err.message);
    }
  };

  if (loading || !me) {
    return <p className="py-20 text-center text-gray-400">Loading...</p>;
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-accent focus:outline-none";

  return (
    <div className="mx-auto max-w-lg px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Account</h1>
        <Link to="/" className="text-sm font-medium text-accent hover:text-accent-hover">
          Back to trips
        </Link>
      </div>

      {/* Pending link confirmation banner */}
      {pendingLink && (
        <section className="mb-8 rounded-lg border border-amber-300 bg-amber-50 p-5">
          <h2 className="mb-2 text-lg font-semibold text-gray-900">Confirm Account Link</h2>
          <p className="mb-4 text-sm text-gray-700">
            You are about to merge this account into{" "}
            <span className="font-medium">{pendingLink.preview.destinationAccount.name}</span>{" "}
            (<span className="font-medium">{pendingLink.preview.destinationAccount.email}</span>).
            All your trips and data will be transferred to that account, and this account will be deleted.
          </p>
          {emailErr && <p className="mb-3 text-sm text-red-600">{emailErr}</p>}
          <div className="flex gap-3">
            <button
              onClick={handleConfirmLink}
              disabled={confirming}
              className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {confirming ? "Linking..." : "Confirm and link accounts"}
            </button>
            <button
              onClick={cancelLink}
              className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Profile</h2>
        <p className="mb-4 text-sm text-gray-500">
          Signed in as <span className="font-medium text-gray-700">{me.email}</span>
        </p>
        <form onSubmit={handleProfileSave} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Name</label>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          {profileErr && <p className="text-sm text-red-600">{profileErr}</p>}
          {profileMsg && <p className="text-sm text-green-600">{profileMsg}</p>}
          <button
            type="submit"
            disabled={profileSaving || name === me.name}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {profileSaving ? "Saving..." : "Save changes"}
          </button>
        </form>
      </section>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Linked Emails</h2>
        <p className="mb-4 text-sm text-gray-500">
          Manage the email addresses associated with your account. You can sign in with any linked email.
        </p>

        <ul className="mb-4 divide-y divide-gray-100">
          {me.emails.map((em) => (
            <li key={em.id} className="flex items-center justify-between py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-900">{em.email}</span>
                {em.isPrimary && (
                  <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                    Primary
                  </span>
                )}
              </div>
              {!em.isPrimary && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSetPrimary(em.id)}
                    className="text-xs font-medium text-accent hover:text-accent-hover"
                  >
                    Set primary
                  </button>
                  <button
                    onClick={() => handleRemoveEmail(em.id)}
                    className="text-xs font-medium text-red-600 hover:text-red-700"
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {emailErr && <p className="mb-3 text-sm text-red-600">{emailErr}</p>}
        {emailMsg && <p className="mb-3 text-sm text-green-600">{emailMsg}</p>}

        <button
          onClick={handleLinkEmail}
          disabled={linkStarting}
          className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {linkStarting ? "Starting..." : "Link another email"}
        </button>
        <p className="mt-2 text-xs text-gray-400">
          You'll be signed out and asked to sign in with the email you want to link.
        </p>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Sign Out</h2>
        <p className="mb-4 text-sm text-gray-500">
          Sign out via Cloudflare Access. You may need to sign in again on your next visit.
        </p>
        <button
          onClick={logout}
          className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
