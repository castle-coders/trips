import { useState } from "react";
import { useAuth } from "../lib/auth";
import { useNavigate } from "react-router-dom";
import { GoogleSignIn } from "../components/GoogleSignIn";

export function Login({ isRegisterMode = false }: { isRegisterMode?: boolean }) {
  const { login, register, loginWithGoogle } = useAuth();
  const navigate = useNavigate();
  const [showEmail, setShowEmail] = useState(false);
  const isRegister = isRegisterMode;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleGoogleCredential = async (credential: string) => {
    setError("");
    setLoading(true);
    try {
      await loginWithGoogle(credential);
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isRegister) {
        await register(email, password, name);
      } else {
        await login(email, password);
      }
      navigate("/");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-accent focus:outline-none";

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex flex-col items-center">
          <img src="/favicon.png" alt="Clawdbot Logo" className="mb-2 h-16 w-16 drop-shadow-sm" />
          <h1 className="text-center text-2xl font-bold text-gray-900">
            Trips
          </h1>
        </div>
        <p className="mb-8 text-center text-sm text-gray-500">
          Sign in to manage your travel
        </p>

        {/* Google Sign-In */}
        <div className="mb-6">
          <GoogleSignIn onCredential={handleGoogleCredential} />
        </div>

        {error && (
          <p className="mb-4 text-center text-sm text-red-600">{error}</p>
        )}

        {!showEmail ? (
          <button
            onClick={() => setShowEmail(true)}
            className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
          >
            or sign in with email
          </button>
        ) : (
          <>
            <div className="mb-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or</span>
              <div className="h-px flex-1 bg-gray-200" />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {isRegister && (
                <input
                  className={inputClass}
                  placeholder="Full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              )}
              <input
                className={inputClass}
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="password"
                placeholder="Password"
                minLength={isRegister ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-lg bg-accent py-2.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {loading
                  ? "..."
                  : isRegister
                    ? "Create Account"
                    : "Sign In"}
              </button>
            </form>

            {isRegister && (
              <p className="mt-4 text-center text-sm text-gray-500">
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => navigate("/login")}
                  className="font-medium text-accent hover:text-accent-hover"
                >
                  Sign in
                </button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
