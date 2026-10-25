export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";

export async function adminLoginAPI(email: string, password: string) {
  const res = await fetch(`${SERVER_URL}/api/admin/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.message || "Login failed");
  }

  return res.json();
}

// Local Next API helpers (use cookies for auth)
export async function getAdminMe() {
  const res = await fetch(`/api/admin/me`, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load profile");
  return res.json();
}

export async function listAdminsAPI() {
  const res = await fetch(`/api/admin/admins`, { method: "GET", cache: "no-store" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to load admins");
  return res.json();
}

export async function createAdminAPI(payload: { email: string; username?: string; password?: string; companyName?: string }) {
  const res = await fetch(`/api/admin/admins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to create admin");
  return res.json();
}

export async function deleteAdminAPI(id: string) {
  const res = await fetch(`/api/admin/admins/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to delete admin");
}

export async function blockAdminAPI(id: string, blocked: boolean) {
  const res = await fetch(`/api/admin/admins/${id}/block`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blocked }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.message || "Failed to update block status");
  return res.json();
}

export async function updateAdminPasswordAPI(id: string, password: string) {
  const res = await fetch(`/api/admin/admins/${id}/password`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw new Error(
      (await res.json().catch(() => ({})))?.message || "Failed to update password"
    );
  }
  return res.json();
}
