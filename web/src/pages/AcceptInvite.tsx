import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { invitesApi, type InviteInfo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { GoogleSignIn } from "../components/GoogleSignIn";

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  useAuth();

  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);

  // Email/password form
  const [showEmail, setShowEmail] = useState(false);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!token) return;
    invitesApi
      .getInfo(token)
      .then((data) => {
        setInfo(data);
        if (data.name) setName(data.name);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  const handleGoogleAccept = async (credential: string) => {
    if (!token) return;
    setError("");
    setAccepting(true);
    try {
      const result = await invitesApi.accept(token, { googleCredential: credential });
      // Save the token to log the user in
      localStorage.setItem("trips_token", result.token);
      // Force a page reload to pick up the new auth state
      window.location.href = "/";
    } catch (err: any) {
      setError(err.message);
      setAccepting(false);
    }
  };

  const handleEmailAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError("");
    setAccepting(true);
    try {
      const result = await invitesApi.accept(token, {
        password,
        name: name || undefined,
      });
      localStorage.setItem("trips_token", result.token);
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
          <h1 className="mb-2 text-2xl font-bold text-gray-900">
            Invalid Invite
          </h1>
          <p className="mb-6 text-sm text-gray-500">
            {error || "This invite link is invalid or has expired."}
          </p>
          <a
            href="/login"
            className="text-sm font-medium text-accent hover:text-accent-hover"
          >
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-accent focus:outline-none";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-2xl font-bold text-gray-900">
          You're invited!
        </h1>
        <p className="mb-1 text-center text-sm text-gray-500">
          <span className="font-medium text-gray-700">{info.inviterName}</span>{" "}
          invited you to join
        </p>
        <p className="mb-2 text-center text-lg font-semibold text-gray-900">
          {info.tripName}
        </p>
        <p className="mb-8 text-center text-xs text-gray-400">
          as {info.role}
        </p>

        {error && (
          <p className="mb-4 text-center text-sm text-red-600">{error}</p>
        )}

        {accepting ? (
          <p className="py-8 text-center text-sm text-gray-400">
            Joining trip...
          </p>
        ) : (
          <>
            {/* Google Sign-In */}
            <div className="mb-6">
              <GoogleSignIn onCredential={handleGoogleAccept} />
            </div>

            {!showEmail ? (
              <button
                onClick={() => setShowEmail(true)}
                className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
              >
                or join with email
              </button>
            ) : (
              <>
                <div className="mb-6 flex items-center gap-3">
                  <div className="h-px flex-1 bg-gray-200" />
                  <span className="text-xs text-gray-400">or</span>
                  <div className="h-px flex-1 bg-gray-200" />
                </div>

                <form onSubmit={handleEmailAccept} className="space-y-4">
                  <p className="text-sm text-gray-500">
                    Joining as{" "}
                    <span className="font-medium text-gray-700">
                      {info.email}
                    </span>
                  </p>
                  <input
                    className={inputClass}
                    placeholder="Your name (for new accounts)"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <input
                    className={inputClass}
                    type="password"
                    placeholder="Password (min 8 characters)"
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="submit"
                    className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white hover:bg-accent-hover"
                  >
                    Join Trip
                  </button>
                </form>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
