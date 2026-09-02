include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-cake-autorate
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=janklovicsmarton

LUCI_TITLE:=LuCI interface for cake-autorate
LUCI_DESCRIPTION:=Web UI for the cake-autorate adaptive CAKE bandwidth controller: live status with rolling charts, per-instance control, full configuration, logs and MQTT publisher management.
LUCI_DEPENDS:=+cake-autorate +luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
