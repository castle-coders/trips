import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { admin, type AppUser, type ServiceIdentity } from "../lib/api";

export function Admin() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [identities, setIdentities] = useState<ServiceIdentity[]>([]);
  const [loading, setLoading] = useState(true);

  // New user form
  const [showNewUser, setShowNewUser] = useState(false);
  const [newUser, setNewUser] = useState({
    email: "",
    name: "",
    password: "",
    role: "viewer",
  });

  // New service identity form
  const [showNewIdentity, setShowNewIdentity] = useState(false);
  const [newIdentity, setNewIdentity] = useState({
    cfAccessSubject: "",
    commonName: "",
    userId: "",
  });

  useEffect(() => {
    Promise.all([admin.listUsers(), admin.listServiceIdentities()])
      .then(([u, si]) => {
        setUsers(u);
        setIdentities(si);
      })
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
    await admin.deleteUser(id);
    setUsers(users.filter((u) => u.id !== id));
    setIdentities(identities.filter((i) => i.userId !== id));
  };

  const handleRoleChange = async (id: string, role: string) => {
    const updated = await admin.updateUser(id, { role });
    setUsers(users.map((u) => (u.id === updated.id ? updated : u)));
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

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent focus:outline-none";

  if (loading) {
    return <p className="py-20 text-center text-gray-400">Loading...</p>;
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

      {/* Service Identities */}
      <section>
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
    </div>
  );
}
