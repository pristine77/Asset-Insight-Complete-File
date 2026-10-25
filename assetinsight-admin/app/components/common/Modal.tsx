"use client";

import React from "react";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
} from "@mui/material";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClass?: string; // e.g., "max-w-md", "max-w-lg"
  fullScreen?: boolean;
};

const maxWidthMap: Record<string, number> = {
  "max-w-md": 448,
  "max-w-lg": 512,
  "max-w-xl": 576,
  "max-w-2xl": 672,
  "max-w-3xl": 768,
  "max-w-4xl": 896,
  "max-w-5xl": 1024,
  "max-w-6xl": 1152,
  "max-w-7xl": 1280,
};

export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidthClass = "max-w-lg",
  fullScreen = false,
}: ModalProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth={false}
      PaperProps={{
        sx: {
          width: "100%",
          maxWidth: fullScreen ? "100%" : maxWidthMap[maxWidthClass] || maxWidthMap["max-w-lg"],
          height: fullScreen ? "100%" : "auto",
          margin: fullScreen ? 0 : undefined,
          borderRadius: fullScreen ? 0 : 4,
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 2,
          pr: 1.5,
          position: fullScreen ? "sticky" : "static",
          top: 0,
          zIndex: 2,
          backgroundColor: "#fff",
          borderBottom: fullScreen ? "1px solid #e5e7eb" : "none",
        }}
      >
        <span>{title}</span>
        <IconButton aria-label="Close" onClick={onClose}>
          <CloseRoundedIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers={!fullScreen} sx={fullScreen ? { px: 0, py: 0, backgroundColor: "#f8fafc" } : undefined}>
        {children}
      </DialogContent>
      {footer ? (
        <DialogActions
          sx={
            fullScreen
              ? { px: 3, py: 2, position: "sticky", bottom: 0, backgroundColor: "#fff", borderTop: "1px solid #e5e7eb", zIndex: 2 }
              : { px: 3, py: 2 }
          }
        >
          {footer}
        </DialogActions>
      ) : null}
    </Dialog>
  );
}
