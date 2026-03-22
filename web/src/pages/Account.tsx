import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { account, type MeResponse } from "../lib/api";
import { Link } from "react-router-dom";

export function Account() {
  const { refreshUser, logout } = useAuth();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileErr, setProfileErr] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  useEffect(() => {
    account.getMe().then((data) => {
      setMe(data);
      setName(data.name);
      setLoading(false);
    });
  }, []);

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
