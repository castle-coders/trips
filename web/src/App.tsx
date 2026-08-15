import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { Dashboard } from "./pages/Dashboard";
import { TripDetail } from "./pages/TripDetail";
import { Admin } from "./pages/Admin";
import { Account } from "./pages/Account";
import { AcceptInvite } from "./pages/AcceptInvite";
import { DevLogin } from "./pages/DevLogin";
import { Footer } from "./components/Footer";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="py-20 text-center text-gray-400">Loading...</p>;
  if (!user) return <p className="py-20 text-center text-gray-400">Authenticating...</p>;
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="py-20 text-center text-gray-400">Loading...</p>;
  if (!user) return <p className="py-20 text-center text-gray-400">Authenticating...</p>;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return <>{children}</>;
}

function DevLoginGate({ children }: { children: React.ReactNode }) {
  const { devLoginPending, devLoginError, devLogin } = useAuth();
  if (devLoginPending) return <DevLogin onLogin={devLogin} error={devLoginError} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <DevLoginGate>
        <Routes>
          <Route path="/invite/:token" element={<AcceptInvite />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Dashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/trips/:tripId"
            element={
              <ProtectedRoute>
                <TripDetail />
              </ProtectedRoute>
            }
          />
          <Route
            path="/account"
            element={
              <ProtectedRoute>
                <Account />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <AdminRoute>
                <Admin />
              </AdminRoute>
            }
          />
        </Routes>
        <Footer />
        </DevLoginGate>
      </BrowserRouter>
    </AuthProvider>
  );
}
