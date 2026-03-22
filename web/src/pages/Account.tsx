import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { account, type MeResponse } from "../lib/api";
import { GoogleSignIn } from "../components/GoogleSignIn";
import { Link } from "react-router-dom";

export function Account() {
  const { user, refreshUser } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // Profile
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileErr, setProfileErr] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  // Password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwMsg, setPwMsg] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwSaving, setPwSaving] = useState(false);

  // Google
  const [googleMsg, setGoogleMsg] = useState("");
  const [googleErr, setGoogleErr] = useState("");

  useEffect(() => {
    account.getMe().then((data) => {
      setMe(data);
      setName(data.name);
      setEmail(data.email);
      setLoading(false);
    });
  }, []);

  const handleProfileSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileMsg("");
    setProfileErr("");
    setProfileSaving(true);
    try {
      const updated = await account.updateProfile({ name, email });
      setMe(updated);
      await refreshUser();
      setProfileMsg("Profile updated");
    } catch (err: any) {
      setProfileErr(err.message);
    } finally {
      setProfileSaving(false);
    }
  };

  const handlePasswordSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg("");
    setPwErr("");
    if (newPassword !== confirmPassword) {
      setPwErr("Passwords do not match");
      return;
    }
    setPwSaving(true);
    try {
      await account.changePassword({
        currentPassword: me?.hasPassword ? currentPassword : undefined,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      // Refresh to update hasPassword
      const updated = await account.getMe();
      setMe(updated);
      setPwMsg(me?.hasPassword ? "Password changed" : "Password set");
    } catch (err: any) {
      setPwErr(err.message);
    } finally {
      setPwSaving(false);
    }
  };

  const handleLinkGoogle = async (credential: string) => {
    setGoogleMsg("");
    setGoogleErr("");
    try {
      const updated = await account.linkGoogle(credential);
      setMe(updated);
      await refreshUser();
      setGoogleMsg("Google account linked");
    } catch (err: any) {
      setGoogleErr(err.message);
    }
  };

  const handleUnlinkGoogle = async () => {
    setGoogleMsg("");
    setGoogleErr("");
    try {
      const updated = await account.unlinkGoogle();
      setMe(updated);
      await refreshUser();
      setGoogleMsg("Google account unlinked");
    } catch (err: any) {
      setGoogleErr(err.message);
    }
  };

  if (loading || !me) {
    return (
      <p className="py-20 text-center text-gray-400">Loading...</p>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-accent focus:outline-none";

  return (
    <div className="mx-auto max-w-lg px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Account</h1>
        <Link
          to="/"
          className="text-sm font-medium text-accent hover:text-accent-hover"
        >
          Back to trips
        </Link>
      </div>

      {/* Profile Section */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Profile</h2>
        <form onSubmit={handleProfileSave} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Name
            </label>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Email
            </label>
            <input
              className={inputClass}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          {profileErr && (
            <p className="text-sm text-red-600">{profileErr}</p>
          )}
          {profileMsg && (
            <p className="text-sm text-green-600">{profileMsg}</p>
          )}
          <button
            type="submit"
            disabled={profileSaving || (name === me.name && email === me.email)}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {profileSaving ? "Saving..." : "Save changes"}
          </button>
        </form>
      </section>

      {/* Password Section */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {me.hasPassword ? "Change Password" : "Set Password"}
        </h2>
        <form onSubmit={handlePasswordSave} className="space-y-4">
          {me.hasPassword && (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">
                Current password
              </label>
              <input
                className={inputClass}
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              New password
            </label>
            <input
              className={inputClass}
              type="password"
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              Confirm new password
            </label>
            <input
              className={inputClass}
              type="password"
              minLength={8}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          {pwErr && <p className="text-sm text-red-600">{pwErr}</p>}
          {pwMsg && <p className="text-sm text-green-600">{pwMsg}</p>}
          <button
            type="submit"
            disabled={pwSaving}
            className="rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {pwSaving
              ? "Saving..."
              : me.hasPassword
                ? "Change password"
                : "Set password"}
          </button>
        </form>
      </section>

      {/* Google Linked Account */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          Google Account
        </h2>
        {me.hasGoogle ? (
          <div>
            <p className="mb-3 text-sm text-gray-600">
              Your Google account is linked. You can sign in with Google.
            </p>
            <button
              onClick={handleUnlinkGoogle}
              className="rounded-lg border border-red-300 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
            >
              Unlink Google account
            </button>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-gray-600">
              Link your Google account for easier sign-in.
            </p>
            <GoogleSignIn onCredential={handleLinkGoogle} />
          </div>
        )}
        {googleErr && (
          <p className="mt-3 text-sm text-red-600">{googleErr}</p>
        )}
        {googleMsg && (
          <p className="mt-3 text-sm text-green-600">{googleMsg}</p>
        )}
      </section>
    </div>
  );
}
