import styles from "./UserAvatar.module.css";

type AvatarUser = {
  avatarUrl?: string | null;
  username?: string | null;
  companyName?: string | null;
  email?: string | null;
};

function initials(user: AvatarUser) {
  const source = user.username || user.companyName || user.email || "User";
  return source
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

export function UserAvatar({
  user,
  size = 40,
  className,
}: {
  user: AvatarUser;
  size?: number;
  className?: string;
}) {
  const label = user.username || user.companyName || user.email || "User";
  return (
    <span
      className={`${styles.avatar} ${className || ""}`}
      style={{ width: size, height: size }}
      aria-label={`${label} profile picture`}
      role="img"
    >
      {user.avatarUrl ? (
        // R2-hosted avatars are normalized server-side to small WebP files.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatarUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <span aria-hidden>{initials(user)}</span>
      )}
    </span>
  );
}
