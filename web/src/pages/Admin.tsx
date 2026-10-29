import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import {
  admin,
  formatOAuthDate,
  oauthAppName,
  oauthErrorMessage,
  oauthScopeLabel,
  type AppUser,
  type ServiceIdentity,
} from "../lib/api";
import type {
  AdminOAuthGrant,
  CreatedOAuthClient,
  OAuthClient,
  OAuthTokenEndpointAuthMethod,
} from "../lib/types";

const grantKey = (g: AdminOAuthGrant) => `${g.userId}:${g.id}`;

export function Admin() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [identities, setIdentities] = useState<ServiceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // New user form
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUser, setNewUser] = useState({
    email: "",
    name: "",
    password: "",
    role: "viewer",
  });

  // Merge accounts
  const [mergeKeep, setMergeKeep] = useState("");
  const [mergeDrop, setMergeDrop] = useState("");
  const [mergeMsg, setMergeMsg] = useState("");
  const [mergeErr, setMergeErr] = useState("");
  const [merging, setMerging] = useState(false);

  // New service identity form
  const [showNewIdentity, setShowNewIdentity] = useState(false);
  const [newIdentity, setNewIdentity] = useState({
    cfAccessSubject: "",
    commonName: "",
    userId: "",
  });

  // Connected apps (all OAuth grants)
  const [grants, setGrants] = useState<AdminOAuthGrant[]>([]);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [grantsErr, setGrantsErr] = useState("");
  const [confirmRevokeKey, setConfirmRevokeKey] = useState<string | null>(null);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);

  // OAuth clients
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsErr, setClientsErr] = useState("");
  const [confirmDeleteClientId, setConfirmDeleteClientId] = useState<string | null>(null);
  const [deletingClientId, setDeletingClientId] = useState<string | null>(null);
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClient, setNewClient] = useState<{
    clientName: string;
    redirectUris: string;
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  }>({ clientName: "", redirectUris: "", tokenEndpointAuthMethod: "client_secret_basic" });
  const [creatingClient, setCreatingClient] = useState(false);
  const [createClientErr, setCreateClientErr] = useState("");
  // Holds the one-time secret only until dismissed. Never persisted anywhere.
  const [createdClient, setCreatedClient] = useState<CreatedOAuthClient | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  useEffect(() => {
    admin.listGrants()
      .then(setGrants)
      .catch((err) => setGrantsErr(oauthErrorMessage(err)))
      .finally(() => setGrantsLoading(false));
    admin.listOAuthClients()
      .then(setClients)
      .catch((err) => setClientsErr(oauthErrorMessage(err)))
      .finally(() => setClientsLoading(false));
  }, []);

  useEffect(() => {
    Promise.all([admin.listUsers(), admin.listServiceIdentities()])
      .then(([u, si]) => {
        setUsers(u);
        setIdentities(si);
      })
      .catch((err) => setError(err.message || "Failed to load admin data"))
      .finally(() => setLoading(false));
  }, []);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const user = await admin.createUser(newUser);
    setUsers([...users, user]);
    setNewUser({ email: "", name: "", password: "", role: "viewer" });
    setShowNewUser(false);
  };

  const handleDeleteUser = async (id: string) => {
    const user = users.find((u) => u.id === id);
    if (!window.confirm(`Are you sure you want to delete ${user?.name ?? "this user"}? This action cannot be undone.`)) {
      return;
    }
    await admin.deleteUser(id);
    setUsers(users.filter((u) => u.id !== id));
    setIdentities(identities.filter((i) => i.userId !== id));
  };

  const handleRoleChange = async (id: string, role: string) => {
    const updated = await admin.updateUser(id, { role });
    setUsers(users.map((u) => (u.id === updated.id ? updated : u)));
  };

  const handleMerge = async (e: React.FormEvent) => {
    e.preventDefault();
    setMergeMsg("");
    setMergeErr("");
    if (mergeKeep === mergeDrop) {
      setMergeErr("Cannot merge a user with themselves");
      return;
    }
    const keepUser = users.find((u) => u.id === mergeKeep);
    const dropUser = users.find((u) => u.id === mergeDrop);
    if (!confirm(`Merge "${dropUser?.name}" into "${keepUser?.name}"? This cannot be undone.`)) return;

    setMerging(true);
    try {
      await admin.mergeUsers(mergeKeep, mergeDrop);
      setMergeMsg(`Merged "${dropUser?.name}" into "${keepUser?.name}"`);
      setMergeKeep("");
      setMergeDrop("");
      // Refresh user list
      const refreshed = await admin.listUsers();
      setUsers(refreshed);
    } catch (err) {
      setMergeErr((err as Error).message);
    } finally {
      setMerging(false);
    }
  };

  const handleCreateIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    const identity = await admin.createServiceIdentity(newIdentity);
    setIdentities([...identities, identity]);
    setNewIdentity({ cfAccessSubject: "", commonName: "", userId: "" });
    setShowNewIdentity(false);
  };

  const handleDeleteIdentity = async (id: string) => {
    await admin.deleteServiceIdentity(id);
    setIdentities(identities.filter((i) => i.id !== id));
  };

  const handleRevokeGrant = async (grant: AdminOAuthGrant) => {
    const key = grantKey(grant);
    setGrantsErr("");
    setRevokingKey(key);
    try {
      await admin.revokeGrant(grant.userId, grant.id);
      setGrants((prev) => prev.filter((g) => grantKey(g) !== key));
    } catch (err) {
      setGrantsErr(oauthErrorMessage(err));
    } finally {
      setRevokingKey(null);
      setConfirmRevokeKey(null);
    }
  };

  const handleCreateClient = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateClientErr("");
    const redirectUris = newClient.redirectUris
      .split("\n")
      .map((u) => u.trim())
      .filter(Boolean);
    if (!redirectUris.length) {
      setCreateClientErr("Enter at least one redirect URI");
      return;
    }
    setCreatingClient(true);
    try {
      const created = await admin.createOAuthClient({
        clientName: newClient.clientName.trim(),
        redirectUris,
        tokenEndpointAuthMethod: newClient.tokenEndpointAuthMethod,
      });
      // Keep the secret out of the list state; it lives only in createdClient until dismissed.
      const listed: OAuthClient = {
        clientId: created.clientId,
        clientName: created.clientName,
        redirectUris: created.redirectUris,
        tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
        confidential: created.confidential,
        registrationDate: created.registrationDate,
      };
      setClients((prev) => [...prev, listed]);
      setCreatedClient(created);
      setSecretCopied(false);
      setNewClient({ clientName: "", redirectUris: "", tokenEndpointAuthMethod: "client_secret_basic" });
      setShowNewClient(false);
    } catch (err) {
      setCreateClientErr(oauthErrorMessage(err));
    } finally {
      setCreatingClient(false);
    }
  };

  const handleCopySecret = async () => {
    if (!createdClient) return;
    try {
      await navigator.clipboard.writeText(createdClient.clientSecret);
      setSecretCopied(true);
    } catch {
      setSecretCopied(false);
    }
  };

  const dismissCreatedClient = () => {
    setCreatedClient(null);
    setSecretCopied(false);
  };

  const handleDeleteClient = async (clientId: string) => {
    setClientsErr("");
    setDeletingClientId(clientId);
    try {
      await admin.deleteOAuthClient(clientId);
      setClients((prev) => prev.filter((cl) => cl.clientId !== clientId));
      setGrants((prev) => prev.filter((g) => g.clientId !== clientId));
      if (createdClient?.clientId === clientId) dismissCreatedClient();
    } catch (err) {
      setClientsErr(oauthErrorMessage(err));
    } finally {
      setDeletingClientId(null);
      setConfirmDeleteClientId(null);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none";

  if (loading) {
    return <p className="py-20 text-center text-gray-400">Loading...</p>;
  }
  if (error) {
    return <p className="py-20 text-center text-red-500">{error}</p>;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <Link
        to="/"
        className="mb-6 inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
      >
        &larr; Dashboard
      </Link>

      <h1 className="mb-8 text-2xl font-bold text-gray-900">Admin</h1>

      {/* Users */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Users</h2>
          <button
            onClick={() => setShowNewUser(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            + Add User
          </button>
        </div>

        {showNewUser && (
          <form
            onSubmit={handleCreateUser}
            className="mb-4 space-y-3 rounded-lg border border-gray-200 bg-white p-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                className={inputClass}
                placeholder="Name"
                value={newUser.name}
                onChange={(e) =>
                  setNewUser({ ...newUser, name: e.target.value })
                }
                required
              />
              <input
                className={inputClass}
                type="email"
                placeholder="Email"
                value={newUser.email}
                onChange={(e) =>
                  setNewUser({ ...newUser, email: e.target.value })
                }
                required
              />
              <input
                className={inputClass}
                type="password"
                placeholder="Password (min 8 chars)"
                minLength={8}
                value={newUser.password}
                onChange={(e) =>
                  setNewUser({ ...newUser, password: e.target.value })
                }
                required
              />
              <select
                className={inputClass}
                value={newUser.role}
                onChange={(e) =>
                  setNewUser({ ...newUser, role: e.target.value })
                }
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowNewUser(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 font-medium text-gray-500">Role</th>
                <th className="px-4 py-3 font-medium text-gray-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id}>
                  <td className="px-4 py-3 text-gray-900">{u.name}</td>
                  <td className="px-4 py-3 text-gray-600">{u.email}</td>
                  <td className="px-4 py-3">
                    <select
                      className="rounded border border-gray-300 px-2 py-1 text-xs"
                      value={u.role}
                      onChange={(e) => handleRoleChange(u.id, e.target.value)}
                    >
                      <option value="viewer">viewer</option>
                      <option value="editor">editor</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDeleteUser(u.id)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Merge Accounts */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Merge Accounts</h2>
        <p className="mb-4 text-sm text-gray-500">
          Merge two user accounts into one. All trips, participants, and data from the merged account will be transferred to the kept account.
        </p>
        <form onSubmit={handleMerge} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Keep this account</label>
              <select
                className={inputClass}
                value={mergeKeep}
                onChange={(e) => setMergeKeep(e.target.value)}
                required
              >
                <option value="">Select user to keep...</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Merge and delete this account</label>
              <select
                className={inputClass}
                value={mergeDrop}
                onChange={(e) => setMergeDrop(e.target.value)}
                required
              >
                <option value="">Select user to merge...</option>
                {users.filter((u) => u.id !== mergeKeep).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>
          </div>
          {mergeErr && <p className="text-sm text-red-600">{mergeErr}</p>}
          {mergeMsg && <p className="text-sm text-green-600">{mergeMsg}</p>}
          <button
            type="submit"
            disabled={merging || !mergeKeep || !mergeDrop}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {merging ? "Merging..." : "Merge accounts"}
          </button>
        </form>
      </section>

      {/* Service Identities */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">
            Service Identities
          </h2>
          <button
            onClick={() => setShowNewIdentity(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            + Add Mapping
          </button>
        </div>

        {showNewIdentity && (
          <form
            onSubmit={handleCreateIdentity}
            className="mb-4 space-y-3 rounded-lg border border-gray-200 bg-white p-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <input
                className={inputClass}
                placeholder="CF Access Subject (sub claim)"
                value={newIdentity.cfAccessSubject}
                onChange={(e) =>
                  setNewIdentity({
                    ...newIdentity,
                    cfAccessSubject: e.target.value,
                  })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Common Name (label)"
                value={newIdentity.commonName}
                onChange={(e) =>
                  setNewIdentity({
                    ...newIdentity,
                    commonName: e.target.value,
                  })
                }
                required
              />
              <select
                className={inputClass}
                value={newIdentity.userId}
                onChange={(e) =>
                  setNewIdentity({ ...newIdentity, userId: e.target.value })
                }
                required
              >
                <option value="">Map to user...</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Create
              </button>
              <button
                type="button"
                onClick={() => setShowNewIdentity(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-500">
                  Common Name
                </th>
                <th className="px-4 py-3 font-medium text-gray-500">
                  CF Access Subject
                </th>
                <th className="px-4 py-3 font-medium text-gray-500">
                  Mapped User
                </th>
                <th className="px-4 py-3 font-medium text-gray-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {identities.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-3 text-gray-900">{i.commonName}</td>
                  <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-gray-500">
                    {i.cfAccessSubject}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {i.userName || i.userId}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDeleteIdentity(i.id)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
              {!identities.length && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-gray-400"
                  >
                    No service identities configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Connected apps (OAuth grants) */}
      <section className="mb-10">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">Connected apps</h2>
        <p className="mb-4 text-sm text-gray-500">
          Every app any user has connected through OAuth. Revoking a grant invalidates its tokens immediately.
        </p>
        {grantsErr && <p className="mb-3 text-sm text-red-600">{grantsErr}</p>}
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-500">User</th>
                <th className="px-4 py-3 font-medium text-gray-500">App</th>
                <th className="px-4 py-3 font-medium text-gray-500">Permissions</th>
                <th className="px-4 py-3 font-medium text-gray-500">Connected</th>
                <th className="px-4 py-3 font-medium text-gray-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {grantsLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              )}
              {!grantsLoading &&
                grants.map((g) => {
                  const key = grantKey(g);
                  return (
                    <tr key={key}>
                      <td className="px-4 py-3 text-gray-600">{g.userEmail}</td>
                      <td className="max-w-[200px] truncate px-4 py-3 text-gray-900" title={g.clientId}>
                        {oauthAppName(g)}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {g.scopes.map(oauthScopeLabel).join(", ") || "None"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                        {formatOAuthDate(g.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        {confirmRevokeKey === key ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-xs text-gray-500">Revoke?</span>
                            <button
                              onClick={() => handleRevokeGrant(g)}
                              disabled={revokingKey === key}
                              className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                            >
                              {revokingKey === key ? "Revoking..." : "Confirm"}
                            </button>
                            <button
                              onClick={() => setConfirmRevokeKey(null)}
                              disabled={revokingKey === key}
                              className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setConfirmRevokeKey(key)}
                            className="text-xs text-red-500 hover:text-red-700"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              {!grantsLoading && !grants.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    No apps are connected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* OAuth clients */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">OAuth clients</h2>
          <button
            onClick={() => {
              setCreateClientErr("");
              setShowNewClient(true);
            }}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            + Add Client
          </button>
        </div>
        <p className="mb-4 text-sm text-gray-500">
          Pre-registered clients for platforms without dynamic registration, plus any dynamically registered clients.
        </p>

        {createdClient && (
          <div className="mb-4 space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
            <p className="text-sm font-medium text-gray-900">
              Client created: {oauthAppName(createdClient)}
            </p>
            <p className="text-sm text-amber-800">
              Copy the client secret now. It won't be shown again and cannot be recovered.
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Client ID</label>
              <input
                className={`${inputClass} bg-white font-mono text-xs`}
                value={createdClient.clientId}
                readOnly
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Client secret</label>
              <div className="flex gap-2">
                <input
                  className={`${inputClass} bg-white font-mono text-xs`}
                  value={createdClient.clientSecret}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  type="button"
                  onClick={handleCopySecret}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {secretCopied ? <Check size={14} /> : <Copy size={14} />}
                  {secretCopied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={dismissCreatedClient}
              className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              I've saved it, dismiss
            </button>
          </div>
        )}

        {showNewClient && (
          <form
            onSubmit={handleCreateClient}
            className="mb-4 space-y-3 rounded-lg border border-gray-200 bg-white p-4"
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <input
                className={inputClass}
                placeholder="Client name"
                maxLength={100}
                value={newClient.clientName}
                onChange={(e) => setNewClient({ ...newClient, clientName: e.target.value })}
                required
              />
              <select
                className={inputClass}
                value={newClient.tokenEndpointAuthMethod}
                onChange={(e) =>
                  setNewClient({
                    ...newClient,
                    tokenEndpointAuthMethod: e.target.value as OAuthTokenEndpointAuthMethod,
                  })
                }
              >
                <option value="client_secret_basic">client_secret_basic</option>
                <option value="client_secret_post">client_secret_post</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">
                Redirect URIs (one per line)
              </label>
              <textarea
                className={`${inputClass} font-mono text-xs`}
                rows={3}
                value={newClient.redirectUris}
                onChange={(e) => setNewClient({ ...newClient, redirectUris: e.target.value })}
                required
              />
            </div>
            {createClientErr && <p className="text-sm text-red-600">{createClientErr}</p>}
            <div className="flex gap-3">
              <button
                type="submit"
                disabled={creatingClient}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {creatingClient ? "Creating..." : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setShowNewClient(false)}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {clientsErr && <p className="mb-3 text-sm text-red-600">{clientsErr}</p>}
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 font-medium text-gray-500">Client ID</th>
                <th className="px-4 py-3 font-medium text-gray-500">Redirect URIs</th>
                <th className="px-4 py-3 font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 font-medium text-gray-500"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {clientsLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              )}
              {!clientsLoading &&
                clients.map((cl) => (
                  <tr key={cl.clientId}>
                    <td className="px-4 py-3 text-gray-900">{cl.clientName || "Unnamed"}</td>
                    <td className="max-w-[160px] truncate px-4 py-3 font-mono text-xs text-gray-500" title={cl.clientId}>
                      {cl.clientId}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {cl.redirectUris.map((u) => (
                        <div key={u} className="max-w-[240px] truncate" title={u}>
                          {u}
                        </div>
                      ))}
                    </td>
                    <td className="px-4 py-3 text-gray-600">
                      {cl.confidential ? "Confidential" : "Public"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      {confirmDeleteClientId === cl.clientId ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-gray-500">Delete and revoke all its grants?</span>
                          <button
                            onClick={() => handleDeleteClient(cl.clientId)}
                            disabled={deletingClientId === cl.clientId}
                            className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                          >
                            {deletingClientId === cl.clientId ? "Deleting..." : "Confirm"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteClientId(null)}
                            disabled={deletingClientId === cl.clientId}
                            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteClientId(cl.clientId)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              {!clientsLoading && !clients.length && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                    No OAuth clients registered.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
