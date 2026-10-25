import React from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { NotificationItem } from "../services/notificationService";

type NotificationCenterModalProps = {
  visible: boolean;
  notifications: NotificationItem[];
  unreadCount: number;
  totalCount: number;
  loading: boolean;
  refreshing: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onOpenNotification: (item: NotificationItem) => void;
  onMarkAllRead: () => void;
  onDeleteNotification: (id: string) => void | Promise<void>;
};

function formatNotificationDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return `${date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })} · ${date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

export default function NotificationCenterModal({
  visible,
  notifications,
  unreadCount,
  totalCount,
  loading,
  refreshing,
  onClose,
  onRefresh,
  onOpenNotification,
  onMarkAllRead,
  onDeleteNotification,
}: NotificationCenterModalProps) {
  const [activeTab, setActiveTab] = React.useState<"new" | "seen">("new");
  const newNotifications = React.useMemo(
    () => notifications.filter((notification) => !notification.read),
    [notifications]
  );
  const seenNotifications = React.useMemo(
    () => notifications.filter((notification) => notification.read),
    [notifications]
  );
  const visibleNotifications = activeTab === "new" ? newNotifications : seenNotifications;
  const seenCount = Math.max(0, totalCount - unreadCount);
  const activeTotal = activeTab === "new" ? unreadCount : seenCount;

  const handleDelete = React.useCallback((notification: NotificationItem) => {
    Alert.alert("Delete notification", "Remove this notification from your inbox?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void onDeleteNotification(notification.id);
        },
      },
    ]);
  }, [onDeleteNotification]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.card}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>Notifications</Text>
              <Text style={styles.subtitle}>
                {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
              </Text>
            </View>
            <View style={styles.actions}>
              {unreadCount > 0 ? (
                <TouchableOpacity style={styles.iconButton} onPress={onMarkAllRead}>
                  <Feather name="check-circle" size={18} color="#2563EB" />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.iconButton} onPress={onClose}>
                <Feather name="x" size={20} color="#374151" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, activeTab === "new" && styles.tabActive]}
              activeOpacity={0.85}
              onPress={() => setActiveTab("new")}
            >
              <Text style={[styles.tabText, activeTab === "new" && styles.tabTextActive]}>
                New
              </Text>
              <View style={[styles.tabBadge, activeTab === "new" && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === "new" && styles.tabBadgeTextActive]}>
                  {unreadCount}
                </Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, activeTab === "seen" && styles.tabActive]}
              activeOpacity={0.85}
              onPress={() => setActiveTab("seen")}
            >
              <Text style={[styles.tabText, activeTab === "seen" && styles.tabTextActive]}>
                Seen
              </Text>
              <View style={[styles.tabBadge, activeTab === "seen" && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === "seen" && styles.tabBadgeTextActive]}>
                  {seenCount}
                </Text>
              </View>
            </TouchableOpacity>
          </View>

          {loading && notifications.length === 0 ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator size="large" color="#2563EB" />
            </View>
          ) : (
            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            >
              {visibleNotifications.length === 0 ? (
                <View style={styles.emptyState}>
                  <Feather name="bell-off" size={34} color="#9CA3AF" />
                  <Text style={styles.emptyTitle}>
                    {activeTotal > 0
                      ? `${activeTotal} notification${activeTotal === 1 ? "" : "s"} not loaded`
                      : activeTab === "new"
                        ? "No new notifications"
                        : "No seen notifications"}
                  </Text>
                  <Text style={styles.emptyText}>
                    {activeTotal > 0
                      ? "Pull to refresh to load the latest inbox page."
                      : activeTab === "new"
                        ? "Unread CRM tasks, previews, approvals, and declined reports will appear here."
                        : "Notifications move here after you open them or mark them as read."}
                  </Text>
                </View>
              ) : (
                visibleNotifications.map((notification) => (
                  <View
                    key={notification.id}
                    style={[styles.item, !notification.read && styles.itemUnread]}
                  >
                    <View style={[styles.dot, notification.read && styles.dotRead]} />
                    <TouchableOpacity
                      style={styles.itemBody}
                      activeOpacity={0.82}
                      onPress={() => onOpenNotification(notification)}
                    >
                      <Text style={[styles.itemTitle, !notification.read && styles.itemTitleUnread]} numberOfLines={1}>
                        {notification.title}
                      </Text>
                      <Text style={styles.itemText} numberOfLines={2}>
                        {notification.body}
                      </Text>
                      <Text style={styles.itemMeta}>{formatNotificationDate(notification.createdAt)}</Text>
                    </TouchableOpacity>
                    <View style={styles.itemActions}>
                      <TouchableOpacity
                        style={styles.deleteButton}
                        activeOpacity={0.8}
                        onPress={() => handleDelete(notification)}
                      >
                        <Feather name="trash-2" size={16} color="#DC2626" />
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.openButton}
                        activeOpacity={0.8}
                        onPress={() => onOpenNotification(notification)}
                      >
                        <Feather name="chevron-right" size={16} color="#9CA3AF" />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.32)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  card: {
    maxHeight: "78%",
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    overflow: "hidden",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 18,
    elevation: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  tabs: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
    backgroundColor: "#FFFFFF",
  },
  tab: {
    flex: 1,
    minHeight: 42,
    borderRadius: 16,
    backgroundColor: "#F3F4F6",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  tabActive: {
    backgroundColor: "#EEF2FF",
    borderColor: "#C7D2FE",
  },
  tabText: {
    fontSize: 14,
    fontWeight: "800",
    color: "#6B7280",
  },
  tabTextActive: {
    color: "#3730A3",
  },
  tabBadge: {
    minWidth: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 7,
    backgroundColor: "#E5E7EB",
  },
  tabBadgeActive: {
    backgroundColor: "#4F46E5",
  },
  tabBadgeText: {
    fontSize: 12,
    fontWeight: "800",
    color: "#4B5563",
  },
  tabBadgeTextActive: {
    color: "#FFFFFF",
  },
  title: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111827",
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    color: "#6B7280",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F3F4F6",
  },
  loadingWrap: {
    paddingVertical: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    maxHeight: "100%",
  },
  listContent: {
    padding: 16,
    gap: 10,
  },
  emptyState: {
    paddingVertical: 48,
    alignItems: "center",
  },
  emptyTitle: {
    marginTop: 12,
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  emptyText: {
    marginTop: 6,
    paddingHorizontal: 24,
    textAlign: "center",
    fontSize: 14,
    lineHeight: 20,
    color: "#6B7280",
  },
  item: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  itemUnread: {
    backgroundColor: "#EFF6FF",
    borderColor: "#BFDBFE",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
    backgroundColor: "#2563EB",
  },
  dotRead: {
    backgroundColor: "#D1D5DB",
  },
  itemBody: {
    flex: 1,
  },
  itemActions: {
    alignItems: "center",
    gap: 8,
  },
  deleteButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#FEF2F2",
    borderWidth: 1,
    borderColor: "#FECACA",
  },
  openButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
  },
  itemTitleUnread: {
    fontWeight: "800",
  },
  itemText: {
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
    color: "#4B5563",
  },
  itemMeta: {
    marginTop: 8,
    fontSize: 12,
    color: "#6B7280",
  },
});
