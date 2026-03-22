import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { invitesApi, type InviteInfo } from "../lib/api";

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!token) return;
    invitesApi
      .getInfo(token)
      .then((data) => setInfo(data))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleAccept = async () => {
    if (!token) return;
    setError("");
    setAccepting(true);
    try {
      await invitesApi.accept(token);
      window.location.href = "/";
    } catch (err: any) {
      setError(err.message);
      setAccepting(false);
    }
  };

  if (loading) {
    return <p className="py-20 text-center text-gray-400">Loading...</p>;
  }

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">Invalid Invite</h1>
          <p className="mb-6 text-sm text-gray-500">
            {error || "This invite link is invalid or has expired."}
          </p>
          <a href="/" className="text-sm font-medium text-accent hover:text-accent-hover">
            Go to trips
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <h1 className="mb-2 text-2xl font-bold text-gray-900">You're invited!</h1>
        <p className="mb-1 text-sm text-gray-500">
          <span className="font-medium text-gray-700">{info.inviterName}</span> invited you to join
        </p>
        <p className="mb-2 text-lg font-semibold text-gray-900">{info.tripName}</p>
        <p className="mb-8 text-xs text-gray-400">as {info.role}</p>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <button
          onClick={handleAccept}
          disabled={accepting}
          className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {accepting ? "Joining..." : "Join Trip"}
        </button>
      </div>
    </div>
  );
}
